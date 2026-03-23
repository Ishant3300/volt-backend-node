/**
 * Price Queue Service  (BullMQ-backed)
 *
 * Two responsibilities:
 *   1. PRODUCER – publishes a PRICE_UPDATE job whenever a live tick arrives
 *   2. WORKER   – consumes PRICE_UPDATE jobs, queries the Redis order book
 *                 for matching orders, and executes them
 *
 * Flow:
 *   livePriceService tick → publishPriceUpdate()
 *     → BullMQ queue "price-updates"
 *       → worker picks up job
 *         → orderBookService.getMatchingBuy/SellOrders()
 *           → for each matched tradeId: execute in DB, remove from Redis
 */

const { Queue, Worker } = require('bullmq');
const redisService = require('./redisService');
const orderBookService = require('./orderBookService');
const { calculateMargin } = require('./marginService');
const firebaseService = require('./firebaseService');
const { LOG_PRICE_QUEUE } = require('../config/logFlags');

const QUEUE_NAME = 'price-updates';

let queue = null;
let worker = null;

// ─── Producer ───────────────────────────────────────────────────────────────

/**
 * Publish a price update event into the BullMQ queue.
 * Called from livePriceService whenever a tick is received.
 *
 * @param {string} instrumentToken
 * @param {number} livePrice
 */
