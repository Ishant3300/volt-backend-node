'use strict';

// Validates: Requirement 2.4 (₹1,00,000 per allowed category, 0 otherwise) and
// Requirement 2.6 (idempotent seed — keyed off the `wallet_seeded_at` marker,
// never re-granting) plus design §10 step 3 (master `margin_square_off=false`
// backfill only when absent), for scripts/migrateWallets.js (Task 15).
//
// A live MongoDB is NOT available in this environment, so the mapping and
// idempotency logic are proven WITHOUT a real connection:
//   - `computeWalletSeed` is a pure function, unit-tested exhaustively.
//   - The migration loop is driven against a fake in-memory collection whose
//     `find` honours the `{ wallet_seeded_at: { $exists: false } }` filter and
//     whose `updateOne` is a spy that actually applies the `$set` — so a second
//     run finds nothing to seed (idempotency), and `--dry-run` performs no writes.
//   - `mongoose.connect` / `disconnect` / `connection.db.collection` are mocked
//     so no real connection is attempted.

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  connection: { db: { collection: jest.fn() } },
}));

const mongoose = require('mongoose');
const {
  computeWalletSeed,
  seedCollection,
  migrateWallets,
  isDryRun,
  SEED,
} = require('../scripts/migrateWallets');

// ---------------------------------------------------------------------------
// A fake native-driver collection.
//   - `find(filter).toArray()` honours the `{ wallet_seeded_at: { $exists:false } }`
//     idempotency filter (returns only unseeded docs).
//   - `updateOne({_id},{ $set })` is a spy that ALSO applies the `$set` to the
//     backing store, so re-running the migration excludes now-seeded docs.
//   - `countDocuments({ wallet_seeded_at: { $exists:true } })` powers the summary.
// ---------------------------------------------------------------------------
function makeFakeCollection(initialDocs) {
  const docs = initialDocs.map((d) => ({ ...d }));

  const collection = {
    find: jest.fn((filter = {}) => ({
      toArray: jest.fn(async () => {
        const wantUnseeded =
          filter.wallet_seeded_at && filter.wallet_seeded_at.$exists === false;
        return docs
          .filter((d) => (wantUnseeded ? d.wallet_seeded_at === undefined : true))
          .map((d) => ({ ...d })); // hand out copies; store mutates only via updateOne
      }),
    })),
    countDocuments: jest.fn(async (filter = {}) => {
      const wantSeeded =
        filter.wallet_seeded_at && filter.wallet_seeded_at.$exists === true;
      return docs.filter((d) => (wantSeeded ? d.wallet_seeded_at !== undefined : true)).length;
    }),
    updateOne: jest.fn(async (filter, update) => {
      const doc = docs.find((d) => d._id === filter._id);
      if (doc && update && update.$set) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    }),
    // test-only peek at the backing store
    _docs: docs,
  };
  return collection;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MONGO_URI = 'mongodb://localhost:27017/scratch-test';
  delete process.env.DRY_RUN;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
});

