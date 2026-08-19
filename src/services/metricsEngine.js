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
const SettlementHistory = require('../models/SettlementHistory');
const SettlementRun = require('../models/SettlementRun');
const { dateRange, isWeekendInIndia } = require('../utils/settlementDates');
const { allowedCategories } = require('../utils/walletCategory');

class MetricsEngine {
  constructor() {
    this.livePriceService = null;

    // In-memory caches (rebuilt on init + periodically)
    this._brokerageRules = [];
    this._brokerageRulesMap = {}; // { userId: rules[], 'global': rules[] }
    this._kiteMap = {};           // instrument_token → { lot_size, segment, raw_name }

    // Per-user trade aggregation cache: userId → { credit, positions[], fifoPnl, brokerage }
    this._userCache = new Map();

    // token → Set<userId> — which users have positions on which instrument
    this._tokenToUsers = new Map();

    // Per-user computed metrics cache: userId → metrics object
    this._metricsCache = new Map();

    // LTP map: instrument_token (string) → last_price
    this._ltpMap = new Map();

    // Bid/Ask maps: instrument_token (string) → best bid/ask price
    this._bidMap = new Map();
    this._askMap = new Map();

    // Debounce: batch tick processing
    this._pendingTokens = new Set();
    this._tickTimer = null;

    // Durable settlement generation applied by this worker. Every PM2 worker
    // independently reconciles against SettlementRun before serving fresh risk
    // metrics, so process-local caches cannot survive another worker's commit.
    this._appliedSettlementRunId = null;
    this._settlementSyncPromise = null;
    this._lastSettlementCheckAt = 0;

    this._initialized = false;
  }

  /**
   * Initialize the engine. Call after livePriceService is ready.
   */
  async init(livePriceService, options = {}) {
    this.livePriceService = livePriceService;
    console.log('📊 [MetricsEngine] Initializing...');

    await this._loadRules();
    await this._rebuildAllUserCaches();

    // Seed position prices from the durable official settlement field on weekends.
    // Daily instrument CSV imports can contain last_price=0, so OHLC is retained as
    // a backward-compatible fallback for settlements created before this field existed.
    const positionTokens = Array.from(this._tokenToUsers.keys());
    if (positionTokens.length > 0) {
      const weekend = isWeekendInIndia(options.now || new Date());
      const latestRun = weekend
        ? await SettlementRun.findOne({ status: { $in: ['committed', 'finalizing', 'completed'] } }).sort({ trading_date: -1 }).select('trading_date').lean()
        : null;
      const activeRange = latestRun ? dateRange(latestRun.trading_date) : null;
      const instruments = await KiteInstrument.find(
        {
          instrument_token: { $in: positionTokens },
          $or: [
            { settlement_price: { $gt: 0 } },
            { last_price: { $gt: 0 } },
            { ohlc_close: { $gt: 0 } },
          ],
        },
        'instrument_token settlement_price settlement_price_date last_price ohlc_close'
      ).lean();
      const seededTokens = [];
      for (const inst of instruments) {
        const token = inst.instrument_token.toString();
        const settlementDate = inst.settlement_price_date ? new Date(inst.settlement_price_date) : null;
        const settlementIsCurrent = !activeRange || (settlementDate && settlementDate >= activeRange.start && settlementDate < activeRange.end);
        const price = weekend
          ? ((settlementIsCurrent ? inst.settlement_price : 0) || inst.ohlc_close || inst.last_price)
          : inst.last_price;
        if (!price || price <= 0) continue;
        this._ltpMap.set(token, price);
        this._bidMap.set(token, price);
        this._askMap.set(token, price);
        seededTokens.push(token);
      }

      // Weekend ticks can be stale snapshots. Lock official prices until the next
      // genuine market move; weekdays accept live ticks immediately.
      if (weekend && seededTokens.length > 0) {
        this._settledTokens = new Set(seededTokens);
        console.log(`📊 [MetricsEngine] Seeded and locked ${seededTokens.length} weekend settlement prices.`);
      }
    }

    // _rebuildAllUserCaches computed once before DB price seeding. Recompute the
    // final metrics now so REST/WebSocket consumers immediately see CMP=ATP.
    for (const userId of this._userCache.keys()) {
      const metrics = this._computeUserMetrics(userId);
      if (metrics) this._metricsCache.set(userId, metrics);
    }

    this._initialized = true;
    await this.synchronizeSettlementGeneration({ force: true, broadcast: false, now: options.now });
    console.log(`📊 [MetricsEngine] Ready. Tracking ${this._userCache.size} users, ${this._tokenToUsers.size} instruments`);
  }

