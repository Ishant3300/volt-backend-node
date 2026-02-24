const Trade = require('../models/Trade');
const Master = require('../models/Master');

// Get All Trades in Hierarchy
const getAllTrades = async (req, res) => {
  try {
    const { master_id, user_id, page = 1, limit = 50, date_from, date_to, status } = req.query;

    // Get current master
    const currentMaster = await Master.findById(req.master.id);

    if (!currentMaster) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Build filter - trades where master_id is current master or any of their children
    const filter = {
      deleted_at: null
    };

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

    if (user_id) filter.user_id = user_id;
    if (status) filter.status = status;
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
        trades: trades.map(trade => trade.toJSON()),
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
