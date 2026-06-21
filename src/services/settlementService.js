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
    activeTradesInDb: 0,
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

  // Fallback: For instruments with open positions but no DB price,
  // use metricsEngine's in-memory LTP (last live price from Kite).
  // This prevents positions from being lost when bhavcopy didn't cover them.
  const positionTokens = metricsEngine.getPositionTokens();
  let fallbackCount = 0;
  for (const tokenInt of positionTokens) {
    const tokenStr = tokenInt.toString();
    if (!closePriceMap[tokenStr]) {
      const ltp = metricsEngine._ltpMap.get(tokenStr);
      const bid = metricsEngine._bidMap.get(tokenStr);
      const ask = metricsEngine._askMap.get(tokenStr);
      const fallbackPrice = ltp || bid || ask;
      if (fallbackPrice && fallbackPrice > 0) {
        closePriceMap[tokenStr] = fallbackPrice;
        fallbackCount++;
      }
    }
  }
  if (fallbackCount > 0) {
    console.log(`   📊 Added ${fallbackCount} fallback prices from metricsEngine (live LTP).`);
  }

  _settlementState.pricesFetched = Object.keys(closePriceMap).length;
  broadcastProgress();
  console.log(`   📊 Loaded ${Object.keys(closePriceMap).length} close prices (${allInstruments.length} from DB + ${fallbackCount} from live LTP).`);

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

  // Diagnostic: count active trades before aggregation
  const activeTradeCount = await Trade.countDocuments({ status: 'completed', deleted_at: null });
  console.log(`   📊 Active completed trades in DB: ${activeTradeCount}`);
  _settlementState.activeTradesInDb = activeTradeCount;

  if (activeTradeCount > 0) {
    // Sample a few trades to verify data integrity
    const sampleTrades = await Trade.find({ status: 'completed', deleted_at: null })
      .select('user_id instrument_token transaction_type executed_quantity tradingsymbol trade_type')
      .limit(5).lean();
    for (const t of sampleTrades) {
      console.log(`   📋 Sample: ${t.tradingsymbol} ${t.transaction_type} qty=${t.executed_quantity} token=${t.instrument_token} type=${t.trade_type} user=${t.user_id}`);
    }
  }

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

  // Diagnostic: if no positions found but trades exist, log the grouped results before net_qty filter
  if (openPositions.length === 0 && activeTradeCount > 0) {
    console.warn('   ⚠️ No open positions found despite having active trades! Checking grouped data...');
    const allGrouped = await Trade.aggregate([
      { $match: { status: 'completed', deleted_at: null } },
      { $group: {
        _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
        net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
        tradingsymbol: { $first: '$tradingsymbol' },
        count: { $sum: 1 },
      }},
    ]);
    console.log(`   📊 Total grouped positions (before net_qty filter): ${allGrouped.length}`);
    const sample = allGrouped.slice(0, 10);
    for (const g of sample) {
      console.log(`   📋 ${g.tradingsymbol}: net=${g.net_qty}, buy=${g.total_buy_qty}, sell=${g.total_sell_qty}, trades=${g.count}`);
    }
  }

  _settlementState.total = openPositions.length; // preliminary count (may reduce after price check)
  broadcastProgress();
  console.log(`   Found ${openPositions.length} open position(s).`);

  // Build instrument display name map
  const tokenSet = new Set(openPositions.map(p => p._id.instrument_token));
  const instruments = await KiteInstrument.find({ instrument_token: { $in: [...tokenSet] } })
    .select('instrument_token tradingsymbol display_name raw_name').lean();
  const instMap = {};
  instruments.forEach(i => { instMap[i.instrument_token.toString()] = i; });

  // ── Phase 4: Soft-delete old completed trades ────────────────
  // IMPORTANT: Only soft-delete trades for positions that have a valid close price.
  // If a position has no close price, we CANNOT settle it — leave those trades intact.
  console.log('📊 [Settlement] Phase 4: Soft-deleting old trades...');
  _settlementState.currentInstrument = 'Cleaning up old trades...';
  broadcastProgress();

  // Determine which positions have valid close prices
  const settleableTokens = new Set();
  const unsettleablePositions = [];
  for (const pos of openPositions) {
    const tokenStr = pos._id.instrument_token.toString();
    const closePrice = closePriceMap[tokenStr];
    if (closePrice && closePrice > 0) {
      settleableTokens.add(tokenStr);
    } else {
      unsettleablePositions.push(pos);
    }
  }

  if (unsettleablePositions.length > 0) {
    console.warn(`   ⚠️ ${unsettleablePositions.length} position(s) have no close price — will NOT be settled:`);
    for (const pos of unsettleablePositions) {
      const inst = instMap[pos._id.instrument_token.toString()];
      const name = inst?.display_name || inst?.raw_name || pos.tradingsymbol || pos._id.instrument_token;
      console.warn(`      - ${name} (token: ${pos._id.instrument_token}, user: ${pos._id.user_id})`);
    }
  }

  // Deletion of old trades now happens PER-POSITION inside Phase 5,
  // AFTER new trades are successfully created ("create then delete" pattern).
  // This prevents silent data loss if Trade.create() fails for any position.
  let deleteResult = { modifiedCount: 0 };
  if (settleableTokens.size === 0) {
    console.log('   No settleable instruments — nothing to process.');
  } else {
    console.log(`   ${settleableTokens.size} settleable instrument(s) — old trades will be deleted per-position in Phase 5 after new trades are confirmed.`);
  }

  // Also soft-delete trades for fully-closed positions (net_qty = 0) that have settleable tokens
  // These are positions where buy_qty == sell_qty — no re-opening needed
  const flatPositionTokens = new Set();
  const allGroupedForFlat = await Trade.aggregate([
    { $match: { status: 'completed', deleted_at: null } },
    { $group: {
      _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
      net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
    }},
    { $match: { net_qty: 0 } },
  ]);
  for (const flat of allGroupedForFlat) {
    const tokenStr = flat._id.instrument_token.toString();
    if (settleableTokens.has(tokenStr) || closePriceMap[tokenStr]) {
      flatPositionTokens.add(tokenStr);
    }
  }
  if (flatPositionTokens.size > 0) {
    const flatDelete = await Trade.updateMany(
      { status: 'completed', deleted_at: null, instrument_token: { $in: [...flatPositionTokens] } },
      { $set: { deleted_at: new Date(), remarks: 'Settlement: week reset (flat position)' } }
    );
    if (flatDelete.modifiedCount > 0) {
      console.log(`   Also soft-deleted ${flatDelete.modifiedCount} trade(s) from ${flatPositionTokens.size} flat (closed) positions.`);
    }
  }

  // ── Phase 5: Create closing + re-opening trades at settlement price ──
  // For each open position WITH a valid close price:
  //   1. CLOSING trade (opposite side) at settlement price — shows deals/P&L in history
  //   2. RE-OPENING trade (same side) at settlement price — fresh position for new week
  // Positions without close prices are left untouched (not deleted in Phase 4 either).
  console.log('📊 [Settlement] Phase 5: Creating closing + re-opening trades...');

  // Only process positions that have a valid close price (settleable ones)
  const settleablePositions = openPositions.filter(pos => {
    const tokenStr = pos._id.instrument_token.toString();
    return settleableTokens.has(tokenStr);
  });

  _settlementState.total = settleablePositions.length;
  broadcastProgress();

  const affectedUsers = new Set();
  let closedCount = 0;
  let reopenedCount = 0;
  const failedPositions = []; // positions where create failed — old trades preserved intact

  for (let i = 0; i < settleablePositions.length; i++) {
    const pos = settleablePositions[i];
    const token = pos._id.instrument_token;
    const userId = pos._id.user_id;
    const tokenStr = token.toString();
    const closePrice = closePriceMap[tokenStr];
    const inst = instMap[tokenStr];
    const displayName = inst?.display_name || inst?.raw_name || pos.tradingsymbol || tokenStr;

    _settlementState.processed = i + 1;
    _settlementState.currentInstrument = displayName;
    broadcastProgress();

    // ── Guard: validate required fields BEFORE touching any DB records ──
    // If master_id is missing the Trade schema will reject the create,
    // and with the old "batch delete first" approach this caused silent data loss.
    if (!pos.master_id) {
      const reason = 'master_id is null/missing — cannot create settlement trades';
      console.error(`   ❌ SKIP ${displayName} (user: ${userId}): ${reason}`);
      console.error(`      Old trades preserved — position NOT lost.`);
      failedPositions.push({ instrument: displayName, userId, reason });
      continue;
    }

    // closePrice is guaranteed > 0 here (filtered in settleablePositions)
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

    console.log(`   📊 ${pos.tradingsymbol}: avgEntry=${avgEntryPrice.toFixed(2)}, settlement=${closePrice.toFixed(2)}, pnl=${closingPnl.toFixed(2)}`);

    try {
      const closeTime = new Date();
      const reopenTime = new Date(closeTime.getTime() + 1000);

      // ── Step A: Create BOTH new trades FIRST (before deleting old ones) ──
      // If either create throws, the catch block fires and old trades stay intact.

      // 1. CLOSING trade — soft-deleted at creation; shows up in history/deals
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
        executed_at: closeTime,
        executed_price: closePrice,
        executed_quantity: absQty,
        pnl: closingPnl,
        deleted_at: closeTime,
        remarks: 'Settlement: position closed at settlement price',
      });

      // 2. RE-OPENING trade — active, ATP = settlement price, P&L = 0
      const reopeningDoc = await Trade.create({
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
        executed_at: reopenTime,
        executed_price: closePrice,
        executed_quantity: absQty,
        pnl: 0,
        remarks: 'Settlement: position carried forward at close price',
      });

      // ── Step B: Both new trades exist — NOW safe to delete old trades ──
      // Exclude the re-opening doc we just created (by _id) so it is never deleted.
      const deleted = await Trade.updateMany(
        {
          status: 'completed',
          deleted_at: null,
          user_id: userId,
          instrument_token: tokenStr,
          _id: { $ne: reopeningDoc._id },
        },
        { $set: { deleted_at: closeTime, remarks: 'Settlement: week reset' } }
      );

      deleteResult.modifiedCount += deleted.modifiedCount;
      closedCount++;
      reopenedCount++;
      affectedUsers.add(userId.toString());
      console.log(`   ✅ Settled ${displayName} (user: ${userId}) — deleted ${deleted.modifiedCount} old trade(s).`);
    } catch (err) {
      console.error(`   ❌ FAILED to settle ${displayName} for user ${userId}: ${err.message}`);
      console.error(`      Old trades preserved — position NOT lost.`);
      failedPositions.push({ instrument: displayName, userId, reason: err.message });
    }
  }

  if (failedPositions.length > 0) {
    console.error(`\n   ⚠️ [Settlement] ${failedPositions.length} POSITION(S) FAILED — old trades were preserved:`);
    for (const f of failedPositions) {
      console.error(`      - ${f.instrument} (user: ${f.userId}): ${f.reason}`);
    }
  }

  // ── Phase 6: Update metricsEngine price maps + full rebuild ─────
  console.log('📊 [Settlement] Phase 6: Rebuilding metrics...');
  _settlementState.currentInstrument = 'Rebuilding metrics...';
  broadcastProgress();

  // Update metricsEngine's LTP/bid/ask maps with settlement prices
  // so CMP = ATP = settlement price (position P&L = 0 after settlement)
  // Update from closePriceMap (all instruments from bhavcopy)
  for (const [tokenStr, price] of Object.entries(closePriceMap)) {
    metricsEngine._ltpMap.set(tokenStr, price);
    metricsEngine._bidMap.set(tokenStr, price);
    metricsEngine._askMap.set(tokenStr, price);
  }
  // Also ensure all settled position tokens are updated (in case they weren't in closePriceMap)
  for (const pos of openPositions) {
    const tokenStr = pos._id.instrument_token.toString();
    const price = closePriceMap[tokenStr];
    if (price) {
      metricsEngine._ltpMap.set(tokenStr, price);
      metricsEngine._bidMap.set(tokenStr, price);
      metricsEngine._askMap.set(tokenStr, price);
    }
  }

  // Full rebuild of ALL user caches — not just affected users.
  // This ensures users with fully closed positions also get their metrics reset to 0.
  // After settlement, only carry_forward trades exist → brokerage = 0, fifoPnl = 0.
  await metricsEngine._rebuildAllUserCaches();

  // Lock settled tokens so stale Kite ticks don't override settlement prices
  metricsEngine.setSettledTokens(Object.keys(closePriceMap));

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
  if (unsettleablePositions.length > 0) {
    console.log(`   ⚠️ ${unsettleablePositions.length} position(s) were NOT settled (no close price) — left intact.`);
  }
}

module.exports = { runSettlement, getState, resetState };
