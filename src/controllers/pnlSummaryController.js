const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * GET /api/master/pnl-summary
 * 
 * Master: per-user realised_pnl, position_pnl, m2m_pnl
 * Admin:  per-master (aggregated)
 *
 * Realised = sum of trade.pnl (FIFO)
 * Position = floating P&L from open positions using live LTP
 * M2M = Realised + Position
 */
const getPnlSummary = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const metricsEngine = require('../services/metricsEngine');

    let users;
    if (role === 'master') {
      const { getAllSubMasterIds } = require('../services/masterHierarchyService');
      const allMasterIds = await getAllSubMasterIds(callerId);
      users = await User.find({ master_id: { $in: allMasterIds }, deleted_at: null }).select('_id name username master_id credits').lean();
    } else {
      users = await User.find({ deleted_at: null }).select('_id name username master_id credits').lean();
    }
    if (!users.length) return res.json({ success: true, data: [], totals: { realised: 0, position: 0, m2m: 0 } });

    // Use metricsEngine as single source of truth
    const perUser = {};
    for (const u of users) {
      const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
      if (metrics) {
        perUser[u._id.toString()] = {
          realised: metrics.realised_pnl,
          position: metrics.position_pnl,
          m2m: metrics.m2m_pnl
        };
      }
    }

    if (role === 'master') {
      const data = users.map(u => {
        const uid = u._id.toString();
        const p = perUser[uid] || { realised: 0, position: 0, m2m: 0 };
        return { id: uid, name: u.name, username: u.username, realised_pnl: p.realised, position_pnl: p.position, m2m_pnl: p.m2m };
      });
      const totals = data.reduce((a, d) => ({
        realised: a.realised + d.realised_pnl, position: a.position + d.position_pnl, m2m: a.m2m + d.m2m_pnl
      }), { realised: 0, position: 0, m2m: 0 });
      return res.json({ success: true, data, totals: { realised: r2(totals.realised), position: r2(totals.position), m2m: r2(totals.m2m) } });
    }

    // Admin: aggregate per master
    const masters = await Master.find({ deleted_at: null }).select('_id name username').lean();
    const userMasterMap = {};
    users.forEach(u => { userMasterMap[u._id.toString()] = u.master_id?.toString(); });

    const data = masters.map(m => {
      const mid = m._id.toString();
      let realised = 0, position = 0;
      for (const [uid, p] of Object.entries(perUser)) {
        if (userMasterMap[uid] === mid) { realised += p.realised; position += p.position; }
      }
      const userCount = Object.keys(userMasterMap).filter(uid => userMasterMap[uid] === mid).length;
      return { id: mid, name: m.name, username: m.username, user_count: userCount, realised_pnl: r2(realised), position_pnl: r2(position), m2m_pnl: r2(realised + position) };
    });
    const totals = data.reduce((a, d) => ({
      realised: a.realised + d.realised_pnl, position: a.position + d.position_pnl, m2m: a.m2m + d.m2m_pnl
    }), { realised: 0, position: 0, m2m: 0 });
    res.json({ success: true, data, totals: { realised: r2(totals.realised), position: r2(totals.position), m2m: r2(totals.m2m) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getPnlSummary };
