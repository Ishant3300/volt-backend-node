const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const { computeBrokerageSplit, computePnlSplit, resolveHierarchyRates } = require('../services/hierarchySettlementCalcService');

/**
 * GET /api/master/weekly-admin-report
 *
 * Hierarchy logic:
 * - Admin: shows only top-level masters with aggregated sub-hierarchy data
 * - Master: shows direct child masters (aggregated) + direct child users
 *
 * Now includes multi-tier brokerage cascade and P&L sharing per the spec.
 */
const getWeeklyAdminReport = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const metricsEngine = require('../services/metricsEngine');
    const { getAllSubMasterIds } = require('../services/masterHierarchyService');

    const data = [];

    if (role === 'admin') {
      // Admin: show only top-level masters (master_id = null)
      const topMasters = await Master.find({ master_id: null, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing').lean();

      for (const master of topMasters) {
        const entry = await _getAggregatedEntry(master._id.toString(), master, metricsEngine, 100, 100);
        entry.parent_username = 'ADMIN';
        entry.type = 'master';
        data.push(entry);
      }
    } else {
      // Master: show direct child masters + direct child users
      const callerMaster = await Master.findById(callerId)
        .select('username pnl_sharing brokerage_sharing').lean();

      // 1. Direct child masters (aggregated)
      const childMasters = await Master.find({ master_id: callerId, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing').lean();

      for (const cm of childMasters) {
        const callerPnlShare = callerMaster?.pnl_sharing || 0;
        const callerBrkShare = callerMaster?.brokerage_sharing || 0;
        const entry = await _getAggregatedEntry(cm._id.toString(), cm, metricsEngine, callerPnlShare, callerBrkShare);
        entry.parent_username = callerMaster?.username || '';
        entry.type = 'master';
        data.push(entry);
      }

      // 2. Direct child users
      const directUsers = await User.find({ master_id: callerId, deleted_at: null })
        .select('_id name username pnl_sharing brokerage_sharing').lean();

      for (const u of directUsers) {
        const entry = await _getUserEntry(u, metricsEngine, callerMaster);
        data.push(entry);
      }
    }

    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get report entry for a single user — computes brokerage split and P&L sharing.
 */
async function _getUserEntry(userDoc, metricsEngine, callerMaster) {
  const metrics = await metricsEngine.getFreshMetrics(userDoc._id.toString());
  const realised = metrics ? metrics.realised_pnl : 0;
  const position = metrics ? metrics.position_pnl : 0;
  const m2mPnl = realised + position;

  // Compute user's total brokerage and turnover
  const { brokerage, turnover, lots } = await _getUserBrokerageAndTurnover(userDoc._id);

  // Get hierarchy sharing percentages
  const subMasterPnlShare = callerMaster?.pnl_sharing || 0;
  const subMasterBrkShare = callerMaster?.brokerage_sharing || 0;

  // P&L split: caller is the immediate master, so they are the "sub-master" level
  const pnlSplit = computePnlSplit({
    clientPnl: m2mPnl,
    subMasterSharing: subMasterPnlShare,
    mainMasterSharing: 0, // Caller IS the immediate master; no further up for this view
  });

  // For the caller (immediate master), their P&L share is subMasterPnl
  const callerPnlShare = pnlSplit.subMasterPnl;

  // Brokerage split: caller's share = their brokerage_sharing% of the spread
  const callerBrkShare = brokerage * (subMasterBrkShare / 100);

  return {
    id: userDoc._id.toString(),
    name: userDoc.name,
    username: userDoc.username,
    parent_username: callerMaster?.username || '',
    type: 'user',
    realised_pnl: _r2(realised),
    m2m_pnl: _r2(m2mPnl),
    brokerage: _r2(brokerage),
    turnover: _r2(turnover),
    caller_brk: _r2(callerBrkShare),
    total_pnl: _r2(-m2mPnl),
    caller_profit: _r2(callerPnlShare),
    total_caller: _r2(callerPnlShare + callerBrkShare),
  };
}

/**
 * Get aggregated weekly report entry for a master and their entire sub-hierarchy.
 * Uses the multi-tier cascade formulas.
 */
async function _getAggregatedEntry(masterId, masterDoc, metricsEngine, callerPnlShare = 100, callerBrkShare = 100) {
  const { getAllSubMasterIds } = require('../services/masterHierarchyService');
  const allMasterIds = await getAllSubMasterIds(masterId);

  const users = await User.find({ master_id: { $in: allMasterIds }, deleted_at: null })
    .select('_id').lean();

  let realised = 0, position = 0;
  for (const u of users) {
    const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
    if (metrics) {
      realised += metrics.realised_pnl;
      position += metrics.position_pnl;
    }
  }

  const m2mPnl = realised + position;

  // Aggregate brokerage and turnover for all users in hierarchy
  let totalBrokerage = 0, totalTurnover = 0, totalLots = 0;
  for (const u of users) {
    const { brokerage, turnover, lots } = await _getUserBrokerageAndTurnover(u._id);
    totalBrokerage += brokerage;
    totalTurnover += turnover;
    totalLots += lots;
  }

  // Caller's brokerage share = spread between caller's rate and child master's rate
  // Using the simplified formula: callerBrkShare% - childMaster's brkShare%
  const pnlKeep = callerPnlShare - (masterDoc.pnl_sharing || 0);
  const brkKeep = callerBrkShare - (masterDoc.brokerage_sharing || 0);

  const callerBrk = totalBrokerage * (brkKeep / 100);
  const callerProfit = (-m2mPnl) * (pnlKeep / 100);

  return {
    id: masterId,
    name: masterDoc.name,
    username: masterDoc.username,
    realised_pnl: _r2(realised),
    m2m_pnl: _r2(m2mPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(totalTurnover),
    caller_brk: _r2(callerBrk),
    total_pnl: _r2(-m2mPnl),
    caller_profit: _r2(callerProfit),
    total_caller: _r2(callerProfit + callerBrk),
  };
}

/**
 * Compute total brokerage, turnover, and lots for a user from their current-week trades.
 */
async function _getUserBrokerageAndTurnover(userId) {
  const trades = await Trade.find({
    user_id: userId, status: 'completed', deleted_at: null
  }).select('instrument_token executed_price executed_quantity').lean();

  if (trades.length === 0) return { brokerage: 0, turnover: 0, lots: 0 };

  // Try user-specific rules first, fall back to global
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

    let brkRule = null;
    if (rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!brkRule && rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
    if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

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
