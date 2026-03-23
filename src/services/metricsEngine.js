/**
 * Metrics Engine
 *
 * Server-side calculation of the 6 trading metrics for each user:
 *   1. Realised P&L   – sum of (trade.pnl − trade.brokerage) across all completed trades
 *   2. Position P&L    – floating unrealised P&L of open positions
 *   3. M2M P&L         – realised + position P&L
 *   4. Margin Used      – margin blocked by open positions
 *   5. Equity           – credit + M2M P&L  (i.e. credit + realised + position)
 *   6. Free Margin      – equity − margin used
 *
 * On every Kite tick batch, recalculates affected users' metrics
 * and pushes them via WebSocket (NO DB writes on ticks).
 * DB is flushed once daily at midnight via flushAllToDb().
 */

const Trade = require('../models/Trade');
const User = require('../models/User');
const { calculateMargin } = require('./marginService');
const { LOG_LIVE_TICKS } = require('../config/logFlags');

// In-memory cache: userId → { positions, realisedPnl }
// Positions: Map<instrumentToken, { buyQty, sellQty, buyValue, sellValue, exchange, tradingsymbol }>
const _userPositionCache = new Map();

// instrumentToken → Set<userId>  (which users have open positions in this token)
const _tokenToUsers = new Map();


/**
 * Build/rebuild position cache for a single user from DB.
 * Called on startup, after trade execution, or cache miss.
 */
