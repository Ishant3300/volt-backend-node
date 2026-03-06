const Trade = require('../models/Trade');
const User = require('../models/User');
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

/**
 * Get full position metrics for all child users of the logged-in master.
 * Computes the same 6 metrics as the user's orders page:
 *   - Position P&L (floating), Realised P&L, M2M P&L, Credit, Margin Used, Equity
 * Returns per-user across ALL their instruments.
 */
const getUserMetrics = async (req, res) => {
  try {
    const masterId = req.master.id;

    // Get all child users with credit/balance
    const childUsers = await User.find({
      master_id: masterId,
      deleted_at: null
    }).select('_id name username credits balance');

    const childUserIds = childUsers.map(u => u._id);

    if (childUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No child users found',
        data: []
      });
    }

    // Get margin rules
    const marginRules = await TradeMargin.find({ deleted_at: null });
    const marginMap = {};
    marginRules.forEach(m => {
      marginMap[m.exchange_name] = {
        amount_type: m.amount_type,
        trade_margin: m.trade_margin
      };
    });

    // Get all completed trades for all child users
    const trades = await Trade.find({
      user_id: { $in: childUserIds },
      status: 'completed',
      deleted_at: null
    }).select('user_id instrument_token tradingsymbol exchange transaction_type executed_quantity executed_price').lean();

    // Group trades by user_id, then by instrument_token
    const userTradeMap = {};
    for (const t of trades) {
      const uid = t.user_id.toString();
      if (!userTradeMap[uid]) userTradeMap[uid] = {};
      const iToken = t.instrument_token;
      if (!userTradeMap[uid][iToken]) {
        userTradeMap[uid][iToken] = {
          exchange: t.exchange,
          tradingsymbol: t.tradingsymbol,
          totalBuyQty: 0,
          totalSellQty: 0,
          totalBuyValue: 0,
          totalSellValue: 0
        };
      }
      const agg = userTradeMap[uid][iToken];
      if (t.transaction_type === 'BUY') {
        agg.totalBuyQty += t.executed_quantity;
        agg.totalBuyValue += t.executed_quantity * t.executed_price;
      } else if (t.transaction_type === 'SELL') {
        agg.totalSellQty += t.executed_quantity;
        agg.totalSellValue += t.executed_quantity * t.executed_price;
      }
    }

    // Compute metrics per user
    const result = childUsers.map(user => {
      const uid = user._id.toString();
      const instruments = userTradeMap[uid] || {};
      const balance = user.balance || 0;

      let totalRealised = 0;
      let totalFloating = 0;
      let totalMargin = 0;
      const positions = [];

      for (const [iToken, agg] of Object.entries(instruments)) {
        const netQty = agg.totalBuyQty - agg.totalSellQty;
        const avgBuyPrice = agg.totalBuyQty > 0 ? agg.totalBuyValue / agg.totalBuyQty : 0;
        const avgSellPrice = agg.totalSellQty > 0 ? agg.totalSellValue / agg.totalSellQty : 0;

        // Use avgBuyPrice as fallback LTP (no live price on backend)
        const ltp = avgBuyPrice > 0 ? avgBuyPrice : avgSellPrice;

        let realised = 0;
        let floating = 0;

        if (netQty > 0) {
          realised = agg.totalSellValue - (agg.totalSellQty * avgBuyPrice);
          floating = (ltp - avgBuyPrice) * netQty;
        } else if (netQty < 0) {
          realised = (agg.totalBuyQty * avgSellPrice) - agg.totalBuyValue;
          floating = (avgSellPrice - ltp) * Math.abs(netQty);
        } else {
          realised = agg.totalSellValue - agg.totalBuyValue;
          floating = 0;
        }

        totalRealised += realised;
        totalFloating += floating;

        // Margin calculation
        if (netQty !== 0) {
          const rule = marginMap[agg.exchange];
          if (rule) {
            if (rule.amount_type === 'percentage') {
              const contractValue = Math.abs(netQty) * ltp;
              totalMargin += (contractValue * rule.trade_margin) / 100;
            } else {
              totalMargin += Math.abs(netQty) * rule.trade_margin;
            }
          }
        }

        if (netQty !== 0) {
          positions.push({
            instrument_token: iToken,
            tradingsymbol: agg.tradingsymbol,
            exchange: agg.exchange,
            net_qty: netQty,
            avg_buy_price: Math.round(avgBuyPrice * 100) / 100,
            avg_sell_price: Math.round(avgSellPrice * 100) / 100,
            total_buy_qty: agg.totalBuyQty,
            total_sell_qty: agg.totalSellQty,
            total_buy_value: Math.round(agg.totalBuyValue * 100) / 100,
            total_sell_value: Math.round(agg.totalSellValue * 100) / 100
          });
        }
      }

      const m2m = totalRealised + totalFloating;
      const equity = balance + m2m;
      const freeMargin = equity - totalMargin;

      return {
        user_id: uid,
        name: user.name,
        username: user.username,
        credit: user.credits || 0,
        balance: balance,
        realised_pnl: Math.round(totalRealised * 100) / 100,
        position_pnl: Math.round(totalFloating * 100) / 100,
        m2m_pnl: Math.round(m2m * 100) / 100,
        margin_used: Math.round(totalMargin * 100) / 100,
        equity: Math.round(equity * 100) / 100,
        free_margin: Math.round(freeMargin * 100) / 100,
        positions
      };
    });

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

module.exports = {
  getAggregatedPositions,
  getInstrumentUserBreakdown,
  getUserMetrics
};
