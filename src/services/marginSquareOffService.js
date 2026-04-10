/**
 * Margin Square Off Service
 * Monitors user equity in real-time via metricsEngine and auto-squares off
 * all positions when equity drops below the configured percentage of credit.
 *
 * Example: credit=100000, percentage=50 → threshold = 50000
 *          If equity < 50000, all positions are squared off.
 */
const User = require('../models/User');
const Trade = require('../models/Trade');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

let _livePriceService = null;
// Track which users are currently being squared off to prevent duplicate triggers
const _squaringOff = new Set();

const init = (livePriceService) => {
  _livePriceService = livePriceService;
  console.log('🛡️  [MarginSquareOff] Service initialized (tick-driven via metricsEngine)');
};

const shutdown = () => {
  console.log('🛡️  [MarginSquareOff] Service shut down');
};

/**
 * Called by metricsEngine after computing metrics for a user.
 * Checks if margin square off should trigger based on the percentage threshold.
 */
const checkUser = async (userId, metrics) => {
  if (_squaringOff.has(userId)) return; // Already processing

  try {
    const user = await User.findById(userId).select('margin_square_off margin_square_off_percentage credits master_id server_id username active_status deleted_at').lean();
    if (!user) return;
    if (!user.margin_square_off) return; // Feature not enabled
    if (!user.active_status || user.deleted_at) return;

    const percentage = user.margin_square_off_percentage || 0;
    if (percentage <= 0) return; // No threshold set

    const credit = user.credits || 0;
    if (credit <= 0) return; // No credit to compare against

    // Threshold: equity must stay above this value
    // percentage=50 means equity must stay above 50% of credit
    const threshold = credit * (1 - percentage / 100);
    const equity = metrics.equity;

    // Check if equity has dropped below threshold
    if (equity < threshold && metrics.positions && metrics.positions.length > 0) {
      console.log(`🛡️  [MarginSquareOff] User ${user.username}: equity=₹${equity.toFixed(2)} < threshold=₹${threshold.toFixed(2)} (${percentage}% of ₹${credit}), squaring off`);
      _squaringOff.add(userId);

      try {
        await _squareOffAllPositions(user, metrics.positions);
      } finally {
        _squaringOff.delete(userId);
      }
    }
  } catch (err) {
    _squaringOff.delete(userId);
    console.error(`🛡️  [MarginSquareOff] Error checking user ${userId}:`, err.message);
  }
};

const _squareOffAllPositions = async (user, positions) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const freshUser = await User.findById(user._id).session(session);
      if (!freshUser) return;

      for (const pos of positions) {
        const netQty = pos.net_qty;
        if (netQty === 0) continue;

        const closeType = netQty > 0 ? 'SELL' : 'BUY';
        const closeQty = Math.abs(netQty);
        const closePrice = pos.ltp || (netQty > 0 ? pos.avg_buy_price : pos.avg_sell_price);

        let pnl = 0;
        if (netQty > 0) pnl = (closePrice - pos.avg_buy_price) * closeQty;
        else pnl = (pos.avg_sell_price - closePrice) * closeQty;

        const newTrade = new Trade({
          user_id: freshUser._id,
          master_id: freshUser.master_id,
          admin_id: freshUser.server_id,
          instrument_token: pos.instrument_token,
          tradingsymbol: pos.tradingsymbol,
          exchange: pos.exchange,
          transaction_type: closeType,
          quantity: closeQty,
          price: closePrice,
          order_type: 'MARKET',
          placed_by: 'ADMIN',
          status: 'completed',
          executed_at: new Date(),
          executed_price: closePrice,
          executed_quantity: closeQty,
          pnl: pnl,
          brokerage: 0,
          taxes: 0,
          net_amount: pnl,
          remarks: 'MARGIN_SQUARE_OFF'
        });
        await newTrade.save({ session });

        const balanceBefore = freshUser.equity;
        freshUser.equity += pnl;

        const tx = new Transaction({
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_MSO`,
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
            tradingsymbol: pos.tradingsymbol,
            quantity: closeQty,
            executedPrice: closePrice,
            order_type: 'MARKET',
            realisedPnl: pnl,
            reason: 'MARGIN_SQUARE_OFF',
            positionClosed: true
          }
        });
        await tx.save({ session });

        console.log(`🛡️  [MarginSquareOff] Squared off ${pos.tradingsymbol}: ${closeType} ${closeQty} @ ₹${closePrice.toFixed(2)}, P&L: ₹${pnl.toFixed(2)}`);
      }

      await freshUser.save({ session });
    });

    session.endSession();

    // Rebuild metricsEngine cache for this user
    try {
      const metricsEngine = require('./metricsEngine');
      await metricsEngine.onTradeExecuted(user._id.toString());
    } catch (_) {}

    // Notify user via WebSocket
    if (_livePriceService) {
      _livePriceService.broadcastToUser(user._id.toString(), {
        type: 'margin_square_off',
        message: `Your positions have been auto-squared off. Equity dropped below ${user.margin_square_off_percentage}% of your credit.`
      });
    }

    // Notify via FCM
    try {
      const firebaseService = require('./firebaseService');
      firebaseService.sendNotification(user._id.toString(), 'admin_order_execution', {
        title: 'Margin Square Off',
        body: `All positions squared off. Equity dropped below ${user.margin_square_off_percentage}% threshold.`,
        data: { reason: 'margin_square_off' }
      });
    } catch (_) {}

  } catch (err) {
    session.endSession();
    console.error(`🛡️  [MarginSquareOff] Failed to square off for ${user.username}:`, err.message);
  }
};

module.exports = { init, shutdown, checkUser };
