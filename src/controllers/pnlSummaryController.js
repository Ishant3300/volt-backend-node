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

    let users;
    if (role === 'master') {
      users = await User.find({ master_id: callerId, deleted_at: null }).select('_id name username master_id').lean();
    } else {
      users = await User.find({ deleted_at: null }).select('_id name username master_id').lean();
    }
    if (!users.length) return res.json({ success: true, data: [], totals: { realised: 0, position: 0, m2m: 0 } });

    const userIds = users.map(u => u._id);
    const trades = await Trade.find({
      user_id: { $in: userIds }, status: 'completed', deleted_at: null
    }).select('user_id instrument_token transaction_type executed_quantity executed_price pnl').lean();

    // Load brokerage rules + instrument info for brokerage recalculation
    const BrokerageSettings = require('../models/BrokerageSettings');
    const KiteInstrument = require('../models/KiteInstrument');
    const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();
    const allTokens = [...new Set(trades.map(t => t.instrument_token))];
    const kiteInstruments = await KiteInstrument.find(
      { instrument_token: { $in: allTokens } }, 'instrument_token lot_size segment raw_name'
    ).lean();
    const kiteMap = {};
    kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

    // Group by user -> instrument, accumulate pnl and recalculate brokerage
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

      // Recalculate brokerage per trade (same formula as Flutter client)
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

    // Collect open position tokens for LTP
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

    // Compute per-user P&L (Realised = sum(trade.pnl) - brokerage, matching Flutter client)
    const perUser = {};
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
      perUser[uid] = { realised: r2(realised), position: r2(position), m2m: r2(realised + position) };
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
