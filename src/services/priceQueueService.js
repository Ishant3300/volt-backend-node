/**
 * BullMQ-backed live-price producer and pending-order consumer.
 * Every financial mutation is committed in one Mongo transaction whose lease
 * proof is touched inside that same transaction.
 */
const mongoose = require('mongoose');
const { Queue, Worker } = require('bullmq');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const ScriptQuantity = require('../models/ScriptQuantity');
const Trade = require('../models/Trade');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { LOG_PRICE_QUEUE } = require('../config/logFlags');
const { beginTradeWrite } = require('./tradeWriteFenceService');
const { calculateMargin } = require('./marginService');
const firebaseService = require('./firebaseService');
const metricsEngine = require('./metricsEngine');
const orderBookService = require('./orderBookService');
const redisService = require('./redisService');

const QUEUE_NAME = 'price-updates';
let queue = null;
let worker = null;

const publishPriceUpdate = async (instrumentToken, livePrice) => {
  if (!queue) return;
  try {
    const jobId = `price_${instrumentToken}_${Date.now()}`;
    await queue.add('PRICE_UPDATE', {
      instrument_token: instrumentToken,
      live_price: livePrice,
      timestamp: Date.now(),
    }, {
      jobId,
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
    if (LOG_PRICE_QUEUE) console.log(`📤 [PriceQueue] Published: Token ${instrumentToken} @ ${livePrice} (Job: ${jobId})`);
  } catch (error) {
    console.error(`❌ [PriceQueue] publishPriceUpdate error: ${error.message}`);
  }
};

function positionState(rows) {
  const row = rows[0] || {};
  return {
    totalBuyQty: Number(row.total_buy_qty || 0),
    totalSellQty: Number(row.total_sell_qty || 0),
    totalBuyValue: Number(row.total_buy_value || 0),
    totalSellValue: Number(row.total_sell_value || 0),
  };
}

function realisedPnlFor(trade, state) {
  const netQty = state.totalBuyQty - state.totalSellQty;
  const avgBuy = state.totalBuyQty > 0 ? state.totalBuyValue / state.totalBuyQty : 0;
  const avgSell = state.totalSellQty > 0 ? state.totalSellValue / state.totalSellQty : 0;
  if (trade.transaction_type === 'SELL' && netQty > 0) {
    return (trade.price - avgBuy) * Math.min(trade.quantity, netQty);
  }
  if (trade.transaction_type === 'BUY' && netQty < 0) {
    return (avgSell - trade.price) * Math.min(trade.quantity, Math.abs(netQty));
  }
  return 0;
}

async function calculateBrokerage(trade, session) {
  const instrument = await KiteInstrument.findOne({ instrument_token: trade.instrument_token }).session(session).lean();
  const rawName = instrument?.raw_name || instrument?.name || null;
  let rule = null;
  if (rawName) {
    rule = await BrokerageSettings.findOne({
      exchange_name: trade.exchange,
      script_name: rawName,
      deleted_at: null,
    }).session(session).lean();
  }
  if (!rule) {
    rule = await BrokerageSettings.findOne({
      exchange_name: trade.exchange,
      script_name: trade.tradingsymbol,
      deleted_at: null,
    }).session(session).lean();
  }
  if (!rule) return 0;
  if (rule.type === 'TURNOVER WISE') return (trade.price * trade.quantity) * (rule.brk_value / 100);
  if (rule.type !== 'LOT WISE') return 0;

  let lotSize = Number(instrument?.lot_size || 0);
  if (lotSize <= 0) {
    const lot = await ScriptQuantity.findOne({
      exchange_name: trade.exchange,
      script_name: trade.tradingsymbol,
      deleted_at: null,
    }).session(session).lean();
    lotSize = Number(lot?.lot_size || 1);
  }
  return (trade.quantity / lotSize) * rule.brk_value;
}

async function executeMatchedOrder(match, livePrice, options = {}) {
  let lease = null;
  let session = null;
  let outcome = { kind: 'unchanged', trade: null };

  try {
    lease = await beginTradeWrite('redis_limit_execution');
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      outcome = { kind: 'unchanged', trade: null };
      await lease.assertActive({ session });
      const trade = await Trade.findById(match.id).session(session);
      if (!trade || trade.status !== 'pending') return;

      const aggregate = await Trade.aggregate([
        {
          $match: {
            user_id: trade.user_id,
            instrument_token: trade.instrument_token,
            status: 'completed',
            deleted_at: null,
          },
        },
        {
          $group: {
            _id: null,
            total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
            total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
            total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
            total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
          },
        },
      ]).session(session);
      const state = positionState(aggregate);
      const previousNetQty = state.totalBuyQty - state.totalSellQty;
      const afterNetQty = trade.transaction_type === 'BUY'
        ? previousNetQty + trade.quantity
        : previousNetQty - trade.quantity;
      const opening = Math.abs(afterNetQty) > Math.abs(previousNetQty);

      if (opening) {
        const freshMetrics = await metricsEngine.getFreshMetrics(trade.user_id.toString());
        if (freshMetrics && freshMetrics.free_margin < 0) {
          trade.status = 'cancelled';
          trade.remarks = 'Insufficient free margin when limit order triggered';
          await trade.save({ session });
          await Trade.create([{
            user_id: trade.user_id,
            master_id: trade.master_id,
            admin_id: trade.admin_id || null,
            instrument_token: trade.instrument_token,
            tradingsymbol: trade.tradingsymbol,
            exchange: trade.exchange,
            transaction_type: trade.transaction_type,
            quantity: trade.quantity,
            price: trade.price,
            order_type: trade.order_type,
            status: 'rejected',
            remarks: `Insufficient free margin (₹${freshMetrics.free_margin.toFixed(2)}). Limit order cancelled.`,
          }], { session });
          await lease.assertActive({ session });
          outcome = { kind: 'cancelled', trade: trade.toObject(), freeMargin: freshMetrics.free_margin };
          return;
        }
      }

      const realisedPnl = realisedPnlFor(trade, state);
      const brokerage = await calculateBrokerage(trade, session);
      const marginPerUnit = await calculateMargin(trade.exchange, 1, trade.price);
      const previousMargin = Math.abs(previousNetQty) * marginPerUnit;
      const newMargin = Math.abs(afterNetQty) * marginPerUnit;
      const marginDelta = newMargin - previousMargin;
      const balanceChange = realisedPnl - marginDelta - brokerage;
      const user = await User.findById(trade.user_id).session(session);
      if (!user) throw new Error(`Pending-order user ${trade.user_id} not found`);

      const currentEquity = Number(user.equity || 0);
      if (marginDelta > 0 && currentEquity + balanceChange < 0) {
        trade.status = 'rejected';
        trade.pnl = 0;
        trade.net_amount = 0;
        trade.remarks = 'Insufficient balance when limit order triggered';
        await trade.save({ session });
        await lease.assertActive({ session });
        outcome = { kind: 'rejected', trade: trade.toObject(), marginDelta, equity: currentEquity };
        return;
      }

      trade.status = 'completed';
      trade.executed_at = new Date();
      trade.executed_price = trade.price;
      trade.executed_quantity = trade.quantity;
      trade.pnl = realisedPnl;
      trade.brokerage = brokerage;
      trade.net_amount = realisedPnl - brokerage;
      await trade.save({ session });

      const balanceBefore = currentEquity;
      user.equity = currentEquity + balanceChange;
      await user.save({ session });
      const transaction = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_RQ`,
        userId: trade.user_id,
        userModel: 'User',
        type: trade.transaction_type,
        status: 'SUCCESS',
        amount: trade.price * trade.quantity,
        referenceId: trade._id,
        referenceModel: 'Trade',
        balanceBefore,
        balanceAfter: user.equity,
        metadata: {
          tradingsymbol: trade.tradingsymbol,
          quantity: trade.quantity,
          executedPrice: trade.price,
          livePrice,
          realisedPnl,
          brokerage,
          marginDelta,
          balanceChange,
          positionClosed: realisedPnl !== 0,
          order_type: trade.order_type,
          executedBy: 'redis_queue_engine',
        },
      });
      await transaction.save({ session });
      if (options.faultInjector) {
        await options.faultInjector({
          phase: 'before_final_lease_proof',
          lease,
          session,
          trade,
        });
      }
      await lease.assertActive({ session });
      outcome = { kind: 'completed', trade: trade.toObject(), realisedPnl };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    return outcome;
  } finally {
    try {
      if (session) await session.endSession();
    } finally {
      await lease?.release();
    }
  }
}

function addCleanupId(match, buys, sells) {
  if (match.side === 'BUY') buys.push(match.id);
  else sells.push(match.id);
}

async function notifyOutcome(outcome, livePrice) {
  const trade = outcome.trade;
  if (!trade) return;
  const livePriceService = require('./livePriceService');

  if (outcome.kind === 'cancelled') {
    console.log(`⚠️ [PriceQueue] Cancelled ${trade.tradingsymbol} LIMIT — insufficient free margin (₹${outcome.freeMargin.toFixed(2)})`);
    livePriceService.broadcastToUser(trade.user_id.toString(), {
      type: 'trade_rejected',
      trade_id: trade._id.toString(),
      tradingsymbol: trade.tradingsymbol,
      message: 'Insufficient free margin. Limit order cancelled.',
    });
    return;
  }

  if (outcome.kind === 'rejected') {
    console.log(`⚠️ [PriceQueue] Rejected ${trade.tradingsymbol} - insufficient balance (need ₹${outcome.marginDelta.toFixed(2)}, have ₹${outcome.equity.toFixed(2)})`);
    return;
  }

  if (outcome.kind !== 'completed') return;
  console.log(`✅ [PriceQueue] Executed ${trade.transaction_type} LIMIT ${trade.tradingsymbol} @ ${trade.price} (live: ${livePrice})`);
  livePriceService.broadcastToUser(trade.user_id.toString(), {
    type: 'trade_executed',
    trade_id: trade._id.toString(),
    instrument_token: trade.instrument_token,
    tradingsymbol: trade.tradingsymbol,
    transaction_type: trade.transaction_type,
    quantity: trade.quantity,
    executed_price: trade.price,
    pnl: outcome.realisedPnl,
    status: 'completed',
  });
  await metricsEngine.onTradeExecuted(trade.user_id.toString());
  firebaseService.sendNotification(trade.user_id.toString(), 'pending_order', {
    title: 'Limit Order Executed',
    body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} @ ₹${trade.price}`,
    data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
  });
}

const _processJob = async job => {
  const { instrument_token, live_price } = job.data;
  if (LOG_PRICE_QUEUE) console.log(`🔄 [PriceQueue] Processing price update: Token ${instrument_token} @ ${live_price}`);

  const [matchingBuys, matchingSells] = await Promise.all([
    orderBookService.getMatchingBuyOrders(instrument_token, live_price),
    orderBookService.getMatchingSellOrders(instrument_token, live_price),
  ]);
  const matches = [
    ...matchingBuys.map(id => ({ id, side: 'BUY' })),
    ...matchingSells.map(id => ({ id, side: 'SELL' })),
  ];
  if (matches.length === 0) return;

  console.log(`⚡ [PriceQueue] Token ${instrument_token} @ ${live_price} → ${matches.length} order(s) to execute`);
  const executedBuys = [];
  const executedSells = [];
  for (const match of matches) {
    try {
      const outcome = await executeMatchedOrder(match, live_price);
      if (['unchanged', 'cancelled', 'rejected', 'completed'].includes(outcome.kind)) {
        addCleanupId(match, executedBuys, executedSells);
      }
      await notifyOutcome(outcome, live_price);
    } catch (error) {
      if (error.code !== 'SETTLEMENT_IN_PROGRESS') {
        console.error(`❌ [PriceQueue] Execution error for trade ${match.id}: ${error.message}`);
      }
      throw error;
    }
  }

  if (executedBuys.length > 0) await orderBookService.removeMany(instrument_token, 'BUY', executedBuys);
  if (executedSells.length > 0) await orderBookService.removeMany(instrument_token, 'SELL', executedSells);
};

const init = () => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [PriceQueue] Redis unavailable – queue not started');
    return;
  }
  if (queue || worker) return;

  const connection = {
    host: redisService.getClient().options.host || '127.0.0.1',
    port: redisService.getClient().options.port || 6379,
    maxRetriesPerRequest: null,
  };
  queue = new Queue(QUEUE_NAME, { connection });
  worker = new Worker(QUEUE_NAME, _processJob, {
    connection,
    concurrency: 5,
    limiter: { max: 100, duration: 1000 },
  });
  worker.on('failed', (job, error) => {
    console.error(`❌ [PriceQueue] Job ${job?.id} failed: ${error.message}`);
  });
  console.log('✅ [PriceQueue] Queue and worker initialised');
};

const shutdown = async () => {
  console.log('🛑 [PriceQueue] Shutting down...');
  if (worker) await worker.close();
  if (queue) await queue.close();
  worker = null;
  queue = null;
};

module.exports = {
  init,
  publishPriceUpdate,
  shutdown,
  _private: { executeMatchedOrder, positionState, realisedPnlFor },
};
