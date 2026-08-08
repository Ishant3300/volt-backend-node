'use strict';

// Validates: Requirements 3.1 / 3.6 (guarded, never-negative block), 3.2 (release),
// 4.1 / 4.2 (affordability gate → INSUFFICIENT_WALLET with category + amount),
// 5.1 / 5.3 / 5.4 / 5.5 (transfer debits source before crediting target, audited),
// and cross-cutting money precision (§ non-functional 2).
//
// The Mongoose models are mocked so no live DB / replica set is needed. True
// concurrent "exactly one wins / never negative" behaviour against a real
// replica set is covered by the integration suite (Task 19).

jest.mock('../src/models/User', () => ({ updateOne: jest.fn(), findById: jest.fn() }));
jest.mock('../src/models/Master', () => ({ updateOne: jest.fn(), findById: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ create: jest.fn() }));
jest.mock('../src/models/Trade', () => ({ aggregate: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ find: jest.fn() }));

const User = require('../src/models/User');
const Master = require('../src/models/Master');
const Transaction = require('../src/models/Transaction');
const walletService = require('../src/services/walletService');

// Money rounding must match walletService's local roundMoney exactly.
const round = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Build a self-returning Mongoose query chain that resolves a `{ wallet }` doc,
// supporting the `.findById().select().session().lean()` shape readWallet uses.
function walletChain(wallet) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve({ wallet }));
  return chain;
}

const FAKE_SESSION = { id: 'txn-session' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('walletService.block — guarded atomic decrement (never negative)', () => {
  test('rejects with INSUFFICIENT_WALLET when the pool cannot cover the amount', async () => {
    User.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    await expect(walletService.block('User', 'u1', 'NSE', 25000))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE', requested: 25000 });

    // The guarded update ran exactly once and nothing else "proceeded".
    expect(User.updateOne).toHaveBeenCalledTimes(1);
  });

  test('applies a $gte guard on the filter and a negative $inc on the update', async () => {
    User.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await expect(walletService.block('User', 'u1', 'NSE', 25000))
      .resolves.toEqual({ category: 'NSE', amount: 25000 });

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1', 'wallet.NSE': { $gte: 25000 } },
      { $inc: { 'wallet.NSE': -25000 } },
      {}
    );
  });

  test('passes the caller session through to the guarded update', async () => {
    Master.updateOne.mockResolvedValue({ matchedCount: 1 });

    await walletService.block('Master', 'm1', 'MCX', 1000, FAKE_SESSION);

    expect(Master.updateOne).toHaveBeenCalledWith(
      { _id: 'm1', 'wallet.MCX': { $gte: 1000 } },
      { $inc: { 'wallet.MCX': -1000 } },
      { session: FAKE_SESSION }
    );
  });

  test('rejects a non-positive amount before touching the DB', async () => {
    await expect(walletService.block('User', 'u1', 'NSE', 0)).rejects.toThrow(/positive/);
    await expect(walletService.block('User', 'u1', 'NSE', -5)).rejects.toThrow(/positive/);
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});

describe('walletService.release — unguarded increment (always allowed)', () => {
  test('applies a positive $inc with no $gte guard on the filter', async () => {
    User.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await expect(walletService.release('User', 'u1', 'NSE', 25000))
      .resolves.toEqual({ category: 'NSE', amount: 25000 });

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $inc: { 'wallet.NSE': 25000 } },
      {}
    );
    const [filter] = User.updateOne.mock.calls[0];
    expect(filter['wallet.NSE']).toBeUndefined(); // no $gte guard
  });
});

