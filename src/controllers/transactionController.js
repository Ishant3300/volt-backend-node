const Transaction = require('../models/Transaction');
const mongoose = require('mongoose');

/**
 * Get transaction history for a user or master.
 * Query params: target_id (required), target_model (User|Master), page, limit
 */
const getTransactionHistory = async (req, res) => {
  try {
    const { target_id, target_model = 'User', page = 1, limit = 50 } = req.query;

    if (!target_id) {
      return res.status(400).json({ success: false, message: 'target_id is required' });
    }

    const filter = {
      userId: new mongoose.Types.ObjectId(target_id),
      userModel: target_model,
      status: 'SUCCESS'
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Transaction.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: {
        transactions,
        total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getTransactionHistory };
