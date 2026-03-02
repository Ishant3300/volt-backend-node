const User = require('../models/User');
const Trade = require('../models/Trade');

// Get User Profile
const getUserProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        // Parameter ID
        const { id } = req.params;

        // Check if the user is requesting their own profile
        if (userId !== id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own profile.',
                data: null
            });
        }

        const user = await User.findById(id)
            .populate('server_id', 'name')
            .populate('master_id', 'username');

        if (!user || user.deleted_at) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
                data: null
            });
        }

        res.status(200).json({
            success: true,
            message: 'User profile retrieved successfully',
            data: user.toJSON()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

// Get User Trades
const getUserTrades = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { page = 1, limit = 50, date_from, date_to, status } = req.query;

        // Check if the user is requesting their own trades
        if (userId !== id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own trades.',
                data: null
            });
        }

        const filter = { user_id: id };
        if (status) filter.status = status;

        if (date_from || date_to) {
            filter.created_at = {};
            if (date_from) filter.created_at.$gte = new Date(date_from);
            if (date_to) filter.created_at.$lte = new Date(date_to);
        }

        const trades = await Trade.find(filter)
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ created_at: -1 });

        const count = await Trade.countDocuments(filter);

        res.status(200).json({
            success: true,
            message: 'User trades retrieved successfully',
            data: {
                trades: trades.map(t => t.toJSON()),
                total: count,
                page: parseInt(page),
                pages: Math.ceil(count / limit)
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
    getUserProfile,
    getUserTrades
};
