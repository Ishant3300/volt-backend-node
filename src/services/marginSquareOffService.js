/**
 * Tick-driven, transactionally fenced margin square-off service.
 */
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Trade = require('../models/Trade');
const User = require('../models/User');
const { beginTradeWrite } = require('./tradeWriteFenceService');

let _livePriceService = null;
const _squaringOff = new Set();

const init = livePriceService => {
  _livePriceService = livePriceService;
  console.log('🛡️  [MarginSquareOff] Service initialized (tick-driven via metricsEngine)');
};

const shutdown = () => {
  console.log('🛡️  [MarginSquareOff] Service shut down');
};

function shouldSquareOff(user, metrics, log = false) {
  if (!user || !metrics) return false;
  const credit = Number(user.credits || 0);
  const equity = Number(metrics.equity || 0);

  if (user.margin_square_off && equity < 0) {
    if (log) console.log(`🛡️  [MarginSquareOff] User ${user.username}: equity=₹${equity.toFixed(2)} < 0 (toggle ON), squaring off`);
    return true;
  }

  if (user.margin_square_off_percentage > 0 && credit > 0) {
    const percentage = user.margin_square_off_percentage;
    const threshold = credit * (1 - percentage / 100);
    if (equity < threshold) {
      if (log) console.log(`🛡️  [MarginSquareOff] User ${user.username}: equity=₹${equity.toFixed(2)} < threshold=₹${threshold.toFixed(2)} (${percentage}% of ₹${credit}), squaring off`);
      return true;
    }
  }
  return false;
}

/**
 * Called by metricsEngine after computing metrics for a user. The tick metrics
 * are only a trigger; the fenced path takes a fresh snapshot before writing.
 */
const checkUser = async (userId, metrics) => {
  if (_squaringOff.has(userId)) return;

  try {
    const user = await User.findById(userId)
      .select('margin_square_off margin_square_off_percentage credits master_id server_id username active_status deleted_at')
      .lean();
    if (!user || !user.active_status || user.deleted_at) return;
    if (!user.margin_square_off && !(user.margin_square_off_percentage > 0)) return;
    if (!metrics?.positions?.length || !shouldSquareOff(user, metrics, true)) return;

    _squaringOff.add(userId);
    try {
      await _squareOffAllPositions(user);
    } finally {
      _squaringOff.delete(userId);
    }
  } catch (error) {
    _squaringOff.delete(userId);
    console.error(`🛡️  [MarginSquareOff] Error checking user ${userId}:`, error.message);
  }
};

