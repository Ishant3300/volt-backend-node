const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');

/**
 * GET /api/master/weekly-admin-report
 * 
 * Master view: per-user breakdown (realised, m2m, brokerage, admin brk, total pnl, admin profit, total admin)
 * Admin view:  per-master breakdown (aggregated from each master's users)
 */
const getWeeklyAdminReport = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;

    // Load brokerage settings
    const brkSettings = await BrokerageSettings.find({ deleted_at: null }).lean();
    const brkMap = _buildBrkMap(brkSettings);

    if (role === 'master') {
      const users = await User.find({ master_id: callerId, deleted_at: null })
        .select('_id name username master_id brokerage_sharing').lean();
      if (!users.length) return res.json({ success: true, data: [], totals: _emptyTotals() });

      // Get master info for parent label
      const master = await Master.findById(callerId).select('username').lean();
      const parentUsername = master?.username || '';

      const userIds = users.map(u => u._id);
      const trades = await Trade.find({
        user_id: { $in: userIds }, status: 'completed', deleted_at: null
      }).select('user_id instrument_token tradingsymbol exchange transaction_type executed_quantity executed_price').lean();

      const perUser = _computePerEntity(trades, 'user_id', brkMap);

      const data = users.map(u => {
        const uid = u._id.toString();
        const p = perUser[uid] || { realised: 0, m2m: 0, brokerage: 0 };
        const adminBrk = p.brokerage * ((u.brokerage_sharing || 0) / 100);
        const totalPnl = p.realised + p.m2m;
        const adminProfit = totalPnl - adminBrk;
        return {
          id: uid, name: u.name, username: u.username,
          parent_username: parentUsername,
          realised_pnl: r2(p.realised), m2m_pnl: r2(p.m2m),
          brokerage: r2(p.brokerage), admin_brk: r2(adminBrk),
          total_pnl: r2(totalPnl), admin_profit: r2(adminProfit),
          total_admin: r2(adminProfit + adminBrk),
        };
      });

      const totals = _sumTotals(data);
      return res.json({ success: true, data, totals });
    }

    // Admin view: per-master
    const masters = await Master.find({ deleted_at: null })
      .select('_id name username brokerage_sharing').lean();
    if (!masters.length) return res.json({ success: true, data: [], totals: _emptyTotals() });

    const masterIds = masters.map(m => m._id);
    const allUsers = await User.find({ master_id: { $in: masterIds }, deleted_at: null })
      .select('_id master_id brokerage_sharing').lean();

    const usersByMaster = {};
    for (const u of allUsers) {
      const mid = u.master_id.toString();
      if (!usersByMaster[mid]) usersByMaster[mid] = [];
      usersByMaster[mid].push(u);
    }

    const allUserIds = allUsers.map(u => u._id);
    const trades = await Trade.find({
      user_id: { $in: allUserIds }, status: 'completed', deleted_at: null
    }).select('user_id instrument_token tradingsymbol exchange transaction_type executed_quantity executed_price').lean();

    const perUser = _computePerEntity(trades, 'user_id', brkMap);

    const data = masters.map(m => {
      const mid = m._id.toString();
      const users = usersByMaster[mid] || [];
      let realised = 0, m2mVal = 0, brokerage = 0, adminBrk = 0;
      for (const u of users) {
        const uid = u._id.toString();
        const p = perUser[uid] || { realised: 0, m2m: 0, brokerage: 0 };
        realised += p.realised;
        m2mVal += p.m2m;
        brokerage += p.brokerage;
        // Each user's admin brk contribution based on user's brokerage_sharing
        adminBrk += p.brokerage * ((u.brokerage_sharing || 0) / 100);
      }
      // Master-level admin brk: net brokerage × master's brokerage_sharing
      const masterAdminBrk = brokerage * ((m.brokerage_sharing || 0) / 100);
      const totalPnl = realised + m2mVal;
      const adminProfit = totalPnl - masterAdminBrk;
      return {
        id: mid, name: m.name, username: m.username,
        parent_username: 'ADMIN',
        user_count: users.length,
        realised_pnl: r2(realised), m2m_pnl: r2(m2mVal),
        brokerage: r2(brokerage), admin_brk: r2(masterAdminBrk),
        total_pnl: r2(totalPnl), admin_profit: r2(adminProfit),
        total_admin: r2(adminProfit + masterAdminBrk),
      };
    });

    const totals = _sumTotals(data);
    res.json({ success: true, data, totals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Map trade exchange+instrumentType to brokerage category
 * NFO CE/PE -> NFO-OPT, MCX CE/PE -> MCX-OPT, else exchange
 */
function _getBrkCategory(exchange, tradingsymbol) {
  // CE/PE suffix detection for options
  const sym = tradingsymbol.toUpperCase();
  const isOption = sym.endsWith('CE') || sym.endsWith('PE');

  if (exchange === 'NFO' && isOption) return 'NFO-OPT';
  if (exchange === 'BFO' && isOption) return 'NFO-OPT';
  if (exchange === 'MCX' && isOption) return 'MCX-OPT';
  if (exchange === 'NSE' || exchange === 'BSE') return 'NSE';
  if (exchange === 'NFO') return 'NSE'; // NFO futures -> NSE turnover
  if (exchange === 'MCX') return 'MCX';
  return 'NSE'; // fallback
}

/**
 * Build lookup: { category: { scriptName: { type, value } } }
 * Also stores a default per category
 */
function _buildBrkMap(settings) {
  const map = {};
  for (const s of settings) {
    const cat = s.exchange_name.toUpperCase();
    if (!map[cat]) map[cat] = {};
    map[cat][s.script_name.toUpperCase()] = { type: s.type, value: s.brk_value };
    // Store as default for category if script is generic
    if (!map[cat]['__DEFAULT__']) map[cat]['__DEFAULT__'] = { type: s.type, value: s.brk_value };
  }
  return map;
}

/**
 * Get brokerage value for a single trade
 * For TURNOVER WISE: (buyPrice + sellPrice) × qty × brkValue
 * For LOT WISE: qty × brkValue (per lot, value is flat Rs amount)
 */
function _getBrkForTrade(category, tradingsymbol, buyPrice, sellPrice, qty, brkMap) {
  const catMap = brkMap[category] || {};
  const sym = tradingsymbol.toUpperCase();
  // Try exact script match, then default for category, then hardcoded defaults
  let setting = catMap[sym] || catMap['__DEFAULT__'];

  if (!setting) {
    // Hardcoded defaults
    if (category === 'NFO-OPT' || category === 'MCX-OPT') {
      setting = { type: 'LOT WISE', value: 20 };
    } else {
      setting = { type: 'TURNOVER WISE', value: 0.0002 };
    }
  }

  if (setting.type === 'LOT WISE') {
    return qty * setting.value;
  }
  // TURNOVER WISE
  return (buyPrice + sellPrice) * qty * setting.value;
}

/**
 * Compute per-entity (user_id) P&L and brokerage from trades
 */
function _computePerEntity(trades, groupKey, brkMap) {
  // Group by entity -> instrument
  const map = {};
  for (const t of trades) {
    const eid = t[groupKey].toString();
    if (!map[eid]) map[eid] = {};
    const iToken = t.instrument_token;
    if (!map[eid][iToken]) {
      map[eid][iToken] = {
        exchange: t.exchange, tradingsymbol: t.tradingsymbol,
        buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0,
        // For brokerage: track matched pairs
        totalBuyPrice: 0, totalSellPrice: 0, matchedQty: 0,
      };
    }
    const a = map[eid][iToken];
    if (t.transaction_type === 'BUY') {
      a.buyQty += t.executed_quantity;
      a.buyVal += t.executed_quantity * t.executed_price;
    } else {
      a.sellQty += t.executed_quantity;
      a.sellVal += t.executed_quantity * t.executed_price;
    }
  }

  const result = {};
  for (const [eid, instruments] of Object.entries(map)) {
    let realised = 0, floating = 0, brokerage = 0;
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

      // Brokerage: on matched (squared off) quantity
      const matchedQty = Math.min(a.buyQty, a.sellQty);
      if (matchedQty > 0) {
        const category = _getBrkCategory(a.exchange, a.tradingsymbol);
        brokerage += _getBrkForTrade(category, a.tradingsymbol, avgBuy, avgSell, matchedQty, brkMap);
      }
    }
    result[eid] = { realised, m2m: realised + floating, brokerage };
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