// ===========================================================================
// computeWalletSeed — pure mapping (Requirement 2.4 + master backfill)
// ===========================================================================
describe('computeWalletSeed — per-document $set mapping', () => {
  test('User allowed NFO-FUT + MCX-FUT -> NSE & MCX seeded, GLOBAL 0, no margin_square_off key', () => {
    const doc = { exchanges_allowed: [{ exchange_name: 'NFO-FUT' }, { exchange_name: 'MCX-FUT' }] };

    const $set = computeWalletSeed(doc, { isMaster: false });

    expect($set.wallet).toEqual({ NSE: 100000, MCX: 100000, GLOBAL: 0 });
    expect($set.wallet_seeded_at).toBeInstanceOf(Date);
    expect($set).not.toHaveProperty('margin_square_off'); // users never get the backfill
  });

  test('User allowed only SGX -> GLOBAL seeded, NSE & MCX 0', () => {
    const doc = { exchanges_allowed: [{ exchange_name: 'SGX' }] };

    const $set = computeWalletSeed(doc, { isMaster: false });

    expect($set.wallet).toEqual({ NSE: 0, MCX: 0, GLOBAL: 100000 });
    expect($set.wallet_seeded_at).toBeInstanceOf(Date);
  });

  test('Master (array of strings) [NFO-FUT] with margin_square_off absent -> NSE seeded + margin_square_off:false', () => {
    const doc = { exchanges_allowed: ['NFO-FUT'] }; // margin_square_off missing

    const $set = computeWalletSeed(doc, { isMaster: true });

    expect($set.wallet).toEqual({ NSE: 100000, MCX: 0, GLOBAL: 0 });
    expect($set.wallet_seeded_at).toBeInstanceOf(Date);
    expect($set.margin_square_off).toBe(false); // design §10 step 3 backfill
  });

  test('Master that already has margin_square_off:true is NOT clobbered', () => {
    const doc = { exchanges_allowed: ['NFO-FUT'], margin_square_off: true };

    const $set = computeWalletSeed(doc, { isMaster: true });

    expect($set).not.toHaveProperty('margin_square_off');
  });

  test('Master that already has margin_square_off:false is NOT re-set (present, not absent)', () => {
    const doc = { exchanges_allowed: ['MCX-OPT'], margin_square_off: false };

    const $set = computeWalletSeed(doc, { isMaster: true });

    expect($set).not.toHaveProperty('margin_square_off');
    expect($set.wallet).toEqual({ NSE: 0, MCX: 100000, GLOBAL: 0 });
  });

  test('empty / missing exchanges_allowed -> all categories 0', () => {
    expect(computeWalletSeed({ exchanges_allowed: [] }).wallet).toEqual({ NSE: 0, MCX: 0, GLOBAL: 0 });
    expect(computeWalletSeed({}).wallet).toEqual({ NSE: 0, MCX: 0, GLOBAL: 0 });
  });

  test('SEED constant is ₹1,00,000', () => {
    expect(SEED).toBe(100000);
  });
});

// ===========================================================================
// seedCollection — write/skip decision + idempotency (injected fake collection)
// ===========================================================================
describe('seedCollection — real run writes exactly the unseeded docs', () => {
  test('calls updateOne once per unseeded doc with the computed $set', async () => {
    const col = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
      { _id: 'u2', exchanges_allowed: [{ exchange_name: 'MCX-FUT' }] },
    ]);

    const summary = await seedCollection(col, { isMaster: false, dryRun: false });

    expect(col.updateOne).toHaveBeenCalledTimes(2);
    expect(col.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'u1' },
      { $set: expect.objectContaining({ wallet: { NSE: 100000, MCX: 0, GLOBAL: 0 }, wallet_seeded_at: expect.any(Date) }) }
    );
    expect(col.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'u2' },
      { $set: expect.objectContaining({ wallet: { NSE: 0, MCX: 100000, GLOBAL: 0 }, wallet_seeded_at: expect.any(Date) }) }
    );
    expect(summary).toMatchObject({ scanned: 2, seeded: 2 });
  });

  test('DRY RUN performs ZERO writes but still reports what would be seeded', async () => {
    const col = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
      { _id: 'u2', exchanges_allowed: [{ exchange_name: 'SGX' }] },
    ]);

    const summary = await seedCollection(col, { isMaster: false, dryRun: true });

    expect(col.updateOne).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 2, seeded: 2 });
    // Nothing was actually marked, so all docs remain unseeded.
    expect(col._docs.every((d) => d.wallet_seeded_at === undefined)).toBe(true);
  });

  test('idempotency: a second run finds nothing to seed and writes nothing (Requirement 2.6)', async () => {
    const col = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
      { _id: 'u2', exchanges_allowed: [{ exchange_name: 'MCX-FUT' }] },
    ]);

    const first = await seedCollection(col, { isMaster: false, dryRun: false });
    expect(first).toMatchObject({ scanned: 2, seeded: 2 });
    expect(col.updateOne).toHaveBeenCalledTimes(2);

    col.updateOne.mockClear();

    const second = await seedCollection(col, { isMaster: false, dryRun: false });
    expect(second).toMatchObject({ scanned: 0, seeded: 0, alreadySeeded: 2 });
    expect(col.updateOne).not.toHaveBeenCalled(); // never re-grants
  });

  test('a legitimately all-zero (but already-seeded) wallet is NOT re-seeded', async () => {
    // Marker present, wallet all zero -> idempotency must key off the marker,
    // not off "wallet is all-zero".
    const col = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [], wallet: { NSE: 0, MCX: 0, GLOBAL: 0 }, wallet_seeded_at: new Date() },
    ]);

    const summary = await seedCollection(col, { isMaster: false, dryRun: false });

    expect(col.updateOne).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 0, seeded: 0, alreadySeeded: 1 });
  });

  test('masters get the margin_square_off backfill only when absent', async () => {
    const col = makeFakeCollection([
      { _id: 'm1', exchanges_allowed: ['NFO-FUT'] },                        // absent -> backfill
      { _id: 'm2', exchanges_allowed: ['MCX-FUT'], margin_square_off: true }, // present -> no clobber
    ]);

    await seedCollection(col, { isMaster: true, dryRun: false });

    expect(col.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'm1' },
      { $set: expect.objectContaining({ margin_square_off: false }) }
    );
    const [, secondUpdate] = col.updateOne.mock.calls[1];
    expect(secondUpdate.$set).not.toHaveProperty('margin_square_off');
  });
});

