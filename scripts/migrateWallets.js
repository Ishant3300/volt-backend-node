/**
 * Migration: seed the per-category trade wallet (NSE / MCX / GLOBAL) for all
 * existing users and masters — idempotently.
 *
 *   Requirement 2.4 — every existing user/master receives ₹1,00,000 in each
 *     category for which they have at least one allowed exchange, and 0 in
 *     categories with no allowed exchange.
 *   Requirement 2.6 — the migration is idempotent. A `wallet_seeded_at` marker is
 *     stamped on every seeded document, and ONLY documents without that marker
 *     are ever seeded, so re-running never stacks additional ₹1,00,000 grants.
 *     (Idempotency is keyed off the marker — NOT off "wallet is all-zero" — so a
 *     legitimately zero wallet is never re-seeded.)
 *   Design §10 step 3 — for masters, also backfill `margin_square_off=false` when
 *     the field is absent (never clobbering a master who already set it).
 *
 * Usage:
 *   node scripts/migrateWallets.js             # real migration (writes)
 *   node scripts/migrateWallets.js --dry-run   # preview only, performs NO writes
 *   DRY_RUN=1 node scripts/migrateWallets.js   # same preview, via env
 *
 * Implementation note: this uses the NATIVE driver
 * (`mongoose.connection.db.collection(...)`) for reads/writes so the
 * `wallet_seeded_at` marker can be stored WITHOUT a schema change — Mongoose
 * strict mode would otherwise strip an unknown path. The Mongoose models are
 * deliberately left untouched by this script.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { allowedCategories } = require('../src/utils/walletCategory');

// ₹1,00,000 granted per allowed category (Requirement 2.4).
const SEED = 100000;

/**
 * Pure per-document seed computation. Returns the `$set` object to apply for one
 * user/master document. No I/O — unit-testable in isolation.
 *
 * @param {object} doc - raw Mongo document (native driver shape). Accepts BOTH
 *   `exchanges_allowed` shapes: User = array of `{ exchange_name }`,
 *   Master = array of strings (allowedCategories handles both).
 * @param {{ isMaster?: boolean }} [opts]
 * @returns {{ wallet: {NSE:number,MCX:number,GLOBAL:number}, wallet_seeded_at: Date, margin_square_off?: boolean }}
 */
function computeWalletSeed(doc = {}, { isMaster = false } = {}) {
  const allowed = allowedCategories(doc.exchanges_allowed || []);

  const wallet = {
    NSE:    allowed.includes('NSE')    ? SEED : 0,
    MCX:    allowed.includes('MCX')    ? SEED : 0,
    GLOBAL: allowed.includes('GLOBAL') ? SEED : 0,
  };

  const $set = { wallet, wallet_seeded_at: new Date() };

  // Master backfill (design §10 step 3): ONLY when the toggle is truly absent,
  // so we never clobber a master who already has `margin_square_off` set.
  if (isMaster && doc.margin_square_off === undefined) {
    $set.margin_square_off = false;
  }

  return $set;
}

/**
 * Seed one collection (users or masters). Only documents WITHOUT the
 * `wallet_seeded_at` marker are considered — this is the idempotency guard
 * (Requirement 2.6). Returns a per-collection summary.
 *
 * @param {import('mongodb').Collection} collection - native driver collection
 * @param {{ isMaster: boolean, dryRun: boolean }} opts
 */
async function seedCollection(collection, { isMaster, dryRun }) {
  const label = isMaster ? 'masters' : 'users';

  // Idempotency guard: seed only the not-yet-seeded documents.
  const unseeded = await collection
    .find({ wallet_seeded_at: { $exists: false } })
    .toArray();

  // Best-effort count of already-seeded docs, for the summary only.
  let alreadySeeded = 0;
  try {
    alreadySeeded = await collection.countDocuments({ wallet_seeded_at: { $exists: true } });
  } catch (_) { /* summary only — safe to skip if the driver can't count */ }

  const sampleIds = [];
  let seeded = 0;

  for (const doc of unseeded) {
    const $set = computeWalletSeed(doc, { isMaster });
    if (sampleIds.length < 5) sampleIds.push(String(doc._id));

    if (dryRun) {
      const extra = $set.margin_square_off !== undefined ? ' + margin_square_off=false' : '';
      console.log(`   🧪 would seed ${label} ${doc._id} -> wallet ${JSON.stringify($set.wallet)}${extra}`);
    } else {
      await collection.updateOne({ _id: doc._id }, { $set });
    }
    seeded += 1;
  }

  const verb = dryRun ? 'would seed' : 'seeded';
  console.log(`📊 ${label}: scanned ${unseeded.length} unseeded, ✅ ${verb} ${seeded}, ⏭️  already-seeded ${alreadySeeded}`);
  if (sampleIds.length) console.log(`   sample ids: ${sampleIds.join(', ')}`);

  return { scanned: unseeded.length, seeded, alreadySeeded, sampleIds };
}

/**
 * Resolve the dry-run flag: explicit option wins, else `--dry-run` argv, else
 * the `DRY_RUN` env var.
 */
function isDryRun(options = {}) {
  if (typeof options.dryRun === 'boolean') return options.dryRun;
  if (process.argv.slice(2).includes('--dry-run')) return true;
  return process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
}

/**
 * Main entrypoint. Connects, seeds users + masters, and ALWAYS disconnects.
 *
 * @param {{ dryRun?: boolean }} [options]
 */
async function migrateWallets(options = {}) {
  const dryRun = isDryRun(options);

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI is not set — aborting.');
    process.exit(1);
    return; // keeps the function safe if process.exit is stubbed (e.g. in tests)
  }

  await mongoose.connect(uri);
  console.log(`✅ Connected to MongoDB${dryRun ? ' — 🧪 DRY RUN (no writes will be performed)' : ''}`);

  try {
    const db = mongoose.connection.db;
    const users = await seedCollection(db.collection('users'), { isMaster: false, dryRun });
    const masters = await seedCollection(db.collection('masters'), { isMaster: true, dryRun });

    console.log(
      `\n✅ Wallet seed ${dryRun ? 'preview' : 'migration'} complete — ` +
      `users(${users.seeded}/${users.scanned}) masters(${masters.seeded}/${masters.scanned})`
    );

    return { users, masters, dryRun };
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

module.exports = { computeWalletSeed, seedCollection, migrateWallets, isDryRun, SEED };

// Auto-run ONLY when invoked directly (never on `require`) so the script is
// safely unit-testable and require-able without opening a DB connection.
if (require.main === module) {
  migrateWallets().catch((err) => {
    console.error('❌ Wallet seed migration failed:', err);
    process.exit(1);
  });
}
