/**
 * Weekend Carry Forward Service
 *
 * Runs Saturday morning after all markets close.
 * 
 * 1. Cancels all pending (limit/SL) orders
 * 2. Soft-deletes all trades for fully closed positions (week's realised P&L reset)
 * 3. For open positions: soft-deletes closing-side trades, consolidates opening-side
 *    to match net qty, overwrites ATP to Friday's close price, zeros pnl
 *
 * After carry forward, metricsEngine shows:
 *   - Equity = Credit (since M2M resets to ~0)
 *   - Realised P&L = 0
 *   - M2M P&L = ~0 (ATP = close price, so floating starts near 0)
 *   - Margin Used = unchanged (open positions still held)
 *   - Free Margin = Equity - Margin Used
 *
 * No new trades are created. No amounts are deducted.
 *
 * Cron: Saturday 9:00 AM IST
 */

const Trade = require('../models/Trade');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * Main entry point — called by cron on Saturday morning.
 */
async function runWeekendCarryForward() {
  console.log('🔄 [WeekendCF] Starting weekend carry forward...');

  try {
    await cancelAllPendingOrders();
    await overwriteAtpWithClosePrice();
    console.log('✅ [WeekendCF] Weekend carry forward completed.');
  } catch (err) {
    console.error('❌ [WeekendCF] Error:', err.message);
  }
}

/**
 * Cancel all pending (limit/SL) orders across all users.
 */
