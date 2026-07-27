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
    let targetIsMaster = false;
    if (role === 'user') {
      targetUserId = new mongoose.Types.ObjectId(callerId);
    } else if (user_id) {
      targetUserId = new mongoose.Types.ObjectId(user_id);
    } else {
      targetUserId = null; // admin/master without user_id = all users
    }

    // User scope (applied to both the live Trade collection and the ledger)
    const userScope = {};
    if (targetUserId) {
      // Check if the target is a User or a Master
      const targetUser = await User.findById(targetUserId).select('_id username name').lean();
      if (targetUser) {
        // It's a user — scope to this single user
        userScope.user_id = targetUserId;
      } else {
        // It's a master — scope to all DIRECT child users of this master
        // (excludes users of sub-masters)
        const Master = require('../models/Master');
        const targetMaster = await Master.findById(targetUserId).select('_id username name').lean();
        if (targetMaster) {
          targetIsMaster = true;
          const directChildUsers = await User.find({ master_id: targetUserId, deleted_at: null }).distinct('_id');
          if (directChildUsers.length > 0) {
            userScope.user_id = { $in: directChildUsers };
          } else {
            userScope.user_id = targetUserId; // fallback (will return empty)
          }
        } else {
          userScope.user_id = targetUserId;
        }
      }
    } else if (role === 'master') {
      const childIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      userScope.user_id = { $in: childIds };
    }

    // Fetch user/master name for the PDF header
    let userName = 'Unknown';
    if (targetUserId) {
      if (targetIsMaster) {
        const Master = require('../models/Master');
        const m = await Master.findById(targetUserId).select('username name').lean();
        if (m) userName = m.name || m.username;
      } else {
        const u = await User.findById(targetUserId).select('username name').lean();
        if (u) userName = u.name || u.username;
      }
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
          _stored_brokerage: f.brokerage || 0,  // brokerage calculated at settlement time
          _is_ledger: true,
        });
      }

      // Include settlement closing entry if the snapshot has a closing position.
      // This represents the unrealised P&L that was locked at settlement price.
      // Without this, the General PDF only shows booked trades but misses the
      // settlement-close P&L for open positions.
      if (s.closing_qty > 0 && s.settlement_price > 0) {
        const settleDate = new Date(s.settlement_date || s.period_to);
        if (settleDate >= fromDate && settleDate <= toDate) {
          // The closing trade: opposite side at settlement price
          ledgerRows.push({
            exchange: s.exchange,
            tradingsymbol: s.tradingsymbol,
            instrument_token: s.instrument_token,
            transaction_type: s.closing_side || (s.carry_forward_side === 'BUY' ? 'SELL' : 'BUY'),
            executed_quantity: s.closing_qty,
            executed_price: s.settlement_price,
            executed_at: settleDate,
            pnl: s.settlement_pnl || 0,
            trade_type: 'settlement_close',
            _stored_brokerage: 0,
            _is_ledger: true,
          });
        }
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
      'instrument_token lot_size segment raw_name name expiry instrument_type strike'
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
      // Use sum of per-trade FIFO P&L (stored by backend at execution time) — not the
      // average-based (avgSell - avgBuy) × matchedQty formula which gives wrong results
      // when multiple buys/sells happen at different prices within the period.
      const pnl = g.all_trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

      // Brokerage: for ledger (settled) rows use the stored value captured at settlement time.
      // For live rows recalculate, but only with rules that were effective at the trade date
      // (prevents a brokerage rate change from retroactively affecting old trades).
      const instrTrades = trades.filter(t => `${t.exchange}::${t.tradingsymbol}` === key);
      let brokerage = 0;
      for (const t of instrTrades) {
        if (t.trade_type === 'carry_forward' || t.trade_type === 'margin_square_off') continue;

        // Settled/historical fills: trust the brokerage stored in the ledger.
        if (t._is_ledger) {
          brokerage += t._stored_brokerage || 0;
          continue;
        }

        // Live fills: recalculate using only rules effective at the trade's execution time.
        const tradeDate = new Date(t.executed_at);
        const ki = kiteMap[t.instrument_token] || {};
        const seg = ki.segment || '';
        const rawName = ki.raw_name || '';
        const lotSize = ki.lot_size || 1;

        // Filter to rules effective at tradeDate, then pick the most recently effective one.
        const effectiveRules = brkRules.filter(r =>
          !r.effective_from || new Date(r.effective_from) <= tradeDate
        );

        const pickRule = (candidates) => candidates.sort(
          (a, b) => new Date(b.effective_from || 0) - new Date(a.effective_from || 0)
        )[0] || null;

        let rule = null;
        if (rawName && seg) rule = pickRule(effectiveRules.filter(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase()));
        if (!rule && rawName) rule = pickRule(effectiveRules.filter(r => r.script_name?.toUpperCase() === rawName.toUpperCase()));
        if (!rule && seg) rule = pickRule(effectiveRules.filter(r => r.exchange_name === seg.toUpperCase() && !r.script_name));
        if (!rule) rule = pickRule(effectiveRules.filter(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name));

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

      // Per-trade brokerage in all_trades: use stored value for ledger rows,
      // recalculate with effective rules for live rows.
      const ki = kiteMap[g.instrument_token] || {};
      const seg = ki.segment || '';
      const rawName = ki.raw_name || '';
      const lotSize = ki.lot_size || 1;

      for (const at of g.all_trades) {
        if (at.trade_type === 'carry_forward' || at.trade_type === 'margin_square_off') continue;

        // Ledger (settled) fill: use brokerage stored at settlement time — no recalculation.
        if (at._is_ledger) {
          at.brokerage = at._stored_brokerage || 0;
          continue;
        }

        // Live fill: find effective rule at the trade date to avoid retroactive changes.
        if (at.rate && (at.buy_qty || at.sell_qty)) {
          const tradeDate = new Date(at.date);
          const effectiveRules = brkRules.filter(r =>
            !r.effective_from || new Date(r.effective_from) <= tradeDate
          );
          const pickRule2 = (candidates) => candidates.sort(
            (a, b) => new Date(b.effective_from || 0) - new Date(a.effective_from || 0)
          )[0] || null;

          let atRule = null;
          if (rawName && seg) atRule = pickRule2(effectiveRules.filter(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase()));
          if (!atRule && rawName) atRule = pickRule2(effectiveRules.filter(r => r.script_name?.toUpperCase() === rawName.toUpperCase()));
          if (!atRule && seg) atRule = pickRule2(effectiveRules.filter(r => r.exchange_name === seg.toUpperCase() && !r.script_name));
          if (!atRule) atRule = pickRule2(effectiveRules.filter(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name));

          if (atRule) {
            const qty = (at.buy_qty || 0) + (at.sell_qty || 0);
            const rate = at.rate || 0;
            if (atRule.type === 'TURNOVER WISE') {
              at.brokerage = Math.round(rate * qty * (atRule.brk_value / 10000) * 100) / 100;
            } else if (atRule.type === 'LOT WISE') {
              at.brokerage = Math.round((lotSize > 1 ? qty / lotSize : qty) * atRule.brk_value * 100) / 100;
            }
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
      // Use the same user scope as the main query (handles master → direct child users)
      const cfUserFilter = userScope.user_id ? { user_id: userScope.user_id } : { user_id: targetUserId };
      const cfTrades = await Trade.find({
        ...cfUserFilter,
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
            const d = exp.getDate(), m = months[exp.getMonth()];
            if (ki.instrument_type === 'FUT') {
              displayName = `${base} ${d} ${m} FUT`;
            } else if (ki.instrument_type === 'CE' || ki.instrument_type === 'PE') {
              displayName = `${base} ${ki.strike || ''} ${ki.instrument_type} ${d} ${m}`.replace(/\s+/g, ' ').trim();
            } else {
              displayName = `${base} ${d} ${m}`;
            }
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
