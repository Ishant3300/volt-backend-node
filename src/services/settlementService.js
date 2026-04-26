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

  // ── Phase 1: Fetch close prices ──────────────────────────────────
  _settlementState.phase = 'fetching_prices';
  broadcastProgress();
  console.log('📊 [Settlement] Phase 1: Fetching close prices...');

  const { fetchAndApplyBhavcopy } = require('./bhavcopyService');
  const bhavResult = await fetchAndApplyBhavcopy();
  const closePriceMap = bhavResult.closePriceMap;
  _settlementState.pricesFetched = Object.keys(closePriceMap).length;
  broadcastProgress();

  if (Object.keys(closePriceMap).length === 0) {
    throw new Error('No close prices fetched — cannot proceed');
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

  // ── Phase 3: Get all open positions BEFORE soft-deleting ─────────
  _settlementState.phase = 'processing';
  broadcastProgress();
  console.log('📊 [Settlement] Phase 3: Collecting open positions...');

  const openPositions = await Trade.aggregate([
    { $match: { status: 'completed', deleted_at: null } },
    { $group: {
      _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
      net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
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

  // ── Phase 5: Create re-opening trades at close price ─────────────
  console.log('📊 [Settlement] Phase 5: Creating re-opening trades...');

  const affectedUsers = new Set();
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
    const openSide = pos.net_qty > 0 ? 'BUY' : 'SELL';

    try {
      // Create ONLY the re-opening trade (old trades already soft-deleted)
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

  console.log(`   Created ${reopenedCount} re-opening trade(s) for ${affectedUsers.size} user(s).`);

  // ── Phase 6: Rebuild metrics for all affected users ──────────────
  console.log('📊 [Settlement] Phase 6: Rebuilding metrics...');
  _settlementState.currentInstrument = 'Rebuilding metrics...';
  broadcastProgress();

  for (const uid of affectedUsers) {
    try { await metricsEngine.onTradeExecuted(uid); } catch (_) {}
  }

  // ── Phase 7: Broadcast settlement ticks (close price as LTP/bid/ask) ──
  console.log('📊 [Settlement] Phase 7: Broadcasting settlement ticks...');
  _settlementState.currentInstrument = 'Broadcasting prices...';
  broadcastProgress();

  // Broadcast close prices for ALL instruments in closePriceMap
  const ticks = Object.entries(closePriceMap).map(([token, price]) => {
    const spread = price * 0.0005;
    return {
      instrument_token: token,
      last_price: price,
      bid_price: price > 0 ? price - spread : price,
      ask_price: price > 0 ? price + spread : price,
      open: price,
      high: price,
      low: price,
      close: price,
      change: 0,
      change_percent: 0,
    };
  });

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
  _settlementState.closedTrades = deleteResult.modifiedCount;
  _settlementState.reopenedTrades = reopenedCount;
  _settlementState.usersAffected = affectedUsers.size;
  broadcastProgress();

  console.log(`✅ [Settlement] Complete: ${deleteResult.modifiedCount} old trades deleted, ${reopenedCount} re-opened, ${affectedUsers.size} users.`);
}

module.exports = { runSettlement, getState, resetState };
