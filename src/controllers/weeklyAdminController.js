const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

const getWeeklyAdminReport = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();

    if (role === 'master') {
      const master = await Master.findById(callerId).select('username pnl_sharing brokerage_sharing').lean();
      const users = await User.find({ master_id: callerId, deleted_at: null }).select('_id name username').lean();
      if (!users.length) return res.json({ success: true, data: [], totals: _emptyTotals() });

      const perUser = await _computePerUser(users.map(u => u._id), brkRules);
      const data = users.map(u => {
        const uid = u._id.toString();
        const p = perUser[uid] || { realised: 0, position: 0, brokerage: 0 };
        const totalPnl = p.realised + p.position;
        const adminBrk = p.brokerage * ((master?.brokerage_sharing || 0) / 100);
        const adminProfit = totalPnl * ((master?.pnl_sharing || 0) / 100);
        return {
          id: uid, name: u.name, username: u.username,
          parent_username: master?.username || '',
          realised_pnl: r2(p.realised), m2m_pnl: r2(totalPnl),
          brokerage: r2(p.brokerage), admin_brk: r2(adminBrk),
          total_pnl: r2(p.realised + totalPnl), admin_profit: r2(adminProfit),
          total_admin: r2(adminProfit),
        };
      });
      return res.json({ success: true, data, totals: _sumTotals(data) });
    }

    const masters = await Master.find({ deleted_at: null }).select('_id name username pnl_sharing brokerage_sharing').lean();
    if (!masters.length) return res.json({ success: true, data: [], totals: _emptyTotals() });

    const allUsers = await User.find({ master_id: { $in: masters.map(m => m._id) }, deleted_at: null }).select('_id master_id').lean();
    const usersByMaster = {};
    allUsers.forEach(u => {
      const mid = u.master_id.toString();
      if (!usersByMaster[mid]) usersByMaster[mid] = [];
      usersByMaster[mid].push(u._id);
    });

    const perUser = await _computePerUser(allUsers.map(u => u._id), brkRules);
    const data = masters.map(m => {
      const mid = m._id.toString();
      const uids = (usersByMaster[mid] || []).map(id => id.toString());
      let realised = 0, position = 0, brokerage = 0;
      for (const uid of uids) {
        const p = perUser[uid];
        if (p) { realised += p.realised; position += p.position; brokerage += p.brokerage; }
      }
      const totalPnl = realised + position;
      const adminBrk = brokerage * ((m.brokerage_sharing || 0) / 100);
      const adminProfit = totalPnl * ((m.pnl_sharing || 0) / 100);
      return {
        id: mid, name: m.name, username: m.username, parent_username: 'ADMIN', user_count: uids.length,
        realised_pnl: r2(realised), m2m_pnl: r2(totalPnl),
        brokerage: r2(brokerage), admin_brk: r2(adminBrk),
        total_pnl: r2(realised + totalPnl), admin_profit: r2(adminProfit),
        total_admin: r2(adminProfit),
      };
    });
    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

async function _computePerUser(userIds, brkRules) {
  const trades = await Trade.find({
    user_id: { $in: userIds }, status: 'completed', deleted_at: null
  }).select('user_id instrument_token transaction_type executed_quantity executed_price pnl').lean();

  const allTokens = [...new Set(trades.map(t => t.instrument_token))];
  const kiteInstruments = await KiteInstrument.find(
    { instrument_token: { $in: allTokens } }, 'instrument_token lot_size segment raw_name'
  ).lean();
  const kiteMap = {};
  kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

  const userInstrMap = {};
  const userBrokerage = {};
  for (const t of trades) {
    const uid = t.user_id.toString();
    if (!userInstrMap[uid]) userInstrMap[uid] = {};
    if (!userBrokerage[uid]) userBrokerage[uid] = 0;
    const key = t.instrument_token;
    if (!userInstrMap[uid][key]) {
      userInstrMap[uid][key] = { buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0, realisedPnl: 0 };
    }
    const a = userInstrMap[uid][key];
    if (t.transaction_type === 'BUY') { a.buyQty += t.executed_quantity; a.buyVal += t.executed_quantity * t.executed_price; }
    else { a.sellQty += t.executed_quantity; a.sellVal += t.executed_quantity * t.executed_price; }
    a.realisedPnl += (t.pnl || 0);

    const ki = kiteMap[t.instrument_token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;
    let brkRule = null;
    if (rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!brkRule && rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === seg.toUpperCase());
    let tradeBrk = 0;
    if (brkRule) {
      if (brkRule.type === 'TURNOVER WISE') tradeBrk = t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
      else if (brkRule.type === 'LOT WISE') tradeBrk = (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
    }
    userBrokerage[uid] += tradeBrk;
  }

  const openTokens = new Set();
  for (const instruments of Object.values(userInstrMap)) {
    for (const [token, a] of Object.entries(instruments)) {
      if ((a.buyQty - a.sellQty) !== 0) openTokens.add(parseInt(token));
    }
  }
  let ltpMap = new Map();
  if (openTokens.size > 0) {
    try {
      const { getLatestQuotes } = require('../services/kiteService');
      const quotes = await getLatestQuotes([...openTokens], 100);
      quotes.forEach(q => { ltpMap.set(q.instrument_token.toString(), q.last_price); });
    } catch (_) {}
  }

  const result = {};
  for (const [uid, instruments] of Object.entries(userInstrMap)) {
    let realisedPnlSum = 0, position = 0;
    for (const [token, a] of Object.entries(instruments)) {
      realisedPnlSum += a.realisedPnl;
      const netQty = a.buyQty - a.sellQty;
      if (netQty !== 0) {
        const avgBuy = a.buyQty > 0 ? a.buyVal / a.buyQty : 0;
        const avgSell = a.sellQty > 0 ? a.sellVal / a.sellQty : 0;
        const ltp = ltpMap.get(token) || (netQty > 0 ? avgBuy : avgSell);
        if (netQty > 0) position += (ltp - avgBuy) * netQty;
        else position += (avgSell - ltp) * Math.abs(netQty);
      }
    }
    const realised = realisedPnlSum - (userBrokerage[uid] || 0);
    result[uid] = { realised: r2(realised), position: r2(position), brokerage: r2(userBrokerage[uid] || 0) };
  }
  return result;
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

function _emptyTotals() {
  return { realised_pnl: 0, m2m_pnl: 0, brokerage: 0, admin_brk: 0, total_pnl: 0, admin_profit: 0, total_admin: 0 };
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getWeeklyAdminReport };
