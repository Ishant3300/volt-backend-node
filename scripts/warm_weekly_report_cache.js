/**
 * One-time warm-up for weeklyReportCache.js.
 *
 * The cache only gets written by metricsEngine.onTradeExecuted(), i.e. it
 * only fills in as trades actually complete going forward — right after
 * deploying this feature, every user is a cache miss until they place a
 * new trade, so GET /api/master/weekly-admin-report falls all the way
 * back to the live per-request query for everyone (no speedup yet).
 *
 * This script computes every active user's current-week aggregate once,
 * up front, so the very next report request already has a warm cache to
 * read from instead of waiting on organic trade activity.
 *
 * Safe to re-run — each user's cache entry is just overwritten with a
 * freshly computed value.
 *
 * Run: node scripts/warm_weekly_report_cache.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const redisService = require('../src/services/redisService');
const weeklyReportCache = require('../src/services/weeklyReportCache');

const CONCURRENCY = 20; // small batches — this is many individual Trade queries, one per user

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to Mongo.');

  redisService.init();
  await new Promise((resolve, reject) => {
    const client = redisService.getClient();
    client.once('ready', resolve);
    client.once('error', reject);
    setTimeout(() => reject(new Error('Redis connect timeout')), 10_000);
  });
  console.log('Connected to Redis.\n');

  const users = await User.find({ deleted_at: null }).select('_id username').lean();
  console.log(`Warming weekly report cache for ${users.length} users...`);

  let done = 0, failed = 0;
  for (let i = 0; i < users.length; i += CONCURRENCY) {
    const batch = users.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((u) => weeklyReportCache.refreshUserWeeklyAggregate(u._id.toString()))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') done++;
      else failed++;
    }
    process.stdout.write(`\r${done + failed}/${users.length} (${failed} failed)`);
  }

  console.log(`\n\nDone. Warmed ${done} users, ${failed} failed.`);
  await mongoose.disconnect();
  await redisService.shutdown();
}

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