describe('walletService.assign — master→child transfer atomicity', () => {
  test('debits the actor (guarded), credits the target, and writes an audit record', async () => {
    Master.findById.mockReturnValue(walletChain({ NSE: 100000, MCX: 0, GLOBAL: 0 })); // actor before
    User.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 0, GLOBAL: 0 }));        // target before
    Master.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });        // block actor
    User.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });          // release target
    Transaction.create.mockResolvedValue([{}]);

    const actor = { type: 'Master', id: 'm1' };
    await walletService.assign(actor, 'User', 'u1', 'NSE', 5000, FAKE_SESSION);

    // Block on the actor's own pool: guarded ($gte) + negative $inc.
    expect(Master.updateOne).toHaveBeenCalledWith(
      { _id: 'm1', 'wallet.NSE': { $gte: 5000 } },
      { $inc: { 'wallet.NSE': -5000 } },
      { session: FAKE_SESSION }
    );
    // Release on the target: positive $inc, no guard.
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $inc: { 'wallet.NSE': 5000 } },
      { session: FAKE_SESSION }
    );
    // A single audit Transaction, tagged WALLET_ASSIGN, on the same session.
    expect(Transaction.create).toHaveBeenCalledTimes(1);
    const [docs, opts] = Transaction.create.mock.calls[0];
    expect(docs[0]).toMatchObject({
      type: 'WALLET_ASSIGN',
      userModel: 'User',
      userId: 'u1',
      amount: 5000,
      balanceBefore: 0,
      balanceAfter: 5000,
    });
    expect(docs[0].metadata).toMatchObject({ category: 'NSE', direction: 'ASSIGN' });
    expect(opts).toEqual({ session: FAKE_SESSION });
  });

  test('when the actor debit fails, the target is NOT credited and no audit is written', async () => {
    Master.findById.mockReturnValue(walletChain({ NSE: 100, MCX: 0, GLOBAL: 0 }));
    User.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 0, GLOBAL: 0 }));
    Master.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }); // insufficient actor
    User.updateOne.mockResolvedValue({ matchedCount: 1 });
    Transaction.create.mockResolvedValue([{}]);

    const actor = { type: 'Master', id: 'm1' };
    await expect(walletService.assign(actor, 'User', 'u1', 'NSE', 5000, FAKE_SESSION))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE' });

    expect(User.updateOne).not.toHaveBeenCalled();     // target never credited
    expect(Transaction.create).not.toHaveBeenCalled(); // nothing audited
  });

  test('admin actor grants the target with no debit source', async () => {
    User.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 0, GLOBAL: 0 }));
    User.updateOne.mockResolvedValue({ matchedCount: 1 });
    Transaction.create.mockResolvedValue([{}]);

    const actor = { type: 'Admin', id: 'a1' };
    await walletService.assign(actor, 'User', 'u1', 'NSE', 7500, FAKE_SESSION);

    expect(Master.updateOne).not.toHaveBeenCalled(); // no admin debit
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $inc: { 'wallet.NSE': 7500 } },
      { session: FAKE_SESSION }
    );
    expect(Transaction.create).toHaveBeenCalledTimes(1);
  });
});

describe('walletService.withdraw — guarded debit on the target', () => {
  test('blocks the target (guarded) and releases to a master actor', async () => {
    User.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 8000, GLOBAL: 0 })); // target before
    Master.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 200, GLOBAL: 0 })); // actor before
    User.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });        // block target
    Master.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });      // release actor
    Transaction.create.mockResolvedValue([{}]);

    const actor = { type: 'Master', id: 'm1' };
    await walletService.withdraw(actor, 'User', 'u1', 'MCX', 3000, FAKE_SESSION);

    // Guarded block on the target.
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1', 'wallet.MCX': { $gte: 3000 } },
      { $inc: { 'wallet.MCX': -3000 } },
      { session: FAKE_SESSION }
    );
    // Credit back to the master.
    expect(Master.updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $inc: { 'wallet.MCX': 3000 } },
      { session: FAKE_SESSION }
    );
    expect(Transaction.create).toHaveBeenCalledTimes(1);
    const [docs] = Transaction.create.mock.calls[0];
    expect(docs[0]).toMatchObject({ type: 'WALLET_WITHDRAW', userId: 'u1', amount: 3000 });
  });

  test('rejects when the target cannot cover the withdrawal and does not credit the actor', async () => {
    User.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 100, GLOBAL: 0 }));
    Master.findById.mockReturnValue(walletChain({ NSE: 0, MCX: 0, GLOBAL: 0 }));
    User.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }); // target short
    Master.updateOne.mockResolvedValue({ matchedCount: 1 });
    Transaction.create.mockResolvedValue([{}]);

    const actor = { type: 'Master', id: 'm1' };
    await expect(walletService.withdraw(actor, 'User', 'u1', 'MCX', 3000, FAKE_SESSION))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'MCX' });

    expect(Master.updateOne).not.toHaveBeenCalled();   // actor not credited
    expect(Transaction.create).not.toHaveBeenCalled(); // nothing audited
  });
});

describe('walletService money rounding — amounts are rounded before the $inc', () => {
  test('rounds a sub-cent amount to 2 decimals per the EPSILON formula', async () => {
    User.updateOne.mockResolvedValue({ matchedCount: 1 });

    const expected = round(100.005);
    await walletService.block('User', 'u1', 'NSE', 100.005);

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1', 'wallet.NSE': { $gte: expected } },
      { $inc: { 'wallet.NSE': -expected } },
      {}
    );
  });

  test('rounds a 3-decimal amount to 2 decimals on release', async () => {
    User.updateOne.mockResolvedValue({ matchedCount: 1 });

    await walletService.release('User', 'u1', 'GLOBAL', 250.559);

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $inc: { 'wallet.GLOBAL': 250.56 } },
      {}
    );
  });
});
