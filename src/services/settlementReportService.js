'use strict';

/**
 * Settlement Report — lists a target's own direct clients/sub-masters for a
 * date range, each with their OWN raw P&L, brokerage, and net total, split
 * into who profited and who lost.
 *
 * Deliberately simple, on purpose (per explicit instruction): NO cascade,
 * NO pnl_sharing/brokerage_sharing weighting, NO house-perspective sign
 * flip. Every row is that account's own real trading result, as-is. This
 * replaces a previously-unimplemented stub (getSettlementReport used to
 * just return `data: null`), so there's no existing behavior being changed
 * — a new, self-contained module, not touching weeklyAdminController.js or
 * accountSummaryController.js.
 *
 * EXTENDED: each row also carries the CALLER's own post-cut share —
 * caller_pnl / caller_brokerage / caller_total — what the caller themselves
 * actually nets from that row's whole subtree, after their own parent's
 * cut has already been applied. Reuses the exact same cascade functions
 * weeklyAdminController.js's Ledger & Payouts page uses
 * (_incomingPoolPnlMultiplierBatched, _computeCallerBrkForUserBatched) —
 * same verified multi-layer brokerage model, same P&L cascade — rather
 * than a second, independent implementation that could drift from it.
 */

const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const KiteInstrument = require('../models/KiteInstrument');
const BrokerageSettings = require('../models/BrokerageSettings');
const SettlementHistory = require('../models/SettlementHistory');
const {
  _incomingPoolPnlMultiplierBatched,
  _computeCallerBrkForUserBatched,
} = require('../controllers/weeklyAdminController')._private;

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * A single user's own raw realised P&L + brokerage for a date range.
 *
 * Queries SettlementHistory (immutable ledger) AND live Trade unconditionally
 * and sums both, rather than picking one source via a coarse "is this range
 * in the past" check. A trade is captured by exactly one of the two sources
 * at any moment — settlement soft-deletes the source Trade the instant it
 * snapshots it into SettlementHistory — so summing both is always safe and
 * never double-counts.
 *
 * The previous isPastPeriod check (comparing `to` against the current
 * settlement week's Monday) broke as soon as a period's settlement actually
 * ran: requesting "this week" right after this week's own settlement
 * completed still has `to` past that boundary, so it took the live-Trade
 * branch — but settlement had already swept every real trade for that week
 * into SettlementHistory, leaving the live query with nothing (deleted_at:
 * null matches none of them). Confirmed against a real report: this week's
 * real total (-1,63,318.50) went missing entirely, and "With Opening"
 * showed only the PRIOR settled period's total instead.
 */
async function getUserPnlAndBrokerage(userId, from, to) {
  const settledRows = await SettlementHistory.find({
    user_id: userId,
    period_from: { $lte: to },
    period_to: { $gte: from },
  }).select('total_pnl brokerage').lean();
  let pnl = 0, brokerage = 0;
  for (const r of settledRows) {
    pnl += r.total_pnl || 0;
    brokerage += r.brokerage || 0;
  }

  const trades = await Trade.find({
    user_id: userId,
    status: 'completed',
    deleted_at: null,
    trade_type: { $ne: 'carry_forward' },
    executed_at: { $gte: from, $lte: to },
  }).select('pnl brokerage').lean();
  for (const t of trades) {
    pnl += t.pnl || 0;
    brokerage += t.brokerage || 0;
  }
  return { pnl, brokerage };
}

/** Cumulative total from every settled period strictly before `from` — the "opening" balance. */
async function getUserOpeningPnlAndBrokerage(userId, from) {
  const rows = await SettlementHistory.find({
    user_id: userId,
    period_to: { $lt: from },
  }).select('total_pnl brokerage').lean();
  let pnl = 0, brokerage = 0;
  for (const r of rows) {
    pnl += r.total_pnl || 0;
    brokerage += r.brokerage || 0;
  }
  return { pnl, brokerage };
}

/**
 * A single user's own trades for a date range, shaped exactly like the raw
 * `Trade` rows the multi-layer brokerage cascade already expects
 * (instrument_token, executed_price, executed_quantity) — needed for the
 * CALLER's brokerage-share columns, which (unlike the plain pnl/brokerage
 * sum above) has to resolve a per-instrument rate, not just add up a
 * number. Combines the same two sources as getUserPnlAndBrokerage: live
 * Trade for anything not yet settled, plus SettlementHistory's own
 * immutable `fills[]` (one entry per original fill, preserved verbatim at
 * settlement time) for anything already swept into the settled ledger —
 * together they cover the whole range with no gap and no double-count,
 * same non-overlap guarantee as the plain sum.
 */
async function getUserTradesForCascade(userId, from, to) {
  const trades = await Trade.find({
    user_id: userId,
    status: 'completed',
    deleted_at: null,
    trade_type: { $ne: 'carry_forward' },
    executed_at: { $gte: from, $lte: to },
  }).select('instrument_token executed_price executed_quantity').lean();

  const settledRows = await SettlementHistory.find({
    user_id: userId,
    period_from: { $lte: to },
    period_to: { $gte: from },
  }).select('instrument_token fills').lean();

  const fromSettled = [];
  for (const row of settledRows) {
    for (const fill of row.fills || []) {
      fromSettled.push({
        instrument_token: row.instrument_token,
        executed_price: fill.executed_price,
        executed_quantity: fill.executed_quantity,
      });
    }
  }

  return [...trades, ...fromSettled];
}

/** Every user under a master's FULL subtree (all descendant masters, any depth) — for a sub-master row's own aggregate. */
async function getAllUsersUnderMaster(masterId, allMasters) {
  const childrenOf = {};
  for (const m of allMasters) {
    const mid = m._id.toString();
    if (!childrenOf[mid]) childrenOf[mid] = [];
    if (m.master_id) {
      const pid = m.master_id.toString();
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(mid);
    }
  }
  const subtreeIds = [];
  const seen = new Set();
  const queue = [masterId.toString()];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    subtreeIds.push(cur);
    for (const child of childrenOf[cur] || []) queue.push(child);
  }
  return User.find({ master_id: { $in: subtreeIds }, deleted_at: null }).select('_id master_id').lean();
}

