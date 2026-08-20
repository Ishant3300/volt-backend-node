'use strict';

// Validates: Requirements 7.4 / 8.4 and design §13.1 (Task 11 — master cascade
// square-off). When a master's AGGREGATE live M2M breaches its toggle
// (`m2m ≤ -credit`) or percentage (`m2m ≤ -(credit×pct/100)`) threshold, EVERY
// user in the master's subtree is squared off by running the existing fenced
// per-user `_squareOffAllPositions` with `force: true`.
//
// Test design (documented choice): the cleanest, most reliable observable for the
// cascade is that `checkMaster` invokes the per-user fenced square-off once per
// subtree user (with `force: true`) when the master breaches, and never when it
// doesn't. Because `checkMaster` calls `_squareOffAllPositions` VIA THE MODULE
// OBJECT, we `jest.spyOn` the exported function and assert the calls — no live DB.
// A second block drives the REAL `_squareOffAllPositions` with fully mocked
// collaborators to prove `force` bypasses ONLY the per-user `shouldSquareOff`
// self-guard (Task 11 A1). The full real cascade (master + 2 users with actual
// position closes + wallet release) is covered by the Task 19/20 integration harness.

jest.mock('../src/models/Trade', () => jest.fn());
jest.mock('../src/models/Transaction', () => jest.fn());
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/BrokerageSettings', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../src/models/ScriptQuantity', () => ({ findOne: jest.fn() }));
jest.mock('../src/services/tradeWriteFenceService', () => ({ beginTradeWrite: jest.fn() }));
jest.mock('../src/services/walletService', () => ({ release: jest.fn(), block: jest.fn() }));
jest.mock('../src/services/metricsEngine', () => ({ getFreshMetrics: jest.fn(), onTradeExecuted: jest.fn() }));
jest.mock('../src/services/firebaseService', () => ({ sendNotification: jest.fn() }));

const mongoose = require('mongoose');
const service = require('../src/services/marginSquareOffService');
const User = require('../src/models/User');
const Trade = require('../src/models/Trade');
const Transaction = require('../src/models/Transaction');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const ScriptQuantity = require('../src/models/ScriptQuantity');
const walletService = require('../src/services/walletService');
const metricsEngine = require('../src/services/metricsEngine');
const { beginTradeWrite } = require('../src/services/tradeWriteFenceService');

describe('checkMaster — master cascade square-off (design §13.1, Req 7.4 / 8.4)', () => {
  let sqSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    // Spy on the exported function; checkMaster calls it via the module object, so
    // the spy intercepts each cascade invocation without running the fenced path.
    sqSpy = jest.spyOn(service, '_squareOffAllPositions').mockResolvedValue(1);
  });

  afterEach(() => {
    sqSpy.mockRestore();
  });

  test('breaching master (toggle, m2m = -credit) cascades a FORCED square-off to BOTH subtree users', async () => {
    const masterConfig = { credits: 50000, margin_square_off: true, active_status: true, username: 'm1' };

    await service.checkMaster('master1', { m2m_pnl: -50000 }, masterConfig, ['u1', 'u2']);

    expect(sqSpy).toHaveBeenCalledTimes(2);
    expect(sqSpy).toHaveBeenNthCalledWith(1, { _id: 'u1' }, { force: true });
    expect(sqSpy).toHaveBeenNthCalledWith(2, { _id: 'u2' }, { force: true });
  });

  test('breaching master (percentage, m2m = -(credit×30%)) cascades to all subtree users', async () => {
    const masterConfig = {
      credits: 50000,
      margin_square_off: false,
      margin_square_off_percentage: 30, // threshold = -(50000×30/100) = -15000
      active_status: true,
      username: 'm1',
    };

    await service.checkMaster('master1', { m2m_pnl: -15000 }, masterConfig, ['u1', 'u2']);

    expect(sqSpy).toHaveBeenCalledTimes(2);
  });

  test('non-breaching master (small aggregate loss) cascades to NO users', async () => {
    const masterConfig = { credits: 50000, margin_square_off: true, active_status: true, username: 'm1' };

    await service.checkMaster('master1', { m2m_pnl: -100 }, masterConfig, ['u1', 'u2']);

    expect(sqSpy).not.toHaveBeenCalled();
  });

  test('master with toggle OFF and pct 0 returns without cascading (even at a huge loss)', async () => {
    const masterConfig = {
      credits: 50000,
      margin_square_off: false,
      margin_square_off_percentage: 0,
      active_status: true,
      username: 'm1',
    };

    await service.checkMaster('master1', { m2m_pnl: -999999 }, masterConfig, ['u1', 'u2']);

    expect(sqSpy).not.toHaveBeenCalled();
  });

  test('inactive master does not cascade even when breaching', async () => {
    const masterConfig = { credits: 50000, margin_square_off: true, active_status: false, username: 'm1' };

    await service.checkMaster('master1', { m2m_pnl: -50000 }, masterConfig, ['u1', 'u2']);

    expect(sqSpy).not.toHaveBeenCalled();
  });

  test('empty subtree does not cascade', async () => {
    const masterConfig = { credits: 50000, margin_square_off: true, active_status: true, username: 'm1' };

    await service.checkMaster('master1', { m2m_pnl: -50000 }, masterConfig, []);

    expect(sqSpy).not.toHaveBeenCalled();
  });

  test('missing masterConfig / masterId does not cascade', async () => {
    await service.checkMaster('master1', { m2m_pnl: -50000 }, null, ['u1', 'u2']);
    await service.checkMaster(null, { m2m_pnl: -50000 }, { credits: 50000, margin_square_off: true, active_status: true }, ['u1']);

    expect(sqSpy).not.toHaveBeenCalled();
  });
});

