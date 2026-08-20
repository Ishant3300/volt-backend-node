/**
 * Order Book Service  (Redis-backed)
 *
 * Uses Redis Sorted Sets to maintain an in-memory order book.
 *
 * Key schema
 * ----------
 *   ob:{instrument_token}:buy       – LIMIT buys,  score = limitPrice
 *   ob:{instrument_token}:sell      – LIMIT sells, score = limitPrice
 *   ob:{instrument_token}:stopbuy   – SL/SL-M buys,  score = triggerPrice
 *   ob:{instrument_token}:stopsell  – SL/SL-M sells, score = triggerPrice
 *
 * Each member is the trade's MongoDB _id (string).
 *
 * Why two separate pairs of sets for LIMIT vs stop orders, not one?
 *   A LIMIT BUY and a stop (SL/SL-M) BUY trigger on OPPOSITE price movement:
 *   a LIMIT buyer wants to buy once the price falls to/below their price
 *   (an entry), while a stop buyer wants to buy once the price rises
 *   to/above their trigger (typically closing out a short before the loss
 *   grows). Storing both in the same sorted set and querying with the same
 *   ZRANGEBYSCORE direction would fire stop orders at the wrong time (e.g.
 *   immediately, or never) — this was a real bug: SL/SL-M orders were
 *   simply never registered anywhere at all (only LIMIT was), so they sat
 *   pending forever with zero stop-loss protection. Separate sets with
 *   deliberately inverted range queries fix that without disturbing the
 *   already-correct LIMIT matching.
 *
 * Why sorted sets?
 *   • ZRANGEBYSCORE lets us grab all BUY orders with price >= livePrice in O(log N + M)
 *   • ZRANGEBYSCORE lets us grab all SELL orders with price <= livePrice
 *   • Adding / removing a single order is O(log N)
 */

const redisService = require('./redisService');

// ─── Key helpers ────────────────────────────────────────────────────────────

const _buyKey = (token) => `ob:${token}:buy`;
const _sellKey = (token) => `ob:${token}:sell`;
const _stopBuyKey = (token) => `ob:${token}:stopbuy`;
const _stopSellKey = (token) => `ob:${token}:stopsell`;

const _isStop = (orderType) => orderType === 'SL' || orderType === 'SL-M';

const _key = (instrumentToken, side, orderType) => {
  const stop = _isStop(orderType);
  if (side === 'BUY') return stop ? _stopBuyKey(instrumentToken) : _buyKey(instrumentToken);
  return stop ? _stopSellKey(instrumentToken) : _sellKey(instrumentToken);
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a pending order (LIMIT or SL/SL-M) in the Redis order book.
 *
 * @param {string} tradeId        – MongoDB _id of the Trade document
 * @param {string} instrumentToken
 * @param {number} limitPrice     – limit price for LIMIT, trigger price for SL/SL-M
 * @param {'BUY'|'SELL'} side
 * @param {'LIMIT'|'SL'|'SL-M'} [orderType='LIMIT']
 */
const addOrder = async (tradeId, instrumentToken, limitPrice, side, orderType = 'LIMIT') => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [OrderBook] Redis unavailable – skipping addOrder');
    return false;
  }

  try {
    const key = _key(instrumentToken, side, orderType);
    // Score = limitPrice/triggerPrice so we can range-query efficiently
    await redisService.getClient().zadd(key, limitPrice, tradeId);
    console.log(`📗 [OrderBook] Added ${orderType} ${side} order ${tradeId} @ ${limitPrice} for token ${instrumentToken}`);
    return true;
  } catch (err) {
    console.error(`❌ [OrderBook] addOrder error: ${err.message}`);
    return false;
  }
};

/**
 * Remove an order from the book (on cancel or execution).
 */
const removeOrder = async (tradeId, instrumentToken, side, orderType = 'LIMIT') => {
  if (!redisService.isAvailable()) return false;

  try {
    const key = _key(instrumentToken, side, orderType);
    await redisService.getClient().zrem(key, tradeId);
    console.log(`📕 [OrderBook] Removed ${orderType} ${side} order ${tradeId} for token ${instrumentToken}`);
    return true;
  } catch (err) {
    console.error(`❌ [OrderBook] removeOrder error: ${err.message}`);
    return false;
  }
};

/**
 * Find all LIMIT BUY orders whose limitPrice >= livePrice
 * (i.e. the buyer is willing to pay at least the current price).
 *
 * Returns array of tradeId strings.
 */
const getMatchingBuyOrders = async (instrumentToken, livePrice) => {
  if (!redisService.isAvailable()) return [];

  try {
    const key = _buyKey(instrumentToken);
    // BUY executes when livePrice <= limitPrice
    // So we want all orders with score (limitPrice) >= livePrice
    const tradeIds = await redisService.getClient().zrangebyscore(key, livePrice, '+inf');
    return tradeIds;
  } catch (err) {
    console.error(`❌ [OrderBook] getMatchingBuyOrders error: ${err.message}`);
    return [];
  }
};

