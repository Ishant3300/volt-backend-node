/**
 * Migration: Add trading metric fields to all existing Users and Masters.
 *
 * Fields: realised_pnl, position_pnl, m2m_pnl, margin_used, equity, free_margin
 *
 * Usage:
 *   node scripts/migrate_trading_metrics.js
 *
 * Safe to run multiple times — only updates documents missing the fields.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/stocker';

const metricsFields = {
  realised_pnl: 0,
  position_pnl: 0,
  m2m_pnl: 0,
  margin_used: 0,
  equity: 0,
  free_margin: 0,
};

// Filter: documents where any of the 6 fields don't exist yet
const filter = {
  $or: Object.keys(metricsFields).map(f => ({ [f]: { $exists: false } })),
};

const update = { $set: metricsFields };

async function run() {
  console.log(`🔌 Connecting to ${MONGO_URI}...`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected.\n');

  const db = mongoose.connection.db;

  // Update Users
  const userResult = await db.collection('users').updateMany(filter, update);
  console.log(`👤 Users  — matched: ${userResult.matchedCount}, modified: ${userResult.modifiedCount}`);

  // Update Masters
  const masterResult = await db.collection('masters').updateMany(filter, update);
  console.log(`👑 Masters — matched: ${masterResult.matchedCount}, modified: ${masterResult.modifiedCount}`);

  console.log('\n✅ Migration complete.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