const buildUserCache = async (userId) => {
  // Ensure userId is a proper ObjectId for aggregation
  const mongoose = require('mongoose');
  const uid = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  const trades = await Trade.aggregate([
    { $match: { user_id: uid, status: 'completed', deleted_at: null } },
    {
      $group: {
        _id: { instrument_token: '$instrument_token', exchange: '$exchange' },
        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
        total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
        total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
        tradingsymbol: { $first: '$tradingsymbol' },
      }
    }
  ]);

  // Realised P&L = sum of (pnl − brokerage) across all completed trades.
  // This captures booked profit/loss minus brokerage charges.
  const pnlAgg = await Trade.aggregate([
    { $match: { user_id: uid, status: 'completed', deleted_at: null } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$pnl', '$brokerage'] } } } }
  ]);
  const realisedPnl = pnlAgg.length > 0 ? pnlAgg[0].total : 0;

  const positions = new Map();
  const userIdStr = userId.toString();

  for (const t of trades) {
    const token = t._id.instrument_token;
    const netQty = t.total_buy_qty - t.total_sell_qty;
    positions.set(token, {
      exchange: t._id.exchange,
      tradingsymbol: t.tradingsymbol,
      buyQty: t.total_buy_qty,
      sellQty: t.total_sell_qty,
      buyValue: t.total_buy_value,
      sellValue: t.total_sell_value,
      netQty,
    });

    // Update token→users index (only for open positions)
    if (netQty !== 0) {
      if (!_tokenToUsers.has(token)) _tokenToUsers.set(token, new Set());
      _tokenToUsers.get(token).add(userIdStr);
    } else {
      if (_tokenToUsers.has(token)) _tokenToUsers.get(token).delete(userIdStr);
    }
  }

  _userPositionCache.set(userIdStr, { positions, realisedPnl });
  return { positions, realisedPnl };
};


/**
 * Calculate metrics for a user given current LTP map.
 * Returns the 6 metric fields.
 */
const calcUserMetrics = async (userId, ltpMap) => {
  const userIdStr = userId.toString();
  let cached = _userPositionCache.get(userIdStr);
  if (!cached) {
    cached = await buildUserCache(userId);
  }

  const { positions, realisedPnl } = cached;

  let positionPnl = 0;
  let marginUsed = 0;

  for (const [token, pos] of positions) {
    if (pos.netQty === 0) continue;

    const avgBuy = pos.buyQty > 0 ? pos.buyValue / pos.buyQty : 0;
    const avgSell = pos.sellQty > 0 ? pos.sellValue / pos.sellQty : 0;
    const ltp = ltpMap.get(token) || ltpMap.get(parseInt(token)) || (pos.netQty > 0 ? avgBuy : avgSell);

    if (pos.netQty > 0) {
      positionPnl += (ltp - avgBuy) * pos.netQty;
    } else {
      positionPnl += (avgSell - ltp) * Math.abs(pos.netQty);
    }

    // Use marginService.calculateMargin for proper exchange→segment resolution
    // Pass full quantity so lot-based segments can compute lots correctly
    const positionMargin = await calculateMargin(pos.exchange, Math.abs(pos.netQty), ltp, {
      instrumentToken: token,
      tradingsymbol: pos.tradingsymbol,
    });
    marginUsed += positionMargin;
  }

  const m2mPnl = realisedPnl + positionPnl;

  // Fetch credit for equity calc (credit rarely changes, but keep it fresh)
  const user = await User.findById(userId, 'credits').lean();
  const credit = user?.credits || 0;

  // Equity = Credit + M2M P&L  (M2M already includes realised + position)
  const equity = credit + m2mPnl;
  const freeMargin = equity - marginUsed;

  return {
    realised_pnl: Math.round(realisedPnl * 100) / 100,
    position_pnl: Math.round(positionPnl * 100) / 100,
    m2m_pnl: Math.round(m2mPnl * 100) / 100,
    margin_used: Math.round(marginUsed * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    free_margin: Math.round(freeMargin * 100) / 100,
    credit: Math.round(credit * 100) / 100,
  };
};

/**
 * Called on every tick batch from livePriceService.
 * Finds affected users and pushes updated metrics via WebSocket.
 *
 * @param {Array} ticks - Array of { instrument_token, last_price, ... }
 * @param {Map} latestPrices - Full LTP map from livePriceService
 * @param {Function} broadcastToUser - livePriceService.broadcastToUser
 */
const onTickBatch = async (ticks, latestPrices, broadcastToUser) => {
  try {
    // Find all users affected by these ticks
    const affectedUsers = new Set();
    for (const tick of ticks) {
      const token = tick.instrument_token?.toString();
      if (!token) continue;
      const users = _tokenToUsers.get(token);
      if (users) {
        for (const uid of users) affectedUsers.add(uid);
      }
    }

    if (affectedUsers.size === 0) return;

    // Recalculate and push metrics for each affected user
    for (const userId of affectedUsers) {
      try {
        const metrics = await calcUserMetrics(userId, latestPrices);

        // Push via WebSocket only — NO DB writes on ticks.
        // DB is flushed once daily at midnight via flushAllToDb().
        broadcastToUser(userId, {
          type: 'metrics_update',
          ...metrics,
        });
      } catch (err) {
        console.error(`[MetricsEngine] Error calculating metrics for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[MetricsEngine] onTickBatch error:', err.message);
  }
};

/**
 * Invalidate cache for a user (call after trade execution).
 * Recalculates and optionally pushes metrics immediately.
 */
const invalidateUser = async (userId, latestPrices, broadcastToUser) => {
  const userIdStr = userId.toString();
  _userPositionCache.delete(userIdStr);
  // Rebuild cache
  await buildUserCache(userId);

  if (latestPrices && broadcastToUser) {
    const metrics = await calcUserMetrics(userId, latestPrices);

    // Push via WebSocket only — no DB write on trade events either.
    // DB is flushed once daily at midnight.
    broadcastToUser(userIdStr, {
      type: 'metrics_update',
      ...metrics,
    });

    return metrics;
  }
};

/**
 * Initialize: build cache for all users with open positions.
 * Call once at server startup.
 */
const initialize = async () => {
  console.log('📊 [MetricsEngine] Initializing position caches...');
  try {
    // Find all users who have completed trades
    const userIds = await Trade.distinct('user_id', { status: 'completed', deleted_at: null });
    let openCount = 0;
    for (const uid of userIds) {
      const cached = await buildUserCache(uid);
      // Count users with open positions
      for (const [, pos] of cached.positions) {
        if (pos.netQty !== 0) { openCount++; break; }
      }
    }
    console.log(`📊 [MetricsEngine] Cached ${userIds.length} users, ${openCount} with open positions`);
  } catch (err) {
    console.error('[MetricsEngine] Initialize error:', err.message);
  }
};

/**
 * Flush all cached users' latest metrics to DB.
 * Called once daily at midnight (12:00 AM) so the DB has a snapshot.
 */
const flushAllToDb = async (latestPrices) => {
  console.log('📊 [MetricsEngine] Midnight flush — writing metrics to DB...');
  let count = 0;
  for (const [userIdStr] of _userPositionCache) {
    try {
      const metrics = await calcUserMetrics(userIdStr, latestPrices || new Map());
      await User.updateOne(
        { _id: userIdStr },
        { $set: {
          realised_pnl: metrics.realised_pnl,
          position_pnl: metrics.position_pnl,
          m2m_pnl: metrics.m2m_pnl,
          margin_used: metrics.margin_used,
          equity: metrics.equity,
          free_margin: metrics.free_margin,
        }}
      );
      count++;
    } catch (err) {
      console.error(`[MetricsEngine] Flush error for ${userIdStr}:`, err.message);
    }
  }
  console.log(`📊 [MetricsEngine] Midnight flush complete — ${count} users updated`);
};

/**
 * Schedule the midnight DB flush.
 * Calculates ms until next 00:00 and sets a recurring 24h interval.
 */
let _midnightTimer = null;
const scheduleMidnightFlush = (getLatestPrices) => {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // next midnight
  const msUntilMidnight = midnight.getTime() - now.getTime();

  console.log(`📊 [MetricsEngine] Midnight flush scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);

  _midnightTimer = setTimeout(() => {
    const prices = typeof getLatestPrices === 'function' ? getLatestPrices() : new Map();
    flushAllToDb(prices);
    // Then repeat every 24 hours
    _midnightTimer = setInterval(() => {
      const p = typeof getLatestPrices === 'function' ? getLatestPrices() : new Map();
      flushAllToDb(p);
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
};

module.exports = {
  initialize,
  onTickBatch,
  invalidateUser,
  calcUserMetrics,
  buildUserCache,
  flushAllToDb,
  scheduleMidnightFlush,
};
