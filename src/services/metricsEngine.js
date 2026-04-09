/**
 * metricsEngine.js — Server-side real-time metrics computation.
 *
 * On every Kite tick, recomputes the 7 account metrics for affected users
 * and pushes them via WebSocket. This ensures all views (user orders page,
 * admin user management, master positions) see identical numbers.
 *
 * Metrics: credit, realisedPnl, positionPnl, m2mPnl, marginUsed, equity, freeMargin
 */

const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const TradeMargin = require('../models/TradeMargin');

class MetricsEngine {
  constructor() {
    this.livePriceService = null;

    // In-memory caches (rebuilt on init + periodically)
    this._brokerageRules = [];
    this._marginRules = [];
    this._kiteMap = {};           // instrument_token → { lot_size, segment, raw_name }

    // Per-user trade aggregation cache: userId → { credit, positions[], fifoPnl, brokerage }
    this._userCache = new Map();

    // token → Set<userId> — which users have positions on which instrument
    this._tokenToUsers = new Map();

    // Per-user computed metrics cache: userId → metrics object
    this._metricsCache = new Map();

    // LTP map: instrument_token (string) → last_price
    this._ltpMap = new Map();

    // Debounce: batch tick processing
    this._pendingTokens = new Set();
    this._tickTimer = null;

    this._initialized = false;
  }

  /**
   * Initialize the engine. Call after livePriceService is ready.
   */
  async init(livePriceService) {
    this.livePriceService = livePriceService;
    console.log('📊 [MetricsEngine] Initializing...');

    await this._loadRules();
    await this._rebuildAllUserCaches();

    this._initialized = true;
    console.log(`📊 [MetricsEngine] Ready. Tracking ${this._userCache.size} users, ${this._tokenToUsers.size} instruments`);
  }

  /**
   * Load brokerage rules, margin rules, and kite instrument info into memory.
   */
  async _loadRules() {
    try {
      this._brokerageRules = await BrokerageSettings.find({ deleted_at: null }).lean();
      this._marginRules = await TradeMargin.find({ deleted_at: null }).lean();

      const instruments = await KiteInstrument.find({}, 'instrument_token lot_size segment raw_name').lean();
      this._kiteMap = {};
      instruments.forEach(ki => {
        this._kiteMap[ki.instrument_token.toString()] = {
          lot_size: ki.lot_size || 1,
          segment: ki.segment || '',
          raw_name: ki.raw_name || ''
        };
      });
      console.log(`📊 [MetricsEngine] Loaded ${this._brokerageRules.length} brokerage rules, ${this._marginRules.length} margin rules, ${instruments.length} instruments`);
    } catch (e) {
      console.error('📊 [MetricsEngine] Error loading rules:', e.message);
    }
  }

  /**
   * Rebuild trade aggregation caches for ALL active users with trades.
   */
  async _rebuildAllUserCaches() {
    try {
      const userIds = await Trade.distinct('user_id', { status: 'completed', deleted_at: null });
      const users = await User.find({ _id: { $in: userIds }, deleted_at: null }).select('_id credits master_id').lean();

      // Build master hierarchy maps for broadcast aggregation
      const allMasters = await Master.find({ deleted_at: null }).select('_id master_id').lean();
      this._masterParentMap = {};   // masterId → parentMasterId
      this._masterChildrenMap = {}; // masterId → [childMasterId, ...]
      for (const m of allMasters) {
        const mid = m._id.toString();
        const parentId = m.master_id?.toString() || null;
        this._masterParentMap[mid] = parentId;
        if (parentId) {
          if (!this._masterChildrenMap[parentId]) this._masterChildrenMap[parentId] = [];
          this._masterChildrenMap[parentId].push(mid);
        }
      }

      this._userCache.clear();
      this._tokenToUsers.clear();

      for (const user of users) {
        await this._rebuildUserCache(user._id.toString(), user.credits || 0, user.master_id?.toString());
      }

      // Compute initial metrics for all cached users (so getCachedMetrics works
      // even before the first tick arrives for their instruments)
      for (const userId of this._userCache.keys()) {
        const metrics = this._computeUserMetrics(userId);
        if (metrics) this._metricsCache.set(userId, metrics);
      }
    } catch (e) {
      console.error('📊 [MetricsEngine] Error rebuilding user caches:', e.message);
    }
  }

