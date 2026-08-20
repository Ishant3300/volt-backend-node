'use strict';

// Validates: Requirements 3.2 (a close/reduce releases the ENTRY notional of the
// closed quantity, independent of the exit price) and 7.5 (square-off close paths
// release margin back to the category pools) for the intraday square-off path
// masterUserController._squareOffUserSegments (design §6.4, Task 7).
//
// Every collaborator is mocked (models, walletService, metricsEngine, trade-write
// lease) and the Mongo session is INJECTED via options.startSession, whose
// withTransaction(fn) just runs the body. `walletCategory` is deliberately NOT
// mocked so the test exercises the real segment→category mapping — that is the
// behaviour Task 7 adds (prefer the SEGMENT over the base exchange). The full
// end-to-end wiring against a live replica-set Mongo is covered by Tasks 19/20.

jest.mock('../src/models/Trade', () => ({ insertMany: jest.fn() }));
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/BrokerageSettings', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../src/models/ScriptQuantity', () => ({ findOne: jest.fn() }));
jest.mock('../src/services/tradeWriteFenceService', () => ({ beginTradeWrite: jest.fn() }));
jest.mock('../src/services/walletService', () => ({ release: jest.fn(), block: jest.fn() }));
jest.mock('../src/services/metricsEngine', () => ({
  getFreshMetrics: jest.fn(),
  onTradeExecuted: jest.fn(),
  _bidMap: new Map(),
  _askMap: new Map(),
}));

const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const ScriptQuantity = require('../src/models/ScriptQuantity');
const walletService = require('../src/services/walletService');
const metricsEngine = require('../src/services/metricsEngine');
const { beginTradeWrite } = require('../src/services/tradeWriteFenceService');
const { _squareOffUserSegments } = require('../src/controllers/masterUserController');

let fakeSession;

// `Model.findOne(...).session(session).lean()` / `Model.find(...).session(session).lean()`
// chain used by calculateBrokerage's KiteInstrument/BrokerageSettings/ScriptQuantity lookups.
function brokerageQueryChain(result) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(result));
  return chain;
}

// `Model.findById(id).select(...).lean()` chain — used for the pre-transaction
// user lookup. Also supports `.session(session)`, used by the SECOND
// User.findById call inside the transaction (fetches the mutable doc that
// gets equity credited and saved).
function queryChain(result) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(result));
  chain.session = jest.fn(() => Promise.resolve({
    _id: 'user1',
    equity: 0,
    save: jest.fn().mockResolvedValue(undefined),
  }));
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();

  fakeSession = {
    withTransaction: jest.fn(async (fn) => { await fn(); }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };

  beginTradeWrite.mockResolvedValue({
    assertActive: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  });

  metricsEngine._bidMap = new Map();
  metricsEngine._askMap = new Map();
  metricsEngine.onTradeExecuted.mockResolvedValue(undefined);

  User.findById.mockReturnValue(queryChain({ master_id: 'master1', admin_id: 'admin1' }));
  Trade.insertMany.mockResolvedValue([]);
  walletService.release.mockResolvedValue({ category: 'NSE', amount: 0 });

  // calculateBrokerage's collaborators — no matching rule, so brokerage resolves to 0.
  KiteInstrument.findOne.mockImplementation(() => brokerageQueryChain({ segment: 'NFO-FUT' }));
  BrokerageSettings.findOne.mockImplementation(() => brokerageQueryChain(null));
  BrokerageSettings.find.mockImplementation(() => brokerageQueryChain([]));
  ScriptQuantity.findOne.mockImplementation(() => brokerageQueryChain(null));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('_squareOffUserSegments — releases entry notional to the wallet category', () => {
  test('long NFO-FUT position releases |qty|×avgBuy to the NSE pool (segment beats exchange)', async () => {
    // Long 2 lots, avg entry ₹25,000. Exit bid is a different price (₹26,010) to
    // prove the release uses the ENTRY notional, not the exit price.
    metricsEngine._bidMap.set(111, 26010);
    metricsEngine.getFreshMetrics.mockResolvedValue({
      positions: [{
        instrument_token: 111,
        tradingsymbol: 'NIFTY24DECFUT',
        exchange: 'NFO',      // base exchange alone would map to GLOBAL…
        segment: 'NFO-FUT',   // …but the SEGMENT correctly maps to NSE
        net_qty: 2,
        avg_buy_price: 25000,
        avg_sell_price: 0,
        ltp: 26000,
        cmp: 26000,
      }],
    });

    const squaredOff = await _squareOffUserSegments('user1', ['NFO-FUT'], {
      startSession: () => fakeSession,
    });

    expect(squaredOff).toBe(1);
    expect(Trade.insertMany).toHaveBeenCalledTimes(1);
    // Entry notional 2 × 25000 = 50000 released to NSE (NOT 2 × 26010), with the txn session.
    expect(walletService.release).toHaveBeenCalledTimes(1);
    expect(walletService.release).toHaveBeenCalledWith('User', 'user1', 'NSE', 50000, fakeSession);
    expect(walletService.block).not.toHaveBeenCalled();
  });

  test('short MCX-FUT position releases |qty|×avgSell to the MCX pool', async () => {
    metricsEngine._askMap.set(222, 58990);
    metricsEngine.getFreshMetrics.mockResolvedValue({
      positions: [{
        instrument_token: 222,
        tradingsymbol: 'GOLDM24DECFUT',
        exchange: 'MCX',
        segment: 'MCX-FUT',
        net_qty: -1,
        avg_buy_price: 0,
        avg_sell_price: 60000,
        ltp: 59000,
        cmp: 59000,
      }],
    });

    const squaredOff = await _squareOffUserSegments('user1', ['MCX-FUT'], {
      startSession: () => fakeSession,
    });

    expect(squaredOff).toBe(1);
    // Short close releases the sell-side entry notional 1 × 60000 to the MCX pool.
    expect(walletService.release).toHaveBeenCalledWith('User', 'user1', 'MCX', 60000, fakeSession);
    expect(walletService.block).not.toHaveBeenCalled();
  });

  test('flat position (net_qty 0) squares off nothing and releases nothing', async () => {
    metricsEngine.getFreshMetrics.mockResolvedValue({
      positions: [{
        instrument_token: 333,
        tradingsymbol: 'FLAT',
        exchange: 'NFO',
        segment: 'NFO-FUT',
        net_qty: 0,
        avg_buy_price: 25000,
        avg_sell_price: 25000,
        ltp: 25000,
        cmp: 25000,
      }],
    });

    const squaredOff = await _squareOffUserSegments('user1', ['NFO-FUT'], {
      startSession: () => fakeSession,
    });

    expect(squaredOff).toBe(0);
    expect(Trade.insertMany).not.toHaveBeenCalled();
    expect(walletService.release).not.toHaveBeenCalled();
  });
});