async function _squareOffAllPositions(triggerUser) {
  let lease = null;
  let session = null;
  let positionsSquared = 0;

  try {
    // Acquire before the authoritative metrics and price snapshot. Settlement
    // cannot drain writers and commit while this decision remains in flight.
    lease = await beginTradeWrite('margin_square_off');
    const metricsEngine = require('./metricsEngine');
    const [user, freshMetrics] = await Promise.all([
      User.findById(triggerUser._id)
        .select('margin_square_off margin_square_off_percentage credits master_id server_id username active_status deleted_at')
        .lean(),
      metricsEngine.getFreshMetrics(triggerUser._id.toString()),
    ]);

    if (!user || !user.active_status || user.deleted_at || !freshMetrics?.positions?.length) return 0;
    if (!shouldSquareOff(user, freshMetrics)) return 0;

    const positions = freshMetrics.positions.filter(position => Number(position.net_qty || 0) !== 0);
    if (positions.length === 0) return 0;

    const priceSnapshot = new Map();
    for (const position of positions) {
      priceSnapshot.set(position.instrument_token.toString(), {
        bid: Number(position.bid_price || position.cmp || position.ltp || 0),
        ask: Number(position.ask_price || position.cmp || position.ltp || 0),
        ltp: Number(position.ltp || 0),
      });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await lease.assertActive({ session });
      const freshUser = await User.findById(user._id).session(session);
      if (!freshUser) throw new Error(`Margin square-off user ${user._id} no longer exists`);

      for (const position of positions) {
        const netQty = Number(position.net_qty || 0);
        const closeType = netQty > 0 ? 'SELL' : 'BUY';
        const closeQty = Math.abs(netQty);
        const snapshot = priceSnapshot.get(position.instrument_token.toString()) || {};
        const closePrice = closeType === 'SELL'
          ? Number(snapshot.bid || snapshot.ltp || position.avg_buy_price || 0)
          : Number(snapshot.ask || snapshot.ltp || position.avg_sell_price || 0);
        if (!Number.isFinite(closePrice) || closePrice <= 0) {
          throw new Error(`No valid fenced square-off price for ${position.tradingsymbol}`);
        }

        const pnl = netQty > 0
          ? (closePrice - position.avg_buy_price) * closeQty
          : (position.avg_sell_price - closePrice) * closeQty;
        const newTrade = new Trade({
          user_id: freshUser._id,
          master_id: freshUser.master_id,
          admin_id: freshUser.server_id,
          instrument_token: position.instrument_token,
          tradingsymbol: position.tradingsymbol,
          exchange: position.exchange,
          transaction_type: closeType,
          quantity: closeQty,
          price: closePrice,
          order_type: 'MARKET',
          placed_by: 'SYSTEM',
          trade_type: 'margin_square_off',
          status: 'completed',
          executed_at: new Date(),
          executed_price: closePrice,
          executed_quantity: closeQty,
          pnl,
          brokerage: 0,
          taxes: 0,
          net_amount: pnl,
          remarks: 'MARGIN_SQUARE_OFF',
        });
        await newTrade.save({ session });

        const balanceBefore = Number(freshUser.equity || 0);
        freshUser.equity = balanceBefore + pnl;
        const transaction = new Transaction({
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_MSO`,
          userId: freshUser._id,
          userModel: 'User',
          type: closeType,
          status: 'SUCCESS',
          amount: closePrice * closeQty,
          referenceId: newTrade._id,
          referenceModel: 'Trade',
          balanceBefore,
          balanceAfter: freshUser.equity,
          metadata: {
            tradingsymbol: position.tradingsymbol,
            quantity: closeQty,
            executedPrice: closePrice,
            order_type: 'MARKET',
            realisedPnl: pnl,
            reason: 'MARGIN_SQUARE_OFF',
            positionClosed: true,
          },
        });
        await transaction.save({ session });
        positionsSquared++;

        console.log(`🛡️  [MarginSquareOff] Squared off ${position.tradingsymbol}: ${closeType} ${closeQty} @ ₹${closePrice.toFixed(2)}, P&L: ₹${pnl.toFixed(2)}`);
      }

      await lease.assertActive({ session });
      await freshUser.save({ session });
    });

    await metricsEngine.onTradeExecuted(user._id.toString());
    notifySquareOff(user);
    return positionsSquared;
  } catch (error) {
    if (error.code !== 'SETTLEMENT_IN_PROGRESS') {
      console.error(`🛡️  [MarginSquareOff] Failed to square off for ${triggerUser.username}:`, error.message);
    }
    return 0;
  } finally {
    if (session) await session.endSession();
    await lease?.release();
  }
}

function notifySquareOff(user) {
  if (_livePriceService) {
    _livePriceService.broadcastToUser(user._id.toString(), {
      type: 'margin_square_off',
      message: `Your positions have been auto-squared off. Equity dropped below ${user.margin_square_off_percentage}% of your credit.`,
    });

    if (_livePriceService.wss) {
      const message = JSON.stringify({
        type: 'trade_executed',
        user_id: user._id.toString(),
        tradingsymbol: 'ALL',
        transaction_type: 'SQUARE_OFF',
        quantity: 0,
        status: 'completed',
        message: `Margin square-off: all positions closed for ${user.username}`,
      });
      _livePriceService.wss.clients.forEach(client => {
        if (client.readyState === 1
          && (client.isAdmin || client.userId === user._id.toString() || client.userId === user.master_id?.toString())) {
          client.send(message);
        }
      });
    }
  }

  try {
    const firebaseService = require('./firebaseService');
    firebaseService.sendNotification(user._id.toString(), 'admin_order_execution', {
      title: 'Margin Square Off',
      body: `All positions squared off. Equity dropped below ${user.margin_square_off_percentage}% threshold.`,
      data: { reason: 'margin_square_off' },
    });
  } catch (_) {}
}

module.exports = { init, shutdown, checkUser };