  /**
   * Rebuild cache for a single user.
   */
  async _rebuildUserCache(userId, credit, masterId) {
    try {
      const trades = await Trade.find({
        user_id: userId, status: 'completed', deleted_at: null
      }).sort({ createdAt: 1 }).lean();

      if (trades.length === 0) {
        this._userCache.delete(userId);
        return;
      }

      // Running-average position aggregation (same logic as Flutter _calculateMetrics)
      const running = {};
      const positions = {};

      let totalFifoPnl = 0;
      let totalBrokerage = 0;

      for (const t of trades) {
        const token = t.instrument_token.toString();
        totalFifoPnl += (t.pnl || 0);

        // Brokerage calculation (same 4-level fallback as Flutter)
        const ki = this._kiteMap[token] || {};
        const seg = ki.segment || '';
        const rawName = ki.raw_name || '';
        const lotSize = ki.lot_size || 1;

        let brkRule = null;
        if (rawName && seg) brkRule = this._brokerageRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
        if (!brkRule && rawName) brkRule = this._brokerageRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
        if (!brkRule && seg) brkRule = this._brokerageRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
        if (!brkRule) brkRule = this._brokerageRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

        if (brkRule) {
          if (brkRule.type === 'TURNOVER WISE') {
            totalBrokerage += t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
          } else if (brkRule.type === 'LOT WISE') {
            totalBrokerage += (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
          }
        }

        // Position aggregation with running average
        if (!running[token]) {
          running[token] = { netQty: 0, avgBuy: 0, avgSell: 0 };
          positions[token] = {
            exchange: t.exchange,
            tradingsymbol: t.tradingsymbol,
            totalBuyQty: 0, totalSellQty: 0,
            totalBuyValue: 0, totalSellValue: 0
          };
        }

        const run = running[token];
        const pos = positions[token];

        if (t.transaction_type === 'BUY') {
          const newQty = run.netQty + t.executed_quantity;
          if (run.netQty >= 0) {
            run.avgBuy = run.netQty > 0
              ? (run.avgBuy * run.netQty + t.executed_price * t.executed_quantity) / newQty
              : t.executed_price;
          } else {
            if (newQty >= 0) run.avgBuy = newQty > 0 ? t.executed_price : 0;
          }
          run.netQty = newQty;
          pos.totalBuyQty += t.executed_quantity;
          pos.totalBuyValue += t.executed_quantity * t.executed_price;
        } else {
          const newQty = run.netQty - t.executed_quantity;
          if (run.netQty <= 0) {
            const absOld = Math.abs(run.netQty);
            const absNew = absOld + t.executed_quantity;
            run.avgSell = absOld > 0
              ? (run.avgSell * absOld + t.executed_price * t.executed_quantity) / absNew
              : t.executed_price;
          } else {
            if (newQty <= 0) run.avgSell = newQty < 0 ? t.executed_price : 0;
          }
          run.netQty = newQty;
          pos.totalSellQty += t.executed_quantity;
          pos.totalSellValue += t.executed_quantity * t.executed_price;
        }

        if (run.netQty === 0) { run.avgBuy = 0; run.avgSell = 0; }
      }

      // Build open positions list and register token→user mappings
      const openPositions = [];
      for (const [token, run] of Object.entries(running)) {
        if (run.netQty !== 0) {
          const pos = positions[token];
          const ki = this._kiteMap[token] || {};
          openPositions.push({
            token,
            exchange: pos.exchange,
            tradingsymbol: pos.tradingsymbol,
            netQty: run.netQty,
            avgBuy: run.avgBuy,
            avgSell: run.avgSell,
            segment: ki.segment || '',
            rawName: ki.raw_name || '',
            lotSize: ki.lot_size || 1
          });

          if (!this._tokenToUsers.has(token)) this._tokenToUsers.set(token, new Set());
          this._tokenToUsers.get(token).add(userId);
        }
      }

      this._userCache.set(userId, {
        credit,
        masterId,
        fifoPnl: totalFifoPnl,
        brokerage: totalBrokerage,
        openPositions
      });
    } catch (e) {
      console.error(`📊 [MetricsEngine] Error rebuilding cache for user ${userId}:`, e.message);
    }
  }

  /**
   * Called by livePriceService on every Kite tick.
   * Debounces to batch-process multiple tokens arriving in the same tick frame.
   */
  onTick(instrumentToken, lastPrice) {
    if (!this._initialized) return;

    const token = instrumentToken.toString();
    this._ltpMap.set(token, lastPrice);
    this._pendingTokens.add(token);

    // Debounce: process all pending tokens after 50ms of quiet
    if (this._tickTimer) clearTimeout(this._tickTimer);
    this._tickTimer = setTimeout(() => this._processPendingTicks(), 50);
  }

  /**
   * Process all pending tick updates — find affected users and recompute their metrics.
   */
  _processPendingTicks() {
    const tokens = [...this._pendingTokens];
    this._pendingTokens.clear();

    const affectedUsers = new Set();
    for (const token of tokens) {
      const users = this._tokenToUsers.get(token);
      if (users) users.forEach(uid => affectedUsers.add(uid));
    }

    if (affectedUsers.size === 0) return;

    for (const userId of affectedUsers) {
      const metrics = this._computeUserMetrics(userId);
      if (metrics) {
        this._metricsCache.set(userId, metrics);
        this._broadcastUserMetrics(userId, metrics);
      }
    }

    this._broadcastMasterMetrics();
  }

  /**
   * Compute the 7 metrics for a single user using cached trades + live LTP.
   * This is the single source of truth — identical to Flutter's _calculateMetrics.
   */
  _computeUserMetrics(userId) {
    const cache = this._userCache.get(userId);
    if (!cache) return null;

    const { credit, openPositions, fifoPnl, brokerage } = cache;

    let totalFloating = 0;
    let totalMargin = 0;
    const positionDetails = [];

    for (const pos of openPositions) {
      const ltp = this._ltpMap.get(pos.token) || (pos.avgBuy > 0 ? pos.avgBuy : pos.avgSell);

      let floating = 0;
      if (pos.netQty > 0) {
        floating = (ltp - pos.avgBuy) * pos.netQty;
      } else if (pos.netQty < 0) {
        floating = (pos.avgSell - ltp) * Math.abs(pos.netQty);
      }
      totalFloating += floating;

      // Margin calculation (same 4-level fallback as Flutter)
      let positionMargin = 0;
      const seg = pos.segment.toUpperCase();
      const rawName = pos.rawName;

      let rule = null;
      if (rawName) rule = this._marginRules.find(m => m.script_name?.toUpperCase() === rawName.toUpperCase() && m.exchange_name === seg);
      if (!rule && rawName) rule = this._marginRules.find(m => m.script_name?.toUpperCase() === rawName.toUpperCase());
      if (!rule) rule = this._marginRules.find(m => m.exchange_name === seg && !m.script_name);
      if (!rule) rule = this._marginRules.find(m => m.exchange_name === pos.exchange.toUpperCase() && !m.script_name);

      if (rule) {
        const isLotBased = seg === 'MCX-FUT' || seg === 'MCX-OPT' || seg === 'NFO-OPT';
        if (isLotBased && rule.amount_type === 'amount') {
          const lots = pos.lotSize > 0 ? Math.ceil(Math.abs(pos.netQty) / pos.lotSize) : Math.abs(pos.netQty);
          positionMargin = rule.trade_margin * lots;
        } else if (rule.amount_type === 'percentage') {
          const atp = pos.netQty > 0 ? pos.avgBuy : pos.avgSell;
          positionMargin = Math.abs(pos.netQty) * atp * (rule.trade_margin / 100);
        } else {
          positionMargin = Math.abs(pos.netQty) * rule.trade_margin;
        }
      }
      totalMargin += positionMargin;

      positionDetails.push({
        instrument_token: pos.token,
        exchange: pos.exchange,
        tradingsymbol: pos.tradingsymbol,
        net_qty: pos.netQty,
        avg_buy_price: Math.round(pos.avgBuy * 100) / 100,
        avg_sell_price: Math.round(pos.avgSell * 100) / 100,
        ltp: Math.round(ltp * 100) / 100,
        floating_pnl: Math.round(floating * 100) / 100,
        margin: Math.round(positionMargin * 100) / 100,
        segment: pos.segment,
        lot_size: pos.lotSize
      });
    }

    const realisedPnl = Math.round((fifoPnl - brokerage) * 100) / 100;
    const positionPnl = Math.round(totalFloating * 100) / 100;
    const m2mPnl = Math.round((realisedPnl + positionPnl) * 100) / 100;
    const marginUsed = Math.round(totalMargin * 100) / 100;
    const equity = Math.round((credit + m2mPnl) * 100) / 100;
    const freeMargin = Math.round((equity - marginUsed) * 100) / 100;

    return {
      user_id: userId,
      credit: Math.round(credit * 100) / 100,
      realised_pnl: realisedPnl,
      position_pnl: positionPnl,
      m2m_pnl: m2mPnl,
      margin_used: marginUsed,
      equity,
      free_margin: freeMargin,
      positions: positionDetails
    };
  }

  /**
   * Send metrics to the specific user via WebSocket.
   * Also sends to the user's master (and up the hierarchy) so admin/master
   * viewing this user's Position tab gets live updates.
   */
  _broadcastUserMetrics(userId, metrics) {
    if (!this.livePriceService) return;

    // Send to the user themselves
    this.livePriceService.broadcastToUser(userId, {
      type: 'metrics_update',
      data: metrics
    });

    // Also send to the user's master and all ancestor masters
    const cache = this._userCache.get(userId);
    if (cache && cache.masterId) {
      let currentMasterId = cache.masterId;
      const visited = new Set();
      while (currentMasterId && !visited.has(currentMasterId)) {
        visited.add(currentMasterId);
        this.livePriceService.broadcastToUser(currentMasterId, {
          type: 'metrics_update',
          data: metrics
        });
        currentMasterId = this._masterParentMap?.[currentMasterId] || null;
      }
    }

    // Also send to all admin WebSocket clients
    if (this.livePriceService.wss) {
      const msg = JSON.stringify({ type: 'metrics_update', data: metrics });
      this.livePriceService.wss.clients.forEach(client => {
        if (client.readyState === 1 && client.isAdmin) {
          client.send(msg);
        }
      });
    }
  }

  /**
   * Aggregate per-user metrics into per-master totals and broadcast to masters/admins.
   * Each master receives data for ALL users in their hierarchy (direct + sub-masters' users).
   */
  _broadcastMasterMetrics() {
    if (!this.livePriceService) return;

    // Step 1: Build direct master → users mapping
    const directMasterUsers = {};
    for (const [userId, cache] of this._userCache) {
      const masterId = cache.masterId;
      if (!masterId) continue;
      if (!directMasterUsers[masterId]) directMasterUsers[masterId] = [];
      
      const metrics = this._metricsCache.get(userId);
      if (!metrics) continue;
      
      directMasterUsers[masterId].push({
        user_id: userId,
        credit: metrics.credit,
        equity: metrics.equity,
        m2m_pnl: metrics.m2m_pnl,
        position_pnl: metrics.position_pnl,
        realised_pnl: metrics.realised_pnl,
        margin_used: metrics.margin_used,
        positions: metrics.positions
      });
    }

    // Step 2: Build master hierarchy (master_id → parent_master_id)
    // We need to know which masters are sub-masters of which
    // Use _masterParentMap built during cache init
    if (!this._masterParentMap) this._masterParentMap = {};

    // Step 3: For each master, collect all descendant users
    const allMasterIds = new Set(Object.keys(directMasterUsers));
    // Also add masters that are parents of other masters
    for (const mid of Object.values(this._masterParentMap)) {
      if (mid) allMasterIds.add(mid);
    }

    for (const masterId of allMasterIds) {
      // Get all sub-master IDs under this master (from cached hierarchy)
      const descendantMasterIds = this._getDescendantMasterIds(masterId);
      const allMasterIdsForThis = [masterId, ...descendantMasterIds];

      let totalPnl = 0;
      const allUsers = [];

      for (const mid of allMasterIdsForThis) {
        const users = directMasterUsers[mid] || [];
        for (const u of users) {
          const userPnl = (u.realised_pnl || 0) + (u.position_pnl || 0);
          totalPnl += userPnl;
          allUsers.push(u);
        }
      }

      if (allUsers.length > 0) {
        this.livePriceService.broadcastToUser(masterId, {
          type: 'master_metrics_update',
          data: {
            total_pnl: Math.round(totalPnl * 100) / 100,
            users: allUsers
          }
        });
      }
    }

    // Broadcast admin-level summary
    if (this.livePriceService.wss) {
      // For admin, group by top-level master (master_id = null or created by admin)
      const adminSummary = [];
      const topLevelMasters = new Set();
      for (const mid of Object.keys(directMasterUsers)) {
        // Walk up to find the top-level master
        let current = mid;
        while (this._masterParentMap[current]) {
          current = this._masterParentMap[current];
        }
        topLevelMasters.add(current);
      }

      for (const masterId of topLevelMasters) {
        const descendantMasterIds = this._getDescendantMasterIds(masterId);
        const allMasterIdsForThis = [masterId, ...descendantMasterIds];
        let totalPnl = 0;
        let userCount = 0;
        for (const mid of allMasterIdsForThis) {
          const users = directMasterUsers[mid] || [];
          userCount += users.length;
          for (const u of users) {
            totalPnl += (u.realised_pnl || 0) + (u.position_pnl || 0);
          }
        }
        adminSummary.push({
          master_id: masterId,
          total_pnl: Math.round(totalPnl * 100) / 100,
          user_count: userCount
        });
      }

      const msg = JSON.stringify({ type: 'admin_metrics_update', data: adminSummary });
      this.livePriceService.wss.clients.forEach(client => {
        if (client.readyState === 1 && client.isAdmin) {
          client.send(msg);
        }
      });
    }
  }

  /**
   * Get all descendant master IDs under a given master (not including itself).
   * Uses the cached _masterChildrenMap.
   */
  _getDescendantMasterIds(masterId) {
    if (!this._masterChildrenMap) return [];
    const result = [];
    const queue = [masterId];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = this._masterChildrenMap[current] || [];
      for (const childId of children) {
        result.push(childId);
        queue.push(childId);
      }
    }
    return result;
  }

