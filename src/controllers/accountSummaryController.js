const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const Transaction = require('../models/Transaction');
const BrokerageSettings = require('../models/BrokerageSettings');
const mongoose = require('mongoose');

/**
 * GET /api/account-summary
 *
 * Query params:
 *   - week: 'this_week' | 'previous_week' | 'custom' (default: 'previous_week')
 *   - from, to: ISO date strings (required when week=custom)
 *   - mode: 'pnl' | 'brokerage' | 'credit' (default: 'pnl')
 *   - user_id: target user (admin/master can specify)
 *   - search: filter instruments by tradingsymbol or exchange
 *
 * Returns:
 *   For pnl/brokerage mode: per-instrument breakdown for the selected user(s)
 *   For credit mode: credit/debit transaction history
 */
const getAccountSummary = async (req, res) => {
  try {
    const { week = 'previous_week', from, to, mode = 'pnl', user_id, search, limit = 200 } = req.query;
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    // Resolve target user(s)
    let targetUserIds = [];
    if (role === 'user') {
      targetUserIds = [new mongoose.Types.ObjectId(callerId)];
    } else if (user_id) {
      targetUserIds = [new mongoose.Types.ObjectId(user_id)];
    } else if (role === 'master') {
      const users = await User.find({ master_id: callerId, deleted_at: null }).select('_id').lean();
      targetUserIds = users.map(u => u._id);
    } else {
      // Admin, no user selected — get all users
      const users = await User.find({ deleted_at: null }).select('_id').lean();
      targetUserIds = users.map(u => u._id);
    }

    // Credit mode — return transaction history
    if (mode === 'credit') {
      return await _handleCreditMode(req, res, targetUserIds, week, from, to, parseInt(limit));
    }

    // P&L / Brokerage mode
    const { start, end, weekLabel } = _getDateRange(week, from, to);

    const matchStage = {
      user_id: { $in: targetUserIds },
      status: 'completed',
      deleted_at: null,
    };
    if (start && end) {
      matchStage.executed_at = { $gte: start, $lt: end };
    }

    const trades = await Trade.find(matchStage)
      .select('user_id instrument_token tradingsymbol exchange transaction_type executed_quantity executed_price')
      .lean();

    // Load brokerage settings for brokerage mode
    let brkMap = {};
    if (mode === 'brokerage') {
      const brkSettings = await BrokerageSettings.find({ deleted_at: null }).lean();
      brkMap = _buildBrkMap(brkSettings);
    }

    // Group by instrument
    const instMap = {};
    for (const t of trades) {
      const key = t.instrument_token;
      if (!instMap[key]) {
        instMap[key] = {
          instrument_token: t.instrument_token,
          tradingsymbol: t.tradingsymbol,
          exchange: t.exchange,
          buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0,
        };
      }
      const a = instMap[key];
      if (t.transaction_type === 'BUY') {
        a.buyQty += t.executed_quantity;
        a.buyVal += t.executed_quantity * t.executed_price;
      } else {
        a.sellQty += t.executed_quantity;
        a.sellVal += t.executed_quantity * t.executed_price;
      }
    }

    // Compute per-instrument results
    const instruments = [];
    let totalPnl = 0, totalBrokerage = 0;

    for (const a of Object.values(instMap)) {
      const avgBuy = a.buyQty > 0 ? a.buyVal / a.buyQty : 0;
      const avgSell = a.sellQty > 0 ? a.sellVal / a.sellQty : 0;
      const netQty = a.buyQty - a.sellQty;
      let pnl = 0;

      if (netQty === 0) {
        pnl = a.sellVal - a.buyVal;
      } else if (netQty > 0) {
        pnl = a.sellVal - (a.sellQty * avgBuy);
      } else {
        pnl = (a.buyQty * avgSell) - a.buyVal;
      }

      let brokerage = 0;
      const matchedQty = Math.min(a.buyQty, a.sellQty);
      if (matchedQty > 0) {
        const category = _getBrkCategory(a.exchange, a.tradingsymbol);
        brokerage = _getBrkForTrade(category, a.tradingsymbol, avgBuy, avgSell, matchedQty, brkMap);
      }

      totalPnl += pnl;
      totalBrokerage += brokerage;

      const entry = {
        tradingsymbol: a.tradingsymbol,
        exchange: a.exchange,
        buy_qty: a.buyQty,
        sell_qty: a.sellQty,
        buy_amount: r2(a.buyVal),
        sell_amount: r2(a.sellVal),
        avg_buy: r2(avgBuy),
        avg_sell: r2(avgSell),
        net_qty: netQty,
        pnl: r2(pnl),
        brokerage: r2(brokerage),
      };
      instruments.push(entry);
    }

    // Filter by search
    let filtered = instruments;
    if (search) {
      const q = search.toLowerCase();
      filtered = instruments.filter(i =>
        i.tradingsymbol.toLowerCase().includes(q) || i.exchange.toLowerCase().includes(q)
      );
    }

    // Sort by absolute P&L descending
    filtered.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

    res.json({
      success: true,
      data: {
        week: weekLabel,
        mode,
        instruments: filtered.slice(0, parseInt(limit)),
        totals: { pnl: r2(totalPnl), brokerage: r2(totalBrokerage), trades: trades.length },
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Credit mode handler ──
async function _handleCreditMode(req, res, targetUserIds, week, from, to, limit) {
  const { start, end, weekLabel } = _getDateRange(week, from, to);

  const filter = {
    userId: { $in: targetUserIds },
    type: { $in: ['CREDIT', 'DEBIT'] },
    status: 'SUCCESS',
  };
  if (start && end) {
    filter.createdAt = { $gte: start, $lt: end };
  }

  const transactions = await Transaction.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'username name')
    .lean();

  const rows = transactions.map(t => ({
    id: t._id,
    type: t.type,
    amount: t.amount,
    balance_before: t.balanceBefore,
    balance_after: t.balanceAfter,
    username: t.userId?.username || '',
    name: t.userId?.name || '',
    note: t.metadata?.note || t.metadata?.description || '',
    created_at: t.createdAt,
  }));

  res.json({
    success: true,
    data: {
      week: weekLabel,
      mode: 'credit',
      transactions: rows,
    }
  });
}

// ── Date range helper ──
function _getDateRange(week, from, to) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - diffToMonday);
  thisWeekStart.setHours(0, 0, 0, 0);

  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setDate(thisWeekEnd.getDate() + 7);

  const prevWeekStart = new Date(thisWeekStart);
  prevWeekStart.setDate(prevWeekStart.getDate() - 7);

  if (week === 'this_week') {
    const s = thisWeekStart;
    const e = thisWeekEnd;
    return { start: s, end: e, weekLabel: `${_fmtDate(s)} to ${_fmtDate(new Date(e.getTime() - 86400000))}` };
  }
  if (week === 'previous_week') {
    return { start: prevWeekStart, end: thisWeekStart, weekLabel: `${_fmtDate(prevWeekStart)} to ${_fmtDate(new Date(thisWeekStart.getTime() - 86400000))}` };
  }
  if (week === 'custom' && from && to) {
    const s = new Date(from); s.setHours(0, 0, 0, 0);
    const e = new Date(to); e.setHours(23, 59, 59, 999);
    return { start: s, end: e, weekLabel: `${_fmtDate(s)} to ${_fmtDate(e)}` };
  }
  // Fallback: previous week
  return { start: prevWeekStart, end: thisWeekStart, weekLabel: `${_fmtDate(prevWeekStart)} to ${_fmtDate(new Date(thisWeekStart.getTime() - 86400000))}` };
}

function _fmtDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

// ── Brokerage helpers (same as weeklyAdminController) ──
function _getBrkCategory(exchange, tradingsymbol) {
  const sym = tradingsymbol.toUpperCase();
  const isOption = sym.endsWith('CE') || sym.endsWith('PE');
  if (exchange === 'NFO' && isOption) return 'NFO-OPT';
  if (exchange === 'BFO' && isOption) return 'NFO-OPT';
  if (exchange === 'MCX' && isOption) return 'MCX-OPT';
  if (exchange === 'NSE' || exchange === 'BSE') return 'NSE';
  if (exchange === 'NFO') return 'NSE';
  if (exchange === 'MCX') return 'MCX';
  return 'NSE';
}

function _buildBrkMap(settings) {
  const map = {};
  for (const s of settings) {
    const cat = s.exchange_name.toUpperCase();
    if (!map[cat]) map[cat] = {};
    map[cat][s.script_name.toUpperCase()] = { type: s.type, value: s.brk_value };
    if (!map[cat]['__DEFAULT__']) map[cat]['__DEFAULT__'] = { type: s.type, value: s.brk_value };
  }
  return map;
}

function _getBrkForTrade(category, tradingsymbol, buyPrice, sellPrice, qty, brkMap) {
  const catMap = brkMap[category] || {};
  const sym = tradingsymbol.toUpperCase();
  let setting = catMap[sym] || catMap['__DEFAULT__'];
  if (!setting) {
    if (category === 'NFO-OPT' || category === 'MCX-OPT') {
      setting = { type: 'LOT WISE', value: 20 };
    } else {
      setting = { type: 'TURNOVER WISE', value: 0.0002 };
    }
  }
  if (setting.type === 'LOT WISE') return qty * setting.value;
  return (buyPrice + sellPrice) * qty * setting.value;
}

const r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getAccountSummary };