describe('_squareOffAllPositions — `force` bypasses ONLY the shouldSquareOff self-guard (Task 11 A1)', () => {
  let fakeSession;

  // `User.findById(id).select(...).lean()` chain → the lean master-select config.
  function configChain(result) {
    const chain = {};
    chain.select = jest.fn(() => chain);
    chain.lean = jest.fn(() => Promise.resolve(result));
    return chain;
  }
  // `User.findById(id).session(session)` → resolves to the mongoose doc to save.
  function sessionChain(doc) {
    return { session: jest.fn(() => Promise.resolve(doc)) };
  }
  // `Model.findOne(...).session(session).lean()` / `Model.find(...).session(session).lean()`
  // chain used by calculateBrokerage's KiteInstrument/BrokerageSettings/ScriptQuantity lookups.
  function queryChain(result) {
    const chain = {};
    chain.select = jest.fn(() => chain);
    chain.session = jest.fn(() => chain);
    chain.lean = jest.fn(() => Promise.resolve(result));
    return chain;
  }

  // A user whose OWN threshold does NOT breach (toggle OFF, pct 0). shouldSquareOff
  // is therefore false, so only `force` can drive a close for this user.
  const nonBreachingUser = {
    _id: 'u1',
    active_status: true,
    deleted_at: null,
    master_id: 'master1',
    server_id: 'admin1',
    username: 'u1',
    margin_square_off: false,
    margin_square_off_percentage: 0,
    credits: 50000,
  };

  const freshDoc = () => ({
    _id: 'u1',
    master_id: 'master1',
    server_id: 'admin1',
    equity: 0,
    save: jest.fn().mockResolvedValue(undefined),
  });

  // One long NFO-FUT position: 2 @ entry ₹25,000. Exit bid (₹26,010) differs from
  // entry to prove the release uses the ENTRY notional, not the exit price.
  const metricsWithPosition = () => ({
    positions: [{
      instrument_token: 111,
      tradingsymbol: 'NIFTY24DECFUT',
      exchange: 'NFO',
      segment: 'NFO-FUT',
      net_qty: 2,
      avg_buy_price: 25000,
      avg_sell_price: 0,
      ltp: 26000,
      cmp: 26000,
      bid_price: 26010,
    }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReset();

    fakeSession = {
      withTransaction: jest.fn(async (fn) => { await fn(); }),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);

    beginTradeWrite.mockResolvedValue({
      assertActive: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    });

    Trade.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this._id = 'trade_' + Math.random().toString(36).slice(2, 6);
      this.save = jest.fn().mockResolvedValue(this);
    });
    Transaction.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn().mockResolvedValue(this);
    });

    walletService.release.mockResolvedValue({ category: 'NSE', amount: 0 });
    metricsEngine.onTradeExecuted.mockResolvedValue(undefined);

    // calculateBrokerage's collaborators — no matching rule, so brokerage resolves to 0.
    KiteInstrument.findOne.mockImplementation(() => queryChain({ segment: 'NFO-FUT' }));
    BrokerageSettings.findOne.mockImplementation(() => queryChain(null));
    BrokerageSettings.find.mockImplementation(() => queryChain([]));
    ScriptQuantity.findOne.mockImplementation(() => queryChain(null));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('force:true squares off even though shouldSquareOff would be false → creates the close Trade + releases entry notional', async () => {
    const doc = freshDoc();
    User.findById
      .mockReturnValueOnce(configChain(nonBreachingUser)) // 1st: .select().lean()
      .mockReturnValueOnce(sessionChain(doc));            // 2nd: .session()
    metricsEngine.getFreshMetrics.mockResolvedValue(metricsWithPosition());

    const squared = await service._squareOffAllPositions({ _id: 'u1' }, { force: true });

    expect(squared).toBe(1);
    expect(Trade).toHaveBeenCalledTimes(1);
    // Entry notional 2 × 25000 = 50000 released to NSE (segment NFO-FUT → NSE), NOT 2 × 26010.
    expect(walletService.release).toHaveBeenCalledWith('User', 'u1', 'NSE', 50000, fakeSession);
    expect(metricsEngine.onTradeExecuted).toHaveBeenCalledWith('u1');
  });

  test('without force, the SAME non-breaching user is NOT squared off (self-guard holds)', async () => {
    User.findById.mockReturnValueOnce(configChain(nonBreachingUser));
    metricsEngine.getFreshMetrics.mockResolvedValue(metricsWithPosition());

    const squared = await service._squareOffAllPositions({ _id: 'u1' }); // force defaults to false

    expect(squared).toBe(0);
    expect(Trade).not.toHaveBeenCalled();
    expect(walletService.release).not.toHaveBeenCalled();
  });

  test('force:true still returns 0 when the user has no open positions (other guards intact)', async () => {
    User.findById.mockReturnValueOnce(configChain(nonBreachingUser));
    metricsEngine.getFreshMetrics.mockResolvedValue({ positions: [] });

    const squared = await service._squareOffAllPositions({ _id: 'u1' }, { force: true });

    expect(squared).toBe(0);
    expect(Trade).not.toHaveBeenCalled();
    expect(walletService.release).not.toHaveBeenCalled();
  });
});
