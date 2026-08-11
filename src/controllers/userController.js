const User = require('../models/User');
const Trade = require('../models/Trade');
const KiteInstrument = require('../models/KiteInstrument');

// Enrich trades with correct lot_size from KiteInstrument
const enrichTradesWithLotSize = async (trades) => {
    const uniqueTokens = [...new Set(trades.map(t => t.instrument_token))];
    const instruments = await KiteInstrument.find(
        { instrument_token: { $in: uniqueTokens } },
        'instrument_token lot_size segment'
    );
    const lotSizeMap = {};
    instruments.forEach(inst => {
        lotSizeMap[inst.instrument_token] = { lot_size: inst.lot_size || 1, segment: inst.segment || '' };
    });
    return trades.map(t => {
        const plain = t.toJSON ? t.toJSON() : { ...t };
        const info = lotSizeMap[t.instrument_token] || { lot_size: 1, segment: '' };
        plain.lot_size = info.lot_size || 1;
        if (!plain.segment) plain.segment = info.segment;
        return plain;
    });
};

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
        const { page = 1, limit = 50, date_from, date_to, status, exchange, tradingsymbol } = req.query;

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
        if (exchange) filter.exchange = exchange;
        if (tradingsymbol) filter.tradingsymbol = { $regex: tradingsymbol, $options: 'i' };

        if (date_from || date_to) {
            filter.createdAt = {};
            if (date_from) filter.createdAt.$gte = new Date(date_from);
            if (date_to) filter.createdAt.$lte = new Date(date_to);
        }

        const trades = await Trade.find(filter)
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const count = await Trade.countDocuments(filter);

        res.status(200).json({
            success: true,
            message: 'User trades retrieved successfully',
            data: {
                trades: await enrichTradesWithLotSize(trades),
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
