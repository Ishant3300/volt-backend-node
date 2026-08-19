'use strict';

/**
 * Hierarchy Settlement Calculation Service
 *
 * Pure math functions for computing multi-tier brokerage revenue splits
 * and P&L sharing. These produce REPORT data only — no wallet/balance
 * modifications are made.
 *
 * NOT CURRENTLY CALLED ANYWHERE IN THIS CODEBASE — confirmed via a
 * repo-wide search (no imports of this module exist). Kept and fixed
 * rather than deleted since it may be intended for future use; the
 * original version was hardcoded to exactly 3 tiers (client -> sub-master
 * -> main-master -> admin) via resolveHierarchyRates() only ever walking
 * two Master lookups, silently producing wrong numbers for any hierarchy
 * deeper than that (which this system does support elsewhere — see
 * weeklyAdminController.js's _getAllSubMasterIdsBatched). Generalized to
 * an arbitrary number of tiers below.
 *
 * Spec reference:
 * - Logic A: Brokerage Cascade Breakdown
 * - Logic B: Trading P&L Cascade Breakdown
 */

const BrokerageSettings = require('../models/BrokerageSettings');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Compute the multi-tier brokerage revenue split for a given turnover/lot
 * amount, across an ARBITRARY number of hierarchy levels — not hardcoded
 * to exactly sub-master + main-master.
 *
 * Derivation note: in the original 2-tier formula, the sub-master's own
 * configured rate was never actually used — only the TOP-level tier's rate
 * (the one whose own parent is admin) and admin's rate served as real
 * "boundary" markers. Everything below the top tier shares a single
 * combined pool (`clientRate - topTierRate`), cascading down from the tier
 * nearest the client, each keeping `sharing%` and passing the rest up —
 * the exact same cascade already used for P&L sharing. The top tier then
 * combines whatever was passed up to it with its OWN direct margin
 * (`topTierRate - adminRate`) before taking its own cut. Verified this
 * reduces to byte-identical output vs. the original 2-tier formula for a
 * 2-tier input (see git history / PR description for the reduction check).
 *
 * @param {object} params
 * @param {number} params.clientRate - What the client is actually billed
 * @param {number} params.adminRate - Admin's own base rate (global)
 * @param {Array<{id: string, rate: number, sharing: number}>} params.tiers -
 *   Every master between the client and admin, ordered NEAREST-TO-CLIENT
 *   FIRST (tiers[0] = the client's immediate master) and
 *   FURTHEST-FROM-CLIENT LAST (the top-level master, whose own parent is
 *   admin). `rate` is only meaningful for the LAST tier — see derivation
 *   note above; every other tier's own rate is unused, matching the
 *   original formula's behavior.
 * @param {string} params.brokerageType - 'TURNOVER WISE' or 'LOT WISE'
 * @param {number} [params.turnover]
 * @param {number} [params.lots]
 * @returns {object} { adminKeeps, adminBaseClearance, tierKeeps: [{id, keeps, passedUp}, ...] } — tierKeeps is in the same order as params.tiers
 */
function computeBrokerageSplit(params) {
  const {
    clientRate = 0,
    adminRate = 0,
    tiers = [],
    brokerageType = 'TURNOVER WISE',
    turnover = 0,
    lots = 0,
  } = params;

  const unit = brokerageType === 'LOT WISE' ? lots : turnover / 10000;
  const adminBaseClearance = Math.max(0, adminRate) * unit;

  if (tiers.length === 0) {
    return { adminKeeps: _r2(adminBaseClearance), adminBaseClearance: _r2(adminBaseClearance), tierKeeps: [] };
  }

  const topTier = tiers[tiers.length - 1];

  // Combined pool for every tier below the top one — clientRate down to the
  // top tier's rate, exactly as the original 2-tier grossMargin did.
  let remaining = Math.max(0, (clientRate - topTier.rate) * unit);
  const tierKeeps = [];
  for (let i = 0; i < tiers.length - 1; i++) {
    const keeps = remaining * ((tiers[i].sharing || 0) / 100);
    const passedUp = remaining - keeps;
    tierKeeps.push({ id: tiers[i].id, keeps: _r2(keeps), passedUp: _r2(passedUp) });
    remaining = passedUp;
  }

  // Top tier: its own direct margin above admin, PLUS whatever cascaded up
  // from every tier below it.
  const directMargin = Math.max(0, (topTier.rate - adminRate) * unit);
  const poolAtTop = directMargin + remaining;
  const topKeeps = poolAtTop * ((topTier.sharing || 0) / 100);
  const passedToAdmin = poolAtTop - topKeeps;
  tierKeeps.push({ id: topTier.id, keeps: _r2(topKeeps), passedUp: _r2(passedToAdmin) });

  const adminKeeps = adminBaseClearance + passedToAdmin;

  return {
    adminKeeps: _r2(adminKeeps),
    adminBaseClearance: _r2(adminBaseClearance),
    tierKeeps,
  };
}

/**
 * Compute multi-tier P&L sharing across an ARBITRARY number of hierarchy
 * levels. Client loss = hierarchy profit. Client profit = hierarchy
 * liability. The sharing percentages apply symmetrically in both
 * directions.
 *
 * Unlike brokerage, this already generalizes cleanly with no special
 * top-tier case — every tier's OWN sharing% applies to whatever pool
 * reaches them, cascading down to admin, who keeps whatever's left after
 * every tier has taken their cut.
 *
 * @param {object} params
 * @param {number} params.clientPnl - Client's P&L (negative = loss for client = profit for hierarchy)
 * @param {Array<{id: string, pnlSharing: number}>} params.tiers - same
 *   ordering as computeBrokerageSplit: nearest-to-client first.
 * @returns {object} { adminPnl, tierPnl: [{id, pnl}, ...], totalHierarchyPnl }
 */
function computePnlSplit(params) {
  const { clientPnl = 0, tiers = [] } = params;

  // Flip sign: client loss = platform profit.
  let pool = -clientPnl;
  const tierPnl = [];
  for (const tier of tiers) {
    const pnl = pool * ((tier.pnlSharing || 0) / 100);
    tierPnl.push({ id: tier.id, pnl: _r2(pnl) });
    pool = pool * (1 - (tier.pnlSharing || 0) / 100);
  }
  const adminPnl = _r2(pool);

  return {
    adminPnl,
    tierPnl,
    totalHierarchyPnl: _r2(tierPnl.reduce((s, t) => s + t.pnl, 0) + adminPnl),
  };
}

/**
 * Resolve the full hierarchy chain rates for a user — walks EVERY master
 * between the client and admin, not just two levels.
 *
 * @param {string} userId - The end client's user ID
 * @param {string} exchangeName - e.g. 'NFO-FUT'
 * @param {string} scriptName - e.g. 'NIFTY'
 * @param {string} brokerageType - 'TURNOVER WISE' or 'LOT WISE'
 * @returns {object|null} {
 *   clientRate, adminRate,
 *   tiers: [{ id, rate, sharing, pnlSharing }, ...] (nearest-to-client first, top-level master last)
 * }
 */
async function resolveHierarchyRates(userId, exchangeName, scriptName, brokerageType) {
  const user = await User.findById(userId).select('master_id').lean();
  if (!user) return null;

  // Helper to find rate for a given owner (null = global/admin).
  async function getRate(ownerId) {
    const filter = {
      user_id: ownerId,
      exchange_name: exchangeName.toUpperCase(),
      script_name: scriptName,
      type: brokerageType,
      deleted_at: null,
    };
    const rule = await BrokerageSettings.findOne(filter).lean();
    if (rule) return rule.brk_value;

    // Fallback: try exchange-only match (no script_name filter)
    const exchangeRule = await BrokerageSettings.findOne({
      user_id: ownerId,
      exchange_name: exchangeName.toUpperCase(),
      type: brokerageType,
      deleted_at: null,
    }).lean();
    return exchangeRule?.brk_value ?? 0;
  }

  const clientRate = await getRate(userId);
  const adminRate = await getRate(null);

  // Walk every master from the client's immediate master up to the
  // top-level master (master_id === null) — an arbitrary number of levels,
  // not hardcoded to exactly two. Guards against a circular master_id
  // reference the same way weeklyAdminController.js's per-user walks do
  // (bounded iteration count rather than trusting the data is acyclic).
  const tiers = [];
  let currentId = user.master_id ? user.master_id.toString() : null;
  const seen = new Set();
  const MAX_DEPTH = 25;
  while (currentId && !seen.has(currentId) && tiers.length < MAX_DEPTH) {
    seen.add(currentId);
    const master = await Master.findById(currentId).select('master_id pnl_sharing brokerage_sharing').lean();
    if (!master) break;

    tiers.push({
      id: currentId,
      rate: await getRate(currentId),
      sharing: master.brokerage_sharing ?? 0,
      pnlSharing: master.pnl_sharing ?? 0,
    });

    currentId = master.master_id ? master.master_id.toString() : null;
  }

  return { clientRate, adminRate, tiers };
}

function _r2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  computeBrokerageSplit,
  computePnlSplit,
  resolveHierarchyRates,
};