  /**
   * Load brokerage rules and kite instrument info into memory.
   */
  async _loadRules() {
    try {
      this._brokerageRules = await BrokerageSettings.find({ deleted_at: null }).lean();
      // Build per-user map for fast lookups
      this._brokerageRulesMap = {};
      for (const rule of this._brokerageRules) {
        const key = rule.user_id ? rule.user_id.toString() : 'global';
        if (!this._brokerageRulesMap[key]) this._brokerageRulesMap[key] = [];
        this._brokerageRulesMap[key].push(rule);
      }

      const instruments = await KiteInstrument.find({}, 'instrument_token lot_size segment raw_name').lean();
      this._kiteMap = {};
      instruments.forEach(ki => {
        this._kiteMap[ki.instrument_token.toString()] = {
          lot_size: ki.lot_size || 1,
          segment: ki.segment || '',
          raw_name: ki.raw_name || ''
        };
      });
      console.log(`📊 [MetricsEngine] Loaded ${this._brokerageRules.length} brokerage rules, ${instruments.length} instruments`);
    } catch (e) {
      console.error('📊 [MetricsEngine] Error loading rules:', e.message);
    }
  }

  /**
   * Rebuild trade aggregation caches for ALL active users with trades.
   */
  async _rebuildAllUserCaches(options = {}) {
    try {
      const activeUserIds = await Trade.distinct('user_id', { status: 'completed', deleted_at: null });
      const requestedUserIds = options.includeUserIds || [];
      const userIds = [...new Set([...activeUserIds, ...requestedUserIds].map(id => id.toString()))];
      const users = await User.find({ _id: { $in: userIds }, deleted_at: null }).select('_id credits settled_pnl master_id wallet exchanges_allowed margin_square_off margin_square_off_percentage username active_status server_id').lean();

      // Build master hierarchy maps for broadcast aggregation. Also cache each
      // master's square-off config here (Task 11) so the master-aggregate path can
      // evaluate the cascade threshold without a per-tick DB read (non-functional
      // Req 4: keep the hot tick path free of extra blocking reads).
      const allMasters = await Master.find({ deleted_at: null })
        .select('_id master_id margin_square_off margin_square_off_percentage credits username active_status')
        .lean();
      this._masterParentMap = {};
      this._masterChildrenMap = {};
      this._masterConfigMap = {};
      for (const master of allMasters) {
        const masterId = master._id.toString();
        const parentId = master.master_id?.toString() || null;
        this._masterParentMap[masterId] = parentId;
        if (parentId) {
          if (!this._masterChildrenMap[parentId]) this._masterChildrenMap[parentId] = [];
          this._masterChildrenMap[parentId].push(masterId);
        }
        this._masterConfigMap[masterId] = {
          credits: master.credits || 0,
          margin_square_off: master.margin_square_off,
          margin_square_off_percentage: master.margin_square_off_percentage,
          username: master.username,
          active_status: master.active_status,
          deleted_at: null,
        };
      }

      this._userCache.clear();
      this._tokenToUsers.clear();
      this._metricsCache.clear();

      for (const user of users) {
        await this._rebuildUserCache(user._id.toString(), user.credits || 0, user.settled_pnl || 0, user.master_id?.toString(), user.wallet, user.exchanges_allowed, {
          margin_square_off: user.margin_square_off,
          margin_square_off_percentage: user.margin_square_off_percentage,
          username: user.username,
          active_status: user.active_status,
          server_id: user.server_id,
        });
      }

      for (const userId of this._userCache.keys()) {
        const metrics = this._computeUserMetrics(userId);
        if (metrics) this._metricsCache.set(userId, metrics);
      }
    } catch (error) {
      console.error('📊 [MetricsEngine] Error rebuilding user caches:', error.message);
      throw error;
    }
  }

