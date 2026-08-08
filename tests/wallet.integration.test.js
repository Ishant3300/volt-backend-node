'use strict';

/**
 * Isolated replica-set wallet integration (Task 19).
 *
 * Exercises `walletService` (and the pure `computeWalletSplit`) DIRECTLY against
 * a real Mongo so the guarded atomic `$inc` — the single write-conflict point
 * that makes concurrent opens race-free and never-negative (design §D1) — is the
 * unit under test, not a mock.
 *
 * Like `settlement.integration.test.js`, the whole suite is GATED behind an env
 * flag so a bare `npx jest` stays green (suite skipped). It runs only when a
 * replica-set Mongo is available:
 *
 *     RUN_WALLET_INTEGRATION=1 MONGO_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 npx jest tests/wallet.integration.test.js
 *
 * `assign`/`withdraw` open their own Mongo transaction when no session is passed,
 * which requires a replica set; `block`/`release` are single-document atomic
 * updates. The scratch database is uniquely named, created on connect, and
 * dropped in afterAll.
 *
 * Requirement map (requirements.md):
 *   - 3.1 block on open           - 3.2 release on full/partial close
 *   - 3.3 reversal (release+block) - 3.6 concurrent opens: one wins, never negative
 *   - 4.1 affordability gate       - 4.2 clear insufficient rejection (unchanged balance)
 *   - 5.1 transfer debits parent / credits child   - 5.3 over-assign rejected
 *   - 5.4 withdraw guards the child                 - 5.5 audited via Transaction
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const Master = require('../src/models/Master');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');
const walletService = require('../src/services/walletService');
const { computeWalletSplit } = require('../src/utils/walletSplit');

const run = process.env.RUN_WALLET_INTEGRATION === '1';
const describeIt = run ? describe : describe.skip;
const databaseName = `stkr_wallet_it_${Date.now().toString(36)}_${process.pid.toString(36)}`;

jest.setTimeout(120_000);

let seedCounter = 0;
/** Unique suffix so seeded usernames never collide with the unique index. */
function uniqueSuffix() {
  seedCounter += 1;
  return `${Date.now().toString(36)}_${seedCounter}`;
}

async function clearCollections() {
  await Promise.all([
    User.deleteMany({}),
    Master.deleteMany({}),
    Transaction.deleteMany({}),
  ]);
}

/** Seed a User with the given per-category wallet balances. */
async function seedUser(wallet = {}, overrides = {}) {
  const suffix = uniqueSuffix();
  return User.create({
    name: `Wallet IT User ${suffix}`,
    username: `wallet_it_user_${suffix}`,
    password: 'not-used',
    credits: 0,
    equity: 0,
    server_id: new mongoose.Types.ObjectId(),
    master_id: overrides.master_id || new mongoose.Types.ObjectId(),
    exchanges_allowed: [
      { exchange_name: 'NFO-FUT', turnover: true, lot: false, group_name: 'IT' },
    ],
    wallet: { NSE: 0, MCX: 0, GLOBAL: 0, ...wallet },
    ...overrides,
  });
}

/** Seed a Master with the given per-category wallet balances. */
async function seedMaster(wallet = {}, overrides = {}) {
  const suffix = uniqueSuffix();
  return Master.create({
    name: `Wallet IT Master ${suffix}`,
    username: `wallet_it_master_${suffix}`,
    password: 'not-used',
    credits: 0,
    equity: 0,
    server_id: new mongoose.Types.ObjectId(),
    admin_id: new mongoose.Types.ObjectId(),
    exchanges_allowed: ['NFO-FUT', 'MCX-FUT'],
    wallet: { NSE: 0, MCX: 0, GLOBAL: 0, ...wallet },
    ...overrides,
  });
}

