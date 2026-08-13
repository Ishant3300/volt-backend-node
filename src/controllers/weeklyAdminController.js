const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * GET /api/master/weekly-admin-report
 *
 * Same hierarchy logic as P&L summary:
 * - Admin: shows only top-level masters with aggregated sub-hierarchy data
 * - Master: shows direct child masters (aggregated) + direct child users
 *
 * M2M = 0 when no open positions (it represents live P&L only).
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
        const entry = await _getAggregatedEntry(master._id.toString(), master, metricsEngine);
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
        // Caller's share = what caller has - what they gave to child
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
        const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
        const realised = metrics ? metrics.realised_pnl : 0;
        const position = metrics ? metrics.position_pnl : 0;

        // Compute brokerage for this user
        const brokerage = await _getUserBrokerage(u._id);

        const m2mPnl = realised + position;
        const totalPnl = m2mPnl;
        // For users: admin brk = full brokerage, admin profit = full P&L (no sharing formula)
        const adminBrk = brokerage;
        const adminProfit = m2mPnl;

        data.push({
          id: u._id.toString(),
          name: u.name,
          username: u.username,
          parent_username: callerMaster?.username || '',
          type: 'user',
          realised_pnl: r2(realised),
          m2m_pnl: r2(m2mPnl),
          brokerage: r2(brokerage),
          admin_brk: r2(adminBrk),
          total_pnl: r2(-totalPnl),
          admin_profit: r2(-adminProfit),
          total_admin: r2(-adminProfit),
        });
      }
    }

    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get aggregated weekly report entry for a master and their entire sub-hierarchy.
 */
async function _getAggregatedEntry(masterId, masterDoc, metricsEngine, callerPnlShare = 100, callerBrkShare = 100) {
  const { getAllSubMasterIds } = require('../services/masterHierarchyService');
  const allMasterIds = await getAllSubMasterIds(masterId);

  const users = await User.find({ master_id: { $in: allMasterIds }, deleted_at: null })
    .select('_id').lean();

  let realised = 0, position = 0, hasAnyOpenPositions = false;
  for (const u of users) {
    const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
    if (metrics) {
      realised += metrics.realised_pnl;
      position += metrics.position_pnl;
      if (metrics.positions && metrics.positions.length > 0) hasAnyOpenPositions = true;
    }
  }

  // M2M = realised + position (always, regardless of open positions)
  const m2mPnl = realised + position;

  // Brokerage for all users in hierarchy
  let totalBrokerage = 0;
  for (const u of users) {
    totalBrokerage += await _getUserBrokerage(u._id);
  }

  const totalPnl = m2mPnl;
  // Caller's share = caller's sharing% - child master's sharing%
  const pnlKeep = callerPnlShare - (masterDoc.pnl_sharing || 0);
  const brkKeep = callerBrkShare - (masterDoc.brokerage_sharing || 0);
  const adminBrk = totalBrokerage * (brkKeep / 100);
  const adminProfit = m2mPnl * (pnlKeep / 100);

  return {
    id: masterId,
    name: masterDoc.name,
    username: masterDoc.username,
    realised_pnl: r2(realised),
    m2m_pnl: r2(m2mPnl),
    brokerage: r2(totalBrokerage),
    admin_brk: r2(adminBrk),
    total_pnl: r2(-totalPnl),
    admin_profit: r2(-adminProfit),
    total_admin: r2(-adminProfit),
  };
}

/**
 * Compute total brokerage for a user from their trades.
 */
async function _getUserBrokerage(userId) {
  const trades = await Trade.find({
    user_id: userId, status: 'completed', deleted_at: null
  }).select('instrument_token executed_price executed_quantity').lean();

  if (trades.length === 0) return 0;

  // Try user-specific rules first, fall back to global
  let brkRules = await BrokerageSettings.find({ user_id: userId, deleted_at: null }).lean();
  if (brkRules.length === 0) brkRules = await BrokerageSettings.find({ user_id: null, deleted_at: null }).lean();
  const allTokens = [...new Set(trades.map(t => t.instrument_token))];
  const kiteInstruments = await KiteInstrument.find(
    { instrument_token: { $in: allTokens } }, 'instrument_token lot_size segment raw_name'
  ).lean();
  const kiteMap = {};
  kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

  let totalBrk = 0;
  for (const t of trades) {
    const ki = kiteMap[t.instrument_token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;

    let brkRule = null;
    if (rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!brkRule && rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === seg.toUpperCase());

    if (brkRule) {
      if (brkRule.type === 'TURNOVER WISE') totalBrk += t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
      else if (brkRule.type === 'LOT WISE') totalBrk += (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
    }
  }
  return totalBrk;
}

function _sumTotals(data) {
  return {
    realised_pnl: r2(data.reduce((s, d) => s + d.realised_pnl, 0)),
    m2m_pnl: r2(data.reduce((s, d) => s + d.m2m_pnl, 0)),
    brokerage: r2(data.reduce((s, d) => s + d.brokerage, 0)),
    admin_brk: r2(data.reduce((s, d) => s + d.admin_brk, 0)),
    total_pnl: r2(data.reduce((s, d) => s + d.total_pnl, 0)),
    admin_profit: r2(data.reduce((s, d) => s + d.admin_profit, 0)),
    total_admin: r2(data.reduce((s, d) => s + d.total_admin, 0)),
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getWeeklyAdminReport };