  /**
   * Rebuild cache for a single user.
   */
  async _rebuildUserCache(userId, credit, settledPnl, masterId, wallet, exchangesAllowed, marginConfig) {
    try {
      // Normalize the wallet + allowed categories once so both cache branches
      // (flat/no-trades and the main aggregation) store identical shapes.
      const walletBalances = {
        NSE: Number(wallet?.NSE) || 0,
        MCX: Number(wallet?.MCX) || 0,
        GLOBAL: Number(wallet?.GLOBAL) || 0,
      };
      const allowedCats = allowedCategories(exchangesAllowed || []);

      const trades = await Trade.find({
        user_id: userId, status: 'completed', deleted_at: null
      }).sort({ createdAt: 1 }).lean();

      if (trades.length === 0) {
        // Keep an explicit flat-user cache when settlement removed the final
        // position. Otherwise a stale pre-settlement metrics entry can survive
        // and REST/WebSocket consumers continue to show phantom P&L.
        this._userCache.set(userId, {
          credit,
          settledPnl,
          masterId,
          fifoPnl: 0,
          brokerage: 0,
          openPositions: [],
          wallet: walletBalances,
          allowedCategories: allowedCats,
          marginConfig: marginConfig || null,
        });
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

        // Skip brokerage for carry_forward and margin_square_off trades (system trades)
        if (t.trade_type !== 'carry_forward' && t.trade_type !== 'margin_square_off') {
          // Brokerage calculation (same 4-level fallback as Flutter)
          const ki = this._kiteMap[token] || {};
          const seg = ki.segment || '';
          const rawName = ki.raw_name || '';
          const lotSize = ki.lot_size || 1;

          // Get user-specific brokerage rules, fallback to global
          const userRulesArr = this._brokerageRulesMap[userId] || [];
          const globalRulesArr = this._brokerageRulesMap['global'] || [];
          const applicableRules = userRulesArr.length > 0 ? userRulesArr : globalRulesArr;

          let brkRule = null;
          if (rawName && seg) brkRule = applicableRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
          if (!brkRule && rawName) brkRule = applicableRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
          if (!brkRule && seg) brkRule = applicableRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
          if (!brkRule) brkRule = applicableRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

          if (brkRule) {
            if (brkRule.type === 'TURNOVER WISE') {
              totalBrokerage += t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
            } else if (brkRule.type === 'LOT WISE') {
              totalBrokerage += (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
            }
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
        settledPnl,
        masterId,
        fifoPnl: totalFifoPnl,
        brokerage: totalBrokerage,
        openPositions,
        wallet: walletBalances,
        allowedCategories: allowedCats,
        marginConfig: marginConfig || null,
      });
    } catch (e) {
      console.error(`📊 [MetricsEngine] Error rebuilding cache for user ${userId}:`, e.message);
    }
  }

  /**
   * Called by livePriceService on every Kite tick.
   * Debounces to batch-process multiple tokens arriving in the same tick frame.
   */
  onTick(instrumentToken, lastPrice, bidPrice, askPrice) {
    if (!this._initialized) return;

    const token = instrumentToken.toString();

    // Weekend settlement prices are locked against cached subscription ticks.
    // The first weekday/session tick releases the lock regardless of price
    // movement; a genuine open can trade at exactly the settlement price.
    if (this._settledTokens && this._settledTokens.has(token)) {
      if (!isWeekendInIndia()) this.clearSettledTokens();
      else return;
    }

    this._ltpMap.set(token, lastPrice);
    if (bidPrice && bidPrice > 0) this._bidMap.set(token, bidPrice);
    if (askPrice && askPrice > 0) this._askMap.set(token, askPrice);
    this._pendingTokens.add(token);

    // Debounce: process all pending tokens after 50ms of quiet
    if (this._tickTimer) clearTimeout(this._tickTimer);
    this._tickTimer = setTimeout(() => this._processPendingTicks(), 50);
  }

  /**
   * Mark tokens as settled — ticks for these will be ignored until clearSettledTokens() is called.
   * Called by settlementService after setting CMP = settlement price.
   */
  setSettledTokens(tokens) {
    this._settledTokens = new Set(tokens.map(t => t.toString()));
    console.log(`📊 [MetricsEngine] ${this._settledTokens.size} tokens locked to settlement prices.`);
  }

  /**
   * Clear settled tokens lock — allows ticks to flow again.
   * Called when market opens (first genuine tick with price movement).
   */
  clearSettledTokens() {
    if (this._settledTokens) {
      console.log(`📊 [MetricsEngine] Cleared settlement lock for ${this._settledTokens.size} tokens.`);
      this._settledTokens = null;
    }
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

        // Check margin square off threshold on every tick
        try {
          const marginSquareOffService = require('./marginSquareOffService');
          marginSquareOffService.checkUser(userId, metrics);
        } catch (_) {}
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

    const { credit, settledPnl, openPositions, fifoPnl, brokerage, wallet, allowedCategories: allowedCats } = cache;
    const walletBalances = wallet || { NSE: 0, MCX: 0, GLOBAL: 0 };
    const allowed = allowedCats || [];

    let totalFloating = 0;
    let totalMargin = 0;
    const positionDetails = [];

    for (const pos of openPositions) {
      const ltp = this._ltpMap.get(pos.token) || (pos.avgBuy > 0 ? pos.avgBuy : pos.avgSell);

      // CMP: use bid for BUY positions (exit = sell at bid), ask for SELL positions (exit = buy at ask)
      // Fall back to LTP if bid/ask not available
      let cmp;
      if (pos.netQty > 0) {
        // BUY position — exit by selling at bid
        cmp = this._bidMap.get(pos.token) || ltp;
      } else {
        // SELL position — exit by buying at ask
        cmp = this._askMap.get(pos.token) || ltp;
      }

      let floating = 0;
      if (pos.netQty > 0) {
        floating = (cmp - pos.avgBuy) * pos.netQty;
      } else if (pos.netQty < 0) {
        floating = (pos.avgSell - cmp) * Math.abs(pos.netQty);
      }
      totalFloating += floating;

      // Margin = entry notional: |net_qty| × avg entry price (design D3).
      // avgEntry uses avgBuy for long positions, avgSell for short.
      const avgEntry = pos.netQty > 0 ? pos.avgBuy : pos.avgSell;
      const positionMargin = Math.abs(pos.netQty) * avgEntry;
      totalMargin += positionMargin;

      positionDetails.push({
        instrument_token: pos.token,
        exchange: pos.exchange,
        tradingsymbol: pos.tradingsymbol,
        net_qty: pos.netQty,
        avg_buy_price: Math.round(pos.avgBuy * 100) / 100,
        avg_sell_price: Math.round(pos.avgSell * 100) / 100,
        ltp: Math.round(ltp * 100) / 100,
        cmp: Math.round(cmp * 100) / 100,
        bid_price: Math.round((this._bidMap.get(pos.token) || 0) * 100) / 100,
        ask_price: Math.round((this._askMap.get(pos.token) || 0) * 100) / 100,
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

    // equity = Σ available wallet balances across ALLOWED categories only (design D2).
    // Non-allowed categories are excluded (Requirement 6.3). margin_used stays for
    // display only; free_margin equals equity because the available balance already
    // excludes margin blocked by open positions (so we stop the equity − margin_used
    // subtraction to avoid double counting).
    const walletSum = allowed.reduce((sum, cat) => sum + (Number(walletBalances[cat]) || 0), 0);
    const equity = Math.round(walletSum * 100) / 100;
    const freeMargin = equity;

    // Per-category available breakdown for the orders-page "i" control, filtered to
    // allowed categories only (Requirement 6.2/6.3).
    const walletBreakdown = {};
    for (const cat of allowed) {
      walletBreakdown[cat] = Math.round((Number(walletBalances[cat]) || 0) * 100) / 100;
    }

    return {
      user_id: userId,
      credit: Math.round(credit * 100) / 100,
      realised_pnl: realisedPnl,
      position_pnl: positionPnl,
      m2m_pnl: m2mPnl,
      margin_used: marginUsed,
      equity,
      free_margin: freeMargin,
      wallet: walletBreakdown,
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
        positions: metrics.positions,
        wallet: metrics.wallet
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
        const masterConfig = this._masterConfigMap?.[masterId] || {};
        
        // Aggregate wallet for the master
        const masterWallet = {};
        for (const u of allUsers) {
          if (u.wallet) {
            for (const [cat, val] of Object.entries(u.wallet)) {
              masterWallet[cat] = (masterWallet[cat] ?? 0) + (Number(val) || 0);
            }
          }
        }
        for (const cat of Object.keys(masterWallet)) {
          masterWallet[cat] = Math.round(masterWallet[cat] * 100) / 100;
        }

        this.livePriceService.broadcastToUser(masterId, {
          type: 'master_metrics_update',
          data: {
            total_pnl: Math.round(totalPnl * 100) / 100,
            credit: masterConfig.credits || 0,
            wallet: masterWallet,
            users: allUsers
          }
        });
      }

      // Master cascade square-off (Task 11, design §13.1 / Requirements 7.4, 8.4):
      // `totalPnl` here is the master's AGGREGATE live M2M (Σ realised+position P&L
      // over the whole subtree). When the master's own threshold is breached, all
      // users under the master are squared off. Fire-and-forget (do NOT await inside
      // the broadcast loop; mirrors how _processPendingTicks calls checkUser). The
      // lazy require avoids circular-import init (marginSquareOffService lazily
      // requires metricsEngine too).
      if (allUsers.length > 0) {
        try {
          const marginSquareOffService = require('./marginSquareOffService');
          const masterConfig = this._masterConfigMap?.[masterId];
          if (masterConfig && (masterConfig.margin_square_off || masterConfig.margin_square_off_percentage > 0)) {
            const subtreeUserIds = allUsers.map(u => u.user_id);
            marginSquareOffService.checkMaster(masterId, { m2m_pnl: Math.round(totalPnl * 100) / 100 }, masterConfig, subtreeUserIds);
          }
        } catch (_) {}
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
        // Aggregate wallet for admin across this master's users
        const adminMasterWallet = {};
        const allUsersForAdmin = [];
        for (const mid of allMasterIdsForThis) {
          const users = directMasterUsers[mid] || [];
          for (const u of users) {
             allUsersForAdmin.push(u);
             if (u.wallet) {
                for (const [cat, val] of Object.entries(u.wallet)) {
                   adminMasterWallet[cat] = (adminMasterWallet[cat] ?? 0) + (Number(val) || 0);
                }
             }
          }
        }
        for (const cat of Object.keys(adminMasterWallet)) {
          adminMasterWallet[cat] = Math.round(adminMasterWallet[cat] * 100) / 100;
        }

        adminSummary.push({
          master_id: masterId,
          total_pnl: Math.round(totalPnl * 100) / 100,
          user_count: userCount,
          wallet: adminMasterWallet
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
    if (!userId) return;
    try {
      // Find user to refresh full base state (credit, settledPnl, etc)
      const User = require('../models/User');
      const user = await User.findById(userId).lean();
      if (!user || user.deleted_at) {
        this._userCache.delete(userId);
        this._metricsCache.delete(userId);
        return;
      }
      
      // Rebuild this single user's cache and recompute
      await this._rebuildUserCache(userId, user.credits || 0, user.settled_pnl || 0, user.master_id?.toString(), user.wallet, user.exchanges_allowed, {
        margin_square_off: user.margin_square_off,
        margin_square_off_percentage: user.margin_square_off_percentage,
        username: user.username,
        active_status: user.active_status,
        server_id: user.server_id,
      });
      const metrics = this._computeUserMetrics(userId);
      if (metrics) {
        this._metricsCache.set(userId, metrics);
        this._broadcastUserMetrics(userId, metrics);
      }
    } catch (err) {
      console.error(`📊 [MetricsEngine] Error refreshing user ${userId}:`, err.message);
    }
  }

  /**
   * Refreshes the cached master configuration (e.g. credits, margin_square_off toggle).
   * Call this when a master's configuration is modified (e.g., via Admin or Parent Master credit).
   */
  async onMasterConfigChanged(masterId) {
    if (!masterId) return;
    try {
      const Master = require('../models/Master');
      const master = await Master.findById(masterId).lean();
      if (!master || master.deleted_at) {
        if (this._masterConfigMap) delete this._masterConfigMap[masterId];
        return;
      }
      
      if (!this._masterConfigMap) this._masterConfigMap = {};
      this._masterConfigMap[masterId] = {
        credits: master.credits || 0,
        margin_square_off: master.margin_square_off,
        margin_square_off_percentage: master.margin_square_off_percentage,
        username: master.username,
        active_status: master.active_status,
        deleted_at: null,
      };
      
      // Also broadcast the updated master metrics to reflect new credit
      this._broadcastMasterMetrics();
    } catch (err) {
      console.error(`📊 [MetricsEngine] Error refreshing master config ${masterId}:`, err.message);
    }
  }

  /**
   * Reconcile this process with the latest durable settlement generation.
   * SettlementRun is the cross-worker event log; the immutable ledger supplies
   * position prices, so mutable instrument rows can never rewrite a generation.
   */
  async synchronizeSettlementGeneration(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 10_000;
    const now = Date.now();
    const applyPrices = options.applyPrices ?? isWeekendInIndia(options.now || new Date());
    if (!options.force && !options.runId && maxAgeMs > 0 && (now - this._lastSettlementCheckAt) < maxAgeMs) {
      return { changed: false, runId: this._appliedSettlementRunId, pricesApplied: applyPrices };
    }
    if (this._settlementSyncPromise) return this._settlementSyncPromise;

    this._settlementSyncPromise = (async () => {
      const runQuery = options.runId
        ? { _id: options.runId, status: { $in: ['committed', 'finalizing', 'completed'] } }
        : { status: { $in: ['committed', 'finalizing', 'completed'] } };
      const query = SettlementRun.findOne(runQuery).select('_id period_key trading_date price_dates committed_at status history_run_id stats');
      if (!options.runId) query.sort({ committed_at: -1, trading_date: -1 });
      const run = await query.lean();
      this._lastSettlementCheckAt = Date.now();
      if (!run) return { changed: false, runId: this._appliedSettlementRunId, pricesApplied: false };

      // Crossing into a weekday/session must release weekend locks even if this
      // worker already consumed the same durable generation.
      if (!applyPrices) {
        this.clearSettledTokens();
        this.livePriceService?._settlementPrices?.clear();
      }

      const runId = run._id.toString();
      if (!options.force && runId === this._appliedSettlementRunId) {
        return { changed: false, runId, pricesApplied: false };
      }

      const historyRunId = run.history_run_id || run.stats?.legacy_settlement_run_id || run._id;
      const snapshots = await SettlementHistory.find({ settlement_run_id: historyRunId })
        .select('user_id instrument_token settlement_price carry_forward_qty')
        .lean();
      const affectedUserIds = [...new Set(snapshots.map(snapshot => snapshot.user_id.toString()))];
      const priceMap = new Map();
      for (const snapshot of snapshots) {
        if (Number(snapshot.carry_forward_qty || 0) <= 0) continue;
        const token = snapshot.instrument_token.toString();
        const price = Number(snapshot.settlement_price || 0);
        if (price <= 0) throw new Error(`Settlement ${run.period_key} has no committed price for ${token}`);
        const existing = priceMap.get(token);
        if (existing && Math.abs(existing - price) >= 0.005) {
          throw new Error(`Settlement ${run.period_key} has conflicting committed prices for ${token}`);
        }
        priceMap.set(token, price);
      }

      const allPriceMap = new Map(priceMap);
      if (applyPrices) {
        const nseRange = dateRange(run.price_dates?.nse || run.trading_date);
        const mcxRange = dateRange(run.price_dates?.mcx || run.trading_date);
        const instruments = await KiteInstrument.find({
          is_active: true,
          deleted_at: null,
          settlement_price: { $gt: 0 },
          $or: [
            { exchange: 'MCX', settlement_price_date: { $gte: mcxRange.start, $lt: mcxRange.end } },
            { exchange: { $ne: 'MCX' }, settlement_price_date: { $gte: nseRange.start, $lt: nseRange.end } },
          ],
        }).select('instrument_token settlement_price').lean();
        for (const instrument of instruments) {
          const token = instrument.instrument_token.toString();
          if (!allPriceMap.has(token)) allPriceMap.set(token, Number(instrument.settlement_price));
        }

        for (const [token, price] of allPriceMap) {
          this._ltpMap.set(token, price);
          this._bidMap.set(token, price);
          this._askMap.set(token, price);
        }
        if (allPriceMap.size > 0) this.setSettledTokens([...allPriceMap.keys()]);
      }

      // Rebuild position generations on every worker regardless of whether the
      // current market session permits settlement-price locking.
      await this._rebuildAllUserCaches({ includeUserIds: affectedUserIds });

      if (applyPrices && this.livePriceService) {
        if (!this.livePriceService._settlementPrices) this.livePriceService._settlementPrices = new Map();
        const ticks = [];
        for (const [token, price] of allPriceMap) {
          this.livePriceService._settlementPrices.set(token, price);
          this.livePriceService.latestPrices.set(token, price);
          this.livePriceService.latestPrices.set(Number(token), price);
          ticks.push({
            instrument_token: token,
            last_price: price,
            bid_price: price,
            ask_price: price,
            close: price,
            is_settlement: true,
            change: 0,
            change_percent: 0,
          });
        }
        if (options.broadcast !== false) {
          for (let index = 0; index < ticks.length; index += 100) {
            this.livePriceService._broadcastToClients({ type: 'ticks', data: ticks.slice(index, index + 100) });
          }
        }
      }

      this._appliedSettlementRunId = runId;
      for (const userId of affectedUserIds) {
        const metrics = this._metricsCache.get(userId);
        if (metrics && options.broadcast !== false) this._broadcastUserMetrics(userId, metrics);
      }
      if (options.broadcast !== false) this._broadcastMasterMetrics();

      console.log(`📊 [MetricsEngine] Applied settlement generation ${run.period_key} (${runId}) in worker ${process.pid}; prices ${applyPrices ? 'locked' : 'preserved'}.`);
      return {
        changed: true,
        runId,
        periodKey: run.period_key,
        priceMap: Object.fromEntries(priceMap),
        affectedUserIds,
        pricesApplied: applyPrices,
      };
    })();

    try {
      return await this._settlementSyncPromise;
    } finally {
      this._settlementSyncPromise = null;
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
    // A risk decision must never use a process-local cache older than another
    // worker's committed settlement. This indexed generation check occurs before
    // returning a cached value; periodic polling keeps non-trade UI traffic warm.
    await this.synchronizeSettlementGeneration({ maxAgeMs: 0 });

    const cached = this._metricsCache.get(userId);
    if (cached) return cached;

    // No cache — rebuild this user's data and compute
    try {
      const user = await User.findById(userId).select('credits settled_pnl master_id wallet exchanges_allowed').lean();
      if (!user) return null;

      // Clear old token→user mappings for this user
      for (const [token, users] of this._tokenToUsers) {
        users.delete(userId);
        if (users.size === 0) this._tokenToUsers.delete(token);
      }

      await this._rebuildUserCache(userId, user.credits || 0, user.settled_pnl || 0, user.master_id?.toString(), user.wallet, user.exchanges_allowed);

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
   * Reload margin/brokerage rules from DB and recompute all user metrics.
   * Call this after admin updates trade margins or brokerage settings.
   */
  async reloadRules() {
    if (!this._initialized) return;
    console.log('📊 [MetricsEngine] Reloading rules (admin update)...');
    await this._loadRules();
    // Recompute metrics for all cached users with the new rules
    for (const userId of this._userCache.keys()) {
      const metrics = this._computeUserMetrics(userId);
      if (metrics) {
        this._metricsCache.set(userId, metrics);
        this._broadcastUserMetrics(userId, metrics);
      }
    }
    console.log(`📊 [MetricsEngine] Rules reloaded, ${this._userCache.size} user metrics recomputed.`);
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

  /**
   * Returns all instrument tokens that have open positions.
   * Used by livePriceService to ensure these tokens are always subscribed on Kite.
   */
  getPositionTokens() {
    return Array.from(this._tokenToUsers.keys()).map(t => parseInt(t)).filter(t => !isNaN(t));
  }

  /**
   * Returns the cached margin config for a user (loaded during cache rebuild).
   * Used by marginSquareOffService to avoid per-tick DB reads.
   */
  getUserMarginConfig(userId) {
    const cache = this._userCache.get(userId);
    if (!cache) return null;
    return {
      margin_square_off: cache.marginConfig?.margin_square_off,
      margin_square_off_percentage: cache.marginConfig?.margin_square_off_percentage,
      credits: cache.credit,
      username: cache.marginConfig?.username,
      active_status: cache.marginConfig?.active_status,
      server_id: cache.marginConfig?.server_id,
      master_id: cache.masterId,
    };
  }
}

module.exports = new MetricsEngine();
