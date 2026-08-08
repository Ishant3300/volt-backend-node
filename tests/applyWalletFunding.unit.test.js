'use strict';

// Validates: Requirements 2.5 (create/edit may supply an initial wallet map for
// allowed categories), 5.1 (a master funding a child is a TRANSFER via
// walletService.assign) and 5.3 (a master cannot over-fund — the
// INSUFFICIENT_WALLET rejection PROPAGATES so the surrounding create aborts) for
// the shared inline-funding helper walletController.applyWalletFunding (Task 13,
// design §13.3).
//
// walletService and the User/Master models walletController pulls in are all
// mocked — no DB. applyWalletFunding is pure actor-resolution + per-category
// iteration over walletService.assign, so we assert exactly which assign calls it
// makes (and with which actor/session). The full create-with-funding DB flow
// (atomic abort on over-fund) is covered by the Task 20 e2e harness.

jest.mock('../src/services/walletService', () => ({
  assign: jest.fn(),
  withdraw: jest.fn(),
  getAvailable: jest.fn(),
  reconcile: jest.fn(),
  CATEGORIES: ['NSE', 'MCX', 'GLOBAL'],
  INSUFFICIENT_WALLET: 'INSUFFICIENT_WALLET',
}));
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/Master', () => ({ findById: jest.fn() }));

const walletService = require('../src/services/walletService');
const { applyWalletFunding } = require('../src/controllers/walletController');

const MASTER_REQ = (wallet) => ({ master: { id: 'master1', role: 'master' }, admin: null, body: { wallet } });
const ADMIN_REQ = (wallet) => ({ master: null, admin: { id: 'admin1', role: 'admin' }, body: { wallet } });

// Build an INSUFFICIENT_WALLET error exactly as walletService tags it.
function insufficientWallet(category) {
  const err = new Error(`INSUFFICIENT_WALLET: ${category} wallet cannot cover`);
  err.code = 'INSUFFICIENT_WALLET';
  err.category = category;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  walletService.assign.mockResolvedValue({ category: 'NSE', amount: 0 });
});

describe('applyWalletFunding — master actor (transfer, Requirement 5.1)', () => {
  test('funds only the positive categories, in CATEGORIES order, forwarding the session', async () => {
    const session = { id: 'txn' };
    const req = MASTER_REQ({ NSE: 50000, MCX: 0, GLOBAL: 10000 });

    const summary = await applyWalletFunding({
      req, targetType: 'User', targetId: 'u1', walletMap: req.body.wallet, session,
    });

    // Exactly two calls: NSE (50000) and GLOBAL (10000). MCX (0) is skipped.
    expect(walletService.assign).toHaveBeenCalledTimes(2);
    expect(walletService.assign).toHaveBeenNthCalledWith(
      1, { type: 'Master', id: 'master1' }, 'User', 'u1', 'NSE', 50000, session
    );
    expect(walletService.assign).toHaveBeenNthCalledWith(
      2, { type: 'Master', id: 'master1' }, 'User', 'u1', 'GLOBAL', 10000, session
    );
    expect(summary).toEqual({
      funded: [{ category: 'NSE', amount: 50000 }, { category: 'GLOBAL', amount: 10000 }],
    });
  });

  test('a Master targetType is forwarded unchanged (funding a sub-master)', async () => {
    const req = MASTER_REQ({ MCX: 2000 });

    await applyWalletFunding({ req, targetType: 'Master', targetId: 'sub1', walletMap: req.body.wallet });

    expect(walletService.assign).toHaveBeenCalledTimes(1);
    expect(walletService.assign).toHaveBeenCalledWith(
      { type: 'Master', id: 'master1' }, 'Master', 'sub1', 'MCX', 2000, null
    );
  });
});

describe('applyWalletFunding — admin actor (grant, Requirement 5.2)', () => {
  test('resolves an Admin actor and forwards a null session when none is given', async () => {
    const req = ADMIN_REQ({ GLOBAL: 9000 });

    await applyWalletFunding({ req, targetType: 'User', targetId: 'u1', walletMap: req.body.wallet });

    expect(walletService.assign).toHaveBeenCalledTimes(1);
    expect(walletService.assign).toHaveBeenCalledWith(
      { type: 'Admin', id: 'admin1' }, 'User', 'u1', 'GLOBAL', 9000, null
    );
  });
});

describe('applyWalletFunding — no-op / skip cases', () => {
  test('undefined walletMap makes no assign calls and returns an empty summary', async () => {
    const summary = await applyWalletFunding({
      req: MASTER_REQ(undefined), targetType: 'User', targetId: 'u1', walletMap: undefined,
    });

    expect(walletService.assign).not.toHaveBeenCalled();
    expect(summary).toEqual({ funded: [] });
  });

  test('empty walletMap makes no assign calls', async () => {
    await applyWalletFunding({ req: MASTER_REQ({}), targetType: 'User', targetId: 'u1', walletMap: {} });
    expect(walletService.assign).not.toHaveBeenCalled();
  });

  test('negative, NaN and zero amounts are all skipped', async () => {
    const walletMap = { NSE: -100, MCX: 'not-a-number', GLOBAL: 0 };
    await applyWalletFunding({ req: MASTER_REQ(walletMap), targetType: 'User', targetId: 'u1', walletMap });
    expect(walletService.assign).not.toHaveBeenCalled();
  });
});

describe('applyWalletFunding — over-funding propagates (Requirement 5.3)', () => {
  test('an INSUFFICIENT_WALLET thrown by assign rejects the helper (so a create aborts)', async () => {
    walletService.assign.mockRejectedValueOnce(insufficientWallet('NSE'));
    const walletMap = { NSE: 999999 };

    await expect(
      applyWalletFunding({ req: MASTER_REQ(walletMap), targetType: 'User', targetId: 'u1', walletMap })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', category: 'NSE' });
  });

  test('a request carrying no actor throws before any funding is attempted', async () => {
    const req = { master: null, admin: null, body: { wallet: { NSE: 100 } } };

    await expect(
      applyWalletFunding({ req, targetType: 'User', targetId: 'u1', walletMap: req.body.wallet })
    ).rejects.toBeTruthy();
    expect(walletService.assign).not.toHaveBeenCalled();
  });
});
