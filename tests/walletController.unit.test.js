'use strict';

// Validates: Requirements 5.1 (master→child transfer), 5.2 (admin grant), 5.3
// (over-assign rejected — master pool too low), 5.4 (over-withdraw rejected),
// 5.6 (hierarchy authorization: masters may only fund/withdraw a DIRECT child;
// admin may act on anyone) for the wallet funding HTTP surface (walletController,
// Task 12 / design §9).
//
// walletService, User and Master are all mocked — no DB. The controller is pure
// validation + authorization + response shaping over walletService (whose own
// transaction/audit atomicity is covered by walletService.unit.test.js and the
// Task 19 integration harness). req/res are fakes: res.status(...).json(...) is a
// chainable spy so we can assert both the status code and the body.

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
const User = require('../src/models/User');
const Master = require('../src/models/Master');
const walletController = require('../src/controllers/walletController');

// Chainable res: res.status(code) returns res; res.json(body) returns res.
function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// `Model.findById(id).select('master_id').lean()` chain used by assertAuthorizedTarget.
function findByIdChain(result) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(result));
  return chain;
}

// Build an INSUFFICIENT_WALLET error exactly as walletService tags it.
function insufficientWallet(category) {
  const err = new Error(`INSUFFICIENT_WALLET: ${category}`);
  err.code = 'INSUFFICIENT_WALLET';
  err.category = category;
  return err;
}

const MASTER_REQ = (body) => ({ master: { id: 'master1', role: 'master' }, admin: null, body });
const ADMIN_REQ = (body) => ({ master: null, admin: { id: 'admin1', role: 'admin' }, body });

beforeEach(() => {
  jest.clearAllMocks();
  walletService.getAvailable.mockResolvedValue({ NSE: 5000, MCX: 0, GLOBAL: 0 });
});

describe('assign — master funds a DIRECT child (Requirement 5.1)', () => {
  test('master assigning to a child User (master_id === master.id) calls assign with a Master actor and returns 200 + wallet', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'master1' }));
    walletService.assign.mockResolvedValue({ category: 'NSE', amount: 5000 });
    walletService.getAvailable.mockResolvedValue({ NSE: 5000, MCX: 0, GLOBAL: 0 });

    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'NSE', amount: 5000 });
    const res = makeRes();

    await walletController.assign(req, res);

    // Actor resolved as the Master, forwarded to walletService.assign (no session).
    expect(walletService.assign).toHaveBeenCalledWith(
      { type: 'Master', id: 'master1' }, 'User', 'u1', 'NSE', 5000
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      success: true,
      data: { owner_type: 'User', owner_id: 'u1', wallet: { NSE: 5000, MCX: 0, GLOBAL: 0 } },
    });
    expect(body.message).toContain('NSE');
  });

  test('master assigning to a sub-Master child (Master.master_id === master.id) is authorized', async () => {
    Master.findById.mockReturnValue(findByIdChain({ _id: 'sub1', master_id: 'master1' }));
    walletService.assign.mockResolvedValue({ category: 'MCX', amount: 2000 });

    const req = MASTER_REQ({ target_id: 'sub1', target_type: 'Master', category: 'MCX', amount: 2000 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(walletService.assign).toHaveBeenCalledWith(
      { type: 'Master', id: 'master1' }, 'Master', 'sub1', 'MCX', 2000
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('assign — hierarchy authorization (Requirement 5.6)', () => {
  test('master assigning to a NON-child (master_id ≠ master.id) is 403 and never calls the service', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u9', master_id: 'someOtherMaster' }));

    const req = MASTER_REQ({ target_id: 'u9', target_type: 'User', category: 'NSE', amount: 5000 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(walletService.assign).not.toHaveBeenCalled();
  });

  test('master assigning to a missing target is 404 and never calls the service', async () => {
    User.findById.mockReturnValue(findByIdChain(null));

    const req = MASTER_REQ({ target_id: 'ghost', target_type: 'User', category: 'NSE', amount: 100 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(walletService.assign).not.toHaveBeenCalled();
  });
});

describe('assign — admin grant to anyone (Requirement 5.2)', () => {
  test('admin assigning to any user calls assign with an Admin actor and returns 200', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'whoeverMaster' }));
    walletService.assign.mockResolvedValue({ category: 'GLOBAL', amount: 9000 });
    walletService.getAvailable.mockResolvedValue({ NSE: 0, MCX: 0, GLOBAL: 9000 });

    const req = ADMIN_REQ({ target_id: 'u1', target_type: 'User', category: 'GLOBAL', amount: 9000 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(walletService.assign).toHaveBeenCalledWith(
      { type: 'Admin', id: 'admin1' }, 'User', 'u1', 'GLOBAL', 9000
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('assign — input validation → 400, service not called', () => {
  test('invalid category is rejected', async () => {
    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'FOREX', amount: 100 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.assign).not.toHaveBeenCalled();
  });

  test('non-positive amount is rejected', async () => {
    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'NSE', amount: 0 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.assign).not.toHaveBeenCalled();
  });

  test('bad target_type is rejected', async () => {
    const req = MASTER_REQ({ target_id: 'u1', target_type: 'Robot', category: 'NSE', amount: 100 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.assign).not.toHaveBeenCalled();
  });

  test('missing target_id is rejected', async () => {
    const req = MASTER_REQ({ target_type: 'User', category: 'NSE', amount: 100 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.assign).not.toHaveBeenCalled();
  });
});

describe('assign — over-assign (master pool too low) → 400 naming the category (Requirement 5.3)', () => {
  test('INSUFFICIENT_WALLET from the service maps to a 400 that names the category', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'master1' }));
    walletService.assign.mockRejectedValue(insufficientWallet('NSE'));

    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'NSE', amount: 999999 });
    const res = makeRes();

    await walletController.assign(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.message).toContain('NSE');
    expect(body.message).toMatch(/master pool/i);
  });
});

describe('withdraw — over-limit → 400 (Requirement 5.4)', () => {
  test('INSUFFICIENT_WALLET from the service maps to a 400 that names the category', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'master1' }));
    walletService.withdraw.mockRejectedValue(insufficientWallet('MCX'));

    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'MCX', amount: 999999 });
    const res = makeRes();

    await walletController.withdraw(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.message).toContain('MCX');
    expect(body.message).toMatch(/withdraw/i);
  });

  test('master withdrawing from a direct child returns 200 + updated wallet', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'master1' }));
    walletService.withdraw.mockResolvedValue({ category: 'NSE', amount: 1000 });
    walletService.getAvailable.mockResolvedValue({ NSE: 4000, MCX: 0, GLOBAL: 0 });

    const req = MASTER_REQ({ target_id: 'u1', target_type: 'User', category: 'NSE', amount: 1000 });
    const res = makeRes();

    await walletController.withdraw(req, res);

    expect(walletService.withdraw).toHaveBeenCalledWith(
      { type: 'Master', id: 'master1' }, 'User', 'u1', 'NSE', 1000
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.wallet).toEqual({ NSE: 4000, MCX: 0, GLOBAL: 0 });
  });

  test('master withdrawing from a NON-child is 403 and never calls the service', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u9', master_id: 'someOtherMaster' }));

    const req = MASTER_REQ({ target_id: 'u9', target_type: 'User', category: 'NSE', amount: 1000 });
    const res = makeRes();

    await walletController.withdraw(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(walletService.withdraw).not.toHaveBeenCalled();
  });
});

