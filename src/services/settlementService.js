/**
 * Settlement Service
 *
 * Admin-triggered weekly settlement:
 * 1. Fetches close prices via bhavcopy
 * 2. Cancels pending orders
 * 3. Soft-deletes ALL existing completed trades (week reset)
 * 4. For each open position: creates a single re-opening trade at close price
 * 5. Rebuilds metrics, broadcasts settlement ticks
 *
 * After settlement: only re-opening trades remain, ATP = close price,
 * so M2M ≈ 0, realised P&L = 0, margin recalculated.
 */

const Trade = require('../models/Trade');
const KiteInstrument = require('../models/KiteInstrument');

let _settlementState = {
  running: false,
  phase: 'idle',
  total: 0,
  processed: 0,
  currentInstrument: '',
  startedAt: null,
  completedAt: null,
  error: null,
  closedTrades: 0,
  reopenedTrades: 0,
  usersAffected: 0,
  pricesFetched: 0,
};

function getState() { return { ..._settlementState }; }
function resetState() {
  _settlementState = {
    running: false, phase: 'idle', total: 0, processed: 0,
    currentInstrument: '', startedAt: null, completedAt: null, error: null,
    closedTrades: 0, reopenedTrades: 0, usersAffected: 0, pricesFetched: 0,
  };
}

function broadcastProgress() {
  try {
    const livePriceService = require('./livePriceService');
    if (!livePriceService.wss) return;
    const state = getState();
    const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    const msg = JSON.stringify({ type: 'settlement_progress', data: { ...state, percentage: pct } });
    livePriceService.wss.clients.forEach((client) => {
      if (client.readyState === 1 && client.isAdmin) client.send(msg);
    });
  } catch (_) {}
}

async function runSettlement() {
  if (_settlementState.running) return { success: false, message: 'Settlement already in progress' };
  resetState();
  _settlementState.running = true;
  _settlementState.startedAt = new Date();
  broadcastProgress();

  _executeSettlement().catch(err => {
    _settlementState.phase = 'error';
    _settlementState.error = err.message;
    _settlementState.running = false;
    broadcastProgress();
    console.error('❌ [Settlement] Fatal error:', err.message);
  });

  return { success: true, message: 'Settlement started' };
}