const publishPriceUpdate = async (instrumentToken, livePrice) => {
  if (!queue) {
    console.log(`⚠️  [PriceQueue] Cannot publish - queue not initialized`);
    return;
  }

  try {
    const jobId = `price_${instrumentToken}_${Date.now()}`; // Unique ID to prevent replacement
    await queue.add('PRICE_UPDATE', {
      instrument_token: instrumentToken,
      live_price: livePrice,
      timestamp: Date.now(),
    }, {
      jobId: jobId,
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
    if (LOG_PRICE_QUEUE) console.log(`📤 [PriceQueue] Published: Token ${instrumentToken} @ ${livePrice} (Job: ${jobId})`);
  } catch (err) {
    console.error(`❌ [PriceQueue] publishPriceUpdate error: ${err.message}`);
  }
};

// ─── Worker / Consumer ──────────────────────────────────────────────────────

/**
 * Process a single PRICE_UPDATE job.
 * Queries Redis order book for matching BUY and SELL orders, then executes.
 */
const _processJob = async (job) => {
  const { instrument_token, live_price } = job.data;

  if (LOG_PRICE_QUEUE) console.log(`🔄 [PriceQueue] Processing price update: Token ${instrument_token} @ ${live_price}`);

  // 1. Find matching BUY orders (limitPrice >= livePrice)
  const matchingBuys = await orderBookService.getMatchingBuyOrders(instrument_token, live_price);

  // 2. Find matching SELL orders (limitPrice <= livePrice)
  const matchingSells = await orderBookService.getMatchingSellOrders(instrument_token, live_price);

  const allMatches = [
    ...matchingBuys.map(id => ({ id, side: 'BUY' })),
    ...matchingSells.map(id => ({ id, side: 'SELL' })),
  ];

  if (allMatches.length === 0) {
    if (LOG_PRICE_QUEUE) console.log(`   ℹ️  No matching orders for token ${instrument_token} at price ${live_price}`);
    return;
  }

  console.log(`⚡ [PriceQueue] Token ${instrument_token} @ ${live_price} → ${allMatches.length} order(s) to execute`);

  // 3. Execute each matched trade
  const Trade = require('../models/Trade');
  const Transaction = require('../models/Transaction');
  const User = require('../models/User');

  const executedBuys = [];
  const executedSells = [];

  for (const match of allMatches) {
    try {
      // Idempotency: only execute if still pending
      const trade = await Trade.findById(match.id);
      if (!trade || trade.status !== 'pending') {
        // Already executed or cancelled – just clean up Redis
        if (match.side === 'BUY') executedBuys.push(match.id);
        else executedSells.push(match.id);
        continue;
      }

      // Calculate realised P&L if this trade closes a position
      let realisedPnl = 0;
      const existingAgg = await Trade.aggregate([
        {
          $match: {
            user_id: trade.user_id,
            instrument_token: trade.instrument_token,
            status: 'completed',
            deleted_at: null
          }
        },
        {
          $group: {
            _id: null,
            total_buy_qty: {
              $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
            },
            total_sell_qty: {
              $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
            },
            total_buy_value: {
              $sum: {
                $cond: [
                  { $eq: ['$transaction_type', 'BUY'] },
                  { $multiply: ['$executed_quantity', '$executed_price'] },
                  0
                ]
              }
            },
            total_sell_value: {
              $sum: {
                $cond: [
                  { $eq: ['$transaction_type', 'SELL'] },
                  { $multiply: ['$executed_quantity', '$executed_price'] },
                  0
                ]
              }
            }
          }
        }
      ]);

      if (existingAgg.length > 0) {
        const agg = existingAgg[0];
        const prevNetQty = agg.total_buy_qty - agg.total_sell_qty;
        const avgBuyPrice = agg.total_buy_qty > 0 ? agg.total_buy_value / agg.total_buy_qty : 0;
        const avgSellPrice = agg.total_sell_qty > 0 ? agg.total_sell_value / agg.total_sell_qty : 0;

        if (trade.transaction_type === 'SELL' && prevNetQty > 0) {
          const closingQty = Math.min(trade.quantity, prevNetQty);
          realisedPnl = (trade.price - avgBuyPrice) * closingQty;
        } else if (trade.transaction_type === 'BUY' && prevNetQty < 0) {
          const closingQty = Math.min(trade.quantity, Math.abs(prevNetQty));
          realisedPnl = (avgSellPrice - trade.price) * closingQty;
        }
      }

      // Execute the trade
      trade.status = 'completed';
      trade.executed_at = new Date();
      trade.executed_price = trade.price;       // Execute at the limit price
      trade.executed_quantity = trade.quantity;
      trade.pnl = realisedPnl;
      trade.net_amount = realisedPnl;
      await trade.save();

      // Calculate margin impact and update balance
      let prevNetQtyForMargin = 0;
      if (existingAgg.length > 0) {
        prevNetQtyForMargin = existingAgg[0].total_buy_qty - existingAgg[0].total_sell_qty;
      }
      const isBuy = trade.transaction_type === 'BUY';
      const newNetQty = prevNetQtyForMargin + (isBuy ? trade.quantity : -trade.quantity);
      const marginPerUnit = await calculateMargin(trade.exchange, 1, trade.price);
      const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
      const newMargin = Math.abs(newNetQty) * marginPerUnit;
      const marginDelta = newMargin - prevMargin;
      const balanceChange = realisedPnl - marginDelta;

      const user = await User.findById(trade.user_id);
      if (user) {
        // Reject if insufficient balance for opening positions
        if (marginDelta > 0 && (user.balance + balanceChange) < 0) {
          trade.status = 'rejected';
          trade.pnl = 0;
          trade.net_amount = 0;
          await trade.save();
          console.log(`⚠️ [PriceQueue] Rejected ${trade.tradingsymbol} - insufficient balance (need ₹${marginDelta.toFixed(2)}, have ₹${user.balance.toFixed(2)})`);
          if (match.side === 'BUY') executedBuys.push(match.id);
          else executedSells.push(match.id);
          continue;
        }

        const balanceBefore = user.balance;
        user.balance += balanceChange;
        await user.save();

        // Log transaction
        try {
          const tradeValue = trade.price * trade.quantity;
          await new Transaction({
            transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_RQ`,
            userId: trade.user_id,
            userModel: 'User',
            type: trade.transaction_type,
            status: 'SUCCESS',
            amount: tradeValue,
            referenceId: trade._id,
            referenceModel: 'Trade',
            balanceBefore,
            balanceAfter: user.balance,
            metadata: {
              tradingsymbol: trade.tradingsymbol,
              quantity: trade.quantity,
              executedPrice: trade.price,
              livePrice: live_price,
              realisedPnl,
              marginDelta,
              balanceChange,
              positionClosed: realisedPnl !== 0,
              order_type: trade.order_type,
              executedBy: 'redis_queue_engine',
            },
          }).save();
        } catch (txErr) {
          console.error(`❌ [PriceQueue] Transaction log error for ${match.id}: ${txErr.message}`);
        }
      }

      // Track for bulk Redis removal
      if (match.side === 'BUY') executedBuys.push(match.id);
      else executedSells.push(match.id);

      console.log(`✅ [PriceQueue] Executed ${trade.transaction_type} LIMIT ${trade.tradingsymbol} @ ${trade.price} (live: ${live_price})`);

      // Notify the user's Flutter client via WebSocket
      const livePriceService = require('./livePriceService');
      livePriceService.broadcastToUser(trade.user_id.toString(), {
        type: 'trade_executed',
        trade_id: trade._id.toString(),
        instrument_token: trade.instrument_token,
        tradingsymbol: trade.tradingsymbol,
        transaction_type: trade.transaction_type,
        quantity: trade.quantity,
        executed_price: trade.price,
        pnl: realisedPnl,
        status: 'completed',
      });

      // FCM push notification for pending order execution
      firebaseService.sendNotification(trade.user_id.toString(), 'pending_order', {
        title: 'Limit Order Executed',
        body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} @ ₹${trade.price}`,
        data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
      });
    } catch (execErr) {
      console.error(`❌ [PriceQueue] Execution error for trade ${match.id}: ${execErr.message}`);
      // Job will retry via BullMQ attempts config
      throw execErr;
    }
  }

  // 4. Bulk-remove executed orders from Redis
  if (executedBuys.length > 0) {
    await orderBookService.removeMany(instrument_token, 'BUY', executedBuys);
  }
  if (executedSells.length > 0) {
    await orderBookService.removeMany(instrument_token, 'SELL', executedSells);
  }
};

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Initialise the BullMQ queue and worker.
 * Must be called after redisService.init().
 */
const init = () => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [PriceQueue] Redis unavailable – queue not started');
    return;
  }

  const connection = {
    host: redisService.getClient().options.host || '127.0.0.1',
    port: redisService.getClient().options.port || 6379,
    maxRetriesPerRequest: null,
  };

  // Create queue (producer side)
  queue = new Queue(QUEUE_NAME, { connection });

  // Create worker (consumer side)
  worker = new Worker(QUEUE_NAME, _processJob, {
    connection,
    concurrency: 5,           // Process up to 5 price updates in parallel
    limiter: {
      max: 100,               // Max 100 jobs per 1 second
      duration: 1000,
    },
  });

  worker.on('completed', (job) => {
    // Quiet – price updates are very frequent
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ [PriceQueue] Job ${job?.id} failed: ${err.message}`);
  });

  console.log('✅ [PriceQueue] Queue and worker initialised');
};

/**
 * Graceful shutdown
 */
const shutdown = async () => {
  console.log('🛑 [PriceQueue] Shutting down...');
  if (worker) await worker.close();
  if (queue) await queue.close();
};

module.exports = {
  init,
  publishPriceUpdate,
  shutdown,
};
