const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const mongoose = require('mongoose');

/**
 * GET /api/trade/deleted-trades
 * Returns only soft-deleted trades (deleted_at != null).
 *
 * Role-based:
 *   User:   own deleted trades
 *   Master: deleted trades of child users
 *   Admin:  all deleted trades
 *
 * Query: page, limit, search (tradingsymbol or username), date (YYYY-MM-DD)
 */
const getDeletedTrades = async (req, res) => {
  try {
    const { page = 1, limit = 50, search, date } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    const filter = { deleted_at: { $ne: null } };

    if (role === 'user') {
      filter.user_id = new mongoose.Types.ObjectId(callerId);
    } else if (role === 'master') {
      const childIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      filter.user_id = { $in: childIds };
    }
    // admin: no user_id filter

    if (search) {
      filter.$or = [
        { tradingsymbol: { $regex: search, $options: 'i' } },
      ];
    }

    if (date) {
      const d = new Date(date);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      filter.deleted_at = { $ne: null, $gte: d, $lt: next };
    }

    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .sort({ deleted_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('user_id', 'username name master_id')
        .lean(),
      Trade.countDocuments(filter),
    ]);

    // Collect master IDs for lookup
    const masterIds = [...new Set(
      trades.map(t => t.user_id?.master_id?.toString()).filter(Boolean)
    )];
    const masters = await Master.find({ _id: { $in: masterIds } }).select('_id username').lean();
    const masterMap = {};
    masters.forEach(m => { masterMap[m._id.toString()] = m.username; });

    const data = trades.map(t => ({
      id: t._id,
      tradingsymbol: t.tradingsymbol,
      exchange: t.exchange,
      transaction_type: t.transaction_type,
      order_type: t.order_type,
      quantity: t.quantity,
      price: t.price,
      executed_price: t.executed_price,
      executed_quantity: t.executed_quantity,
      remarks: t.remarks || '',
      username: t.user_id?.username || 'Unknown',
      name: t.user_id?.name || '',
      master_username: masterMap[t.user_id?.master_id?.toString()] || '',
      created_at: t.createdAt,
      deleted_at: t.deleted_at,
    }));

    res.status(200).json({ success: true, data, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getDeletedTrades };
