const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

const getSettlementReport = async (req, res) => {
  try {
    const { master_id, user_id, date } = req.query;
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin ? req.admin.id : req.master.id;

    // Build date filter
    const dateFilter = {};
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      dateFilter.createdAt = { $gte: start, $lte: end };
    }

    const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();

    // Single user mode: show that user's own P&L + brokerage
    if (user_id) {
      const user = await User.findOne({ _id: user_id, deleted_at: null })
        .select('name username master_id').lean();
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      // Auth check: master can only see own users
      if (role === 'master' && user.master_id.toString() !== callerId) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }

      const perUser = await _computeSettlement([user._id], brkRules, dateFilter);
      const p = perUser[user._id.toString()] || { pnl: 0, brokerage: 0 };
      const data = [{
        id: user._id, name: user.name, username: user.username, role: 'USER',
        pnl: r2(p.pnl), brokerage: r2(p.brokerage), total: r2(p.pnl - p.brokerage),
      }];
      return res.json({ success: true, data, totals: _sumTotals(data) });
    }

    // Master mode: show all users under a master
    const targetMasterId = (role === 'admin' && master_id) ? master_id : callerId;

    const users = await User.find({ master_id: targetMasterId, deleted_at: null })
      .select('_id name username').lean();

    if (!users.length) {
      return res.json({ success: true, data: [], totals: { pnl: 0, brokerage: 0, total: 0 } });
    }

    const perUser = await _computeSettlement(users.map(u => u._id), brkRules, dateFilter);
    const data = users.map(u => {
      const uid = u._id.toString();
      const p = perUser[uid] || { pnl: 0, brokerage: 0 };
      return {
        id: uid, name: u.name, username: u.username, role: 'USER',
        pnl: r2(p.pnl), brokerage: r2(p.brokerage), total: r2(p.pnl - p.brokerage),
      };
    });

    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Compute per-user P&L and brokerage using FIFO trade.pnl + floating P&L for open positions
async function _computeSettlement(userIds, brkRules, dateFilter) {
  const tradeFilter = {
    user_id: { $in: userIds },
    status: 'completed',
    deleted_at: null,
    ...dateFilter,
  };

  const trades = await Trade.find(tradeFilter)
    .select('user_id instrument_token transaction_type executed_quantity executed_price pnl')
    .lean();

  // Get instrument info for brokerage calculation
  const allTokens = [...new Set(trades.map(t => t.instrument_token))];
  const kiteInstruments = await KiteInstrument.find(
    { instrument_token: { $in: allTokens } },
    'instrument_token lot_size segment raw_name'
  ).lean();
  const kiteMap = {};
  kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

  // Track per-user per-instrument positions + brokerage
  const userInstrMap = {};
  const userBrokerage = {};
  const userRealisedPnl = {};

  for (const t of trades) {
    const uid = t.user_id.toString();
    if (!userInstrMap[uid]) userInstrMap[uid] = {};
    if (!userBrokerage[uid]) userBrokerage[uid] = 0;
    if (!userRealisedPnl[uid]) userRealisedPnl[uid] = 0;

    const key = t.instrument_token;
    if (!userInstrMap[uid][key]) {
      userInstrMap[uid][key] = { buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0 };
    }
    const a = userInstrMap[uid][key];
    if (t.transaction_type === 'BUY') {
      a.buyQty += t.executed_quantity;
      a.buyVal += t.executed_quantity * t.executed_price;
    } else {
      a.sellQty += t.executed_quantity;
      a.sellVal += t.executed_quantity * t.executed_price;
    }

    // Accumulate FIFO P&L from closing trades
    userRealisedPnl[uid] += (t.pnl || 0);

    // Recalculate brokerage using BrokerageSettings with 4-level fallback
    const ki = kiteMap[t.instrument_token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;

    let brkRule = null;
    if (rawName && seg) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!brkRule && rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!brkRule && seg) brkRule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
    if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === (ki?.segment?.split('-')[0] || '').toUpperCase() && !r.script_name);

    let tradeBrk = 0;
    if (brkRule) {
      if (brkRule.type === 'TURNOVER WISE') {
        tradeBrk = t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
      } else if (brkRule.type === 'LOT WISE') {
        tradeBrk = (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
      }
    }
    userBrokerage[uid] += tradeBrk;
  }

  // Find open positions (net_qty != 0) and fetch live prices
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

  // Compute final P&L per user: realised + floating for open positions
  const result = {};
  for (const [uid, instruments] of Object.entries(userInstrMap)) {
    let floatingPnl = 0;
    for (const [token, a] of Object.entries(instruments)) {
      const netQty = a.buyQty - a.sellQty;
      if (netQty !== 0) {
        const avgBuy = a.buyQty > 0 ? a.buyVal / a.buyQty : 0;
        const avgSell = a.sellQty > 0 ? a.sellVal / a.sellQty : 0;
        const ltp = ltpMap.get(token) || (netQty > 0 ? avgBuy : avgSell);
        if (netQty > 0) floatingPnl += (ltp - avgBuy) * netQty;
        else floatingPnl += (avgSell - ltp) * Math.abs(netQty);
      }
    }

    const brokerage = userBrokerage[uid] || 0;
    // Realised P&L = sum(trade.pnl) - brokerage, then add floating
    const realised = (userRealisedPnl[uid] || 0) - brokerage;
    result[uid] = {
      pnl: r2(realised + floatingPnl),
      brokerage: r2(brokerage),
    };
  }

  return result;
}

function _sumTotals(data) {
  return {
    pnl: r2(data.reduce((s, d) => s + d.pnl, 0)),
    brokerage: r2(data.reduce((s, d) => s + d.brokerage, 0)),
    total: r2(data.reduce((s, d) => s + d.total, 0)),
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getSettlementReport };