async function cancelAllPendingOrders() {
  console.log('🔄 [WeekendCF] Cancelling all pending orders...');

  const result = await Trade.updateMany(
    { status: 'pending', deleted_at: null },
    { $set: { status: 'cancelled', remarks: 'Weekend: pending order expired (market closed)' } }
  );

  console.log(`   ✅ Cancelled ${result.modifiedCount} pending order(s).`);

  // Remove from Redis order book
  try {
    const orderBookService = require('./orderBookService');
    const redisService = require('./redisService');
    if (redisService.isAvailable()) {
      const cancelledTrades = await Trade.find({
        status: 'cancelled',
        remarks: 'Weekend: pending order expired (market closed)',
      }).select('_id').lean();
      for (const t of cancelledTrades) {
        try { await orderBookService.removeOrder(t._id.toString()); } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * Overwrite executed_price (ATP) of all open position trades to Friday's close price.
 * Also cleans up the week's history so metricsEngine starts fresh:
 *   - Soft-deletes all trades for fully closed positions (net_qty = 0)
 *   - For open positions: soft-deletes closing-side trades, keeps opening-side with new ATP
 *   - Zeros out pnl on remaining trades so realised P&L resets to 0
 *
 * Result: equity = credit, M2M = 0, realised P&L = 0, margin = unchanged for open positions
 */
async function overwriteAtpWithClosePrice() {
  console.log('🔄 [WeekendCF] Overwriting ATP with close prices...');

  // Refresh settlement prices first
  try {
    const livePriceService = require('./livePriceService');
    console.log('   Refreshing settlement prices...');
    await livePriceService.refreshSettlementPrices();
  } catch (err) {
    console.warn(`   ⚠️ Settlement refresh failed: ${err.message}. Using cached prices.`);
  }

  // Get ALL user+instrument positions (including flat ones)
  const allPositions = await Trade.aggregate([
    { $match: { status: 'completed', deleted_at: null } },
    { $group: {
      _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
      net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
    }},
  ]);

  const openPositions = allPositions.filter(p => p.net_qty !== 0);
  const closedPositions = allPositions.filter(p => p.net_qty === 0);

  console.log(`   Found ${openPositions.length} open position(s), ${closedPositions.length} fully closed position(s).`);

  // ── 1. Soft-delete all trades for fully closed positions ──────────
  // These are completed trades where buy qty = sell qty (flat). They carry
  // realised P&L from the past week that should not carry into the new week.
  const allAffectedUsers = new Set();
  let softDeleted = 0;

  for (const pos of closedPositions) {
    const result = await Trade.updateMany(
      {
        user_id: pos._id.user_id,
        instrument_token: pos._id.instrument_token,
        status: 'completed',
        deleted_at: null,
      },
      { $set: { deleted_at: new Date(), remarks: 'Weekend carry forward: week reset' } }
    );
    softDeleted += result.modifiedCount;
    allAffectedUsers.add(pos._id.user_id.toString());
  }

  if (softDeleted > 0) {
    console.log(`   🗑️  Soft-deleted ${softDeleted} trade(s) from ${closedPositions.length} fully closed position(s).`);
  }

  // ── 2. Handle open positions: soft-delete closing side, update opening side ATP ──
  if (openPositions.length === 0) {
    console.log('   No open positions to carry forward.');
  } else {
    // Get close prices for open position instruments
    const tokenSet = new Set(openPositions.map(p => p._id.instrument_token));
    const instruments = await KiteInstrument.find({
      instrument_token: { $in: [...tokenSet] },
    }).select('instrument_token last_price tradingsymbol').lean();

    const closePriceMap = {};
    for (const inst of instruments) {
      if (inst.last_price && inst.last_price > 0) {
        closePriceMap[inst.instrument_token.toString()] = {
          price: inst.last_price,
          symbol: inst.tradingsymbol,
        };
      }
    }

    console.log(`   ${Object.keys(closePriceMap).length} close prices available for ${openPositions.length} open position(s).`);

    let updated = 0;
    let closingSideDeleted = 0;
    let skipped = 0;

    for (const pos of openPositions) {
      const token = pos._id.instrument_token;
      const userId = pos._id.user_id;
      const closeData = closePriceMap[token.toString()];
      allAffectedUsers.add(userId.toString());

      if (!closeData) {
        skipped++;
        continue;
      }

      const openingSide = pos.net_qty > 0 ? 'BUY' : 'SELL';
      const closingSide = pos.net_qty > 0 ? 'SELL' : 'BUY';

      // Soft-delete the closing side trades (they carry partial realised P&L)
      const closeResult = await Trade.updateMany(
        {
          user_id: userId,
          instrument_token: token,
          transaction_type: closingSide,
          status: 'completed',
          deleted_at: null,
        },
        { $set: { deleted_at: new Date(), remarks: 'Weekend carry forward: week reset' } }
      );
      closingSideDeleted += closeResult.modifiedCount;

      // Now we need to consolidate the opening side to match the net qty.
      // Since net_qty might be less than total opening qty (partial closes happened),
      // we soft-delete excess opening trades and keep only enough to match net_qty.
      const openingTrades = await Trade.find({
        user_id: userId,
        instrument_token: token,
        transaction_type: openingSide,
        status: 'completed',
        deleted_at: null,
      }).sort({ executed_at: 1 }).lean();

      const absNetQty = Math.abs(pos.net_qty);
      let remainingQty = absNetQty;
      const tradesToKeep = [];
      const tradesToDelete = [];

      // Walk through opening trades FIFO, keep only what's needed for net qty
      for (const t of openingTrades) {
        if (remainingQty <= 0) {
          tradesToDelete.push(t._id);
        } else if (t.executed_quantity <= remainingQty) {
          tradesToKeep.push(t._id);
          remainingQty -= t.executed_quantity;
        } else {
          // This trade has more qty than needed — we'll keep it but adjust qty
          tradesToKeep.push(t._id);
          // Update this trade's quantity to only the remaining needed
          await Trade.updateOne(
            { _id: t._id },
            { $set: { executed_quantity: remainingQty, quantity: remainingQty } }
          );
          remainingQty = 0;
        }
      }

      // Soft-delete excess opening trades
      if (tradesToDelete.length > 0) {
        await Trade.updateMany(
          { _id: { $in: tradesToDelete } },
          { $set: { deleted_at: new Date(), remarks: 'Weekend carry forward: consolidated' } }
        );
        closingSideDeleted += tradesToDelete.length;
      }

      // Update remaining opening trades: set ATP to close price, zero out pnl,
      // mark as carry_forward so metricsEngine skips brokerage calculation
      if (tradesToKeep.length > 0) {
        const updateResult = await Trade.updateMany(
          { _id: { $in: tradesToKeep } },
          { $set: { executed_price: closeData.price, price: closeData.price, pnl: 0, trade_type: 'carry_forward' } }
        );
        updated += updateResult.modifiedCount;
        console.log(`   📝 ${closeData.symbol}: kept ${tradesToKeep.length} trade(s), ATP → ${closeData.price}, net_qty=${pos.net_qty}`);
      }
    }

    console.log(`   ✅ Updated ${updated} opening trade(s), soft-deleted ${closingSideDeleted} closing/excess trade(s), skipped ${skipped} (no close price).`);
  }

  // ── 3. Rebuild metricsEngine for ALL affected users ───────────────
  try {
    const metricsEngine = require('./metricsEngine');
    for (const uid of allAffectedUsers) {
      await metricsEngine.onTradeExecuted(uid);
    }
    console.log(`   🔄 Rebuilt metrics for ${allAffectedUsers.size} user(s).`);
  } catch (err) {
    console.warn(`   ⚠️ MetricsEngine rebuild error: ${err.message}`);
  }
}

module.exports = { runWeekendCarryForward, cancelAllPendingOrders, overwriteAtpWithClosePrice };