/**
 * One row's own {pnl, brokerage, total} for the range (+ opening if
 * requested), PLUS the caller's own post-cut share of that same range
 * (never includes opening — the caller-share columns are always scoped to
 * the report's own date range, matching what the caller actually earned
 * IN that period). `identity` carries both `name` and `username`
 * separately — previously this collapsed them into one field via
 * `username || name`, so the report could only ever show a bare username,
 * never the friendly name alongside it, even though every call site
 * already had both fields on hand from its own query.
 *
 * `users` (not just userIds) is needed now — each underlying user's own
 * `master_id` (their DIRECT parent) is what the brokerage/P&L cascades
 * walk from, same as weeklyAdminController.js's per-user loop.
 */
async function buildRow(identity, users, from, to, withOpening, cascadeCtx) {
  let pnl = 0, brokerage = 0;
  let callerPnl = 0, callerBrk = 0;

  for (const u of users) {
    const uid = u._id.toString();
    const range = await getUserPnlAndBrokerage(uid, from, to);
    pnl += range.pnl;
    brokerage += range.brokerage;
    if (withOpening) {
      const opening = await getUserOpeningPnlAndBrokerage(uid, from);
      pnl += opening.pnl;
      brokerage += opening.brokerage;
    }

    if (cascadeCtx) {
      const { callerId, callerRole, masterMap, kiteMap, brkRulesByUser, globalBrkRules } = cascadeCtx;

      // P&L side: same math as weeklyAdminController.js's
      // _getAggregatedEntryBatched — the pool arriving at the caller
      // (every intermediate master's own % already absorbed), then the
      // caller's own % on top. Admin has no pnl_sharing of their own and
      // nothing further upstream — whatever isn't claimed by a master
      // below reaches admin in full.
      const incomingPool = _incomingPoolPnlMultiplierBatched(uid, callerId, u, masterMap);
      const callerOwnPnlShare = masterMap[callerId]?.pnl_sharing || 0;
      const callerRetention = callerRole === 'admin' ? 1 : callerOwnPnlShare / 100;
      callerPnl += (-range.pnl) * incomingPool * callerRetention;

      // Brokerage side: the verified multi-layer cascade — needs this
      // user's own raw trades (per-instrument), not the plain sum above.
      const userTrades = await getUserTradesForCascade(uid, from, to);
      if (userTrades.length > 0) {
        const tradesByUser = { [uid]: userTrades };
        const { callerBrk: thisCallerBrk } = _computeCallerBrkForUserBatched(
          uid, callerId, callerRole, tradesByUser, [], kiteMap,
          masterMap, brkRulesByUser, globalBrkRules, u, range.brokerage,
        );
        callerBrk += thisCallerBrk;
      }
    }
  }

  const row = {
    id: identity.id,
    name: identity.name || identity.username || '',
    username: identity.username || '',
    pnl: r2(pnl),
    brokerage: r2(brokerage),
    total: r2(pnl - brokerage),
  };
  if (cascadeCtx) {
    row.caller_pnl = r2(callerPnl);
    row.caller_brokerage = r2(callerBrk);
    row.caller_total = r2(callerPnl + callerBrk);
  }
  return row;
}

