const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * GET /api/master/weekly-admin-report
 *
 * Multi-tier hierarchy report using per-instrument brokerage cascade
 * and P&L sharing per the spec (Sections 2.2 and 2.3).
 *
 * Admin view: shows top-level masters with aggregated sub-hierarchy data.
 * Master view: shows direct child masters (aggregated) + direct child users.
 */
const getWeeklyAdminReport = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const metricsEngine = require('../services/metricsEngine');

    const data = [];

    if (role === 'admin') {
      const topMasters = await Master.find({ master_id: null, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing').lean();

      for (const master of topMasters) {
        const entry = await _getAggregatedEntry(master._id.toString(), master, metricsEngine, callerId, 'admin');
        entry.parent_username = 'ADMIN';
        entry.type = 'master';
        data.push(entry);
      }
    } else {
      const callerMaster = await Master.findById(callerId)
        .select('username pnl_sharing brokerage_sharing').lean();

      const childMasters = await Master.find({ master_id: callerId, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing').lean();

      for (const cm of childMasters) {
        const entry = await _getAggregatedEntry(cm._id.toString(), cm, metricsEngine, callerId, 'master');
        entry.parent_username = callerMaster?.username || '';
        entry.type = 'master';
        data.push(entry);
      }

      const directUsers = await User.find({ master_id: callerId, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing master_id').lean();

      for (const u of directUsers) {
        const entry = await _getUserEntry(u, metricsEngine, callerMaster, callerId, 'master');
        data.push(entry);
      }
    }

    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    console.error('[WeeklyAdminReport] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Report entry for a single user.
 */
async function _getUserEntry(userDoc, metricsEngine, callerMaster, callerId, callerRole) {
  const metrics = await metricsEngine.getFreshMetrics(userDoc._id.toString());
  const floatingPnl = metrics?.position_pnl || 0;
  const grossPnl = await _getGrossPnl(userDoc._id);
  const { brokerage: totalBrokerage, turnover, lots } = await _getUserBrokerageAndTurnover(userDoc._id);

  // Caller's brokerage share (per-instrument cascade)
  const callerBrk = await _computeCallerBrkForUser(userDoc._id, callerId, callerRole);

  // P&L sharing: caller's share = product of unpassed fractions from user up to caller
  const pnlMultiplier = await _getPnlUnpassedMultiplierForUser(userDoc._id, callerId);
  const callerProfit = _r2((-grossPnl) * pnlMultiplier);

  return {
    id: userDoc._id.toString(),
    name: userDoc.name,
    username: userDoc.username,
    parent_username: callerMaster?.username || '',
    type: 'user',
    realised_pnl: _r2(grossPnl),
    m2m_pnl: _r2(floatingPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(turnover),
    caller_brk: _r2(callerBrk),
    total_pnl: _r2(-grossPnl),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
  };
}

/**
 * Aggregated report entry for a master and their entire sub-hierarchy.
 */
async function _getAggregatedEntry(masterId, masterDoc, metricsEngine, callerId, callerRole) {
  const { getAllSubMasterIds } = require('../services/masterHierarchyService');
  const allMasterIds = await getAllSubMasterIds(masterId);

  const users = await User.find({ master_id: { $in: allMasterIds }, deleted_at: null })
    .select('_id master_id').lean();

  let totalGrossPnl = 0;
  let totalFloatingPnl = 0;
  for (const u of users) {
    const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
    totalFloatingPnl += metrics?.position_pnl || 0;
    totalGrossPnl += await _getGrossPnl(u._id);
  }

  let totalBrokerage = 0, totalTurnover = 0;
  for (const u of users) {
    const { brokerage, turnover } = await _getUserBrokerageAndTurnover(u._id);
    totalBrokerage += brokerage;
    totalTurnover += turnover;
  }

  // Caller's brokerage share across all users in this master's hierarchy
  let callerBrk = 0;
  for (const u of users) {
    callerBrk += await _computeCallerBrkForUser(u._id, callerId, callerRole);
  }

  // P&L sharing: walk the tree tier-by-tier
  // Admin viewing betest (90% sharing): admin gets what flows past ALL tiers
  // The correct formula: admin gets (100% - masterDoc.pnl_sharing%) × grossPnl
  // BUT this only works for 2-tier (admin → master → users).
  // For 3+ tiers (admin → main → sub → user), we need the sequential cascade:
  //   sub keeps 80%, passes 20% up
  //   main keeps 90% of that 20%, passes 10% of that 20% up to admin
  //   admin gets: grossPnl × (100-subSharing)/100 × (100-mainSharing)/100
  //
  // When admin views a top-level master (betest), the master's pnl_sharing represents
  // what % the ENTIRE subtree below retains. Admin gets (100 - that%).
  // But the subtree has multiple layers — the correct admin share is:
  //   grossPnl × (1 - subSharing) × (1 - mainSharing) ... for each layer
  //
  // For the simplified 2-layer case (admin sees one master):
  //   adminPnlShare = grossPnl × (100 - masterDoc.pnl_sharing) / 100
  //
  // This IS correct when admin views a top-level master, because masterDoc.pnl_sharing
  // represents what that master and everything below keeps. Admin gets the remainder.
  //
  // For a master viewing their child sub-master: same logic applies.
  const callerPnlKeep = await _getPnlUnpassedMultiplier(masterId, callerId);
  const callerProfit = _r2((-totalGrossPnl) * callerPnlKeep);

  return {
    id: masterId,
    name: masterDoc.name,
    username: masterDoc.username,
    realised_pnl: _r2(totalGrossPnl),
    m2m_pnl: _r2(totalFloatingPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(totalTurnover),
    caller_brk: _r2(callerBrk),
    total_pnl: _r2(-totalGrossPnl),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
  };
}

/**
 * Compute caller's brokerage share for a single user using per-instrument cascade.
 *
 * Per spec Section 2.2 Step 3:
 * Admin BRK = Admin Base Clearance (adminRate × turnover/lots per instrument)
 *           + Unpassed from the hierarchy above admin's base
 *
 * The "unpassed" that reaches the caller is computed as:
 *   (userBrokerage - callerBaseClearance) × product of (1 - sharing%) at each intermediate tier
 *
 * For admin viewing through betest (90% sharing) with subtest (80% sharing) below:
 *   spreadAboveCaller = userBrk - callerBase
 *   sub keeps 80% of their gross margin, passes 20%
 *   main keeps 90% of (their direct margin + passed from sub), passes 10%
 *   admin gets: callerBase + the 10% that flows past main
 *
 * Simplified: callerBase + (spreadAboveCaller × (1-0.80) × (1-0.90))
 *           = callerBase + spread × 0.20 × 0.10
 *           = callerBase + spread × 0.02
 */
async function _computeCallerBrkForUser(userId, callerId, callerRole) {
  const trades = await Trade.find({
    user_id: userId, status: 'completed', deleted_at: null
  }).select('instrument_token executed_price executed_quantity').lean();

  if (trades.length === 0) return 0;

  // Caller's brokerage rules (admin = global/null, master = their own)
  const callerRuleOwnerId = callerRole === 'admin' ? null : callerId;
  let callerRules = await BrokerageSettings.find({ user_id: callerRuleOwnerId, deleted_at: null }).lean();
  if (callerRules.length === 0 && callerRuleOwnerId !== null) {
    callerRules = await BrokerageSettings.find({ user_id: null, deleted_at: null }).lean();
  }

  // Instrument info
  const allTokens = [...new Set(trades.map(t => t.instrument_token))];
  const kiteInstruments = await KiteInstrument.find(
    { instrument_token: { $in: allTokens } }, 'instrument_token lot_size segment raw_name'
  ).lean();
  const kiteMap = {};
  kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

  // Group trades by instrument
  const byInstrument = {};
  for (const t of trades) {
    const token = t.instrument_token;
    if (!byInstrument[token]) byInstrument[token] = { turnover: 0, lots: 0 };
    const ki = kiteMap[token];
    const lotSize = ki?.lot_size || 1;
    byInstrument[token].turnover += t.executed_price * t.executed_quantity;
    byInstrument[token].lots += lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;
  }

  // Compute caller's base clearance per instrument
  let callerBaseClearance = 0;
  for (const [token, data] of Object.entries(byInstrument)) {
    const ki = kiteMap[token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';

    let callerRule = _findRule(callerRules, rawName, seg);
    if (!callerRule) continue;

    if (callerRule.type === 'TURNOVER WISE') {
      callerBaseClearance += data.turnover * (callerRule.brk_value / 10000);
    } else if (callerRule.type === 'LOT WISE') {
      callerBaseClearance += data.lots * callerRule.brk_value;
    }
  }

  // Compute the unpassed share that flows up to the caller.
  // For BROKERAGE (different from P&L): Admin gets their base clearance
  // + (100 - immediateChildMaster.brokerage_sharing)% of the spread above base.
  // The "spread" = totalUserBrk - adminBase. Main keeps mainSharing%, passes (100-mainSharing)% to admin.
  // We only look at the IMMEDIATE child master's sharing (not full tree product).
  
  // Find the immediate child master of the caller (the top-level master in this branch)
  const user = await User.findById(userId).select('master_id').lean();
  let immediateChildSharing = 0;
  if (user?.master_id) {
    let masterId = user.master_id.toString();
    const maxWalk = 10;
    let walk = 0;
    while (masterId && walk < maxWalk) {
      const m = await Master.findById(masterId).select('master_id brokerage_sharing').lean();
      if (!m) break;
      // If this master's parent is null (admin is caller) or equals callerId, this is the immediate child
      if (!m.master_id || m.master_id.toString() === callerId) {
        immediateChildSharing = m.brokerage_sharing || 0;
        break;
      }
      masterId = m.master_id.toString();
      walk++;
    }
  }

  // Total brokerage billed to user
  const { brokerage: userTotalBrk } = await _getUserBrokerageAndTurnover(userId);

  // Spread above caller's base = what's left after caller takes their base
  const spreadAboveCaller = Math.max(0, userTotalBrk - callerBaseClearance);

  // Admin gets (100 - immediateChildSharing)% of the spread
  const unpassedPct = (100 - immediateChildSharing) / 100;
  const unpassedAmount = spreadAboveCaller * unpassedPct;

  return callerBaseClearance + unpassedAmount;
}

/**
 * Walk from user up to caller, computing the product of (1 - brokerage_sharing/100)
 * at each intermediate master tier. This gives the fraction of the spread
 * that flows past all intermediate tiers to reach the caller.
 *
 * Example: user → subtest (80%) → betest (90%) → admin
 * If caller is admin: multiplier = (1 - 0.80) × (1 - 0.90) = 0.20 × 0.10 = 0.02
 * Meaning admin gets 2% of the spread above their base as "unpassed".
 */
async function _getUnpassedMultiplier(userId, callerId) {
  const user = await User.findById(userId).select('master_id').lean();
  if (!user?.master_id) return 0;

  let multiplier = 1;
  let currentMasterId = user.master_id.toString();

  // Walk up the tree until we reach the caller (or run out of parents)
  const maxDepth = 10; // safety limit
  let depth = 0;
  while (currentMasterId && currentMasterId !== callerId && depth < maxDepth) {
    const master = await Master.findById(currentMasterId)
      .select('master_id brokerage_sharing').lean();
    if (!master) break;

    // At each tier, multiply by (1 - sharing/100) = fraction passed upward
    const sharing = master.brokerage_sharing || 0;
    multiplier *= (100 - sharing) / 100;

    currentMasterId = master.master_id?.toString() || null;
    depth++;
  }

  return multiplier;
}

/**
 * Walk from a master down through its sub-tree to compute the P&L unpassed multiplier.
 * For admin viewing mainmaster (90%) with submaster (80%) below:
 *   multiplier = (1 - 80/100) × (1 - 90/100) = 0.20 × 0.10 = 0.02
 *
 * We walk from the DEEPEST sub-master up to the target master, collecting
 * (1 - pnl_sharing/100) at each tier INCLUDING the target master itself.
 */
async function _getPnlUnpassedMultiplier(masterId, callerId) {
  // Get all masters in the subtree
  const { getAllSubMasterIds } = require('../services/masterHierarchyService');
  
  // Walk from target master up to caller, collecting (1 - pnl_sharing%)
  // But we need to go DOWN from the master through all layers to the users,
  // and compute what fraction flows past ALL tiers to reach the caller.
  //
  // Actually: the caller is ABOVE the master. The P&L flows UP from users:
  //   Users → sub-master (keeps 80%, passes 20%) → main-master (keeps 90% of 20%, passes 10% of 20%) → admin
  //
  // For admin viewing mainmaster: admin gets what passes through ALL tiers below mainmaster + mainmaster itself.
  // multiplier = product of (1 - sharing%) for mainmaster AND all sub-masters below it.
  
  let multiplier = 1;
  
  // First: mainmaster's own unpassed fraction (what flows past mainmaster to admin)
  const targetMaster = await Master.findById(masterId).select('pnl_sharing').lean();
  if (targetMaster) {
    multiplier *= (100 - (targetMaster.pnl_sharing || 0)) / 100;
  }
  
  // Then: any sub-masters below also retain their share before passing up
  const subMasters = await Master.find({ master_id: masterId, deleted_at: null }).select('pnl_sharing').lean();
  for (const sub of subMasters) {
    // Each sub-master retains their share, reducing what reaches the top
    // The sub passes (1 - subSharing%) to main, then main passes (1 - mainSharing%) to admin
    // But we already accounted for main above. The sub's retention means
    // less total reaches main in the first place.
    // Correct: multiply by (1 - subSharing%) as well
    multiplier *= (100 - (sub.pnl_sharing || 0)) / 100;
  }
  
  return multiplier;
}

/**
 * For a direct user: compute what fraction of their P&L flows up to the caller.
 * Walk from user's immediate master up to caller, multiplying (1 - pnl_sharing%) at each tier.
 */
async function _getPnlUnpassedMultiplierForUser(userId, callerId) {
  const user = await User.findById(userId).select('master_id').lean();
  if (!user?.master_id) return 0;
  
  let multiplier = 1;
  let currentMasterId = user.master_id.toString();
  
  const maxDepth = 10;
  let depth = 0;
  while (currentMasterId && depth < maxDepth) {
    const master = await Master.findById(currentMasterId).select('master_id pnl_sharing').lean();
    if (!master) break;
    
    multiplier *= (100 - (master.pnl_sharing || 0)) / 100;
    
    // If this master's parent is the caller (or null for admin), stop
    if (!master.master_id || master.master_id.toString() === callerId) break;
    currentMasterId = master.master_id.toString();
    depth++;
  }
  
  return multiplier;
}

/**
 * Find a brokerage rule using 4-level matching.
 */
function _findRule(rules, rawName, seg) {
  let rule = null;
  if (rawName && seg) rule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
  if (!rule && rawName) rule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
  if (!rule && seg) rule = rules.find(r => r.exchange_name === seg.toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
  if (!rule) rule = rules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
  return rule;
}

/**
 * Gross realised P&L (sum of trade.pnl — before brokerage deduction).
 */
async function _getGrossPnl(userId) {
  const result = await Trade.aggregate([
    { $match: { user_id: userId, status: 'completed', deleted_at: null } },
    { $group: { _id: null, totalPnl: { $sum: '$pnl' } } }
  ]);
  return result.length > 0 ? (result[0].totalPnl || 0) : 0;
}

/**
 * User's total brokerage, turnover, and lots from current trades.
 */
async function _getUserBrokerageAndTurnover(userId) {
  const trades = await Trade.find({
    user_id: userId, status: 'completed', deleted_at: null
  }).select('instrument_token executed_price executed_quantity').lean();

  if (trades.length === 0) return { brokerage: 0, turnover: 0, lots: 0 };

  let brkRules = await BrokerageSettings.find({ user_id: userId, deleted_at: null }).lean();
  if (brkRules.length === 0) brkRules = await BrokerageSettings.find({ user_id: null, deleted_at: null }).lean();

  const allTokens = [...new Set(trades.map(t => t.instrument_token))];
  const kiteInstruments = await KiteInstrument.find(
    { instrument_token: { $in: allTokens } }, 'instrument_token lot_size segment raw_name'
  ).lean();
  const kiteMap = {};
  kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

  let totalBrk = 0, totalTurnover = 0, totalLots = 0;
  for (const t of trades) {
    const ki = kiteMap[t.instrument_token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;
    const tradeTurnover = t.executed_price * t.executed_quantity;
    const tradeLots = lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;

    totalTurnover += tradeTurnover;
    totalLots += tradeLots;

    const brkRule = _findRule(brkRules, rawName, seg);
    if (brkRule) {
      if (brkRule.type === 'TURNOVER WISE') {
        totalBrk += tradeTurnover * (brkRule.brk_value / 10000);
      } else if (brkRule.type === 'LOT WISE') {
        totalBrk += tradeLots * brkRule.brk_value;
      }
    }
  }

  return { brokerage: totalBrk, turnover: totalTurnover, lots: totalLots };
}

function _sumTotals(data) {
  return {
    realised_pnl: _r2(data.reduce((s, d) => s + d.realised_pnl, 0)),
    m2m_pnl: _r2(data.reduce((s, d) => s + d.m2m_pnl, 0)),
    brokerage: _r2(data.reduce((s, d) => s + d.brokerage, 0)),
    turnover: _r2(data.reduce((s, d) => s + (d.turnover || 0), 0)),
    caller_brk: _r2(data.reduce((s, d) => s + (d.caller_brk || 0), 0)),
    total_pnl: _r2(data.reduce((s, d) => s + d.total_pnl, 0)),
    caller_profit: _r2(data.reduce((s, d) => s + (d.caller_profit || 0), 0)),
    total_caller: _r2(data.reduce((s, d) => s + (d.total_caller || 0), 0)),
  };
}

const _r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getWeeklyAdminReport };
