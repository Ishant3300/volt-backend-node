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
 */

const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const SettlementHistory = require('../models/SettlementHistory');

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
  return User.find({ master_id: { $in: subtreeIds }, deleted_at: null }).select('_id').lean();
}

/**
 * One row's own {pnl, brokerage, total} for the range (+ opening if
 * requested). `identity` carries both `name` and `username` separately —
 * previously this collapsed them into one field via `username || name`,
 * so the report could only ever show a bare username, never the friendly
 * name alongside it, even though every call site already had both fields
 * on hand from its own query.
 */
async function buildRow(identity, userIds, from, to, withOpening) {
  let pnl = 0, brokerage = 0;
  for (const uid of userIds) {
    const range = await getUserPnlAndBrokerage(uid, from, to);
    pnl += range.pnl;
    brokerage += range.brokerage;
    if (withOpening) {
      const opening = await getUserOpeningPnlAndBrokerage(uid, from);
      pnl += opening.pnl;
      brokerage += opening.brokerage;
    }
  }
  return {
    id: identity.id,
    name: identity.name || identity.username || '',
    username: identity.username || '',
    pnl: r2(pnl),
    brokerage: r2(brokerage),
    total: r2(pnl - brokerage),
  };
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
 */
async function buildSettlementReport(targetType, targetDoc, from, to, withOpening, hiddenMasterIds = null) {
  const rows = [];

  if (targetType === 'User') {
    // A leaf user has no children — the row IS just their own result.
    const row = await buildRow(
      { id: targetDoc._id.toString(), name: targetDoc.name, username: targetDoc.username },
      [targetDoc._id],
      from, to, withOpening,
    );
    rows.push(row);
  } else {
    const allMasters = await Master.find({ deleted_at: null }).select('_id master_id name username').lean();

    let directUsers, directSubMasters;
    if (targetType === 'Admin') {
      directUsers = [];
      directSubMasters = allMasters.filter((m) => !m.master_id && !(hiddenMasterIds && hiddenMasterIds.has(m._id.toString())));
    } else {
      directUsers = await User.find({ master_id: targetDoc._id, deleted_at: null }).select('_id name username').lean();
      directSubMasters = allMasters.filter((m) => m.master_id && m.master_id.toString() === targetDoc._id.toString());
    }

    for (const u of directUsers) {
      rows.push(await buildRow(
        { id: u._id.toString(), name: u.name, username: u.username },
        [u._id], from, to, withOpening,
      ));
    }
    for (const m of directSubMasters) {
      const userIds = (await getAllUsersUnderMaster(m._id, allMasters)).map((u) => u._id);
      rows.push(await buildRow(
        { id: m._id.toString(), name: m.name, username: m.username },
        userIds, from, to, withOpening,
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
