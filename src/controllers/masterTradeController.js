const Trade = require('../models/Trade');
const Master = require('../models/Master');

// Get All Trades in Hierarchy
const getAllTrades = async (req, res) => {
  try {
    const { master_id, user_id, page = 1, limit = 50, date_from, date_to, status, exchange, tradingsymbol } = req.query;

    const filter = {
      deleted_at: null
    };

    // Admin calling with master_id: fetch trades for that master and its children
    if (req.admin && master_id) {
      const targetMaster = await Master.findById(master_id);
      if (!targetMaster) {
        return res.status(404).json({ success: false, message: 'Master not found', data: null });
      }
      const childMasters = await Master.find({ master_id: master_id, deleted_at: null }).select('_id');
      const masterIds = childMasters.map(m => m._id);
      masterIds.push(targetMaster._id);
      filter.master_id = { $in: masterIds };
    } else if (req.admin) {
      // Admin without master_id: return all trades (no filter needed)
    } else {
      // Master flow
      const currentMaster = await Master.findById(req.master.id);

      if (!currentMaster) {
        return res.status(404).json({
          success: false,
          message: 'Master not found',
          data: null
        });
      }

      // If specific master_id provided, verify it's a child
      if (master_id) {
        const childMaster = await Master.findOne({
          _id: master_id,
          master_id: req.master.id,
          deleted_at: null
        });

        if (!childMaster) {
          return res.status(403).json({
            success: false,
            message: 'You can only view trades from your child masters',
            data: null
          });
        }

        filter.master_id = master_id;
      } else {
        // Get all child masters
        const childMasters = await Master.find({
          master_id: req.master.id,
          deleted_at: null
        }).select('_id');

        const childMasterIds = childMasters.map(m => m._id);
        childMasterIds.push(currentMaster._id); // Include current master's trades

        filter.master_id = { $in: childMasterIds };
      }
    }

    if (user_id) filter.user_id = user_id;
    if (status) filter.status = status;
    if (exchange) filter.exchange = exchange;
    if (tradingsymbol) filter.tradingsymbol = { $regex: tradingsymbol, $options: 'i' };
    if (date_from || date_to) {
      filter.createdAt = {};
      if (date_from) filter.createdAt.$gte = new Date(date_from);
      if (date_to) filter.createdAt.$lte = new Date(date_to);
    }

    const trades = await Trade.find(filter)
      .populate('user_id', 'name username')
      .populate('master_id', 'name username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await Trade.countDocuments(filter);

    // Calculate summary
    const summary = await Trade.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total_trades: { $sum: 1 },
          total_pnl: { $sum: '$pnl' },
          total_brokerage: { $sum: '$brokerage' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      message: 'Trades retrieved successfully',
      data: {
        trades: trades.map(trade => {
          const t = trade.toJSON();
          // Flatten populated user_id and master_id into top-level fields
          if (t.user_id && typeof t.user_id === 'object') {
            t.user_name = t.user_id.name || null;
            t.user_username = t.user_id.username || null;
            t.user_id = t.user_id.id || t.user_id._id || t.user_id;
          }
          if (t.master_id && typeof t.master_id === 'object') {
            t.master_name = t.master_id.name || null;
            t.master_id = t.master_id.id || t.master_id._id || t.master_id;
          }
          return t;
        }),
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / limit),
        summary: summary[0] || { total_trades: 0, total_pnl: 0, total_brokerage: 0 }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

module.exports = {
  getAllTrades
};
