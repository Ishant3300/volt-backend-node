const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const { sanitizeErrorMessage } = require('../utils/sanitizeError');

/**
 * GET /api/master/weekly-admin-report
 *
 * Multi-tier hierarchy report using per-instrument brokerage cascade
 * and P&L sharing per the spec (Sections 2.2 and 2.3).
 *
 * OPTIMIZED: Uses batch queries instead of N+1 per-user queries.
 * ~6 DB queries total regardless of user count.
 */
/**
 * Current settlement week boundaries: Monday 00:00 → now. Same Monday-start
 * logic as weeklySummaryService.js's snapshot job, so "this week" means the
 * same thing everywhere in the app.
 */
function currentWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

const getWeeklyAdminReport = async (req, res) => {
  // Timing breakdown — logged, not returned, so we can see exactly which
  // phase is slow instead of guessing from a single end-to-end number.
  const _t0 = Date.now();
  const _timings = {};
  const _mark = (label) => { _timings[label] = Date.now() - _t0; };

  try {
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;
    const metricsEngine = require('../services/metricsEngine');

    // requireAdminPermission('REPORTS_ACCESS') on this route is a no-op for
    // a master caller by design (see requireAdminPermission.js) — Master
    // authorization is meant to be enforced inline per-endpoint instead.
    // This one was never actually checking it: an admin can toggle a
    // specific master's own Master.permissions.weekly_admin off (only an
    // admin can — masterController.js's updateMasterPermissions blocks a
    // master from changing this on their children), and the web/mobile UI
    // hides the menu item accordingly, but nothing stopped that master from
    // calling this endpoint directly regardless.
    if (req.master) {
      const caller = await Master.findById(req.master.id).select('permissions').lean();
      if (caller?.permissions?.weekly_admin === false) {
        return res.status(403).json({ success: false, message: 'Not authorized to view the weekly admin report', data: null });
      }
    }

    // Was previously unbounded (every completed trade ever, for every user
    // in scope) despite this being a "weekly" report — the actual cause of
    // this endpoint timing out as trade history grew. Defaults to the
    // current settlement week, same as weeklySummaryService.js; callers can
    // still override with ?date_from=&date_to= like every other trade-list
    // endpoint in this codebase (masterTradeController.js, userController.js).
    const { date_from, date_to } = req.query;
    const executedAtFilter = {};
    executedAtFilter.$gte = date_from ? new Date(date_from) : currentWeekStart();
    if (date_to) executedAtFilter.$lte = new Date(date_to);

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Batch-load ALL data upfront (~6 DB queries total)
    // ═══════════════════════════════════════════════════════════════════════

    // 1. Load ALL masters (we need the full tree for hierarchy walks)
    const allMasters = await Master.find({ deleted_at: null })
      .select('_id name username master_id pnl_sharing brokerage_sharing')
      .lean();

    // Build master lookup maps
    const masterMap = {};          // masterId → masterDoc
    const masterChildrenMap = {};   // masterId → [childMasterDoc, ...]
    for (const m of allMasters) {
      const mid = m._id.toString();
      masterMap[mid] = m;
      masterChildrenMap[mid] = [];
    }
    for (const m of allMasters) {
      if (m.master_id) {
        const parentId = m.master_id.toString();
        if (masterChildrenMap[parentId]) {
          masterChildrenMap[parentId].push(m);
        }
      }
    }
    _mark('1_masters');

    // 2. Determine scope based on role
    let topEntities; // masters to report on (top-level for admin, children for master)
    let callerMaster = null;

    // Per-admin master-visibility restriction — expanded once here (a Set
    // of every hidden master's full subtree) and reused for both topEntities
    // and allScopeMasterIds below.
    const { resolveHiddenMasterIds } = require('../utils/adminVisibility');
    const hiddenMasterIds = await resolveHiddenMasterIds(req);

    if (role === 'admin') {
      topEntities = allMasters.filter(m => !m.master_id && !(hiddenMasterIds && hiddenMasterIds.has(m._id.toString())));
    } else {
      callerMaster = masterMap[callerId] || null;
      topEntities = masterChildrenMap[callerId] || [];
    }

    // 3. Collect ALL master IDs in scope (for all sub-trees we need to report on)
    const allScopeMasterIds = new Set();
    if (role === 'admin') {
      // Admin sees everything, minus any hidden master's entire subtree.
      allMasters.forEach(m => {
        const mid = m._id.toString();
        if (!hiddenMasterIds || !hiddenMasterIds.has(mid)) allScopeMasterIds.add(mid);
      });
    } else {
      // Master sees their sub-tree
      const queue = [callerId];
      while (queue.length > 0) {
        const cid = queue.shift();
        allScopeMasterIds.add(cid);
        const children = masterChildrenMap[cid] || [];
        for (const child of children) {
          queue.push(child._id.toString());
        }
      }
    }

    // 4. Load ALL users under scope
    const allUsers = await User.find({
      master_id: { $in: [...allScopeMasterIds] },
      deleted_at: null
    }).select('_id name username master_id pnl_sharing brokerage_sharing').lean();

    const userMap = {};           // userId → userDoc
    const usersByMaster = {};     // masterId → [userDoc, ...]
    for (const u of allUsers) {
      const uid = u._id.toString();
      userMap[uid] = u;
      const mid = u.master_id.toString();
      if (!usersByMaster[mid]) usersByMaster[mid] = [];
      usersByMaster[mid].push(u);
    }
    _mark('2_users');

    // 5. Load trades for all users in scope.
    //
    // Default (no date_from/date_to override) means "current week" — the
    // exact window weeklyReportCache.js keeps precomputed per user, updated
    // the instant each trade completes (see metricsEngine.onTradeExecuted).
    // Only that default case can use the cache; an explicit historical
    // range always needs a live query, since the cache only ever tracks
    // the current week.
    const allUserIds = allUsers.map(u => u._id);
    const tradesByUser = {};
    const usersNeedingLiveQuery = [];

    if (!date_from && !date_to) {
      const weeklyReportCache = require('../services/weeklyReportCache');
      await Promise.all(allUserIds.map(async (uid) => {
        const cached = await weeklyReportCache.getUserWeeklyTrades(uid.toString());
        if (cached) {
          tradesByUser[uid.toString()] = cached;
        } else {
          usersNeedingLiveQuery.push(uid);
        }
      }));
    } else {
      usersNeedingLiveQuery.push(...allUserIds);
    }
    _mark('3_cacheLookup');
    _timings.cacheHits = allUserIds.length - usersNeedingLiveQuery.length;
    _timings.cacheMisses = usersNeedingLiveQuery.length;

    // Cache misses (cold start, Redis unavailable, or an explicit date
    // range) fall back to the same bounded, indexed live query as before —
    // uses the existing { user_id, status, deleted_at, executed_at } index
    // (Trade.js line 161), which an unbounded query never hit.
    if (usersNeedingLiveQuery.length > 0) {
      const liveTrades = await Trade.find({
        user_id: { $in: usersNeedingLiveQuery },
        status: 'completed',
        deleted_at: null,
        // carry_forward is a synthetic settlement marker with no real
        // brokerage — same exclusion as weeklyReportCache.js's cache path,
        // kept consistent so a cache miss doesn't silently bill brokerage
        // on a carried position's reopen leg that the cache path wouldn't.
        trade_type: { $ne: 'carry_forward' },
        executed_at: executedAtFilter
      }).select('user_id instrument_token executed_price executed_quantity pnl').lean();

      for (const t of liveTrades) {
        const uid = t.user_id.toString();
        if (!tradesByUser[uid]) tradesByUser[uid] = [];
        tradesByUser[uid].push(t);
      }
    }
    _mark('4_trades');
    _timings.tradeCount = usersNeedingLiveQuery.length > 0
      ? Object.values(tradesByUser).reduce((n, arr) => n + arr.length, 0)
      : 0;

    const allTrades = Object.values(tradesByUser).flat();

    // 6. Load ALL KiteInstruments for tokens in trades
    const allTokens = [...new Set(allTrades.map(t => t.instrument_token))];
    const kiteInstruments = await KiteInstrument.find(
      { instrument_token: { $in: allTokens } },
      'instrument_token lot_size segment raw_name exchange'
    ).lean();
    const kiteMap = {};
    for (const ki of kiteInstruments) {
      kiteMap[ki.instrument_token] = ki;
    }
    _mark('5_instruments');

    // Optional exchange/script narrowing for the Client P&L Summary screen —
    // filters which trades feed every downstream P&L/brokerage calculation
    // below, rather than filtering the already-computed report rows (a
    // per-row total is a sum across trades, so it can only be scoped to a
    // subset of trades before that sum happens, not after). Trade documents
    // don't carry exchange/raw_name directly on the ones loaded here (only
    // instrument_token, price, qty, pnl were selected above and in the
    // Redis cache) — resolved via kiteMap instead, built from the full
    // unfiltered trade set immediately above so every token is covered.
    const { exchange: exchangeFilter, script: scriptFilter } = req.query;
    if (exchangeFilter || scriptFilter) {
      for (const uid of Object.keys(tradesByUser)) {
        tradesByUser[uid] = tradesByUser[uid].filter((t) => {
          const inst = kiteMap[t.instrument_token];
          if (!inst) return false;
          if (exchangeFilter && inst.exchange !== exchangeFilter) return false;
          if (scriptFilter && inst.raw_name !== scriptFilter) return false;
          return true;
        });
      }
    }

    // 7. Load ALL BrokerageSettings (user-specific + caller's own + global)
    //
    // BUG (confirmed live, 2026-08-19 to 2026-08-26): this query's $in list
    // was built from allUserIds alone — every CLIENT under scope, but never
    // the CALLING MASTER's own id. callerRuleOwnerId (below) needs the
    // caller's own rows to compute their real per-instrument brokerage
    // rate, but since those rows were never fetched, brkRulesByUser[caller]
    // was always empty, silently falling back to the global platform rate
    // for every caller's "own rate" — inflating (or deflating) caller_brk/
    // total_caller for every master with a real custom rate, platform-wide,
    // since the batch-loading optimization (5c017b1b) introduced this
    // query. callerRuleOwnerId is computed here (moved up from just below)
    // so it can be included in the fetch, not just the later lookup.
    const callerRuleOwnerId = role === 'admin' ? null : callerId;
    // Confirmed live bug: for an ADMIN caller this previously fetched
    // `allUserIds` alone — every CLIENT under scope, but never any TOP-LEVEL
    // MASTER's own id. `masterOwnRules` (below, admin's per-master "what I
    // charge THIS specific master" rate) reads `brkRulesByUser[master._id]`
    // per row, which was therefore always empty regardless of whether that
    // master had a real individually-assigned rate on file — silently
    // falling back to the flat global default for EVERY top-level master's
    // caller_brk, platform-wide. Unlike the master-role case (a single
    // caller with one set of own rules), admin has no rules of its own —
    // every DIFFERENT top-level master's own id has to be included here, one
    // per row, not just a single "caller" id. Confirmed live: master 157459
    // has ~200 individually-assigned per-script rates (e.g. GOLD MCX-FUT at
    // their own rate), all silently ignored in favour of the global GOLD
    // rate (500/lot vs their actual ~200/lot), inflating "ADMIN BRK" from a
    // verified ~21,585 to a reported 86,184.89 for the same week's trades.
    const topEntityIds = role === 'admin' ? topEntities.map((m) => m._id.toString()) : [];
    // Every master in scope now needs its own rate fetched, not just the
    // caller's — _computeCallerBrkForUserBatched's base cost is the
    // client's DIRECT PARENT's own rate (whoever actually onboarded them),
    // which can be several levels below the caller. Without this, any
    // master that isn't the caller/topEntity falls through to the global
    // default for its own rate — the same class of bug documented above,
    // just for an intermediate master instead of the caller.
    const brkSettingsOwnerIds = callerRuleOwnerId
      ? [...allUserIds, callerRuleOwnerId, ...allScopeMasterIds]
      : [...allUserIds, ...topEntityIds, ...allScopeMasterIds];
    const allBrkSettings = await BrokerageSettings.find({
      $or: [
        { user_id: { $in: brkSettingsOwnerIds }, deleted_at: null },
        { user_id: null, deleted_at: null }
      ]
    }).lean();
    _mark('6_brokerageSettings');

    // Group brokerage rules by user_id
    const brkRulesByUser = {};   // userId → rules[]
    const globalBrkRules = [];
    for (const r of allBrkSettings) {
      if (!r.user_id) {
        globalBrkRules.push(r);
      } else {
        const uid = r.user_id.toString();
        if (!brkRulesByUser[uid]) brkRulesByUser[uid] = [];
        brkRulesByUser[uid].push(r);
      }
    }

    // Caller's rules (for caller brokerage base clearance calculation)
    let callerRules;
    if (callerRuleOwnerId === null) {
      callerRules = globalBrkRules;
    } else {
      callerRules = brkRulesByUser[callerRuleOwnerId] || [];
      if (callerRules.length === 0) callerRules = globalBrkRules;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Compute report using in-memory data (zero DB queries)
    // ═══════════════════════════════════════════════════════════════════════

    const data = [];

    if (role === 'admin') {
      for (const master of topEntities) {
        // Admin's "own rate" is NOT one flat global default shared by every
        // master — admin assigns each top-level master its own base rate
        // (stored as that master's own BrokerageSettings rows, same as any
        // other owner), and different masters are routinely given different
        // rates. Using the single request-wide `callerRules` (always
        // resolved to global for role==='admin', see callerRuleOwnerId
        // above) here meant every master's row was priced at the flat
        // global default regardless of what admin actually assigned that
        // specific master — inflating (or deflating) Master Brk for every
        // master whose own assigned rate differs from the global default.
        // Resolve per-master here instead, falling back to global only if
        // this master has no rate of their own.
        const masterOwnRules = brkRulesByUser[master._id.toString()] || globalBrkRules;
        const entry = _getAggregatedEntryBatched(
          master._id.toString(), master, metricsEngine, callerId, 'admin',
          masterMap, masterChildrenMap, usersByMaster, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, masterOwnRules
        );
        entry.parent_username = 'ADMIN';
        entry.type = 'master';
        data.push(entry);
      }
    } else {
      // Child masters
      for (const cm of topEntities) {
        const entry = _getAggregatedEntryBatched(
          cm._id.toString(), cm, metricsEngine, callerId, 'master',
          masterMap, masterChildrenMap, usersByMaster, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, callerRules
        );
        entry.parent_username = callerMaster?.username || '';
        entry.type = 'master';
        data.push(entry);
      }

      // Direct users
      const directUsers = usersByMaster[callerId] || [];
      for (const u of directUsers) {
        const entry = _getUserEntryBatched(
          u, metricsEngine, callerMaster, callerId, 'master',
          masterMap, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, callerRules
        );
        data.push(entry);
      }
    }

    _mark('7_compute');
    _timings.totalMs = Date.now() - _t0;
    _timings.masterCount = allMasters.length;
    _timings.userCount = allUsers.length;
    console.log(`[WeeklyAdminReport] ${_timings.totalMs}ms —`, JSON.stringify(_timings));

    // Distinct exchange/script values actually present in-period across the
    // caller's scope, for the Client P&L Summary screen's two filter
    // dropdowns — from kiteMap (built above from the FULL unfiltered trade
    // set, before the exchange/script narrowing above was applied), so
    // these lists don't shrink to just the currently-selected filter.
    const availableExchanges = [...new Set(kiteInstruments.map((k) => k.exchange).filter(Boolean))].sort();
    const availableScripts = [...new Set(kiteInstruments.map((k) => k.raw_name).filter(Boolean))].sort();

    res.json({
      success: true,
      data,
      totals: _sumTotals(data),
      available_exchanges: availableExchanges,
      available_scripts: availableScripts,
    });
  } catch (error) {
    console.error('[WeeklyAdminReport] Error:', error.message);
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// BATCHED COMPUTATION FUNCTIONS (zero DB queries — pure in-memory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BFS to get all sub-master IDs under a given master (inclusive).
 * Same logic as masterHierarchyService.getAllSubMasterIds but from in-memory map.
 */
function _getAllSubMasterIdsBatched(masterId, masterChildrenMap) {
  const result = [masterId];
  const queue = [masterId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = masterChildrenMap[currentId] || [];
    for (const child of children) {
      const childId = child._id.toString();
      result.push(childId);
      queue.push(childId);
    }
  }

  return result;
}

/**
 * Report entry for a single user. (No DB queries)
 */
function _getUserEntryBatched(userDoc, metricsEngine, callerMaster, callerId, callerRole,
  masterMap, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, callerRules) {

  const userId = userDoc._id.toString();
  const metrics = metricsEngine.getCachedMetrics(userId);
  const floatingPnl = metrics?.position_pnl || 0;
  const grossPnl = _getGrossPnlBatched(userId, tradesByUser);
  const { brokerage: totalBrokerage, turnover, lots } = _getUserBrokerageAndTurnoverBatched(
    userId, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap
  );

  // Caller's brokerage share (per-instrument), split from the spread above
  // the caller's own base/clearing cost — baseCost itself is display-only,
  // never shared (see the function's own doc comment).
  const { baseCost, callerBrk, owedUpwardBrk: rawOwedUpwardBrk } = _computeCallerBrkForUserBatched(
    userId, callerId, callerRole, tradesByUser, callerRules, kiteMap,
    masterMap, brkRulesByUser, globalBrkRules, userDoc, totalBrokerage
  );

  // P&L sharing: what the CALLER keeps for themselves = the pool that
  // arrives at them (nothing absorbed by anyone strictly between the user
  // and the caller) × the caller's OWN retention. Admin has no
  // pnl_sharing% of their own and no parent above them — whatever isn't
  // claimed by a master below reaches admin in full, so admin's own
  // retention is 100%. A master's retention is their own pnl_sharing%.
  //
  // Confirmed bug (this was previously `_getPnlUnpassedMultiplierForUserBatched`,
  // which multiplies by (100 - share)/100 at the caller's own hop — that
  // formula answers "what's left over after the caller's own cut", i.e.
  // what flows PAST the caller to whoever is above them. For admin (no
  // parent) that coincidentally equals what admin keeps, but for a master
  // viewing their own direct client it silently returned the SAME number
  // as owed_upward_pnl — the amount owed UP to admin, not what the master
  // keeps. Real numbers off a live report: a master's own direct client
  // showed "MASTER PROFIT" and "ADMIN P&L" as the identical figure, which
  // should only ever coincide for admin's own view.
  const incomingPoolMultiplier = _incomingPoolPnlMultiplierBatched(userId, callerId, userDoc, masterMap);
  const callerOwnPnlShare = masterMap[callerId]?.pnl_sharing || 0;
  const callerRetention = callerRole === 'admin' ? 1 : callerOwnPnlShare / 100;
  // Sharing is priced off the client's REAL total exposure (realised + still-
  // open m2m), not realised alone — a deliberate choice: this used to exclude
  // m2m to avoid paying a share on floating P&L that could still reverse
  // before settlement, but that basis is now applied uniformly regardless of
  // caller role.
  const sharingBasis = grossPnl + floatingPnl;
  const callerProfit = _r2((-sharingBasis) * incomingPoolMultiplier * callerRetention);

  // What the caller (whoever is viewing this report — a sub-master included)
  // must pass UP to their OWN parent, as opposed to caller_profit/caller_brk
  // above (what the caller keeps for themselves).
  const owedUpwardPnl = _r2(((-sharingBasis) * incomingPoolMultiplier) * (100 - callerOwnPnlShare) / 100);
  const owedUpwardBrk = _r2(rawOwedUpwardBrk);

  return {
    id: userId,
    name: userDoc.name,
    username: userDoc.username,
    parent_username: callerMaster?.username || '',
    type: 'user',
    realised_pnl: _r2(grossPnl),
    m2m_pnl: _r2(floatingPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(turnover),
    // Display-only base/clearing cost — never shared, see GM-Global note above.
    broker_brokerage: _r2(baseCost),
    caller_brk: _r2(callerBrk),
    // Net of BOTH realised and floating — was previously just -grossPnl,
    // silently ignoring m2m_pnl entirely, so "total" wasn't actually the
    // total. caller_profit/owed_upward_pnl above now share this same
    // realised+m2m basis (sharingBasis).
    total_pnl: _r2(-(grossPnl + floatingPnl)),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
    owed_upward_pnl: owedUpwardPnl,
    owed_upward_brk: owedUpwardBrk,
    total_owed_upward: _r2(owedUpwardPnl + owedUpwardBrk),
  };
}

/**
 * Aggregated report entry for a master and their entire sub-hierarchy. (No DB queries)
 */
function _getAggregatedEntryBatched(masterId, masterDoc, metricsEngine, callerId, callerRole,
  masterMap, masterChildrenMap, usersByMaster, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, callerRules) {

  const allMasterIds = _getAllSubMasterIdsBatched(masterId, masterChildrenMap);

  // Collect all users under this master's sub-tree
  const users = [];
  for (const mid of allMasterIds) {
    const usersForMaster = usersByMaster[mid] || [];
    users.push(...usersForMaster);
  }

  // Single pass per user for every per-user figure this row needs — P&L
  // share, brokerage/turnover, and the caller's brokerage cut. Used to be
  // three separate loops over the same `users` array, two of which
  // (brokerage and caller_brk) independently recomputed the same per-trade
  // sums via _getUserBrokerageAndTurnoverBatched.
  //
  // P&L sharing is computed PER USER and summed, not as one flat
  // multiplier applied to the combined total — a single blended rate is
  // wrong the moment two branches of the subtree have different
  // pnl_sharing rates, which real accounts do (100%, 90%, 98%, 50%, 20%,
  // 0% all seen on different masters).
  //
  // What the CALLER keeps for themselves from their own retention, once the
  // pool has already survived every level strictly between the user and the
  // caller. Admin has no pnl_sharing% of their own and nothing further
  // upstream — whatever isn't claimed by a master below reaches admin in
  // full (100% retention). Confirmed bug this replaces: the previous
  // `_getPnlUnpassedMultiplierForUserBatched`-based calc multiplied by
  // (100 - share)/100 at the caller's own hop, which is "what flows PAST
  // the caller" (the owed-upward amount) — coincidentally correct for
  // admin (nothing sits above them) but wrong for a master, whose own
  // "caller_profit" row was silently showing the exact same figure as
  // their "owed_upward_pnl" for a direct child.
  const callerOwnPnlShare = masterMap[callerId]?.pnl_sharing || 0;
  const callerRetention = callerRole === 'admin' ? 1 : callerOwnPnlShare / 100;

  let totalGrossPnl = 0;
  let totalFloatingPnl = 0;
  let callerProfit = 0;
  let totalBrokerage = 0, totalTurnover = 0, callerBrk = 0, totalBaseCost = 0;
  let owedUpwardPnl = 0;
  let owedUpwardBrk = 0;
  for (const u of users) {
    const uid = u._id.toString();

    const metrics = metricsEngine.getCachedMetrics(uid);
    const userFloatingPnl = metrics?.position_pnl || 0;
    totalFloatingPnl += userFloatingPnl;

    const userGrossPnl = _getGrossPnlBatched(uid, tradesByUser);
    totalGrossPnl += userGrossPnl;
    // Sharing is priced off the client's REAL total exposure (realised +
    // still-open m2m), not realised alone, for every caller role — see the
    // same note in _getUserEntryBatched. caller_profit and owed_upward_pnl
    // must use the SAME basis so the two always sum to the full incoming
    // pool for this user, regardless of role.
    const userSharingBasis = userGrossPnl + userFloatingPnl;
    // Pool arriving AT THE CALLER (e.g. a master viewing their own
    // sub-broker), after every level strictly between this user and the
    // caller has already absorbed their own cut — same helper
    // _getUserEntryBatched uses for a direct client, applied here per-user
    // across this row's entire sub-tree (not just masterId's direct clients).
    const userIncomingPool = _incomingPoolPnlMultiplierBatched(uid, callerId, u, masterMap);
    callerProfit += (-userSharingBasis) * userIncomingPool * callerRetention;
    // What passes PAST the caller, upward — the caller's own complement of
    // the SAME incoming pool. Confirmed bug this replaces: previously used
    // masterId's OWN pnl_sharing% here instead of the caller's — since an
    // aggregated row's masterId always has the caller as its direct parent,
    // that produced the pool arriving AT the caller BEFORE the caller's own
    // cut (i.e. the same total callerProfit is only ~90% of), not the ~10%
    // that actually flows past the caller. A live report showed a
    // sub-broker row's "ADMIN P&L" LARGER in magnitude than "MASTER
    // PROFIT" — backwards from the direct-client rows on the same report,
    // where the admin figure is correctly the smaller remainder.
    owedUpwardPnl += (-userSharingBasis) * userIncomingPool * (1 - callerRetention);

    const { brokerage, turnover } = _getUserBrokerageAndTurnoverBatched(
      uid, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap
    );
    totalBrokerage += brokerage;
    totalTurnover += turnover;
    const userBrkShare = _computeCallerBrkForUserBatched(
      uid, callerId, callerRole, tradesByUser, callerRules, kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, u, brokerage
    );
    totalBaseCost += userBrkShare.baseCost;
    callerBrk += userBrkShare.callerBrk;
    owedUpwardBrk += userBrkShare.owedUpwardBrk;
  }
  callerProfit = _r2(callerProfit);
  owedUpwardPnl = _r2(owedUpwardPnl);
  owedUpwardBrk = _r2(owedUpwardBrk);

  return {
    id: masterId,
    name: masterDoc.name,
    username: masterDoc.username,
    realised_pnl: _r2(totalGrossPnl),
    m2m_pnl: _r2(totalFloatingPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(totalTurnover),
    broker_brokerage: _r2(totalBaseCost),
    caller_brk: _r2(callerBrk),
    // Net of BOTH realised and floating. caller_profit's own basis differs
    // by caller role — see the callerProfitBasis comment in the loop above:
    // realised-only for a master's own view, realised+m2m for admin's.
    total_pnl: _r2(-(totalGrossPnl + totalFloatingPnl)),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
    owed_upward_pnl: owedUpwardPnl,
    owed_upward_brk: owedUpwardBrk,
    total_owed_upward: _r2(owedUpwardPnl + owedUpwardBrk),
  };
}

/**
 * Resolve the rupee amount a single rule set implies for a given
 * turnover/lots pair — the same TURNOVER WISE / LOT WISE arithmetic used
 * everywhere else in this file, factored out so the multi-layer cascade
 * below can apply it once per participant per instrument.
 */
function _rateAmountForRules(rules, rawName, seg, turnover, lots) {
  const rule = _findRule(rules, rawName, seg);
  if (!rule) return null;
  if (rule.type === 'TURNOVER WISE') return turnover * (rule.brk_value / 10000);
  if (rule.type === 'LOT WISE') return lots * rule.brk_value;
  return null;
}

/**
 * Walk from a client's direct parent up to the topmost master (the one
 * whose own master_id is null — admin's direct child), returning IDs
 * TOP-FIRST. Same cycle-detection safety net as the pnl/brk "unpassed"
 * multiplier walks elsewhere in this file.
 */
function _getMasterChainTopDown(directParentId, masterMap) {
  const bottomUp = [];
  let current = directParentId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    bottomUp.push(current);
    const m = masterMap[current];
    current = m?.master_id ? m.master_id.toString() : null;
  }
  return bottomUp.reverse();
}

/**
 * Multi-layer brokerage cascade — replaces the old single-spread model.
 *
 * Confirmed business rule (verified end-to-end against real GM-Global
 * figures for the SAME real trades and the SAME configured rates — not
 * just internally-consistent totals, but the exact rupee amount GM-Global
 * itself displays as "Broker Brokerage": ₹240.00 for a GOLD trade, ₹187.04
 * for a BANKNIFTY trade, ₹160.00 for a NIFTY-CE trade, all matched to the
 * paisa using 829814 (test harry main, brokerage_sharing 94) -> 119318
 * (harry demo test, brokerage_sharing 0) -> client 205239's real trades
 * this week):
 *
 * A client's actual billed rate is reached by a CHAIN of per-instrument
 * rates — the topmost master's own admin-assigned rate, then whatever each
 * subsequent master along the way charges their own downline (which may
 * simply repeat the same rate unchanged, or raise it). This produces a
 * sequence of LAYERS: layer 1 is the topmost master's own rate (the base,
 * assigned by admin); every later layer is the INCREASE (if any) a
 * specific master introduces for their own child — zero, and skipped
 * entirely, when a hop just passes the same rate through unchanged.
 *
 * Each layer cascades upward INDEPENDENTLY, starting its own walk at
 * whoever "owns" it — the topmost master for layer 1 (admin's own
 * assignment); whoever raised the rate for their own downline, for every
 * later layer. At each step of a layer's own upward walk, that entity's
 * OWN brokerage_sharing% determines what they keep of THAT layer; the
 * remainder continues to their own parent, who applies THEIR OWN %,
 * compounding, until it reaches admin (who has no parent — whatever isn't
 * claimed by anyone below reaches admin in full). A master who never
 * personally raises a rate for anyone never triggers a layer of their own,
 * and only ever earns from the base layer (and any layer raised further
 * above them) passing through — the multi-tier variant of the OLD single-
 * spread model's "spread stays with whoever created it" rule.
 *
 * Superseded the old "spread stays entirely with the direct parent, base
 * cascades via each intermediate's own share%" model — correct only when
 * there is exactly ONE rate change anywhere in the chain (which the
 * earlier 3-tier verification happened to have); wrong the moment a rate
 * changes at more than one hop, since the old model had no way to
 * attribute a SPECIFIC increase to the SPECIFIC master who introduced it.
 *
 * Returns { baseCost, callerBrk, owedUpwardBrk }. `baseCost` is now
 * redefined to mean the client's DIRECT PARENT's own total keep (base
 * layer's share reaching them, plus every layer they personally created)
 * — this is what `broker_brokerage` displays, and is exactly the figure
 * GM-Global's own "Broker Brokerage" column shows, not a never-shared
 * clearing cost as the old model's `baseCost` was.
 */
function _computeCallerBrkForUserBatched(userId, callerId, callerRole, tradesByUser, callerRules, kiteMap,
  masterMap, brkRulesByUser, globalBrkRules, userDoc, userTotalBrk) {

  const trades = tradesByUser[userId] || [];
  if (trades.length === 0) return { baseCost: 0, callerBrk: 0, owedUpwardBrk: 0 };

  const directParentId = userDoc?.master_id?.toString() || null;
  if (!directParentId) return { baseCost: 0, callerBrk: 0, owedUpwardBrk: 0 };

  const chainTopDown = _getMasterChainTopDown(directParentId, masterMap); // [topmost, ..., directParent]
  if (chainTopDown.length === 0) return { baseCost: 0, callerBrk: 0, owedUpwardBrk: 0 };

  // Group trades by instrument, same as every other per-instrument walk in
  // this file.
  const byInstrument = {};
  for (const t of trades) {
    const token = t.instrument_token;
    if (!byInstrument[token]) byInstrument[token] = { turnover: 0, lots: 0 };
    const ki = kiteMap[token];
    const lotSize = ki?.lot_size || 1;
    byInstrument[token].turnover += t.executed_price * t.executed_quantity;
    byInstrument[token].lots += lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;
  }

  // What every participant keeps in total, across all instruments — keyed
  // by master id, plus a special 'admin' key for whatever reaches the top
  // unclaimed.
  const keepByEntity = {};
  const addKeep = (id, amount) => {
    if (!amount) return;
    keepByEntity[id] = (keepByEntity[id] || 0) + amount;
  };

  for (const [token, data] of Object.entries(byInstrument)) {
    const ki = kiteMap[token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const { turnover, lots } = data;

    // Resolve each participant's OWN effective rate amount for this
    // instrument, topmost master down to the client. "Own effective rate"
    // = their own configured rule if they have one; if not, they silently
    // INHERIT whoever is immediately above them (already resolved) — never
    // jumping straight to the platform global default. A master with no
    // override of their own charges exactly what their own parent charges
    // (no layer forms at that hop), not the platform's unrelated default.
    // FLOOR against the inherited amount (never let a resolved rate DROP
    // below what's already flowing in from above) — confirmed real leak
    // otherwise: if a middle entity's own configured rate is lower than
    // their own parent's (e.g. left over from testing, or simply never
    // updated after a parent's rate changed), the base layer still gets
    // fully distributed using the ORIGINAL higher rate, and a later
    // markup layer further down gets computed AND distributed again
    // relative to the now-lower baseline — double-counting the gap. A
    // 3-level trace (top=100, middle drops to 50, client billed 90) pays
    // out 140 total from a client who only paid 90 without this floor.
    // Flooring treats an accidental/leftover drop as "no layer at this
    // hop" (their own rate is simply ignored in favour of the inherited
    // one) instead of creating a phantom negative-then-repeated-positive
    // gap — the correctness guarantee that matters here (total
    // distributed == total billed), not preserving the literal
    // misconfigured number.
    const fullChain = [...chainTopDown, userId];
    const rateAmounts = [];
    let prevAmount = null;
    for (const entityId of fullChain) {
      const ownRules = brkRulesByUser[entityId] || [];
      const ownAmount = _rateAmountForRules(ownRules, rawName, seg, turnover, lots);
      let resolved;
      if (ownAmount != null) {
        resolved = prevAmount != null ? Math.max(ownAmount, prevAmount) : ownAmount;
      } else {
        resolved = prevAmount != null ? prevAmount : (_rateAmountForRules(globalBrkRules, rawName, seg, turnover, lots) || 0);
      }
      rateAmounts.push(resolved);
      prevAmount = resolved;
    }

    // Layer 0 = the topmost master's own rate (the base, admin-assigned —
    // nobody "created" it, it simply passes through). Layer k (k>0) = the
    // increase, if any, that chainTopDown[k-1] personally introduced for
    // their own child at hop k.
    //
    // Two different rules, confirmed against real data (see this
    // function's own doc comment) — NOT the same mechanic:
    //
    //  - Layer 0 (pass-through/assigned, RULE 1): walk UP from the topmost
    //    master toward admin. Each entity's OWN % is their OWN retention —
    //    they keep that %, the remainder continues further up, compounding
    //    through every ancestor — same mechanic as
    //    _incomingPoolBrkMultiplierBatched.
    //
    //  - Layer k>0 (personally created, RULE 2): the CREATOR's own % is
    //    the INVERSE — how much they voluntarily share back UP to their
    //    own parent, keeping the complement for themselves. (Confirmed:
    //    119318's own share of 0% meant they kept the FULL spread, not
    //    0% of it — the opposite of RULE 1's meaning for the same field.)
    //    Whatever the creator shares upward then behaves like ordinary
    //    base money reaching their own parent, who applies RULE 1 for
    //    however many ancestors remain above the creator, compounding.
    for (let i = 0; i < fullChain.length; i++) {
      const layerValue = i === 0 ? rateAmounts[0] : (rateAmounts[i] - rateAmounts[i - 1]);
      if (!layerValue || layerValue <= 0) continue;

      let remaining;
      let walkFrom; // index into chainTopDown to start the RULE-1 upward walk from
      if (i === 0) {
        remaining = layerValue;
        walkFrom = 0;
      } else {
        const creatorIdx = i - 1; // always a valid chainTopDown index — the client (last in fullChain) never creates a layer for anyone below them
        const creatorEntityId = chainTopDown[creatorIdx];
        const creatorOwnShare = (masterMap[creatorEntityId]?.brokerage_sharing || 0) / 100;
        addKeep(creatorEntityId, layerValue * (1 - creatorOwnShare));
        remaining = layerValue * creatorOwnShare;
        walkFrom = creatorIdx - 1;
      }

      // RULE 1 upward walk: toward admin, i.e. DECREASING index — index 0
      // is the topmost master, closest to admin.
      for (let j = walkFrom; j >= 0 && remaining > 0; j--) {
        const entityId = chainTopDown[j];
        const ownShare = (masterMap[entityId]?.brokerage_sharing || 0) / 100;
        const kept = remaining * ownShare;
        addKeep(entityId, kept);
        remaining -= kept;
      }
      // Whatever nobody along the way claimed reaches admin in full.
      if (remaining > 0) addKeep('admin', remaining);
    }
  }

  const callerKey = callerRole === 'admin' ? 'admin' : callerId;
  const callerBrk = keepByEntity[callerKey] || 0;

  // owedUpwardBrk: what the caller (a master) still owes further up —
  // everything kept by every entity STRICTLY ABOVE the caller in this
  // specific user's chain, admin included. Zero for an admin caller
  // (nothing sits above them) and zero if the caller isn't actually an
  // ancestor of this user (shouldn't happen given this route's own
  // authorization checks, but stay safe rather than throw).
  let owedUpwardBrk = 0;
  if (callerRole !== 'admin') {
    const callerIdx = chainTopDown.indexOf(callerId);
    if (callerIdx !== -1) {
      for (let j = 0; j < callerIdx; j++) owedUpwardBrk += keepByEntity[chainTopDown[j]] || 0;
      owedUpwardBrk += keepByEntity['admin'] || 0;
    }
  }

  // baseCost (→ broker_brokerage display column): the client's DIRECT
  // PARENT's own total keep — base layer's share reaching them, plus every
  // layer they personally created. Exactly GM-Global's "Broker Brokerage".
  const baseCost = keepByEntity[directParentId] || 0;

  return { baseCost, callerBrk, owedUpwardBrk };
}

/**
 * For a direct user: compute what fraction of their P&L flows up to the caller. (No DB queries)
 *
 * Same logic as original _getPnlUnpassedMultiplierForUser.
 *
 * No depth limit — real hierarchies here run 50-60+ tiers deep, and a
 * fixed cap (previously 10, then 500) silently truncates the cascade for
 * anything deeper, attributing the wrong share to every tier above the
 * cap instead of continuing to the real caller. The only guard is cycle
 * detection: a `visited` set stops the walk if the SAME master is reached
 * twice, which can only happen from a corrupted circular master_id
 * reference (impossible in a valid tree) — without it, that one bad row
 * would spin this synchronous loop forever and freeze the whole Node
 * process (this runs on the single-threaded event loop), not just fail
 * one request.
 */
function _getPnlUnpassedMultiplierForUserBatched(userId, callerId, userDoc, masterMap) {
  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;

  let multiplier = 1;
  let currentMasterId = userMasterId;
  const visited = new Set();

  while (currentMasterId && !visited.has(currentMasterId)) {
    visited.add(currentMasterId);
    const master = masterMap[currentMasterId];
    if (!master) break;

    multiplier *= (100 - (master.pnl_sharing || 0)) / 100;

    // Stop the INSTANT we've just applied the caller's own hop — for a
    // direct client (userMasterId === callerId), that's this very first
    // iteration. The old check below tested this master's PARENT against
    // callerId instead of the master itself, so a direct client's row kept
    // climbing past the caller into every ancestor above them, multiplying
    // in shares that don't belong to this calculation at all (confirmed
    // bug — collapses to near-zero whenever an ancestor has a high share).
    if (currentMasterId === callerId) break;
    if (!master.master_id) break;
    currentMasterId = master.master_id.toString();
  }

  return multiplier;
}

/**
 * The P&L pool ARRIVING at the caller for this user, before the caller's own
 * pnl_sharing% is taken out — i.e. every intermediate master strictly
 * BETWEEN the user and the caller absorbs their own share and passes the
 * remainder up, but the caller's own absorption is deliberately excluded
 * here (the caller applies their own rate to this result separately, to get
 * "owed upward" = what's left after that). Returns 1 for a direct client of
 * the caller (nothing has been absorbed by anyone yet).
 *
 * Structural sibling of _getPnlUnpassedMultiplierForUserBatched, which
 * answers a different question ("how much reaches the caller as THEIR OWN
 * take") — that function's stopping boundary works backwards for this one's
 * purpose: for a direct client (userMasterId === callerId), that walk
 * absorbs the caller's own share (and, since a master's own parent is never
 * itself, incorrectly keeps climbing past the caller into their ancestors
 * too) — fine for its own purpose, wrong for "pool before caller's
 * absorption." This function stops the instant callerId is reached, before
 * ever processing it.
 */
function _incomingPoolPnlMultiplierBatched(userId, callerId, userDoc, masterMap) {
  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;
  if (userMasterId === callerId) return 1;

  let multiplier = 1;
  let currentMasterId = userMasterId;
  const visited = new Set();

  while (currentMasterId && currentMasterId !== callerId && !visited.has(currentMasterId)) {
    visited.add(currentMasterId);
    const master = masterMap[currentMasterId];
    if (!master) break;

    multiplier *= (100 - (master.pnl_sharing || 0)) / 100;
    currentMasterId = master.master_id ? master.master_id.toString() : null;
  }

  return multiplier;
}

/**
 * For a direct user: compute what fraction of their brokerage spread flows
 * up to the caller. (No DB queries)
 *
 * Structural mirror of _getPnlUnpassedMultiplierForUserBatched — walks
 * every intermediate master between the user and the caller, multiplying
 * in each one's own brokerage_sharing%, instead of only looking at a
 * single master along the path.
 *
 * No depth limit, same cycle-detection safety net — see
 * _getPnlUnpassedMultiplierForUserBatched's comment on the same pattern.
 */
function _getBrkUnpassedMultiplierForUserBatched(userId, callerId, userDoc, masterMap) {
  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;

  let multiplier = 1;
  let currentMasterId = userMasterId;
  const visited = new Set();

  while (currentMasterId && !visited.has(currentMasterId)) {
    visited.add(currentMasterId);
    const master = masterMap[currentMasterId];
    if (!master) break;

    multiplier *= (100 - (master.brokerage_sharing || 0)) / 100;

    // Same fix as _getPnlUnpassedMultiplierForUserBatched — stop right
    // after applying the caller's own hop, not their parent's.
    if (currentMasterId === callerId) break;
    if (!master.master_id) break;
    currentMasterId = master.master_id.toString();
  }

  return multiplier;
}

/**
 * The brokerage spread ARRIVING at the caller for this user, before the
 * caller's own brokerage_sharing% is taken out — brokerage-side mirror of
 * _incomingPoolPnlMultiplierBatched. Every intermediate master strictly
 * BETWEEN the user and the caller absorbs their own share and passes the
 * remainder up; the caller's own absorption is deliberately excluded here
 * (the caller applies their own rate/share to this result separately).
 * Returns 1 for a direct client of the caller (nothing absorbed yet).
 *
 * _getBrkUnpassedMultiplierForUserBatched above answers a different
 * question ("how much reaches the caller as THEIR OWN take", including
 * their own hop) — right for that purpose, wrong for "pool before the
 * caller's own absorption", which is what _computeCallerBrkForUserBatched
 * actually needs for caller_brk (a GROSS figure, not the caller's net).
 */
function _incomingPoolBrkMultiplierBatched(userId, callerId, userDoc, masterMap) {
  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;
  if (userMasterId === callerId) return 1;

  let multiplier = 1;
  let currentMasterId = userMasterId;
  const visited = new Set();

  while (currentMasterId && currentMasterId !== callerId && !visited.has(currentMasterId)) {
    visited.add(currentMasterId);
    const master = masterMap[currentMasterId];
    if (!master) break;

    multiplier *= (100 - (master.brokerage_sharing || 0)) / 100;
    currentMasterId = master.master_id ? master.master_id.toString() : null;
  }

  return multiplier;
}


/**
 * Gross realised P&L (sum of trade.pnl). Same as original _getGrossPnl but from pre-loaded array.
 */
function _getGrossPnlBatched(userId, tradesByUser) {
  const trades = tradesByUser[userId] || [];
  let total = 0;
  for (const t of trades) {
    total += t.pnl || 0;
  }
  return total;
}

/**
 * User's total brokerage, turnover, and lots from current trades. (No DB queries)
 * Same logic as original _getUserBrokerageAndTurnover.
 */
function _getUserBrokerageAndTurnoverBatched(userId, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap) {
  const trades = tradesByUser[userId] || [];
  if (trades.length === 0) return { brokerage: 0, turnover: 0, lots: 0 };

  const ownRules = brkRulesByUser[userId] || [];

  let totalBrk = 0, totalTurnover = 0, totalLots = 0;
  for (const t of trades) {
    const ki = kiteMap[t.instrument_token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;
    const tradeTurnover = t.executed_price * t.executed_quantity;
    const tradeLots = lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;

    totalTurnover += tradeTurnover;
    totalLots += tradeLots;

    // Try the client's own custom rules first, then fall back to the global
    // rule set PER INSTRUMENT — not just when the client has zero custom
    // rules at all. A client with SOME custom rules (e.g. an NSE-only
    // override) but none matching THIS instrument (e.g. an MCX trade)
    // previously fell through silently: real turnover, zero brokerage, no
    // error, because the old code only consulted the global list when the
    // client's own rule array was completely empty.
    const brkRule = _findRule(ownRules, rawName, seg) || _findRule(globalBrkRules, rawName, seg);
    if (brkRule) {
      if (brkRule.type === 'TURNOVER WISE') {
        totalBrk += tradeTurnover * (brkRule.brk_value / 10000);
      } else if (brkRule.type === 'LOT WISE') {
        totalBrk += tradeLots * brkRule.brk_value;
      }
    }
  }

  return { brokerage: totalBrk, turnover: totalTurnover, lots: totalLots };
}

/**
 * Find a brokerage rule using 4-level matching. (Unchanged — already pure in-memory)
 */
function _findRule(rules, rawName, seg) {
  let rule = null;
  if (rawName && seg) rule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
  if (!rule && rawName) rule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
  if (!rule && seg) rule = rules.find(r => r.exchange_name === seg.toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
  // Guarded by `seg` here too — an instrument missing from kiteMap (token
  // not found) passes seg='', and `''.split('-')[0] || ''` still evaluates
  // to '', so this used to match any rule with a blank exchange_name for
  // ANY unrecognized instrument, applying an unrelated rate. No seg means
  // no rule, not a guess.
  if (!rule && seg) rule = rules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
  return rule;
}

function _sumTotals(data) {
  return {
    realised_pnl: _r2(data.reduce((s, d) => s + d.realised_pnl, 0)),
    m2m_pnl: _r2(data.reduce((s, d) => s + d.m2m_pnl, 0)),
    brokerage: _r2(data.reduce((s, d) => s + d.brokerage, 0)),
    turnover: _r2(data.reduce((s, d) => s + (d.turnover || 0), 0)),
    broker_brokerage: _r2(data.reduce((s, d) => s + (d.broker_brokerage || 0), 0)),
    caller_brk: _r2(data.reduce((s, d) => s + (d.caller_brk || 0), 0)),
    total_pnl: _r2(data.reduce((s, d) => s + d.total_pnl, 0)),
    caller_profit: _r2(data.reduce((s, d) => s + (d.caller_profit || 0), 0)),
    total_caller: _r2(data.reduce((s, d) => s + (d.total_caller || 0), 0)),
    owed_upward_pnl: _r2(data.reduce((s, d) => s + (d.owed_upward_pnl || 0), 0)),
    owed_upward_brk: _r2(data.reduce((s, d) => s + (d.owed_upward_brk || 0), 0)),
    total_owed_upward: _r2(data.reduce((s, d) => s + (d.total_owed_upward || 0), 0)),
  };
}

const _r2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  getWeeklyAdminReport,
  _private: {
    _computeCallerBrkForUserBatched,
    _getPnlUnpassedMultiplierForUserBatched,
    _getBrkUnpassedMultiplierForUserBatched,
    _incomingPoolPnlMultiplierBatched,
    _incomingPoolBrkMultiplierBatched,
    _getUserBrokerageAndTurnoverBatched,
    _findRule,
  },
};