async function _executeSettlement() {
  const metricsEngine = require('./metricsEngine');
  const livePriceService = require('./livePriceService');

  // ── Phase 1: Load close prices from DB (already fetched via "Fetch Settlement Prices") ──
  _settlementState.phase = 'fetching_prices';
  broadcastProgress();
  console.log('📊 [Settlement] Phase 1: Loading close prices from DB...');

  const closePriceMap = {};
  const allInstruments = await KiteInstrument.find({
    is_active: true,
    last_price: { $gt: 0 },
    deleted_at: null,
  }).select('instrument_token last_price').lean();

  for (const inst of allInstruments) {
    closePriceMap[inst.instrument_token.toString()] = inst.last_price;
  }

  _settlementState.pricesFetched = Object.keys(closePriceMap).length;
  broadcastProgress();
  console.log(`   📊 Loaded ${Object.keys(closePriceMap).length} close prices from DB.`);

  if (Object.keys(closePriceMap).length === 0) {
    throw new Error('No close prices in DB — run "Fetch Settlement Prices" first');
  }

  // ── Phase 2: Cancel all pending orders ───────────────────────────
  _settlementState.phase = 'cancelling_pending';
  broadcastProgress();
  console.log('📊 [Settlement] Phase 2: Cancelling pending orders...');

  await Trade.updateMany(
    { status: 'pending', deleted_at: null },
    { $set: { status: 'cancelled', remarks: 'Settlement: pending order expired' } }
  );

  try {
    const orderBookService = require('./orderBookService');
    const redisService = require('./redisService');
    if (redisService.isAvailable()) {
      const cancelled = await Trade.find({ status: 'cancelled', remarks: 'Settlement: pending order expired' }).select('_id').lean();
      for (const t of cancelled) { try { await orderBookService.removeOrder(t._id.toString()); } catch (_) {} }
    }
  } catch (_) {}

  // ── Phase 3: Get all open positions with avg entry price BEFORE soft-deleting ─
  _settlementState.phase = 'processing';
  broadcastProgress();
  console.log('📊 [Settlement] Phase 3: Collecting open positions...');

  const openPositions = await Trade.aggregate([
    { $match: { status: 'completed', deleted_at: null } },
    { $group: {
      _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
      net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
      total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
      total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
      total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
      total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
      tradingsymbol: { $first: '$tradingsymbol' },
      exchange: { $first: '$exchange' },
      master_id: { $first: '$master_id' },
      admin_id: { $first: '$admin_id' },
    }},
    { $match: { net_qty: { $ne: 0 } } },
  ]);

  _settlementState.total = openPositions.length;
  broadcastProgress();
  console.log(`   Found ${openPositions.length} open position(s).`);

  // Build instrument display name map
  const tokenSet = new Set(openPositions.map(p => p._id.instrument_token));
  const instruments = await KiteInstrument.find({ instrument_token: { $in: [...tokenSet] } })
    .select('instrument_token tradingsymbol display_name raw_name').lean();
  const instMap = {};
  instruments.forEach(i => { instMap[i.instrument_token.toString()] = i; });

  // ── Phase 4: Soft-delete ALL old completed trades ────────────────
  console.log('📊 [Settlement] Phase 4: Soft-deleting old trades...');
  _settlementState.currentInstrument = 'Cleaning up old trades...';
  broadcastProgress();

  const deleteResult = await Trade.updateMany(
    { status: 'completed', deleted_at: null },
    { $set: { deleted_at: new Date(), remarks: 'Settlement: week reset' } }
  );
  console.log(`   Soft-deleted ${deleteResult.modifiedCount} old trade(s).`);

  // ── Phase 5: Create closing + re-opening trades at settlement price ──
  // For each open position:
  //   1. CLOSING trade (opposite side) at settlement price — shows deals/P&L in history
  //   2. RE-OPENING trade (same side) at settlement price — fresh position for new week
  console.log('📊 [Settlement] Phase 5: Creating closing + re-opening trades...');

  const affectedUsers = new Set();
  let closedCount = 0;
  let reopenedCount = 0;

  for (let i = 0; i < openPositions.length; i++) {
    const pos = openPositions[i];
    const token = pos._id.instrument_token;
    const userId = pos._id.user_id;
    const tokenStr = token.toString();
    const closePrice = closePriceMap[tokenStr];
    const inst = instMap[tokenStr];
    const displayName = inst?.display_name || inst?.raw_name || pos.tradingsymbol || tokenStr;

    _settlementState.processed = i + 1;
    _settlementState.currentInstrument = displayName;
    broadcastProgress();

    if (!closePrice || closePrice <= 0) {
      console.warn(`   ⚠️ No close price for ${displayName}, skipping.`);
      continue;
    }

    const absQty = Math.abs(pos.net_qty);
    const isLong = pos.net_qty > 0;
    const openSide = isLong ? 'BUY' : 'SELL';
    const closeSide = isLong ? 'SELL' : 'BUY';

    // Calculate avg entry price for P&L on the closing trade
    const avgEntryPrice = isLong
      ? (pos.total_buy_qty > 0 ? pos.total_buy_value / pos.total_buy_qty : 0)
      : (pos.total_sell_qty > 0 ? pos.total_sell_value / pos.total_sell_qty : 0);

    // P&L for the closing trade: (exit - entry) × qty for longs, (entry - exit) × qty for shorts
    const closingPnl = isLong
      ? (closePrice - avgEntryPrice) * absQty
      : (avgEntryPrice - closePrice) * absQty;

    try {
      // 1. CLOSING trade — opposite side at settlement price
      // Soft-deleted immediately so metricsEngine ignores it (only reopening trade counts).
      // History page includes settlement trades via special query.
      await Trade.create({
        user_id: userId,
        master_id: pos.master_id,
        admin_id: pos.admin_id || null,
        instrument_token: tokenStr,
        tradingsymbol: pos.tradingsymbol,
        exchange: pos.exchange,
        transaction_type: closeSide,
        quantity: absQty,
        price: closePrice,
        order_type: 'MARKET',
        placed_by: 'SYSTEM',
        trade_type: 'carry_forward',
        status: 'completed',
        executed_at: new Date(),
        executed_price: closePrice,
        executed_quantity: absQty,
        pnl: 0,
        deleted_at: new Date(),
        remarks: 'Settlement: position closed at settlement price',
      });
      closedCount++;

      // 2. RE-OPENING trade — same side at settlement price (fresh position for new week)
      await Trade.create({
        user_id: userId,
        master_id: pos.master_id,
        admin_id: pos.admin_id || null,
        instrument_token: tokenStr,
        tradingsymbol: pos.tradingsymbol,
        exchange: pos.exchange,
        transaction_type: openSide,
        quantity: absQty,
        price: closePrice,
        order_type: 'MARKET',
        placed_by: 'SYSTEM',
        trade_type: 'carry_forward',
        status: 'completed',
        executed_at: new Date(),
        executed_price: closePrice,
        executed_quantity: absQty,
        pnl: 0,
        remarks: 'Settlement: position carried forward at close price',
      });
      reopenedCount++;
      affectedUsers.add(userId.toString());
    } catch (err) {
      console.error(`   ❌ Error settling ${displayName} for user ${userId}: ${err.message}`);
    }
  }

  console.log(`   Created ${closedCount} closing + ${reopenedCount} re-opening trade(s) for ${affectedUsers.size} user(s).`);

  // ── Phase 6: Update metricsEngine price maps + full rebuild ─────
  console.log('📊 [Settlement] Phase 6: Rebuilding metrics...');
  _settlementState.currentInstrument = 'Rebuilding metrics...';
  broadcastProgress();

  // Update metricsEngine's LTP/bid/ask maps with settlement prices
  // so CMP = ATP = settlement price (position P&L = 0)
  for (const [tokenStr, price] of Object.entries(closePriceMap)) {
    metricsEngine._ltpMap.set(tokenStr, price);
    metricsEngine._bidMap.set(tokenStr, price);
    metricsEngine._askMap.set(tokenStr, price);
  }

  // Full rebuild of ALL user caches — not just affected users.
  // This ensures users with fully closed positions also get their metrics reset to 0.
  // After settlement, only carry_forward trades exist → brokerage = 0, fifoPnl = 0.
  await metricsEngine._rebuildAllUserCaches();

  // ── Phase 7: Broadcast settlement ticks (close price as LTP/bid/ask) ──
  console.log('📊 [Settlement] Phase 7: Broadcasting settlement ticks...');
  _settlementState.currentInstrument = 'Broadcasting prices...';
  broadcastProgress();

  // Broadcast close prices for ALL instruments in closePriceMap
  // bid = ask = close price (no fake spread — settlement price is exact)
  const ticks = Object.entries(closePriceMap).map(([token, price]) => ({
    instrument_token: token,
    last_price: price,
    bid_price: price,
    ask_price: price,
    close: price,
    is_settlement: true,
    change: 0,
    change_percent: 0,
  }));

  // Store in settlement prices map for new subscribers
  if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();
  for (const [token, price] of Object.entries(closePriceMap)) {
    livePriceService._settlementPrices.set(token, price);
    livePriceService.latestPrices.set(token, price);
    livePriceService.latestPrices.set(parseInt(token), price);
  }

  // Broadcast in batches
  const BATCH = 100;
  for (let i = 0; i < ticks.length; i += BATCH) {
    livePriceService._broadcastToClients({ type: 'ticks', data: ticks.slice(i, i + BATCH) });
  }
  console.log(`   Broadcast ${ticks.length} settlement tick(s).`);

  // ── Done ─────────────────────────────────────────────────────────
  _settlementState.phase = 'done';
  _settlementState.processed = _settlementState.total;
  _settlementState.currentInstrument = '';
  _settlementState.completedAt = new Date();
  _settlementState.running = false;
  _settlementState.closedTrades = closedCount;
  _settlementState.reopenedTrades = reopenedCount;
  _settlementState.usersAffected = affectedUsers.size;
  broadcastProgress();

  console.log(`✅ [Settlement] Complete: ${deleteResult.modifiedCount} old trades deleted, ${closedCount} closed, ${reopenedCount} re-opened, ${affectedUsers.size} users.`);
}

module.exports = { runSettlement, getState, resetState };
