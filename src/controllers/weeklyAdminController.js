const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

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

    if (role === 'admin') {
      topEntities = allMasters.filter(m => !m.master_id);
    } else {
      callerMaster = masterMap[callerId] || null;
      topEntities = masterChildrenMap[callerId] || [];
    }

    // 3. Collect ALL master IDs in scope (for all sub-trees we need to report on)
    const allScopeMasterIds = new Set();
    if (role === 'admin') {
      // Admin sees everything
      allMasters.forEach(m => allScopeMasterIds.add(m._id.toString()));
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
      'instrument_token lot_size segment raw_name'
    ).lean();
    const kiteMap = {};
    for (const ki of kiteInstruments) {
      kiteMap[ki.instrument_token] = ki;
    }
    _mark('5_instruments');

    // 7. Load ALL BrokerageSettings (user-specific + global)
    const allBrkSettings = await BrokerageSettings.find({
      $or: [
        { user_id: { $in: allUserIds }, deleted_at: null },
        { user_id: null, deleted_at: null }
      ]
    }).lean();
    _mark('6_brokerageSettings');

    // Also load caller's brokerage rules
    const callerRuleOwnerId = role === 'admin' ? null : callerId;
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
        const entry = _getAggregatedEntryBatched(
          master._id.toString(), master, metricsEngine, callerId, 'admin',
          masterMap, masterChildrenMap, usersByMaster, tradesByUser, kiteMap, brkRulesByUser, globalBrkRules, callerRules
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

    res.json({ success: true, data, totals: _sumTotals(data) });
  } catch (error) {
    console.error('[WeeklyAdminReport] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
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

  // P&L sharing: caller's share = product of unpassed fractions from user up to caller
  const pnlMultiplier = _getPnlUnpassedMultiplierForUserBatched(userId, callerId, userDoc, masterMap);
  const callerProfit = _r2((-grossPnl) * pnlMultiplier);

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
    // total. caller_profit's own basis is deliberately left as grossPnl
    // alone (realised only) — that's a separate, already-verified
    // commission-sharing calculation, not the display total, and
    // commission shouldn't be paid out on unrealised/floating P&L that
    // could still reverse before settlement.
    total_pnl: _r2(-(grossPnl + floatingPnl)),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
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
  // multiplier applied to the combined total — the previous implementation
  // (_getPnlUnpassedMultiplierBatched, removed) only walked masterId's
  // direct children, ignoring anything deeper, and even walked fully, a
  // single blended rate is wrong the moment two branches of the subtree
  // have different pnl_sharing rates, which real accounts do (100%, 90%,
  // 98%, 50%, 20%, 0% all seen on different masters).
  // _getPnlUnpassedMultiplierForUserBatched already walks each user's own
  // path correctly and stops at the right boundary relative to callerId
  // (it's what _getUserEntryBatched uses for individual client rows).
  let totalGrossPnl = 0;
  let totalFloatingPnl = 0;
  let callerProfit = 0;
  let totalBrokerage = 0, totalTurnover = 0, callerBrk = 0;
  for (const u of users) {
    const uid = u._id.toString();

    const metrics = metricsEngine.getCachedMetrics(uid);
    totalFloatingPnl += metrics?.position_pnl || 0;

    const userGrossPnl = _getGrossPnlBatched(uid, tradesByUser);
    totalGrossPnl += userGrossPnl;
    callerProfit += (-userGrossPnl) * _getPnlUnpassedMultiplierForUserBatched(uid, callerId, u, masterMap);

    const { brokerage, turnover } = _getUserBrokerageAndTurnoverBatched(
      uid, tradesByUser, brkRulesByUser, globalBrkRules, kiteMap
    );
    totalBrokerage += brokerage;
    totalTurnover += turnover;
    callerBrk += _computeCallerBrkForUserBatched(
      uid, callerId, callerRole, tradesByUser, callerRules, kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, u, brokerage
    );
  }
  callerProfit = _r2(callerProfit);

  return {
    id: masterId,
    name: masterDoc.name,
    username: masterDoc.username,
    realised_pnl: _r2(totalGrossPnl),
    m2m_pnl: _r2(totalFloatingPnl),
    brokerage: _r2(totalBrokerage),
    turnover: _r2(totalTurnover),
    caller_brk: _r2(callerBrk),
    // Net of BOTH realised and floating — see _getUserEntryBatched's
    // comment on the same fix. caller_profit stays realised-only
    // (unchanged), same reasoning.
    total_pnl: _r2(-(totalGrossPnl + totalFloatingPnl)),
    caller_profit: callerProfit,
    total_caller: _r2(callerProfit + callerBrk),
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

  // Find the immediate child master of the caller (walk up from user's master)
  let immediateChildSharing = 0;
  const userMasterId = userDoc?.master_id?.toString();
  if (userMasterId) {
    let masterId = userMasterId;
    const maxWalk = 10;
    let walk = 0;
    while (masterId && walk < maxWalk) {
      const m = masterMap[masterId];
      if (!m) break;
      // If this master's parent is null (admin is caller) or equals callerId, this is the immediate child
      if (!m.master_id || m.master_id.toString() === callerId) {
        immediateChildSharing = m.brokerage_sharing || 0;
        break;
      }
      masterId = m.master_id.toString();
      walk++;
    }
  }

  // Spread above caller's base = what's left after caller takes their base
  const spreadAboveCaller = Math.max(0, userTotalBrk - callerBaseClearance);

  // Admin gets (100 - immediateChildSharing)% of the spread
  const unpassedPct = (100 - immediateChildSharing) / 100;
  const unpassedAmount = spreadAboveCaller * unpassedPct;

  return callerBaseClearance + unpassedAmount;
}

/**
 * For a direct user: compute what fraction of their P&L flows up to the caller. (No DB queries)
 *
 * Same logic as original _getPnlUnpassedMultiplierForUser.
 */
function _getPnlUnpassedMultiplierForUserBatched(userId, callerId, userDoc, masterMap) {
  const userMasterId = userDoc?.master_id?.toString();
  if (!userMasterId) return 0;

  let multiplier = 1;
  let currentMasterId = userMasterId;

  const maxDepth = 10;
  let depth = 0;
  while (currentMasterId && depth < maxDepth) {
    const master = masterMap[currentMasterId];
    if (!master) break;

    multiplier *= (100 - (master.pnl_sharing || 0)) / 100;

    // If this master's parent is the caller (or null for admin), stop
    if (!master.master_id || master.master_id.toString() === callerId) break;
    currentMasterId = master.master_id.toString();
    depth++;
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

  // User-specific rules, fallback to global
  let brkRules = brkRulesByUser[userId] || [];
  if (brkRules.length === 0) brkRules = globalBrkRules;

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

    const brkRule = _findRule(brkRules, rawName, seg);
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
  if (!rule) rule = rules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
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
  };
}

const _r2 = (n) => Math.round(n * 100) / 100;

module.exports = { getWeeklyAdminReport };
