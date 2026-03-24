/**
 * Metrics Engine (Lightweight)
 *
 * The 6 trading metrics are now computed entirely on the Flutter client.
 * This module only handles:
 *   1. Midnight flush (12:01 AM) — reads cached metrics from all User docs
 *      (written by the client via POST /trade/metrics) and ensures they're persisted.
 *   2. Cache invalidation after trade execution (rebuilds position data for
 *      the next client fetch, NOT for WebSocket push).
 *
 * NO metrics are pushed via WebSocket anymore — the server stays lightweight.
 */

const Trade = require('../models/Trade');
const User = require('../models/User');

/**
 * Flush: At 12:01 AM the client should have already pushed its latest
 * cached metrics via POST /trade/metrics throughout the day.
 * This is a safety net — log how many users have non-zero metrics stored.
 */
const midnightAuditLog = async () => {
  console.log('📊 [MetricsEngine] 12:01 AM audit — checking stored metrics...');
  try {
    const count = await User.countDocuments({
      $or: [
        { realised_pnl: { $ne: 0 } },
        { position_pnl: { $ne: 0 } },
        { margin_used: { $ne: 0 } },
      ]
    });
    console.log(`📊 [MetricsEngine] ${count} users have non-zero metrics in DB`);
  } catch (err) {
    console.error('[MetricsEngine] Audit error:', err.message);
  }
};

/**
 * Schedule the 12:01 AM audit log.
 */
let _midnightTimer = null;
const scheduleMidnightAudit = () => {
  const now = new Date();
  const target = new Date(now);
  target.setHours(0, 1, 0, 0); // 12:01 AM
  if (target <= now) target.setDate(target.getDate() + 1); // next day
  const ms = target.getTime() - now.getTime();

  console.log(`📊 [MetricsEngine] Midnight audit scheduled in ${Math.round(ms / 60000)} minutes`);

  _midnightTimer = setTimeout(() => {
    midnightAuditLog();
    // Repeat every 24h
    _midnightTimer = setInterval(() => midnightAuditLog(), 24 * 60 * 60 * 1000);
  }, ms);
};

module.exports = {
  midnightAuditLog,
  scheduleMidnightAudit,
};
