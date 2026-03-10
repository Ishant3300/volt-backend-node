const Trade = require('../models/Trade');
const User = require('../models/User');
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

    const match = {
      status: 'completed',
      deleted_at: null,
      executed_at: { $gte: fromDate, $lte: toDate },
    };
    if (targetUserId) match.user_id = targetUserId;
    else if (role === 'master') {
      const childIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      match.user_id = { $in: childIds };
    }

    // Fetch user info
    let userName = 'Unknown';
    if (targetUserId) {
      const u = await User.findById(targetUserId).select('username name').lean();
      if (u) userName = u.name || u.username;
    }

    const trades = await Trade.find(match)
      .sort({ executed_at: 1 })
      .lean();

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
        buy_qty: t.transaction_type === 'BUY' ? (t.executed_quantity || 0) : 0,
        sell_qty: t.transaction_type === 'SELL' ? (t.executed_quantity || 0) : 0,
        rate: t.executed_price || 0,
        brokerage: t.brokerage || 0,
        pnl: t.pnl || 0,
      });
    }

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

      // Brokerage from actual trades
      const instrTrades = trades.filter(t => `${t.exchange}::${t.tradingsymbol}` === key);
      const brokerage = instrTrades.reduce((s, t) => s + (t.brokerage || 0), 0);
      const netPnl = pnl - brokerage;

      grandTotalPnl += pnl;
      grandBrokerage += brokerage;

      instruments.push({
        exchange: g.exchange,
        tradingsymbol: g.tradingsymbol,
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
          type: diff > 0 ? 'Buy' : 'Sell',
          quantity: Math.abs(diff),
          price: diff > 0 ? avgBuyPrice : avgSellPrice,
        });
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

module.exports = { getTradeReport };
