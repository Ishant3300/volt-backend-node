const Trade = require('../models/Trade');
const User = require('../models/User');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const SettlementHistory = require('../models/SettlementHistory');
const mongoose = require('mongoose');

/**
 * GET /api/trade/report
 * Query: from, to (ISO dates), user_id (optional, for master/admin)
 * 
 * Returns trades grouped by instrument with buy/sell sides,
 * per-instrument summary, and overall summary.
 */
const getTradeReport = async (req, res) => {
  try {
    const { from, to, user_id } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to dates are required' });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    // Determine target user
    let targetUserId;
    if (role === 'user') {
      targetUserId = new mongoose.Types.ObjectId(callerId);
    } else if (user_id) {
      targetUserId = new mongoose.Types.ObjectId(user_id);
    } else {
      targetUserId = null; // admin/master without user_id = all users
    }

    // User scope (applied to both the live Trade collection and the ledger)
    const userScope = {};
    if (targetUserId) userScope.user_id = targetUserId;
    else if (role === 'master') {
      const childIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      userScope.user_id = { $in: childIds };
    }

    // Fetch user info
    let userName = 'Unknown';
    if (targetUserId) {
      const u = await User.findById(targetUserId).select('username name').lean();
      if (u) userName = u.name || u.username;
    }

    // ── Trade-table sources (response shape unchanged) ──
    // (1) Current/unsettled period: LIVE active regular fills within the window.
    const liveRegular = await Trade.find({
      ...userScope,
      status: 'completed',
      deleted_at: null,
      trade_type: { $nin: ['carry_forward', 'margin_square_off'] },
      executed_at: { $gte: fromDate, $lte: toDate },
    }).sort({ executed_at: 1 }).lean();

    // (2) Historical/settled period: immutable SettlementHistory ledger fills within the
    //     window. This is the DURABLE source of historical bills — independent of any
    //     live-table mutation. It replaces the old fragile soft-deleted "week reset"
    //     remarks matching, which could silently drop history.
    const snapshots = await SettlementHistory.find({
      ...userScope,
      period_from: { $lte: toDate },
      period_to: { $gte: fromDate },
    }).lean();

    const ledgerRows = [];
    for (const s of snapshots) {
      for (const f of (s.fills || [])) {
        if (!f.executed_at) continue;
        const at = new Date(f.executed_at);
        if (at < fromDate || at > toDate) continue;
        // Only actual market trades belong in the table; carry_forward/margin
        // markers are represented via the Carry Forward section, not as fills.
        if (f.trade_type === 'carry_forward' || f.trade_type === 'margin_square_off') continue;
        ledgerRows.push({
          exchange: s.exchange,
          tradingsymbol: s.tradingsymbol,
          instrument_token: s.instrument_token,
          transaction_type: f.transaction_type,
          executed_quantity: f.executed_quantity || 0,
          executed_price: f.executed_price || 0,
          executed_at: at,
          pnl: f.pnl || 0,
          trade_type: f.trade_type || 'regular',
        });
      }
    }

    // Merge live (current) + ledger (historical) fills, chronologically.
    const trades = [...liveRegular, ...ledgerRows].sort(
      (a, b) => new Date(a.executed_at) - new Date(b.executed_at)
    );

    // Group by instrument key (exchange + tradingsymbol)
    const grouped = {};
    for (const t of trades) {
      const key = `${t.exchange}::${t.tradingsymbol}`;
      if (!grouped[key]) {
        grouped[key] = {
          exchange: t.exchange,
          tradingsymbol: t.tradingsymbol,
          instrument_token: t.instrument_token,
          buys: [],
          sells: [],
          all_trades: [], // chronological for advanced mode
        };
      }

      // Skip active carry_forward re-opening trades from buy/sell aggregation
      // (they only appear in the Carry Forward section via dedicated query below)
      const isActiveCarryForward = t.trade_type === 'carry_forward' && !t.deleted_at;
      if (isActiveCarryForward) continue;

      const entry = {
        date: t.executed_at,
        qty: t.executed_quantity || 0,
        price: t.executed_price || 0,
        volume: (t.executed_quantity || 0) * (t.executed_price || 0),
      };
      if (t.transaction_type === 'BUY') grouped[key].buys.push(entry);
      else grouped[key].sells.push(entry);

      grouped[key].all_trades.push({
        date: t.executed_at,
        type: t.transaction_type,
        trade_type: t.trade_type || 'regular',
        buy_qty: t.transaction_type === 'BUY' ? (t.executed_quantity || 0) : 0,
        sell_qty: t.transaction_type === 'SELL' ? (t.executed_quantity || 0) : 0,
        rate: t.executed_price || 0,
        brokerage: 0, // Will be recalculated below
        pnl: t.pnl || 0,
      });
    }

    // Load brokerage rules and instrument info for recalculation
    const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();
    const allTokens = [...new Set(trades.map(t => t.instrument_token))];
    const kiteInstruments = await KiteInstrument.find(
      { instrument_token: { $in: allTokens } },
      'instrument_token lot_size segment raw_name name expiry instrument_type'
    ).lean();
    const kiteMap = {};
    kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

    // Build per-instrument summaries
    const instruments = [];
    let grandTotalPnl = 0;
    let grandBrokerage = 0;
    const carryForward = [];

    for (const key of Object.keys(grouped)) {
      const g = grouped[key];
      const totalBuyQty = g.buys.reduce((s, b) => s + b.qty, 0);
      const totalBuyVol = g.buys.reduce((s, b) => s + b.volume, 0);
      const avgBuyPrice = totalBuyQty > 0 ? totalBuyVol / totalBuyQty : 0;

      const totalSellQty = g.sells.reduce((s, b) => s + b.qty, 0);
      const totalSellVol = g.sells.reduce((s, b) => s + b.volume, 0);
      const avgSellPrice = totalSellQty > 0 ? totalSellVol / totalSellQty : 0;

      const matchedQty = Math.min(totalBuyQty, totalSellQty);
      const pnl = matchedQty > 0 ? (avgSellPrice - avgBuyPrice) * matchedQty : 0;

      // Recalculate brokerage from BrokerageSettings (stored trade.brokerage is unreliable)
      const instrTrades = trades.filter(t => `${t.exchange}::${t.tradingsymbol}` === key);
      let brokerage = 0;
      for (const t of instrTrades) {
        // No brokerage on carry_forward or margin_square_off trades
        if (t.trade_type === 'carry_forward' || t.trade_type === 'margin_square_off') continue;

        const ki = kiteMap[t.instrument_token] || {};
        const seg = ki.segment || '';
        const rawName = ki.raw_name || '';
        const lotSize = ki.lot_size || 1;

        let rule = null;
        if (rawName && seg) rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
        if (!rule && rawName) rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
        if (!rule && seg) rule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
        if (!rule) rule = brkRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

        if (rule) {
          if (rule.type === 'TURNOVER WISE') {
            brokerage += t.executed_price * t.executed_quantity * (rule.brk_value / 10000);
          } else if (rule.type === 'LOT WISE') {
            brokerage += (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * rule.brk_value;
          }
        }
      }

      const netPnl = pnl - brokerage;

      grandTotalPnl += pnl;
      grandBrokerage += brokerage;

      // Recalculate per-trade brokerage in all_trades (stored t.brokerage is unreliable)
      const ki = kiteMap[g.instrument_token] || {};
      const seg = ki.segment || '';
      const rawName = ki.raw_name || '';
      const lotSize = ki.lot_size || 1;

      let perTradeRule = null;
      if (rawName && seg) perTradeRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
      if (!perTradeRule && rawName) perTradeRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
      if (!perTradeRule && seg) perTradeRule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
      if (!perTradeRule) perTradeRule = brkRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

      for (const at of g.all_trades) {
        // No brokerage on carry_forward or margin_square_off trades
        if (at.trade_type === 'carry_forward' || at.trade_type === 'margin_square_off') continue;

        if (perTradeRule) {
          const qty = (at.buy_qty || 0) + (at.sell_qty || 0);
          const rate = at.rate || 0;
          if (perTradeRule.type === 'TURNOVER WISE') {
            at.brokerage = Math.round(rate * qty * (perTradeRule.brk_value / 10000) * 100) / 100;
          } else if (perTradeRule.type === 'LOT WISE') {
            at.brokerage = Math.round((lotSize > 1 ? qty / lotSize : qty) * perTradeRule.brk_value * 100) / 100;
          }
        }
      }

      // Build friendly display name from KiteInstrument data
      let displayName = g.tradingsymbol;
      if (ki.name) {
        const base = ki.name;
        if (ki.expiry) {
          const exp = new Date(ki.expiry);
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const day = exp.getDate();
          const month = months[exp.getMonth()];
          if (ki.instrument_type === 'FUT') {
            displayName = `${base} ${day} ${month} FUT`;
          } else if (ki.instrument_type === 'CE' || ki.instrument_type === 'PE') {
            displayName = `${base} ${ki.strike || ''} ${ki.instrument_type} ${day} ${month}`;
          } else {
            displayName = `${base} ${day} ${month}`;
          }
        } else {
          displayName = base;
        }
      }

      instruments.push({
        exchange: g.exchange,
        tradingsymbol: g.tradingsymbol,
        display_name: displayName,
        buys: g.buys,
        sells: g.sells,
        all_trades: g.all_trades,
        total_buy_qty: totalBuyQty,
        total_sell_qty: totalSellQty,
        avg_buy_price: avgBuyPrice,
        avg_sell_price: avgSellPrice,
        total_buy_vol: totalBuyVol,
        total_sell_vol: totalSellVol,
        pnl,
        brokerage,
        net_pnl: netPnl,
      });

      // Carry forward: unmatched qty
      const diff = totalBuyQty - totalSellQty;
      if (diff !== 0) {
        carryForward.push({
          exchange: g.exchange,
          tradingsymbol: g.tradingsymbol,
          display_name: displayName,
          type: diff > 0 ? 'Buy' : 'Sell',
          quantity: Math.abs(diff),
          price: diff > 0 ? avgBuyPrice : avgSellPrice,
        });
      }
    }

    // Also include settlement carry_forward positions (reopened at settlement price).
    // Include both:
    //   - Active (deleted_at: null) → currently open carry-forwards
    //   - Soft-deleted AFTER fromDate → were open during the report period (settled mid-period)
    // This ensures positions that existed during the report window always show in Carry Forward,
    // even if they were subsequently settled by a later settlement run.
    if (targetUserId) {
      const cfTrades = await Trade.find({
        user_id: targetUserId,
        status: 'completed',
        trade_type: 'carry_forward',
        remarks: 'Settlement: position carried forward at close price',
        $or: [
          { deleted_at: null },                        // still open
          { deleted_at: { $gt: fromDate } },           // settled after the report window started
        ],
      }).lean();

      for (const t of cfTrades) {
        const ki = kiteMap[t.instrument_token] || {};
        let displayName = t.tradingsymbol;
        if (ki.name) {
          const base = ki.name;
          if (ki.expiry) {
            const exp = new Date(ki.expiry);
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            displayName = `${base} ${exp.getDate()} ${months[exp.getMonth()]} ${ki.instrument_type || ''}`.trim();
          }
        }

        // Only add if not already in carryForward from the regular trade matching
        const exists = carryForward.some(cf =>
          cf.tradingsymbol === t.tradingsymbol && cf.exchange === t.exchange
        );
        if (!exists) {
          carryForward.push({
            exchange: t.exchange,
            tradingsymbol: t.tradingsymbol,
            display_name: displayName,
            type: t.transaction_type === 'BUY' ? 'Buy' : 'Sell',
            quantity: t.executed_quantity,
            price: t.executed_price,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        user_name: userName,
        from: fromDate,
        to: toDate,
        instruments,
        summary: {
          total_pnl: grandTotalPnl,
          total_brokerage: grandBrokerage,
          net_pnl: grandTotalPnl - grandBrokerage,
        },
        carry_forward: carryForward,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/trade/open-positions
 * Returns actual current open positions for a user by aggregating ALL active trades.
 * No date filter — this is the source of truth for direction and qty.
 * Query: user_id (required for admin/master, optional for user — defaults to self)
 */
const getOpenPositions = async (req, res) => {
  try {
    const { user_id } = req.query;
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    let targetUserId;
    if (role === 'user') {
      targetUserId = new mongoose.Types.ObjectId(callerId);
    } else if (user_id) {
      targetUserId = new mongoose.Types.ObjectId(user_id);
    } else {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    // All active (non-deleted) completed trades — no date filter
    const trades = await Trade.find({
      user_id: targetUserId,
      status: 'completed',
      deleted_at: null,
    }).lean();

    // Compute net position per instrument
    const posMap = {};
    for (const t of trades) {
      const key = `${t.exchange}::${t.tradingsymbol}`;
      if (!posMap[key]) {
        posMap[key] = {
          exchange: t.exchange,
          tradingsymbol: t.tradingsymbol,
          instrument_token: t.instrument_token,
          netQty: 0,
          totalBuyQty: 0,
          totalBuyValue: 0,
          totalSellQty: 0,
          totalSellValue: 0,
        };
      }
      const qty = t.executed_quantity || 0;
      const price = t.executed_price || 0;
      if (t.transaction_type === 'BUY') {
        posMap[key].netQty += qty;
        posMap[key].totalBuyQty += qty;
        posMap[key].totalBuyValue += qty * price;
      } else {
        posMap[key].netQty -= qty;
        posMap[key].totalSellQty += qty;
        posMap[key].totalSellValue += qty * price;
      }
    }

    const openPositions = [];
    for (const pos of Object.values(posMap)) {
      if (Math.abs(pos.netQty) > 0.001) {
        const isLong = pos.netQty > 0;
        const avgPrice = isLong
          ? (pos.totalBuyQty > 0 ? pos.totalBuyValue / pos.totalBuyQty : 0)
          : (pos.totalSellQty > 0 ? pos.totalSellValue / pos.totalSellQty : 0);
        openPositions.push({
          exchange: pos.exchange,
          tradingsymbol: pos.tradingsymbol,
          instrument_token: pos.instrument_token,
          direction: isLong ? 'BUY' : 'SELL',
          open_qty: Math.abs(pos.netQty),
          avg_price: avgPrice,
        });
      }
    }

    res.status(200).json({ success: true, data: openPositions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/trade/settlement-history
 * Returns immutable settlement-ledger snapshots for a user within a period.
 * This is the durable source of truth for historical bills (survives any
 * live Trade-table mutation). Query: user_id (required for admin/master,
 * optional for user — defaults to self), from, to (ISO dates, optional).
 */
const getSettlementHistory = async (req, res) => {
  try {
    const SettlementHistory = require('../models/SettlementHistory');
    const { user_id, from, to } = req.query;
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    let targetUserId;
    if (role === 'user') {
      targetUserId = new mongoose.Types.ObjectId(callerId);
    } else if (user_id) {
      targetUserId = new mongoose.Types.ObjectId(user_id);
    } else {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    const q = { user_id: targetUserId };
    if (from || to) {
      q.period_to = {};
      if (from) q.period_to.$gte = new Date(from);
      if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); q.period_to.$lte = t; }
    }

    const snapshots = await SettlementHistory.find(q)
      .sort({ period_to: -1, tradingsymbol: 1 })
      .lean();

    res.status(200).json({ success: true, data: snapshots });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getTradeReport, getOpenPositions, getSettlementHistory };