/**
 * Find all LIMIT SELL orders whose limitPrice <= livePrice
 * (i.e. the seller wants at least this price and the market is there).
 *
 * Returns array of tradeId strings.
 */
const getMatchingSellOrders = async (instrumentToken, livePrice) => {
  if (!redisService.isAvailable()) return [];

  try {
    const key = _sellKey(instrumentToken);
    // SELL executes when livePrice >= limitPrice
    // So we want all orders with score (limitPrice) <= livePrice
    const tradeIds = await redisService.getClient().zrangebyscore(key, '-inf', livePrice);
    return tradeIds;
  } catch (err) {
    console.error(`❌ [OrderBook] getMatchingSellOrders error: ${err.message}`);
    return [];
  }
};

/**
 * Find all stop (SL/SL-M) BUY orders whose triggerPrice <= livePrice —
 * INVERTED from a LIMIT buy. A stop BUY (typically covering a short before
 * the loss grows) triggers once the price rises to/through the trigger, so
 * it fires when livePrice >= triggerPrice, i.e. all orders with score
 * (triggerPrice) <= livePrice.
 *
 * Returns array of tradeId strings.
 */
const getMatchingStopBuyOrders = async (instrumentToken, livePrice) => {
  if (!redisService.isAvailable()) return [];

  try {
    const key = _stopBuyKey(instrumentToken);
    const tradeIds = await redisService.getClient().zrangebyscore(key, '-inf', livePrice);
    return tradeIds;
  } catch (err) {
    console.error(`❌ [OrderBook] getMatchingStopBuyOrders error: ${err.message}`);
    return [];
  }
};

/**
 * Find all stop (SL/SL-M) SELL orders whose triggerPrice >= livePrice —
 * INVERTED from a LIMIT sell. A stop SELL (typically closing a long before
 * the loss grows) triggers once the price falls to/through the trigger, so
 * it fires when livePrice <= triggerPrice, i.e. all orders with score
 * (triggerPrice) >= livePrice.
 *
 * Returns array of tradeId strings.
 */
const getMatchingStopSellOrders = async (instrumentToken, livePrice) => {
  if (!redisService.isAvailable()) return [];

  try {
    const key = _stopSellKey(instrumentToken);
    const tradeIds = await redisService.getClient().zrangebyscore(key, livePrice, '+inf');
    return tradeIds;
  } catch (err) {
    console.error(`❌ [OrderBook] getMatchingStopSellOrders error: ${err.message}`);
    return [];
  }
};

/**
 * Bulk-remove a list of executed tradeIds from a given key.
 */
const removeMany = async (instrumentToken, side, tradeIds, orderType = 'LIMIT') => {
  if (!redisService.isAvailable() || tradeIds.length === 0) return;

  try {
    const key = _key(instrumentToken, side, orderType);
    await redisService.getClient().zrem(key, ...tradeIds);
  } catch (err) {
    console.error(`❌ [OrderBook] removeMany error: ${err.message}`);
  }
};

/**
 * Bootstrap: load all pending LIMIT and SL/SL-M orders from MongoDB into
 * Redis. Called once at server startup so Redis is in sync with the DB.
 */
const syncFromDatabase = async () => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [OrderBook] Redis unavailable – skipping bootstrap sync');
    return;
  }

  try {
    const Trade = require('../models/Trade');
    // deleted_at: null — a trade admin-soft-deleted while still 'pending'
    // (deleteTrade only sets deleted_at, never touches status) must not be
    // revived into the live order book by this boot-time resync.
    const pendingTrades = await Trade.find({
      status: 'pending',
      order_type: { $in: ['LIMIT', 'SL', 'SL-M'] },
      deleted_at: null,
    });

    if (pendingTrades.length === 0) {
      console.log('📗 [OrderBook] No pending orders to sync');
      return;
    }

    const pipeline = redisService.getClient().pipeline();

    for (const trade of pendingTrades) {
      const key = _key(trade.instrument_token, trade.transaction_type, trade.order_type);
      pipeline.zadd(key, trade.price, trade._id.toString());
    }

    await pipeline.exec();
    console.log(`📗 [OrderBook] Synced ${pendingTrades.length} pending orders into Redis`);
  } catch (err) {
    console.error(`❌ [OrderBook] syncFromDatabase error: ${err.message}`);
  }
};

module.exports = {
  addOrder,
  removeOrder,
  getMatchingBuyOrders,
  getMatchingSellOrders,
  getMatchingStopBuyOrders,
  getMatchingStopSellOrders,
  removeMany,
  syncFromDatabase,
};
