const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const TradeMargin = require('../models/TradeMargin');

/**
 * Get aggregated positions across all child users of the logged-in master.
 * Groups by instrument_token, returns net qty and user count per instrument.
 */
const getAggregatedPositions = async (req, res) => {
  try {
    const masterId = req.master.id;

    // Get all child user IDs for this master
    const childUsers = await User.find({
      master_id: masterId,
      deleted_at: null
    }).select('_id name username');

    const childUserIds = childUsers.map(u => u._id);

    if (childUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No child users found',
        data: []
      });
    }

    // Aggregate completed trades across all child users, grouped by instrument
    const positions = await Trade.aggregate([
      {
        $match: {
          user_id: { $in: childUserIds },
          status: 'completed',
          deleted_at: null
        }
      },
      {
        $group: {
          _id: {
            instrument_token: '$instrument_token',
            tradingsymbol: '$tradingsymbol',
            exchange: '$exchange'
          },
          total_buy_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
          },
          total_sell_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
          },
          total_buy_value: {
            $sum: {
              $cond: [
                { $eq: ['$transaction_type', 'BUY'] },
                { $multiply: ['$executed_quantity', '$executed_price'] },
                0
              ]
            }
          },
          total_sell_value: {
            $sum: {
              $cond: [
                { $eq: ['$transaction_type', 'SELL'] },
                { $multiply: ['$executed_quantity', '$executed_price'] },
                0
              ]
            }
          },
          user_ids: { $addToSet: '$user_id' }
        }
      }
    ]);

    // Filter to only instruments with open positions (netQty != 0)
    const result = positions
      .map(p => {
        const netQty = p.total_buy_qty - p.total_sell_qty;
        return {
          instrument_token: p._id.instrument_token,
          tradingsymbol: p._id.tradingsymbol,
          exchange: p._id.exchange,
          net_qty: netQty,
          total_buy_qty: p.total_buy_qty,
          total_sell_qty: p.total_sell_qty,
          total_buy_value: p.total_buy_value,
          total_sell_value: p.total_sell_value,
          user_count: p.user_ids.length
        };
      })
      .filter(p => p.net_qty !== 0);

    res.status(200).json({
      success: true,
      message: 'Master aggregated positions fetched successfully',
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get per-user breakdown for a specific instrument.
 * Shows each child user's position (qty, side, avg price) for the given instrument_token.
 */
const getInstrumentUserBreakdown = async (req, res) => {
  try {
    const masterId = req.master.id;
    const { instrumentToken } = req.params;

    // Get all child user IDs
    const childUsers = await User.find({
      master_id: masterId,
      deleted_at: null
    }).select('_id name username');

    const childUserIds = childUsers.map(u => u._id);
    const userMap = {};
    childUsers.forEach(u => {
      userMap[u._id.toString()] = { name: u.name, username: u.username };
    });

    if (childUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No child users found',
        data: { instrument_token: instrumentToken, users: [] }
      });
    }

    // Aggregate per-user for this instrument
    const perUser = await Trade.aggregate([
      {
        $match: {
          user_id: { $in: childUserIds },
          instrument_token: instrumentToken,
          status: 'completed',
          deleted_at: null
        }
      },
      {
        $group: {
          _id: '$user_id',
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
              $cond: [
                { $eq: ['$transaction_type', 'BUY'] },
                { $multiply: ['$executed_quantity', '$executed_price'] },
                0
              ]
            }
          },
          total_sell_value: {
            $sum: {
              $cond: [
                { $eq: ['$transaction_type', 'SELL'] },
                { $multiply: ['$executed_quantity', '$executed_price'] },
                0
              ]
            }
          }
        }
      }
    ]);

    // Build response with user details
    const users = perUser
      .map(p => {
        const netQty = p.total_buy_qty - p.total_sell_qty;
        const userId = p._id.toString();
        const userInfo = userMap[userId] || { name: 'Unknown', username: 'unknown' };
        const avgBuyPrice = p.total_buy_qty > 0 ? p.total_buy_value / p.total_buy_qty : 0;
        const avgSellPrice = p.total_sell_qty > 0 ? p.total_sell_value / p.total_sell_qty : 0;

        return {
          user_id: userId,
          name: userInfo.name,
          username: userInfo.username,
          net_qty: netQty,
          side: netQty > 0 ? 'BUY' : netQty < 0 ? 'SELL' : 'FLAT',
          avg_buy_price: Math.round(avgBuyPrice * 100) / 100,
          avg_sell_price: Math.round(avgSellPrice * 100) / 100,
          total_buy_qty: p.total_buy_qty,
          total_sell_qty: p.total_sell_qty
        };
      })
      .filter(u => u.net_qty !== 0);

    // Get tradingsymbol and exchange from first result
    const firstTrade = perUser.length > 0 ? perUser[0] : null;

    res.status(200).json({
      success: true,
      message: 'Instrument user breakdown fetched successfully',
      data: {
        instrument_token: instrumentToken,
        tradingsymbol: firstTrade?.tradingsymbol || '',
        exchange: firstTrade?.exchange || '',
        users
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

const _getLivePricesFromKite = async (instrumentTokens) => {
  if (!instrumentTokens || instrumentTokens.length === 0) return new Map();
  try {
    const { getLatestQuotes } = require('../services/kiteService');
    const quotes = await getLatestQuotes(instrumentTokens, 100);
    const ltpMap = new Map();
    quotes.forEach(q => {
      ltpMap.set(q.instrument_token.toString(), q.last_price);
      ltpMap.set(parseInt(q.instrument_token), q.last_price);
    });
    return ltpMap;
  } catch (err) {
    console.error('Error fetching live quotes for metrics fallback:', err.message);
    return new Map();
  }
};

/**
 * Get full position metrics for all child users of the logged-in master.
 * Computes the same 6 metrics as the user's orders page.
 * Uses tradeMetricsService for consistent FIFO P&L calculation.
 */
const getUserMetrics = async (req, res) => {
  try {
    const tradeMetricsService = require('../services/tradeMetricsService');

    // Admin passes ?master_id=xxx to view a specific master's users
    // Or ?user_id=xxx to view a single user's metrics
    const masterId = req.master?.id ?? req.query.master_id;
    const singleUserId = req.query.user_id;

    let childUsers;
    if (singleUserId) {
      const user = await User.findOne({ _id: singleUserId, deleted_at: null })
        .select('_id name username credits balance');
      childUsers = user ? [user] : [];
    } else if (masterId) {
      childUsers = await User.find({
        master_id: masterId,
        deleted_at: null
      }).select('_id name username credits balance');
    } else {
      return res.status(200).json({ success: true, data: [] });
    }

    if (childUsers.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const childUserIds = childUsers.map(u => u._id);

    // Find all active instrument_tokens for these users to fetch LTPs
    const activeTokens = await Trade.distinct('instrument_token', {
      user_id: { $in: childUserIds },
      status: 'completed',
      deleted_at: null
    });

    const ltpMap = await _getLivePricesFromKite(activeTokens.map(t => parseInt(t)));

    // Compute metrics per user using the centralized service
    const result = await Promise.all(childUsers.map(async (user) => {
      try {
        return await tradeMetricsService.getUserMetrics(user._id, ltpMap);
      } catch (err) {
        console.error(`Error computing metrics for user ${user._id}:`, err.message);
        return {
          user_id: user._id,
          name: user.name,
          username: user.username,
          error: 'Failed to compute metrics'
        };
      }
    }));

    res.status(200).json({
      success: true,
      message: 'User metrics fetched successfully',
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Admin endpoint: returns all masters with their users' positions
 * and aggregated P&L metrics per master.
 */
const getAdminMasterMetrics = async (req, res) => {
  try {
    const tradeMetricsService = require('../services/tradeMetricsService');
    const masters = await Master.find({ deleted_at: null }).select('_id name username');

    if (masters.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const masterIds = masters.map(m => m._id);
    const allUsers = await User.find({
      master_id: { $in: masterIds },
      deleted_at: null
    }).select('_id master_id');

    const usersByMaster = {};
    allUsers.forEach(u => {
      const mid = u.master_id.toString();
      if (!usersByMaster[mid]) usersByMaster[mid] = [];
      usersByMaster[mid].push(u._id);
    });

    const result = await Promise.all(masters.map(async (master) => {
      const mid = master._id.toString();
      const userIds = usersByMaster[mid] || [];

      // Find active tokens for this master's users
      const activeTokens = await Trade.distinct('instrument_token', {
        user_id: { $in: userIds },
        status: 'completed',
        deleted_at: null
      });

      const ltpMap = await _getLivePricesFromKite(activeTokens.map(t => parseInt(t)));

      // Fetch metrics for all users under this master
      const userMetrics = await Promise.all(userIds.map(async (uid) => {
        try {
          return await tradeMetricsService.getUserMetrics(uid, ltpMap);
        } catch (e) {
          return null;
        }
      }));

      const validMetrics = userMetrics.filter(m => m !== null);

      // Aggregate master-level metrics
      const masterMetrics = {
        master_id: mid,
        name: master.name,
        username: master.username,
        user_count: userIds.length,
        realised_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.realised_pnl, 0) * 100) / 100,
        position_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.position_pnl, 0) * 100) / 100,
        m2m_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.m2m_pnl, 0) * 100) / 100,
        margin_used: Math.round(validMetrics.reduce((sum, m) => sum + m.margin_used, 0) * 100) / 100,
        equity: Math.round(validMetrics.reduce((sum, m) => sum + m.equity, 0) * 100) / 100,
        positions: [].concat(...validMetrics.map(m => m.positions))
      };

      return masterMetrics;
    }));

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

const moduleExports = {
  getAggregatedPositions,
  getInstrumentUserBreakdown,
  getUserMetrics,
  getAdminMasterMetrics
};

module.exports = moduleExports;