// ===========================================================================
// migrateWallets — full wiring with mocked mongoose (connect/disconnect + db)
// ===========================================================================
describe('migrateWallets — end-to-end wiring (mocked mongoose)', () => {
  test('real run connects, seeds users + masters via updateOne, then disconnects', async () => {
    const users = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
      { _id: 'u2', exchanges_allowed: [{ exchange_name: 'SGX' }] },
    ]);
    const masters = makeFakeCollection([
      { _id: 'm1', exchanges_allowed: ['MCX-FUT'] },
    ]);
    mongoose.connection.db.collection.mockImplementation((name) =>
      name === 'users' ? users : masters
    );

    const result = await migrateWallets({ dryRun: false });

    expect(mongoose.connect).toHaveBeenCalledWith(process.env.MONGO_URI);
    expect(users.updateOne).toHaveBeenCalledTimes(2);
    expect(masters.updateOne).toHaveBeenCalledTimes(1);
    expect(masters.updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $set: expect.objectContaining({ wallet: { NSE: 0, MCX: 100000, GLOBAL: 0 }, margin_square_off: false }) }
    );
    expect(result).toMatchObject({ users: { seeded: 2 }, masters: { seeded: 1 }, dryRun: false });
    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  });

  test('--dry-run wiring performs no writes but still connects and disconnects', async () => {
    const users = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
    ]);
    const masters = makeFakeCollection([]);
    mongoose.connection.db.collection.mockImplementation((name) =>
      name === 'users' ? users : masters
    );

    const result = await migrateWallets({ dryRun: true });

    expect(users.updateOne).not.toHaveBeenCalled();
    expect(masters.updateOne).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, users: { seeded: 1 } });
    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    expect(mongoose.disconnect).toHaveBeenCalledTimes(1); // finally always disconnects
  });

  test('idempotency across two full runs: the second run writes nothing', async () => {
    const users = makeFakeCollection([
      { _id: 'u1', exchanges_allowed: [{ exchange_name: 'NFO-FUT' }] },
      { _id: 'u2', exchanges_allowed: [{ exchange_name: 'MCX-FUT' }] },
    ]);
    const masters = makeFakeCollection([]);
    mongoose.connection.db.collection.mockImplementation((name) =>
      name === 'users' ? users : masters
    );

    await migrateWallets({ dryRun: false });
    expect(users.updateOne).toHaveBeenCalledTimes(2);

    users.updateOne.mockClear();

    const second = await migrateWallets({ dryRun: false });
    expect(users.updateOne).not.toHaveBeenCalled();
    expect(second).toMatchObject({ users: { scanned: 0, seeded: 0, alreadySeeded: 2 } });
  });
});

// ===========================================================================
// isDryRun — flag resolution
// ===========================================================================
describe('isDryRun — flag resolution precedence', () => {
  test('explicit option wins over argv/env', () => {
    expect(isDryRun({ dryRun: true })).toBe(true);
    expect(isDryRun({ dryRun: false })).toBe(false);
  });

  test('DRY_RUN=1 env enables dry-run when no explicit option', () => {
    process.env.DRY_RUN = '1';
    expect(isDryRun()).toBe(true);
  });

  test('defaults to false with no option, no --dry-run argv, no env', () => {
    delete process.env.DRY_RUN;
    expect(isDryRun()).toBe(false);
  });
});
