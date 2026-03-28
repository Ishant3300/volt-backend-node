/**
 * Migration: Rename `balance` → `equity` in User and Master collections.
 * 
 * Usage: node scripts/migrateBalanceToEquity.js
 * 
 * This renames the field in all existing documents. Run once before deploying
 * the code changes that reference `equity` instead of `balance`.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function migrate() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set'); process.exit(1); }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;

  // Rename balance → equity in Masters
  const masterResult = await db.collection('masters').updateMany(
    { balance: { $exists: true } },
    { $rename: { balance: 'equity' } }
  );
  console.log(`Masters: renamed ${masterResult.modifiedCount} documents`);

  // Rename balance → equity in Users
  const userResult = await db.collection('users').updateMany(
    { balance: { $exists: true } },
    { $rename: { balance: 'equity' } }
  );
  console.log(`Users: renamed ${userResult.modifiedCount} documents`);

  await mongoose.disconnect();
  console.log('Migration complete');
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