  /**
   * Called after a trade is placed — invalidate and rebuild the affected user's cache.
   */
  async onTradeExecuted(userId) {
    if (!this._initialized) return;
    try {
      const user = await User.findById(userId).select('credits master_id').lean();
      if (!user) return;

      // Clear old token→user mappings for this user
      for (const [token, users] of this._tokenToUsers) {
        users.delete(userId);
        if (users.size === 0) this._tokenToUsers.delete(token);
      }

      await this._rebuildUserCache(userId, user.credits || 0, user.master_id?.toString());

      const metrics = this._computeUserMetrics(userId);
      if (metrics) {
        this._metricsCache.set(userId, metrics);
        this._broadcastUserMetrics(userId, metrics);
      }
    } catch (e) {
      console.error(`📊 [MetricsEngine] Error on trade executed for ${userId}:`, e.message);
    }
  }

  /**
   * Get cached metrics for a user (for REST API fallback).
   */
  getCachedMetrics(userId) {
    return this._metricsCache.get(userId) || null;
  }

  /**
   * Get metrics for a user — always fresh. If not cached, rebuild and compute on the spot.
   * This is the method tradeController should use to guarantee consistency with the orders page.
   */
  async getFreshMetrics(userId) {
    // Try cache first
    const cached = this._metricsCache.get(userId);
    if (cached) return cached;

    // No cache — rebuild this user's data and compute
    try {
      const user = await User.findById(userId).select('credits master_id').lean();
      if (!user) return null;

      // Clear old token→user mappings for this user
      for (const [token, users] of this._tokenToUsers) {
        users.delete(userId);
        if (users.size === 0) this._tokenToUsers.delete(token);
      }

      await this._rebuildUserCache(userId, user.credits || 0, user.master_id?.toString());

      const metrics = this._computeUserMetrics(userId);
      if (metrics) {
        this._metricsCache.set(userId, metrics);
        return metrics;
      }
    } catch (e) {
      console.error(`📊 [MetricsEngine] getFreshMetrics error for ${userId}:`, e.message);
    }

    return null;
  }