/**
 * Build the settlement report: every direct child (user + sub-master) under
 * `targetType`/`targetDoc`, each with their own raw P&L/brokerage/total,
 * split into profit (total >= 0) and loss (total < 0).
 *
 * @param {'User'|'Master'|'Admin'} targetType
 * @param {object|null} targetDoc - the target's own doc (null for Admin viewing top-level masters)
 * @param {Date} from
 * @param {Date} to
 * @param {boolean} withOpening
 * @param {Set<string>|null} hiddenMasterIds - per-admin master-visibility
 *   restriction (already expanded to include hidden masters' full
 *   subtrees); only meaningful when targetType === 'Admin'.
 * @param {string} [callerId] - the actual caller (whoever is viewing the
 *   report) — when provided (with callerRole), every row also carries
 *   that caller's own post-cut share. Omitted entirely when either is
 *   missing, matching every other call site's existing behaviour.
 * @param {'admin'|'master'} [callerRole]
 */
async function buildSettlementReport(targetType, targetDoc, from, to, withOpening, hiddenMasterIds = null, callerId = null, callerRole = null) {
  const rows = [];

  const allMasters = await Master.find({ deleted_at: null }).select('_id master_id name username pnl_sharing brokerage_sharing').lean();

  let cascadeCtx = null;
  if (callerId && callerRole) {
    const masterMap = {};
    for (const m of allMasters) masterMap[m._id.toString()] = m;

    // Instruments + brokerage rules aren't scoped to any particular date
    // range or user set up front (unlike weeklyAdminController.js's
    // batch-load, which already knows every token/user involved) — this
    // report can touch any instrument any row traded, so load the full
    // rule/instrument tables once per request rather than per row.
    const [allBrkSettings, allInstruments] = await Promise.all([
      BrokerageSettings.find({ deleted_at: null }).lean(),
      KiteInstrument.find({}, 'instrument_token lot_size segment raw_name').lean(),
    ]);
    const brkRulesByUser = {};
    const globalBrkRules = [];
    for (const r of allBrkSettings) {
      if (!r.user_id) { globalBrkRules.push(r); continue; }
      const uid = r.user_id.toString();
      if (!brkRulesByUser[uid]) brkRulesByUser[uid] = [];
      brkRulesByUser[uid].push(r);
    }
    const kiteMap = {};
    for (const ki of allInstruments) kiteMap[ki.instrument_token] = ki;

    cascadeCtx = { callerId, callerRole, masterMap, kiteMap, brkRulesByUser, globalBrkRules };
  }

  if (targetType === 'User') {
    // A leaf user has no children — the row IS just their own result.
    const row = await buildRow(
      { id: targetDoc._id.toString(), name: targetDoc.name, username: targetDoc.username },
      [targetDoc],
      from, to, withOpening, cascadeCtx,
    );
    rows.push(row);
  } else {
    let directUsers, directSubMasters;
    if (targetType === 'Admin') {
      directUsers = [];
      directSubMasters = allMasters.filter((m) => !m.master_id && !(hiddenMasterIds && hiddenMasterIds.has(m._id.toString())));
    } else {
      directUsers = await User.find({ master_id: targetDoc._id, deleted_at: null }).select('_id name username master_id').lean();
      directSubMasters = allMasters.filter((m) => m.master_id && m.master_id.toString() === targetDoc._id.toString());
    }

    for (const u of directUsers) {
      rows.push(await buildRow(
        { id: u._id.toString(), name: u.name, username: u.username },
        [u], from, to, withOpening, cascadeCtx,
      ));
    }
    for (const m of directSubMasters) {
      const users = await getAllUsersUnderMaster(m._id, allMasters);
      rows.push(await buildRow(
        { id: m._id.toString(), name: m.name, username: m.username },
        users, from, to, withOpening, cascadeCtx,
      ));
    }
  }

  const profit = rows.filter((r) => r.total >= 0);
  const loss = rows.filter((r) => r.total < 0);
  const totalPnl = r2(rows.reduce((s, r) => s + r.total, 0));

  return {
    target: targetDoc
      ? { id: targetDoc._id.toString(), name: targetDoc.name || targetDoc.username || '', username: targetDoc.username || '', type: targetType }
      : { id: null, name: 'Admin', username: '', type: 'Admin' },
    range: { from: from.toISOString(), to: to.toISOString() },
    with_opening: !!withOpening,
    total_pnl: totalPnl,
    profit,
    loss,
  };
}

module.exports = { buildSettlementReport };
