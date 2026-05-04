const Trade = require('../models/Trade');
const User = require('../models/User');
const mongoose = require('mongoose');

/**
 * GET /api/trade/rejection-log
 * Returns cancelled, rejected, and soft-deleted trades.
 * 
 * Role-based:
 *   User:  own trades only
 *   Master: trades of child users
 *   Admin:  all trades
 *
 * Query: page, limit, search (tradingsymbol)
 */
const getRejectionLog = async (req, res) => {
  try {
    const { page = 1, limit = 50, search, user_id } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    const callerId = req.admin?.id || req.master?.id || req.user?.id;

    // Base filter: cancelled/rejected OR soft-deleted
    const filter = {
      $or: [
        { status: { $in: ['cancelled', 'rejected'] } },
        { deleted_at: { $ne: null } },
      ],
    };

    // If a specific user_id is requested (from username_view), filter to that user
    if (user_id && (role === 'admin' || role === 'master')) {
      filter.user_id = new mongoose.Types.ObjectId(user_id);
    } else if (role === 'user') {
      filter.user_id = new mongoose.Types.ObjectId(callerId);
    } else if (role === 'master') {
      const childIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      filter.user_id = { $in: childIds };
    }
    // admin without user_id: no user filter — sees all

    if (search) {
      filter.tradingsymbol = { $regex: search, $options: 'i' };
    }

    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('user_id', 'username name')
        .lean(),
      Trade.countDocuments(filter),
    ]);

    const data = trades.map(t => ({
      id: t._id,
      tradingsymbol: t.tradingsymbol,
      exchange: t.exchange,
      transaction_type: t.transaction_type,
      order_type: t.order_type,
      quantity: t.quantity,
      price: t.price,
      status: t.deleted_at ? 'deleted' : t.status,
      remarks: t.remarks || '',
      username: t.user_id?.username || 'Unknown',
      name: t.user_id?.name || '',
      executed_at: t.executed_at,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      deleted_at: t.deleted_at,
    }));

    res.status(200).json({ success: true, data, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getRejectionLog };
