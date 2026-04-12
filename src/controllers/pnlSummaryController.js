const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * GET /api/master/pnl-summary
 *
 * Shows only DIRECT children of the caller, with sub-hierarchy P&L aggregated.
 *
 * ADMIN view:
 *   - Shows only top-level masters (master_id = null, created by admin)
 *   - Each master's P&L = aggregation of ALL users in their entire sub-tree
 *   - No users shown (admin doesn't create users)
 *
 * MASTER view:
 *   - Shows direct child masters (with aggregated sub-hierarchy P&L)
 *   - Shows direct child users (own P&L only)
 *   - Does NOT show sub-masters' users or deeper sub-masters
 */
const getPnlSummary = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const metricsEngine = require('../services/metricsEngine');
    const { getAllSubMasterIds } = require('../services/masterHierarchyService');

    const data = [];

    if (role === 'admin') {
      // Admin: show only top-level masters (master_id = null)
      const topMasters = await Master.find({ master_id: null, deleted_at: null })
        .select('_id name username').lean();

      for (const master of topMasters) {
        const pnl = await _getAggregatedMasterPnl(master._id.toString(), metricsEngine);
        data.push({
          id: master._id.toString(),
          name: master.name,
          username: master.username,
          type: 'master',
          realised_pnl: r2(pnl.realised),
          position_pnl: r2(pnl.position),
          m2m_pnl: r2(pnl.m2m),
        });
      }
    } else {
      // Master: show direct child masters + direct child users

      // 1. Direct child masters (with aggregated sub-hierarchy P&L)
      const childMasters = await Master.find({ master_id: callerId, deleted_at: null })
        .select('_id name username').lean();

      for (const cm of childMasters) {
        const pnl = await _getAggregatedMasterPnl(cm._id.toString(), metricsEngine);
        data.push({
          id: cm._id.toString(),
          name: cm.name,
          username: cm.username,
          type: 'master',
          realised_pnl: r2(pnl.realised),
          position_pnl: r2(pnl.position),
          m2m_pnl: r2(pnl.m2m),
        });
      }

      // 2. Direct child users (only users created by THIS master, not sub-masters)
      const directUsers = await User.find({ master_id: callerId, deleted_at: null })
        .select('_id name username').lean();

      for (const u of directUsers) {
        const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
        const pnl = metrics
          ? { realised: metrics.realised_pnl, position: metrics.position_pnl, m2m: metrics.m2m_pnl }
          : { realised: 0, position: 0, m2m: 0 };
        data.push({
          id: u._id.toString(),
          name: u.name,
          username: u.username,
          type: 'user',
          realised_pnl: r2(pnl.realised),
          position_pnl: r2(pnl.position),
          m2m_pnl: r2(pnl.m2m),
        });
      }
    }

    const totals = data.reduce((a, d) => ({
      realised: a.realised + d.realised_pnl,
      position: a.position + d.position_pnl,
      m2m: a.m2m + d.m2m_pnl,
    }), { realised: 0, position: 0, m2m: 0 });

    res.json({
      success: true,
      data,
      totals: { realised: r2(totals.realised), position: r2(totals.position), m2m: r2(totals.m2m) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get aggregated P&L for a master and their entire sub-hierarchy.
 * Sums up all users under this master + all sub-masters recursively.
 */
async function _getAggregatedMasterPnl(masterId, metricsEngine) {
  const { getAllSubMasterIds } = require('../services/masterHierarchyService');
  const allMasterIds = await getAllSubMasterIds(masterId);

  // Get all users under this master's entire hierarchy
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

  return { realised, position, m2m: realised + position };
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getPnlSummary };
