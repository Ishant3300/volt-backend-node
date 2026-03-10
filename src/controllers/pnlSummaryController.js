const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * GET /api/master/pnl-summary
 * 
 * Master: returns per-user realised_pnl, m2m_pnl, total for their child users
 * Admin:  returns per-master realised_pnl, m2m_pnl, total (aggregated across each master's users)
 */
const getPnlSummary = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;

    if (role === 'master') {
      // Master view: per-user P&L
      const users = await User.find({ master_id: callerId, deleted_at: null })
        .select('_id name username').lean();
      if (!users.length) return res.json({ success: true, data: [], totals: { realised: 0, m2m: 0, total: 0 } });

      const userIds = users.map(u => u._id);
      const trades = await Trade.find({
        user_id: { $in: userIds }, status: 'completed', deleted_at: null
      }).select('user_id instrument_token transaction_type executed_quantity executed_price').lean();

      const pnlMap = _computePerUserPnl(trades);

      const data = users.map(u => {
        const uid = u._id.toString();
        const p = pnlMap[uid] || { realised: 0, m2m: 0 };
        return { id: uid, name: u.name, username: u.username, realised_pnl: r2(p.realised), m2m_pnl: r2(p.m2m), total: r2(p.realised + p.m2m) };
      });

      const totals = data.reduce((a, d) => ({ realised: a.realised + d.realised_pnl, m2m: a.m2m + d.m2m_pnl, total: a.total + d.total }), { realised: 0, m2m: 0, total: 0 });
      return res.json({ success: true, data, totals: { realised: r2(totals.realised), m2m: r2(totals.m2m), total: r2(totals.total) } });
    }

    // Admin view: per-master P&L
    const masters = await Master.find({ deleted_at: null }).select('_id name username').lean();
    if (!masters.length) return res.json({ success: true, data: [], totals: { realised: 0, m2m: 0, total: 0 } });

    const masterIds = masters.map(m => m._id);
    const allUsers = await User.find({ master_id: { $in: masterIds }, deleted_at: null })
      .select('_id master_id').lean();

    const usersByMaster = {};
    for (const u of allUsers) {
      const mid = u.master_id.toString();
      if (!usersByMaster[mid]) usersByMaster[mid] = [];
      usersByMaster[mid].push(u._id);
    }

    const allUserIds = allUsers.map(u => u._id);
    const trades = await Trade.find({
      user_id: { $in: allUserIds }, status: 'completed', deleted_at: null
    }).select('user_id instrument_token transaction_type executed_quantity executed_price').lean();

    const pnlMap = _computePerUserPnl(trades);

    const data = masters.map(m => {
      const mid = m._id.toString();
      const uids = (usersByMaster[mid] || []).map(id => id.toString());
      let realised = 0, m2m = 0;
      for (const uid of uids) {
        const p = pnlMap[uid];
        if (p) { realised += p.realised; m2m += p.m2m; }
      }
      return { id: mid, name: m.name, username: m.username, user_count: uids.length, realised_pnl: r2(realised), m2m_pnl: r2(m2m), total: r2(realised + m2m) };
    });

    const totals = data.reduce((a, d) => ({ realised: a.realised + d.realised_pnl, m2m: a.m2m + d.m2m_pnl, total: a.total + d.total }), { realised: 0, m2m: 0, total: 0 });
    res.json({ success: true, data, totals: { realised: r2(totals.realised), m2m: r2(totals.m2m), total: r2(totals.total) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

function _computePerUserPnl(trades) {
  // Group by user_id -> instrument_token
  const map = {};
  for (const t of trades) {
    const uid = t.user_id.toString();
    if (!map[uid]) map[uid] = {};
    const iToken = t.instrument_token;
    if (!map[uid][iToken]) map[uid][iToken] = { buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0 };
    const a = map[uid][iToken];
    if (t.transaction_type === 'BUY') { a.buyQty += t.executed_quantity; a.buyVal += t.executed_quantity * t.executed_price; }
    else { a.sellQty += t.executed_quantity; a.sellVal += t.executed_quantity * t.executed_price; }
  }

  // Compute P&L per user
  const result = {};
  for (const [uid, instruments] of Object.entries(map)) {
    let realised = 0, floating = 0;
    for (const a of Object.values(instruments)) {
      const netQty = a.buyQty - a.sellQty;
      const avgBuy = a.buyQty > 0 ? a.buyVal / a.buyQty : 0;
      const avgSell = a.sellQty > 0 ? a.sellVal / a.sellQty : 0;
      const ltp = avgBuy > 0 ? avgBuy : avgSell;
      if (netQty > 0) {
        realised += a.sellVal - (a.sellQty * avgBuy);
        floating += (ltp - avgBuy) * netQty;
      } else if (netQty < 0) {
        realised += (a.buyQty * avgSell) - a.buyVal;
        floating += (avgSell - ltp) * Math.abs(netQty);
      } else {
        realised += a.sellVal - a.buyVal;
      }
    }
    result[uid] = { realised, m2m: realised + floating };
  }
  return result;
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getPnlSummary };
