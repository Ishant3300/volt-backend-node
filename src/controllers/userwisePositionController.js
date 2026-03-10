const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * GET /api/trade/userwise-positions
 * Returns open positions grouped per user with instrument details.
 * - User: own open positions
 * - Master: child users' open positions
 * - Admin: all users' open positions
 * Query params: search (username), exchange, tradingsymbol
 */
const getUserwisePositions = async (req, res) => {
  try {
    const { search, exchange, tradingsymbol } = req.query;
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';

    let userFilter = {};
    let users = [];

    if (role === 'user') {
      const userId = req.user.id;
      users = await User.find({ _id: userId, deleted_at: null }).select('_id name username master_id');
    } else if (role === 'master') {
      const masterId = req.master.id;
      userFilter = { master_id: masterId, deleted_at: null };
      if (search) userFilter.username = { $regex: search, $options: 'i' };
      users = await User.find(userFilter).select('_id name username master_id');
    } else {
      // admin
      userFilter = { deleted_at: null };
      if (search) userFilter.username = { $regex: search, $options: 'i' };
      users = await User.find(userFilter).select('_id name username master_id');
    }

    if (users.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const userIds = users.map(u => u._id);

    // Build master lookup for master_username
    const masterIds = [...new Set(users.map(u => u.master_id?.toString()).filter(Boolean))];
    const masters = await Master.find({ _id: { $in: masterIds } }).select('_id username');
    const masterMap = {};
    masters.forEach(m => { masterMap[m._id.toString()] = m.username; });

    // Build user info map
    const userMap = {};
    users.forEach(u => {
      userMap[u._id.toString()] = {
        name: u.name,
        username: u.username,
        master_username: masterMap[u.master_id?.toString()] || ''
      };
    });

    // Trade match filter
    const tradeMatch = {
      user_id: { $in: userIds },
      status: 'completed',
      deleted_at: null
    };
    if (exchange) tradeMatch.exchange = exchange;
    if (tradingsymbol) tradeMatch.tradingsymbol = { $regex: tradingsymbol, $options: 'i' };

    // Aggregate per user per instrument
    const positions = await Trade.aggregate([
      { $match: tradeMatch },
      {
        $group: {
          _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
          tradingsymbol: { $first: '$tradingsymbol' },
          exchange: { $first: '$exchange' },
          total_buy_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
          },
          total_sell_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
          },
          total_buy_value: {
            $sum: {
              $cond: [{ $eq: ['$transaction_type', 'BUY'] },
                { $multiply: ['$executed_quantity', '$executed_price'] }, 0]
            }
          },
          total_sell_value: {
            $sum: {
              $cond: [{ $eq: ['$transaction_type', 'SELL'] },
                { $multiply: ['$executed_quantity', '$executed_price'] }, 0]
            }
          }
        }
      }
    ]);

    // Build result — only open positions (net_qty != 0)
    const result = [];
    for (const p of positions) {
      const netQty = p.total_buy_qty - p.total_sell_qty;
      if (netQty === 0) continue;

      const uid = p._id.user_id.toString();
      const info = userMap[uid];
      if (!info) continue;

      const avgBuy = p.total_buy_qty > 0 ? p.total_buy_value / p.total_buy_qty : 0;
      const avgSell = p.total_sell_qty > 0 ? p.total_sell_value / p.total_sell_qty : 0;

      result.push({
        user_id: uid,
        username: info.username,
        master_username: info.master_username,
        instrument_token: p._id.instrument_token,
        tradingsymbol: p.tradingsymbol,
        exchange: p.exchange,
        net_qty: netQty,
        side: netQty > 0 ? 'BUY' : 'SELL',
        avg_buy_price: Math.round(avgBuy * 100) / 100,
        avg_sell_price: Math.round(avgSell * 100) / 100,
        total_buy_qty: p.total_buy_qty,
        total_sell_qty: p.total_sell_qty,
        total_buy_value: Math.round(p.total_buy_value * 100) / 100,
        total_sell_value: Math.round(p.total_sell_value * 100) / 100
      });
    }

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

module.exports = { getUserwisePositions };