  /**
   * Get cached metrics for all users under a master (including sub-masters' users).
   */
  getMasterUserMetrics(masterId) {
    const descendantMasterIds = this._getDescendantMasterIds(masterId);
    const allMasterIds = new Set([masterId, ...descendantMasterIds]);

    const result = [];
    for (const [userId, cache] of this._userCache) {
      if (allMasterIds.has(cache.masterId)) {
        const metrics = this._metricsCache.get(userId);
        if (metrics) result.push(metrics);
      }
    }
    return result;
  }

  /**
   * Schedule midnight audit — reload rules and rebuild caches.
   */
  scheduleMidnightAudit() {
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utcMs + (5.5 * 3600000));

    const nextMidnight = new Date(ist);
    nextMidnight.setHours(0, 1, 0, 0);
    if (nextMidnight <= ist) nextMidnight.setDate(nextMidnight.getDate() + 1);

    const msUntilMidnight = nextMidnight.getTime() - ist.getTime();
    console.log(`📊 [MetricsEngine] Midnight audit scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);

    setTimeout(async () => {
      console.log('📊 [MetricsEngine] Running midnight audit...');
      await this._loadRules();
      await this._rebuildAllUserCaches();
      this.scheduleMidnightAudit();
    }, msUntilMidnight);
  }
}

module.exports = new MetricsEngine();
