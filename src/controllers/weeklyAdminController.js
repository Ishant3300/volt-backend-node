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
    const brkSettingsOwnerIds = callerRuleOwnerId
      ? [...allUserIds, callerRuleOwnerId]
      : [...allUserIds, ...topEntityIds];
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

  // Caller's brokerage share (per-instrument cascade)
  const callerBrk = _computeCallerBrkForUserBatched(
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
  // above (what the caller keeps for themselves). See _cascadeBrokerageOwedUpwardBatched
  // for the brokerage-side cascade.
  const owedUpwardPnl = _r2(((-sharingBasis) * incomingPoolMultiplier) * (100 - callerOwnPnlShare) / 100);
  const owedUpwardBrk = _r2(_cascadeBrokerageOwedUpwardBatched(
    userId, callerId, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap, userDoc, masterMap
  ));

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
  let totalBrokerage = 0, totalTurnover = 0, callerBrk = 0;
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
    callerBrk += _computeCallerBrkForUserBatched(
      uid, callerId, callerRole, tradesByUser, callerRules, kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, u, brokerage
    );
    // Same fix as owedUpwardPnl above — cascade all the way through the
    // CALLER's own step, not just up to masterId's own step.
    owedUpwardBrk += _cascadeBrokerageOwedUpwardBatched(
      uid, callerId, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap, u, masterMap
    );
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
 * Compute caller's brokerage share for a single user using per-instrument cascade. (No DB queries)
 *
 * Same logic as original _computeCallerBrkForUser but reads from pre-loaded maps.
 *
 * `userTotalBrk` is passed in rather than recomputed — every call site
 * already calls _getUserBrokerageAndTurnoverBatched for this same user a
 * few lines earlier (for the report's own `brokerage` column); this used
 * to redo that same per-trade iteration a second time internally, doubling
 * the JS-side work for every user in the report.
 */
function _computeCallerBrkForUserBatched(userId, callerId, callerRole, tradesByUser, callerRules, kiteMap,
  masterMap, brkRulesByUser, globalBrkRules, userDoc, userTotalBrk) {

  const trades = tradesByUser[userId] || [];
  if (trades.length === 0) return 0;

  // Group trades by instrument
  const byInstrument = {};
  for (const t of trades) {
    const token = t.instrument_token;
    if (!byInstrument[token]) byInstrument[token] = { turnover: 0, lots: 0 };
    const ki = kiteMap[token];
    const lotSize = ki?.lot_size || 1;
    byInstrument[token].turnover += t.executed_price * t.executed_quantity;
    byInstrument[token].lots += lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;
  }

  // Compute caller's base clearance per instrument
  let callerBaseClearance = 0;
  for (const [token, data] of Object.entries(byInstrument)) {
    const ki = kiteMap[token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';

    let callerRule = _findRule(callerRules, rawName, seg);
    if (!callerRule) continue;

    if (callerRule.type === 'TURNOVER WISE') {
      callerBaseClearance += data.turnover * (callerRule.brk_value / 10000);
    } else if (callerRule.type === 'LOT WISE') {
      callerBaseClearance += data.lots * callerRule.brk_value;
    }
  }

  // Cascade through EVERY intermediate master's own brokerage_sharing%
  // between the user and the caller — mirrors
  // _getPnlUnpassedMultiplierForUserBatched exactly. Previously this only
  // looked at the SINGLE topmost master below the caller (the first whose
  // own parent was the caller) and applied just that one master's
  // brokerage_sharing% to the entire spread, silently ignoring any
  // different brokerage_sharing% configured on deeper intermediate masters
  // — correct by coincidence for 1- and 2-tier hierarchies (nothing to
  // ignore), wrong for 3+ tiers.
  const unpassedFraction = _getBrkUnpassedMultiplierForUserBatched(userId, callerId, userDoc, masterMap);

  // Spread above caller's base = what's left after caller takes their base
  const spreadAboveCaller = Math.max(0, userTotalBrk - callerBaseClearance);
  const unpassedAmount = spreadAboveCaller * unpassedFraction;

  return callerBaseClearance + unpassedAmount;
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
 * What the caller must pass UP to their own parent for this one user's
 * brokerage — a different question from _computeCallerBrkForUserBatched
 * (what the caller keeps). Per the confirmed business rule:
 *
 *   base_cost_owed = volume × THIS LEVEL's own rate — whatever
 *                    BrokerageSettings row admin actually assigned to this
 *                    specific master (brkRulesByUser[masterId], the same
 *                    mechanism used to bill a leaf user, just keyed by a
 *                    master's own id), falling back to the global default
 *                    only if admin never assigned this master an
 *                    individual rate. Per-master, not a fixed constant.
 *   spread_margin  = amount arriving at this level − base_cost_owed
 *   passed_up      = base_cost_owed + spread_margin × (1 − brokerage_sharing% / 100)
 *
 * Applied once per level, walking from the user's direct master UP TO AND
 * INCLUDING the caller (unlike _incomingPoolPnlMultiplierBatched, which
 * stops BEFORE the caller — brokerage's base-cost step is coupled to each
 * level's own rate, so the caller's own step has to run here, not be
 * applied separately afterward). The starting amount is the client's own
 * actual billed brokerage — same per-instrument turnover/lots grouping as
 * _computeCallerBrkForUserBatched, computed independently here since that
 * function only returns a total, not a per-instrument breakdown to feed
 * this cascade.
 *
 * Previously used a separate MasterBaseRate collection (a self-reported,
 * rarely-configured value with no relation to what admin actually billed
 * that master) — replaced with the real BrokerageSettings rate on file for
 * each level, same data source _computeCallerBrkForUserBatched already
 * uses for a caller's own base clearance.
 *
 * A level with no individually-assigned rate falls back to the global
 * default rather than treating base_cost_owed as 0 — same fail-open
 * convention as every other lookup in this file (ownRules || globalBrkRules).
 */
function _cascadeBrokerageOwedUpwardBatched(
  userId, callerId, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap, userDoc, masterMap
) {
  const trades = tradesByUser[userId] || [];
  if (trades.length === 0) return 0;

  const ownRules = brkRulesByUser[userId] || [];

  // Per instrument: the client's own actual billed brokerage + volume.
  const byInstrument = {};
  for (const t of trades) {
    const token = t.instrument_token;
    const ki = kiteMap[token];
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;
    if (!byInstrument[token]) byInstrument[token] = { turnover: 0, lots: 0, billed: 0, seg, rawName };
    const entry = byInstrument[token];
    const tradeTurnover = t.executed_price * t.executed_quantity;
    const tradeLots = lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity;
    entry.turnover += tradeTurnover;
    entry.lots += tradeLots;

    // Same per-instrument fallback fix as _getUserBrokerageAndTurnoverBatched
    // — this must reflect the client's ACTUAL billed brokerage, which has to
    // agree with that function's own total for the same trades.
    const rule = _findRule(ownRules, rawName, seg) || _findRule(globalBrkRules, rawName, seg);
    if (rule) {
      if (rule.type === 'TURNOVER WISE') entry.billed += tradeTurnover * (rule.brk_value / 10000);
      else if (rule.type === 'LOT WISE') entry.billed += tradeLots * rule.brk_value;
    }
  }

  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;

  const currentAmount = {};
  for (const [token, d] of Object.entries(byInstrument)) currentAmount[token] = d.billed;

  let currentMasterId = userMasterId;
  const visited = new Set();

  while (currentMasterId && !visited.has(currentMasterId)) {
    visited.add(currentMasterId);
    const master = masterMap[currentMasterId];
    if (!master) break;

    const sharePct = master.brokerage_sharing || 0;
    // This level's OWN base cost = whatever rate ADMIN actually assigned to
    // THIS master specifically — the same BrokerageSettings row used to
    // bill a leaf user, just keyed by this master's own id instead. Falls
    // back to the global default only if admin never assigned this master
    // an individual rate, same convention every other lookup in this file
    // uses (_findRule via ownRules || globalBrkRules).
    const levelOwnRules = brkRulesByUser[currentMasterId] || globalBrkRules;

    for (const [token, d] of Object.entries(byInstrument)) {
      const baseRule = _findRule(levelOwnRules, d.rawName, d.seg);
      let baseCostOwed = 0;
      if (baseRule) {
        if (baseRule.type === 'TURNOVER WISE') baseCostOwed = d.turnover * (baseRule.brk_value / 10000);
        else if (baseRule.type === 'LOT WISE') baseCostOwed = d.lots * baseRule.brk_value;
      }
      const spreadMargin = currentAmount[token] - baseCostOwed;
      currentAmount[token] = baseCostOwed + spreadMargin * (100 - sharePct) / 100;
    }

    if (currentMasterId === callerId) break; // just processed the caller's own level
    currentMasterId = master.master_id ? master.master_id.toString() : null;
  }

  return Object.values(currentAmount).reduce((sum, v) => sum + v, 0);
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
    _cascadeBrokerageOwedUpwardBatched,
    _getUserBrokerageAndTurnoverBatched,
    _findRule,
  },
};
