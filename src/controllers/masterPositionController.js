const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Get aggregated positions across all child users of the logged-in master.
 * Groups by instrument_token, returns net qty and user count per instrument.
 */
const getAggregatedPositions = async (req, res) => {
  try {
    const masterId = req.master.id;

    // Get all child user IDs for this master (full hierarchy including sub-masters' users)
    const { getAllSubMasterIds } = require('../services/masterHierarchyService');
    const allMasterIds = await getAllSubMasterIds(masterId);
    const childUsers = await User.find({
      master_id: { $in: allMasterIds },
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

    // Aggregate completed trades per user per instrument first
    const perUserPositions = await Trade.aggregate([
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
            exchange: '$exchange',
            user_id: '$user_id'
          },
          buy_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
          },
          sell_qty: {
            $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
          },
          buy_value: {
            $sum: {
              $cond: [
                { $eq: ['$transaction_type', 'BUY'] },
                { $multiply: ['$executed_quantity', '$executed_price'] },
                0
              ]
            }
          },
          sell_value: {
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

    // Aggregate per-instrument, counting only users with open positions (netQty != 0)
    const instrAgg = {};
    for (const p of perUserPositions) {
      const key = p._id.instrument_token;
      const userNetQty = p.buy_qty - p.sell_qty;
      if (!instrAgg[key]) {
        instrAgg[key] = {
          instrument_token: p._id.instrument_token,
          tradingsymbol: p._id.tradingsymbol,
          exchange: p._id.exchange,
          total_buy_qty: 0, total_sell_qty: 0,
          total_buy_value: 0, total_sell_value: 0,
          open_user_count: 0
        };
      }
      const agg = instrAgg[key];
      agg.total_buy_qty += p.buy_qty;
      agg.total_sell_qty += p.sell_qty;
      agg.total_buy_value += p.buy_value;
      agg.total_sell_value += p.sell_value;
      if (userNetQty !== 0) agg.open_user_count++;
    }

    // Filter to only instruments with open positions (netQty != 0)
    const openPositions = Object.values(instrAgg)
      .map(p => ({
        ...p,
        net_qty: p.total_buy_qty - p.total_sell_qty,
        user_count: p.open_user_count
      }))
      .filter(p => p.net_qty !== 0);

    // Enrich with segment + lot_size from KiteInstrument
    const KiteInstrument = require('../models/KiteInstrument');
    const uniqueTokens = [...new Set(openPositions.map(p => p.instrument_token))];
    const instruments = await KiteInstrument.find(
      { instrument_token: { $in: uniqueTokens } },
      'instrument_token lot_size segment'
    ).lean();
    const instrMap = {};
    instruments.forEach(inst => {
      instrMap[inst.instrument_token] = {
        lot_size: inst.lot_size || 1,
        segment: inst.segment || ''
      };
    });

    const result = openPositions.map(p => {
      const info = instrMap[p.instrument_token] || { lot_size: 1, segment: '' };
      return { ...p, segment: info.segment, lot_size: info.lot_size };
    });

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

    // Get all child user IDs (full hierarchy including sub-masters' users)
    const { getAllSubMasterIds } = require('../services/masterHierarchyService');
    const allMasterIds = await getAllSubMasterIds(masterId);
    const childUsers = await User.find({
      master_id: { $in: allMasterIds },
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
    const metricsEngine = require('../services/metricsEngine');

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
      // Get all users under this master AND all sub-masters (full hierarchy)
      const { getAllSubMasterIds } = require('../services/masterHierarchyService');
      const allMasterIds = await getAllSubMasterIds(masterId);
      childUsers = await User.find({
        master_id: { $in: allMasterIds },
        deleted_at: null
      }).select('_id name username credits balance');
    } else {
      return res.status(200).json({ success: true, data: [] });
    }

    if (childUsers.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // Use metricsEngine as single source of truth
    const result = await Promise.all(childUsers.map(async (user) => {
      try {
        const metrics = await metricsEngine.getFreshMetrics(user._id.toString());
        if (metrics) {
          return {
            user_id: user._id,
            name: user.name,
            username: user.username,
            credit: metrics.credit,
            balance: metrics.equity,
            realised_pnl: metrics.realised_pnl,
            position_pnl: metrics.position_pnl,
            m2m_pnl: metrics.m2m_pnl,
            equity: metrics.equity,
            margin_used: metrics.margin_used,
            free_margin: metrics.free_margin,
            open_positions_count: metrics.positions.length,
            positions: metrics.positions
          };
        }
        // User has no trades
        return {
          user_id: user._id,
          name: user.name,
          username: user.username,
          credit: user.credits || 0,
          balance: user.credits || 0,
          realised_pnl: 0,
          position_pnl: 0,
          m2m_pnl: 0,
          equity: user.credits || 0,
          margin_used: 0,
          free_margin: user.credits || 0,
          open_positions_count: 0,
          positions: []
        };
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
    const metricsEngine = require('../services/metricsEngine');
    // Only fetch top-level masters (master_id: null) — same hierarchy as user management
    const masters = await Master.find({ master_id: null, deleted_at: null }).select('_id name username');

    if (masters.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const masterIds = masters.map(m => m._id);
    
    // For each top-level master, get all descendant master IDs (sub-masters)
    const { getAllSubMasterIds } = require('../services/masterHierarchyService');
    const masterToAllIds = {};
    for (const m of masters) {
      const allIds = await getAllSubMasterIds(m._id.toString());
      masterToAllIds[m._id.toString()] = allIds;
    }

    // Get all users across all masters and their sub-masters
    const allMasterIds = new Set();
    masterIds.forEach(id => allMasterIds.add(id.toString()));
    for (const ids of Object.values(masterToAllIds)) {
      ids.forEach(id => allMasterIds.add(id));
    }

    const allUsers = await User.find({
      master_id: { $in: [...allMasterIds] },
      deleted_at: null
    }).select('_id master_id credits');

    // Group users by top-level master (including sub-masters' users)
    const usersByMaster = {};
    for (const master of masters) {
      const mid = master._id.toString();
      const allIds = new Set([mid, ...(masterToAllIds[mid] || [])]);
      usersByMaster[mid] = allUsers.filter(u => allIds.has(u.master_id.toString()));
    }

    const result = await Promise.all(masters.map(async (master) => {
      const mid = master._id.toString();
      const users = usersByMaster[mid] || [];

      // Get metrics for all users under this master from metricsEngine
      const userMetrics = await Promise.all(users.map(async (u) => {
        try {
          const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
          return metrics;
        } catch (e) {
          return null;
        }
      }));

      const validMetrics = userMetrics.filter(m => m !== null);

      // For users with no trades, add their credits as equity
      let noTradeEquity = 0;
      for (const u of users) {
        const hasMetrics = validMetrics.some(m => m.user_id === u._id.toString());
        if (!hasMetrics) {
          noTradeEquity += u.credits || 0;
        }
      }

      const masterMetrics = {
        master_id: mid,
        name: master.name,
        username: master.username,
        user_count: users.length,
        realised_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.realised_pnl, 0) * 100) / 100,
        position_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.position_pnl, 0) * 100) / 100,
        m2m_pnl: Math.round(validMetrics.reduce((sum, m) => sum + m.m2m_pnl, 0) * 100) / 100,
        margin_used: Math.round(validMetrics.reduce((sum, m) => sum + m.margin_used, 0) * 100) / 100,
        equity: Math.round((validMetrics.reduce((sum, m) => sum + m.equity, 0) + noTradeEquity) * 100) / 100,
        positions: [].concat(...validMetrics.map(m => m.positions))
      };

      return masterMetrics;
    }));

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * Lightweight endpoint returning computed equity per user/master.
 * Admin: returns equity for ALL users and masters.
 * Master: returns equity for child users and child masters.
 * Returns: { users: { id: equity }, masters: { id: equity } }
 */
const getBulkEquity = async (req, res) => {
  try {
    const metricsEngine = require('../services/metricsEngine');
    const isAdmin = !!req.admin;
    const masterId = req.master?.id;

    let users, childMasters;
    if (isAdmin) {
      users = await User.find({ deleted_at: null }).select('_id credits');
      childMasters = await Master.find({ deleted_at: null }).select('_id');
    } else if (masterId) {
      users = await User.find({ master_id: masterId, deleted_at: null }).select('_id credits');
      childMasters = await Master.find({ master_id: masterId, deleted_at: null }).select('_id');
    } else {
      return res.status(200).json({ success: true, data: { users: {}, masters: {} } });
    }

    const userEquityMap = {};
    await Promise.all(users.map(async (u) => {
      try {
        const metrics = await metricsEngine.getFreshMetrics(u._id.toString());
        userEquityMap[u._id.toString()] = metrics
          ? Math.round(metrics.equity * 100) / 100
          : Math.round((u.credits || 0) * 100) / 100;
      } catch (_) {
        userEquityMap[u._id.toString()] = Math.round((u.credits || 0) * 100) / 100;
      }
    }));

    const masterEquityMap = {};
    if (childMasters.length > 0) {
      const allMasterUsers = await User.find({
        master_id: { $in: childMasters.map(m => m._id) },
        deleted_at: null
      }).select('_id master_id');

      const usersByMaster = {};
      allMasterUsers.forEach(u => {
        const mid = u.master_id.toString();
        if (!usersByMaster[mid]) usersByMaster[mid] = [];
        usersByMaster[mid].push(u._id.toString());
      });

      for (const m of childMasters) {
        const mid = m._id.toString();
        const mUserIds = usersByMaster[mid] || [];
        let totalEquity = 0;
        for (const uid of mUserIds) {
          totalEquity += userEquityMap[uid] || 0;
        }
        masterEquityMap[mid] = Math.round(totalEquity * 100) / 100;
      }
    }

    res.status(200).json({
      success: true,
      data: { users: userEquityMap, masters: masterEquityMap }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * Get live metrics from metricsEngine cache.
 * Query params: ?user_id=X or ?master_id=X
 * Returns cached server-computed metrics (same values pushed via WebSocket).
 */
const getLiveMetrics = async (req, res) => {
  try {
    const metricsEngine = require('../services/metricsEngine');
    const { user_id, master_id } = req.query;

    if (user_id) {
      // Try cache first; if empty (user has no active trades post-settlement),
      // build a fresh response from DB so the Position tab shows correct equity.
      let metrics = metricsEngine.getCachedMetrics(user_id);
      if (!metrics) {
        // User not in cache (no active trades) — build a fresh response from DB so the Position tab shows correct equity.
        const User = require('../models/User');
        const user = await User.findById(user_id).select('credits settled_pnl wallet exchanges_allowed').lean();
        if (user) {
          const credit = user.credits || 0;
          
          let equity = 0;
          if (user.wallet && user.exchanges_allowed) {
            const { allowedCategories } = require('../utils/walletCategory');
            const allowedCats = allowedCategories(user.exchanges_allowed);
            const walletSum = allowedCats.reduce((sum, cat) => sum + (Number(user.wallet[cat]) || 0), 0);
            equity = Math.round(walletSum * 100) / 100;
          } else {
            const settledPnl = user.settled_pnl || 0;
            equity = Math.round((credit + settledPnl) * 100) / 100; // Fallback if no wallet
          }

          metrics = {
            user_id,
            credit: Math.round(credit * 100) / 100,
            realised_pnl: 0,
            position_pnl: 0,
            m2m_pnl: 0,
            margin_used: 0,
            equity,
            free_margin: equity,
            positions: [],
          };
        }
      }
      return res.status(200).json({ success: true, data: metrics ? [metrics] : [] });
    }

    if (master_id) {
      const userMetrics = metricsEngine.getMasterUserMetrics(master_id);
      return res.status(200).json({ success: true, data: userMetrics });
    }

    // No filter: return all users under this master
    const masterId = req.master?.id;
    if (masterId) {
      const userMetrics = metricsEngine.getMasterUserMetrics(masterId);
      return res.status(200).json({ success: true, data: userMetrics });
    }

    res.status(200).json({ success: true, data: [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

module.exports = {
  getAggregatedPositions,
  getInstrumentUserBreakdown,
  getUserMetrics,
  getAdminMasterMetrics,
  getBulkEquity,
  getLiveMetrics
};
