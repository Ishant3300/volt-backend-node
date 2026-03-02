/**
 * Order Book Service  (Redis-backed)
 *
 * Uses Redis Sorted Sets to maintain an in-memory order book.
 *
 * Key schema
 * ----------
 *   ob:{instrument_token}:buy   – sorted set, score = limitPrice (ascending)
 *   ob:{instrument_token}:sell  – sorted set, score = limitPrice (ascending)
 *
 * Each member is the trade's MongoDB _id (string).
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a pending limit order in the Redis order book.
 *
 * @param {string} tradeId        – MongoDB _id of the Trade document
 * @param {string} instrumentToken
 * @param {number} limitPrice
 * @param {'BUY'|'SELL'} side
 */
const addOrder = async (tradeId, instrumentToken, limitPrice, side) => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [OrderBook] Redis unavailable – skipping addOrder');
    return false;
  }

  try {
    const key = side === 'BUY' ? _buyKey(instrumentToken) : _sellKey(instrumentToken);
    // Score = limitPrice so we can range-query efficiently
    await redisService.getClient().zadd(key, limitPrice, tradeId);
    console.log(`📗 [OrderBook] Added ${side} order ${tradeId} @ ${limitPrice} for token ${instrumentToken}`);
    return true;
  } catch (err) {
    console.error(`❌ [OrderBook] addOrder error: ${err.message}`);
    return false;
  }
};

/**
 * Remove an order from the book (on cancel or execution).
 */
const removeOrder = async (tradeId, instrumentToken, side) => {
  if (!redisService.isAvailable()) return false;

  try {
    const key = side === 'BUY' ? _buyKey(instrumentToken) : _sellKey(instrumentToken);
    await redisService.getClient().zrem(key, tradeId);
    console.log(`📕 [OrderBook] Removed ${side} order ${tradeId} for token ${instrumentToken}`);
    return true;
  } catch (err) {
    console.error(`❌ [OrderBook] removeOrder error: ${err.message}`);
    return false;
  }
};

/**
 * Find all BUY orders whose limitPrice >= livePrice
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
 * Find all SELL orders whose limitPrice <= livePrice
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
 * Bulk-remove a list of executed tradeIds from a given key.
 */
const removeMany = async (instrumentToken, side, tradeIds) => {
  if (!redisService.isAvailable() || tradeIds.length === 0) return;

  try {
    const key = side === 'BUY' ? _buyKey(instrumentToken) : _sellKey(instrumentToken);
    await redisService.getClient().zrem(key, ...tradeIds);
  } catch (err) {
    console.error(`❌ [OrderBook] removeMany error: ${err.message}`);
  }
};

/**
 * Bootstrap: load all pending limit orders from MongoDB into Redis.
 * Called once at server startup so Redis is in sync with the DB.
 */
const syncFromDatabase = async () => {
  if (!redisService.isAvailable()) {
    console.log('⚠️  [OrderBook] Redis unavailable – skipping bootstrap sync');
    return;
  }

  try {
    const Trade = require('../models/Trade');
    const pendingTrades = await Trade.find({ status: 'pending', order_type: 'LIMIT' });

    if (pendingTrades.length === 0) {
      console.log('📗 [OrderBook] No pending orders to sync');
      return;
    }

    const pipeline = redisService.getClient().pipeline();

    for (const trade of pendingTrades) {
      const key = trade.transaction_type === 'BUY'
        ? _buyKey(trade.instrument_token)
        : _sellKey(trade.instrument_token);

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
  removeMany,
  syncFromDatabase,
};
