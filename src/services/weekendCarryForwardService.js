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

    // Broadcast settlement ticks so watchlist shows close price as LTP/bid/ask
    await broadcastSettlementTicks();

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
 * Uses Kite Historical API (day candle) for accurate close prices.
 * Updates ALL active instruments in DB, not just those in watchlists.
 *
 * Result: equity = credit, M2M = 0, realised P&L = 0, margin = unchanged for open positions
 */
async function overwriteAtpWithClosePrice() {
  console.log('🔄 [WeekendCF] Overwriting ATP with close prices...');

  // ── Refresh close prices via NSE Bhavcopy + MCX Kite API fallback ──
  const { fetchAndApplyBhavcopy } = require('./bhavcopyService');
  const bhavResult = await fetchAndApplyBhavcopy();
  let closePriceMap = bhavResult.closePriceMap;

  // If bhavcopy failed entirely, fall back to the old per-instrument Historical API
  if (bhavResult.error || Object.keys(closePriceMap).length === 0) {
    console.log('   ⚠️ Bhavcopy failed, falling back to Kite Historical API...');
    closePriceMap = await refreshAllClosePricesViaHistorical();
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
    // Get instrument info for logging
    const tokenSet = new Set(openPositions.map(p => p._id.instrument_token));
    const instruments = await KiteInstrument.find({
      instrument_token: { $in: [...tokenSet] },
    }).select('instrument_token tradingsymbol').lean();
    const symbolMap = {};
    for (const inst of instruments) {
      symbolMap[inst.instrument_token.toString()] = inst.tradingsymbol;
    }

    let updated = 0;
    let closingSideDeleted = 0;
    let skipped = 0;

    for (const pos of openPositions) {
      const token = pos._id.instrument_token;
      const tokenStr = token.toString();
      const userId = pos._id.user_id;
      const closePrice = closePriceMap[tokenStr];
      const symbol = symbolMap[tokenStr] || tokenStr;
      allAffectedUsers.add(userId.toString());

      if (!closePrice) {
        console.warn(`   ⚠️ No close price for ${symbol} (token ${tokenStr}), skipping.`);
        skipped++;
        continue;
      }

      const openingSide = pos.net_qty > 0 ? 'BUY' : 'SELL';
      const closingSide = pos.net_qty > 0 ? 'SELL' : 'BUY';

      // Soft-delete the closing side trades
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

      // Consolidate opening side to match net qty
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

      for (const t of openingTrades) {
        if (remainingQty <= 0) {
          tradesToDelete.push(t._id);
        } else if (t.executed_quantity <= remainingQty) {
          tradesToKeep.push(t._id);
          remainingQty -= t.executed_quantity;
        } else {
          tradesToKeep.push(t._id);
          await Trade.updateOne(
            { _id: t._id },
            { $set: { executed_quantity: remainingQty, quantity: remainingQty } }
          );
          remainingQty = 0;
        }
      }

      if (tradesToDelete.length > 0) {
        await Trade.updateMany(
          { _id: { $in: tradesToDelete } },
          { $set: { deleted_at: new Date(), remarks: 'Weekend carry forward: consolidated' } }
        );
        closingSideDeleted += tradesToDelete.length;
      }

      if (tradesToKeep.length > 0) {
        const updateResult = await Trade.updateMany(
          { _id: { $in: tradesToKeep } },
          { $set: { executed_price: closePrice, price: closePrice, pnl: 0, trade_type: 'carry_forward' } }
        );
        updated += updateResult.modifiedCount;
        console.log(`   📝 ${symbol}: kept ${tradesToKeep.length} trade(s), ATP → ${closePrice}, net_qty=${pos.net_qty}`);
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

/**
 * Fetch Friday's close price for ALL active instruments using Kite Historical API.
 * Updates KiteInstrument.last_price in DB and returns a token→closePrice map.
 *
 * Historical API: GET /instruments/historical/{token}/day?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns candles: [date, open, high, low, close, volume]
 */
async function refreshAllClosePricesViaHistorical() {
  const kiteService = require('./kiteService');

  // Determine last trading day (Friday if running on Saturday, or previous weekday)
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 3600000 - now.getTimezoneOffset() * 60000));
  const dayOfWeek = ist.getDay(); // 0=Sun, 6=Sat
  let daysBack = 1;
  if (dayOfWeek === 0) daysBack = 2; // Sunday → Friday
  else if (dayOfWeek === 6) daysBack = 1; // Saturday → Friday
  else if (dayOfWeek === 1) daysBack = 3; // Monday → Friday
  else daysBack = 1; // Tue-Fri → previous day

  const friday = new Date(ist);
  friday.setDate(friday.getDate() - daysBack);
  const fridayStr = friday.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log(`   📅 Fetching close prices for ${fridayStr} (last trading day)...`);

  // Get ALL active non-synthetic instruments from DB
  const allInstruments = await KiteInstrument.find({
    is_active: true,
    instrument_token: { $not: /^9999/ }, // Exclude synthetic tokens
  }).select('instrument_token tradingsymbol exchange').lean();

  console.log(`   📊 Found ${allInstruments.length} active instruments to refresh.`);

  const closePriceMap = {};
  const bulkOps = [];
  let fetched = 0;
  let failed = 0;

  // Fetch in batches to avoid rate limiting (Kite allows ~3 req/sec for historical)
  const BATCH_SIZE = 3;
  const DELAY_MS = 1100; // ~1.1s between batches to stay under rate limit

  for (let i = 0; i < allInstruments.length; i += BATCH_SIZE) {
    const batch = allInstruments.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (inst) => {
      const tokenStr = inst.instrument_token.toString();
      try {
        const candles = await kiteService.getHistoricalData(
          inst.instrument_token, 'day', fridayStr, fridayStr, { silent: true }
        );

        if (candles && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          const closePrice = lastCandle.close;
          const openPrice = lastCandle.open || 0;
          const highPrice = lastCandle.high || 0;
          const lowPrice = lastCandle.low || 0;

          if (closePrice && closePrice > 0) {
            closePriceMap[tokenStr] = closePrice;
            bulkOps.push({
              updateOne: {
                filter: { instrument_token: tokenStr },
                update: { $set: {
                  last_price: closePrice,
                  ohlc_open: openPrice,
                  ohlc_high: highPrice,
                  ohlc_low: lowPrice,
                  ohlc_close: closePrice,
                } },
              }
            });
            fetched++;
          }
        }
      } catch (err) {
        // Don't log every failure — just count them
        failed++;
      }
    });

    await Promise.all(promises);

    // Rate limit delay between batches
    if (i + BATCH_SIZE < allInstruments.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    // Progress log every 50 batches
    if ((i / BATCH_SIZE) % 50 === 0 && i > 0) {
      console.log(`   ... progress: ${Math.min(i + BATCH_SIZE, allInstruments.length)}/${allInstruments.length} instruments`);
    }
  }

  // Bulk update DB
  if (bulkOps.length > 0) {
    await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(`   ✅ Close prices: ${fetched} fetched, ${failed} failed, ${bulkOps.length} DB records updated.`);

  return closePriceMap;
}

/**
 * Broadcast settlement ticks to all connected WebSocket clients.
 * After carry forward, this sends each instrument's close price as LTP, bid, ask
 * so the watchlist shows correct prices even when the market is closed.
 * Also includes OHLC data for the trade card view.
 */
async function broadcastSettlementTicks() {
  console.log('📡 [WeekendCF] Broadcasting settlement ticks to connected clients...');

  try {
    const livePriceService = require('./livePriceService');

    // Get all instruments that have OHLC data
    const instruments = await KiteInstrument.find({
      is_active: true,
      ohlc_close: { $gt: 0 },
    }).select('instrument_token last_price ohlc_open ohlc_high ohlc_low ohlc_close').lean();

    if (instruments.length === 0) {
      console.log('   No instruments with OHLC data to broadcast.');
      return;
    }

    // Build ticks array — close price as LTP, bid, ask; include OHLC
    const ticks = instruments.map(inst => {
      const close = inst.ohlc_close;
      const spread = close * 0.0005; // 0.05% spread
      return {
        instrument_token: inst.instrument_token.toString(),
        last_price: close,
        bid_price: close > 0 ? close - spread : close,
        ask_price: close > 0 ? close + spread : close,
        open: inst.ohlc_open,
        high: inst.ohlc_high,
        low: inst.ohlc_low,
        close: inst.ohlc_close,
        change: 0,
        change_percent: 0,
      };
    });

    // Broadcast in batches to avoid overwhelming clients
    const BATCH = 100;
    for (let i = 0; i < ticks.length; i += BATCH) {
      const batch = ticks.slice(i, i + BATCH);
      livePriceService._broadcastToClients({ type: 'ticks', data: batch });
    }

    console.log(`   ✅ Broadcast settlement ticks for ${ticks.length} instrument(s).`);
  } catch (err) {
    console.warn(`   ⚠️ Settlement tick broadcast error: ${err.message}`);
  }
}

module.exports = { runWeekendCarryForward, cancelAllPendingOrders, overwriteAtpWithClosePrice, refreshAllClosePricesViaHistorical, broadcastSettlementTicks };