describeIt('isolated replica-set category wallet', () => {
  beforeAll(async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required for isolated integration tests');
    if (!databaseName.startsWith('stkr_wallet_it_') || Buffer.byteLength(databaseName) > 38) {
      throw new Error(`Unsafe integration database name: ${databaseName}`);
    }

    await mongoose.connect(process.env.MONGO_URI, {
      dbName: databaseName,
      autoIndex: false,
      autoCreate: true,
      serverSelectionTimeoutMS: 30_000,
    });
    if (mongoose.connection.name !== databaseName || mongoose.connection.name === 'stocker') {
      throw new Error(`Refusing to test against unsafe database ${mongoose.connection.name}`);
    }

    for (const model of [User, Master, Transaction]) {
      await model.syncIndexes();
    }
  });

  beforeEach(clearCollections);

  afterAll(async () => {
    try {
      if (mongoose.connection.readyState === 1
        && mongoose.connection.name === databaseName
        && databaseName.startsWith('stkr_wallet_it_')) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  });

  // --- 1. Block on open (Requirement 3.1 / 4.1) ---------------------------
  test('block on open subtracts the entry notional from the category pool', async () => {
    const user = await seedUser({ NSE: 100_000 });

    const result = await walletService.block('User', user._id, 'NSE', 25_000);
    expect(result).toEqual({ category: 'NSE', amount: 25_000 });

    const available = await walletService.getAvailable('User', user._id);
    expect(available.NSE).toBeCloseTo(75_000, 2); // 100000 − 25000
    // Untouched pools stay put.
    expect(available.MCX).toBeCloseTo(0, 2);
    expect(available.GLOBAL).toBeCloseTo(0, 2);
  });

  // --- 2. Release on full & partial close (Requirement 3.2) ---------------
  test('release restores the entry notional on full and partial close', async () => {
    // Full close: block 25000 then release the same 25000 → back to 100000.
    const fullUser = await seedUser({ NSE: 100_000 });
    await walletService.block('User', fullUser._id, 'NSE', 25_000);
    await walletService.release('User', fullUser._id, 'NSE', 25_000);
    expect((await walletService.getAvailable('User', fullUser._id)).NSE).toBeCloseTo(100_000, 2);

    // Partial close: block 25000 (→75000), release 10000 of it (→85000).
    const partialUser = await seedUser({ NSE: 100_000 });
    await walletService.block('User', partialUser._id, 'NSE', 25_000);
    await walletService.release('User', partialUser._id, 'NSE', 10_000);
    expect((await walletService.getAvailable('User', partialUser._id)).NSE).toBeCloseTo(85_000, 2);
  });

  // --- 3. Reversal: release closed portion + block opened portion (Req 3.3) ---
  test('reversal releases the closed portion and blocks the newly opened portion', async () => {
    // User is long 10 @ entry 100 → 1000 blocked; funded 100000 → available 99000.
    const AVG_ENTRY = 100;
    const EXEC_PRICE = 120;
    const prevNetQty = 10;
    const user = await seedUser({ NSE: 100_000 - (prevNetQty * AVG_ENTRY) }); // 99000

    // A SELL 15 flips the position: closes the 10 long, opens 5 short.
    const { closingQty, openingQty } = computeWalletSplit(prevNetQty, 'SELL', 15);
    expect(closingQty).toBe(10);
    expect(openingQty).toBe(5);

    await walletService.release('User', user._id, 'NSE', closingQty * AVG_ENTRY); // +1000 → 100000
    await walletService.block('User', user._id, 'NSE', openingQty * EXEC_PRICE);  // −600  → 99400

    expect((await walletService.getAvailable('User', user._id)).NSE).toBeCloseTo(99_400, 2);
  });

  // --- 4. Insufficient-balance rejection, balance unchanged (Req 4.1 / 4.2) ---
  test('block over the available balance throws INSUFFICIENT_WALLET and leaves the balance unchanged', async () => {
    const user = await seedUser({ NSE: 20_000 });

    await expect(walletService.block('User', user._id, 'NSE', 25_000))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE', requested: 25_000 });

    // The guarded update must be all-or-nothing: nothing partially applied.
    expect((await walletService.getAvailable('User', user._id)).NSE).toBeCloseTo(20_000, 2);
  });

  // --- 5. Concurrent same-category opens → exactly one wins, never negative ---
  //         THE critical race test (Requirement 3.6 / cross-cutting 1).
  test('concurrent same-category opens: exactly capacity-many succeed, none drive the pool negative', async () => {
    const user = await seedUser({ NSE: 100_000 });
    const CONCURRENCY = 10;
    const AMOUNT = 25_000; // pool covers exactly 4 of these (4 × 25000 = 100000)

    // Fire N concurrent guarded blocks against the SAME document/category.
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        walletService.block('User', user._id, 'NSE', AMOUNT))
    );

    const succeeded = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected');

    // Exactly 4 win; the other 6 lose the race cleanly.
    expect(succeeded).toHaveLength(4);
    expect(rejected).toHaveLength(6);
    expect(rejected.every(o => o.reason && o.reason.code === 'INSUFFICIENT_WALLET')).toBe(true);

    // No lost updates and never negative: the pool lands exactly on 0.
    const finalWallet = (await User.findById(user._id).select('wallet').lean()).wallet;
    expect(finalWallet.NSE).toBeCloseTo(0, 2);
    expect(finalWallet.NSE).toBeGreaterThanOrEqual(0);
  });

  // --- 6. Transfer debits parent + credits child, audited (Req 5.1/5.3/5.4/5.5) ---
  test('assign debits the master and credits the child with a WALLET_ASSIGN audit record', async () => {
    const master = await seedMaster({ NSE: 50_000 });
    const child = await seedUser({ NSE: 0 }, { master_id: master._id });

    await walletService.assign({ type: 'Master', id: master._id }, 'User', child._id, 'NSE', 5_000);

    // Parent debited, child credited (5.1).
    expect((await walletService.getAvailable('Master', master._id)).NSE).toBeCloseTo(45_000, 2);
    expect((await walletService.getAvailable('User', child._id)).NSE).toBeCloseTo(5_000, 2);

    // Audit trail written (5.5): actor, target, category, amount, before/after.
    const audit = await Transaction.findOne({ type: 'WALLET_ASSIGN', userId: child._id }).lean();
    expect(audit).toMatchObject({
      type: 'WALLET_ASSIGN',
      userModel: 'User',
      amount: 5_000,
      balanceBefore: 0,
      balanceAfter: 5_000,
    });
    expect(audit.metadata).toMatchObject({ category: 'NSE', direction: 'ASSIGN' });
  });

  test('over-assign beyond the master pool is rejected with no balance change and no audit', async () => {
    const master = await seedMaster({ NSE: 1_000 });
    const child = await seedUser({ NSE: 0 }, { master_id: master._id });

    // 5.3 — a transfer that would drive the parent below 0 is rejected.
    await expect(
      walletService.assign({ type: 'Master', id: master._id }, 'User', child._id, 'NSE', 5_000)
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE' });

    // Both sides untouched, and nothing audited (transaction rolled back).
    expect((await walletService.getAvailable('Master', master._id)).NSE).toBeCloseTo(1_000, 2);
    expect((await walletService.getAvailable('User', child._id)).NSE).toBeCloseTo(0, 2);
    expect(await Transaction.countDocuments({ type: 'WALLET_ASSIGN' })).toBe(0);
  });

  test('withdraw guards the child and credits the master; over-withdraw is rejected', async () => {
    const master = await seedMaster({ NSE: 0 });
    const child = await seedUser({ NSE: 5_000 }, { master_id: master._id });

    // 5.4 — withdraw debits the child (guarded) and credits the master.
    await walletService.withdraw({ type: 'Master', id: master._id }, 'User', child._id, 'NSE', 2_000);
    expect((await walletService.getAvailable('User', child._id)).NSE).toBeCloseTo(3_000, 2);
    expect((await walletService.getAvailable('Master', master._id)).NSE).toBeCloseTo(2_000, 2);
    const withdrawAudit = await Transaction.findOne({ type: 'WALLET_WITHDRAW', userId: child._id }).lean();
    expect(withdrawAudit).toMatchObject({ type: 'WALLET_WITHDRAW', amount: 2_000 });

    // 5.4 — an over-withdrawal (more than the child holds) is rejected, unchanged.
    await expect(
      walletService.withdraw({ type: 'Master', id: master._id }, 'User', child._id, 'NSE', 10_000)
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE' });
    expect((await walletService.getAvailable('User', child._id)).NSE).toBeCloseTo(3_000, 2);
    expect((await walletService.getAvailable('Master', master._id)).NSE).toBeCloseTo(2_000, 2);
  });
});