describe('getWallet — read authorization (Requirement 5.6)', () => {
  test('master reading its OWN wallet returns 200 without a hierarchy lookup', async () => {
    walletService.getAvailable.mockResolvedValue({ NSE: 100, MCX: 200, GLOBAL: 300 });

    const req = { master: { id: 'master1' }, admin: null, query: { owner_type: 'Master', owner_id: 'master1' } };
    const res = makeRes();

    await walletController.getWallet(req, res);

    expect(Master.findById).not.toHaveBeenCalled(); // self read skips the child check
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      owner_type: 'Master', owner_id: 'master1', wallet: { NSE: 100, MCX: 200, GLOBAL: 300 },
    });
  });

  test('master reading a direct child returns 200', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u1', master_id: 'master1' }));
    walletService.getAvailable.mockResolvedValue({ NSE: 10, MCX: 0, GLOBAL: 0 });

    const req = { master: { id: 'master1' }, admin: null, query: { owner_type: 'User', owner_id: 'u1' } };
    const res = makeRes();

    await walletController.getWallet(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('master reading a NON-child is 403', async () => {
    User.findById.mockReturnValue(findByIdChain({ _id: 'u9', master_id: 'someOtherMaster' }));

    const req = { master: { id: 'master1' }, admin: null, query: { owner_type: 'User', owner_id: 'u9' } };
    const res = makeRes();

    await walletController.getWallet(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(walletService.getAvailable).not.toHaveBeenCalled();
  });

  test('admin reading anyone returns 200', async () => {
    walletService.getAvailable.mockResolvedValue({ NSE: 1, MCX: 2, GLOBAL: 3 });

    const req = { master: null, admin: { id: 'admin1' }, query: { owner_type: 'User', owner_id: 'anyUser' } };
    const res = makeRes();

    await walletController.getWallet(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(walletService.getAvailable).toHaveBeenCalledWith('User', 'anyUser');
  });

  test('missing owner_id is 400', async () => {
    const req = { master: null, admin: { id: 'admin1' }, query: { owner_type: 'User' } };
    const res = makeRes();

    await walletController.getWallet(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.getAvailable).not.toHaveBeenCalled();
  });
});

describe('reconcile — admin drift audit', () => {
  test('returns the walletService.reconcile result with 200', async () => {
    const reconResult = {
      ownerModel: 'User',
      ownerId: 'u1',
      categories: {
        NSE: { available: 75000, blocked: 25000, total: 100000 },
        MCX: { available: 0, blocked: 0, total: 0 },
        GLOBAL: { available: 0, blocked: 0, total: 0 },
      },
    };
    walletService.reconcile.mockResolvedValue(reconResult);

    const req = { admin: { id: 'admin1' }, master: null, query: { owner_type: 'User', owner_id: 'u1' } };
    const res = makeRes();

    await walletController.reconcile(req, res);

    expect(walletService.reconcile).toHaveBeenCalledWith('User', 'u1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual(reconResult);
  });

  test('invalid owner_type is 400', async () => {
    const req = { admin: { id: 'admin1' }, master: null, query: { owner_type: 'Nope', owner_id: 'u1' } };
    const res = makeRes();

    await walletController.reconcile(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(walletService.reconcile).not.toHaveBeenCalled();
  });
});
