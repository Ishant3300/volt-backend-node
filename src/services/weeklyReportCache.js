/**
 * Weekly Admin Report Cache (Redis-backed)
 *
 * GET /api/master/weekly-admin-report used to query every completed trade
 * live on every request (fixed to be date-bounded in a prior change, but
 * still a live query per request). This service precomputes each user's
 * per-instrument weekly trade aggregate — updated the moment a trade
 * completes, not on a timer — so the report endpoint can read instantly
 * instead of aggregating on demand.
 *
 * Backed by Redis, not an in-memory Map, because this app runs multiple
 * PM2 workers (see metricsEngine.js's settlement-generation reconciliation)
 * — a trade completed on worker A must be visible to a report request
 * served by worker B immediately, which only a shared store guarantees.
 *
 * Key schema
 * ----------
 *   weeklyagg:{weekStartISO}:{userId} → JSON string:
 *     { realised_pnl: number, byInstrument: { [token]: { turnover, qty, pnl } } }
 *
 * Deliberately stores SUMS per instrument, not individual trades — every
 * downstream consumer in weeklyAdminController.js (_getGrossPnlBatched,
 * _getUserBrokerageAndTurnoverBatched, _computeCallerBrkForUserBatched)
 * only ever sums turnover/lots/pnl across a user's trades, all linear
 * operations. A single pre-summed row per instrument is mathematically
 * identical to summing every individual trade — so those functions need
 * ZERO changes; they just receive fewer, pre-aggregated synthetic rows
 * instead of many raw ones. This is deliberate: that calculation logic
 * (multi-tier brokerage cascade, P&L sharing) is complex and already
 * correct — this cache changes only how it's fed data, not the math itself.
 */

const redisService = require('./redisService');

const TTL_SECONDS = 60 * 60 * 24 * 9; // ~9 days — safety net so stale weeks don't linger forever

/** Monday 00:00 of the current settlement week — same boundary used everywhere else in the app. */
function currentWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function keyFor(userId, weekStartIso) {
  return `weeklyagg:${weekStartIso}:${userId}`;
}

/** Aggregates ONE user's current-week completed trades into { realised_pnl, byInstrument }. Single indexed query. */
async function computeUserWeeklyAggregate(userId) {
  const Trade = require('../models/Trade');
  const weekStart = currentWeekStart();

  const trades = await Trade.find({
    user_id: userId,
    status: 'completed',
    deleted_at: null,
    executed_at: { $gte: weekStart },
  }).select('instrument_token executed_price executed_quantity pnl').lean();

  let realised_pnl = 0;
  const byInstrument = {};
  for (const t of trades) {
    realised_pnl += t.pnl || 0;
    const token = t.instrument_token;
    if (!byInstrument[token]) byInstrument[token] = { turnover: 0, qty: 0, pnl: 0 };
    byInstrument[token].turnover += (t.executed_price || 0) * (t.executed_quantity || 0);
    byInstrument[token].qty += t.executed_quantity || 0;
    byInstrument[token].pnl += t.pnl || 0;
  }

  return { weekStart: weekStart.toISOString(), realised_pnl, byInstrument };
}

/**
 * Recomputes and caches one user's weekly aggregate. Call this from
 * metricsEngine.onTradeExecuted(userId) — already the single hook every
 * trade-completion path in this codebase calls, so wiring it there covers
 * order execution, price-queue fills, margin square-off, settlement, and
 * admin/master credit-debit adjustments without touching any of them.
 */
async function refreshUserWeeklyAggregate(userId) {
  if (!redisService.isAvailable()) return; // report endpoint falls back to a live query when Redis is down
  try {
    const aggregate = await computeUserWeeklyAggregate(userId);
    const key = keyFor(userId, aggregate.weekStart);
    await redisService.getClient().set(key, JSON.stringify(aggregate), 'EX', TTL_SECONDS);
  } catch (err) {
    console.error(`[weeklyReportCache] Failed to refresh user ${userId}:`, err.message);
  }
}

/**
 * Reads a user's cached weekly aggregate as synthetic pseudo-trade rows —
 * same shape weeklyAdminController.js already expects (one row per
 * instrument instead of one per real trade; see file header for why that's
 * safe). Returns `null` on a cache miss or stale week so the caller can
 * fall back to a live per-user query and self-heal the cache.
 */
async function getUserWeeklyTrades(userId) {
  if (!redisService.isAvailable()) return null;
  try {
    const weekStart = currentWeekStart().toISOString();
    const raw = await redisService.getClient().get(keyFor(userId, weekStart));
    if (!raw) return null;

    const { byInstrument } = JSON.parse(raw);
    return Object.entries(byInstrument).map(([instrument_token, agg]) => ({
      instrument_token,
      executed_price: agg.qty > 0 ? agg.turnover / agg.qty : 0,
      executed_quantity: agg.qty,
      pnl: agg.pnl,
    }));
  } catch (err) {
    console.error(`[weeklyReportCache] Failed to read cache for user ${userId}:`, err.message);
    return null;
  }
}

module.exports = {
  currentWeekStart,
  computeUserWeeklyAggregate,
  refreshUserWeeklyAggregate,
  getUserWeeklyTrades,
};
