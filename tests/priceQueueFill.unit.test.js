'use strict';

// Validates: Requirements 3.1 (opening fill blocks), 3.2 (closing fill releases),
// 4.1 (underfunded opening fill is rejected, never completed), design §6.2 / §13.2
// (block/release happens at FILL time, not at placement; a fill that fails the
// wallet gate is rejected via the existing rejection path).
//
// This unit-tests priceQueueService._private.executeMatchedOrder — the PRIMARY
// (Redis/BullMQ) pending-fill path — with every collaborator mocked (models,
// walletService, metricsEngine, brokerage, trade-write lease) and a fake session
// whose withTransaction(fn) just runs the body. The full end-to-end wiring against
// a live replica-set Mongo is covered by the integration suite (Tasks 19/20).

jest.mock('bullmq', () => ({ Queue: jest.fn(), Worker: jest.fn() }));
jest.mock('../src/models/Trade', () => ({ findById: jest.fn(), aggregate: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/BrokerageSettings', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/ScriptQuantity', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/Transaction', () => jest.fn().mockImplementation(() => ({ save: jest.fn().mockResolvedValue(undefined) })));
jest.mock('../src/services/tradeWriteFenceService', () => ({ beginTradeWrite: jest.fn() }));
jest.mock('../src/services/marginService', () => ({ calculateMargin: jest.fn() }));
jest.mock('../src/services/walletService', () => ({ getAvailable: jest.fn(), block: jest.fn(), release: jest.fn() }));
jest.mock('../src/services/firebaseService', () => ({ sendNotification: jest.fn() }));
jest.mock('../src/services/metricsEngine', () => ({ getFreshMetrics: jest.fn(), onTradeExecuted: jest.fn() }));
jest.mock('../src/services/orderBookService', () => ({ getMatchingBuyOrders: jest.fn(), getMatchingSellOrders: jest.fn(), removeMany: jest.fn() }));
jest.mock('../src/services/redisService', () => ({ isAvailable: jest.fn(), getClient: jest.fn() }));

const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const walletService = require('../src/services/walletService');
const { beginTradeWrite } = require('../src/services/tradeWriteFenceService');
const { calculateMargin } = require('../src/services/marginService');
const priceQueueService = require('../src/services/priceQueueService');

const { executeMatchedOrder } = priceQueueService._private;

let fakeSession;

// A self-returning query chain supporting both `.select().session().lean()`
// (segment lookup) and `.session().lean()` (calculateBrokerage) shapes.
function queryChain(result) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(result));
  return chain;
}

// A `.session(session)` thenable: `Model.findById(id).session(session)` resolves the doc.
function sessionResolving(result) {
  return { session: jest.fn().mockResolvedValue(result) };
}

function makeTradeDoc(overrides = {}) {
  const doc = Object.assign({
    _id: 'trade1',
    status: 'pending',
    transaction_type: 'BUY',
    quantity: 2,
    user_id: 'user1',
    master_id: 'master1',
    admin_id: null,
    instrument_token: 111,
    tradingsymbol: 'NIFTY24DECFUT',
    exchange: 'NFO',
    price: 25000,
    order_type: 'LIMIT',
    pnl: 0,
    net_amount: 0,
  }, overrides);
  doc.save = jest.fn().mockResolvedValue(doc);
  doc.toObject = jest.fn(() => ({ ...doc }));
  return doc;
}

beforeEach(() => {
  jest.clearAllMocks();

  fakeSession = {
    withTransaction: jest.fn(async (fn) => { await fn(); }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);

  beginTradeWrite.mockResolvedValue({
    assertActive: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  });

  // Instrument segment 'NFO-FUT' → wallet category NSE. Also serves the
  // calculateBrokerage lookup (no raw_name/name → brokerage resolves to 0).
  KiteInstrument.findOne.mockImplementation(() => queryChain({ segment: 'NFO-FUT' }));
  BrokerageSettings.findOne.mockImplementation(() => queryChain(null));

  calculateMargin.mockResolvedValue(25000); // per-unit notional (doesn't affect wallet asserts)
  walletService.block.mockResolvedValue({ category: 'NSE', amount: 0 });
  walletService.release.mockResolvedValue({ category: 'NSE', amount: 0 });
  walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 100000, GLOBAL: 100000 });

  User.findById.mockReturnValue(sessionResolving({ equity: 1000000, save: jest.fn().mockResolvedValue(undefined) }));
  Trade.create.mockResolvedValue([{}]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('executeMatchedOrder — category wallet block/release at fill time', () => {
  test('(a) opening fill with sufficient balance blocks openingQty×price and completes', async () => {
    const trade = makeTradeDoc({ transaction_type: 'BUY', quantity: 2, price: 25000 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    // Flat book → nothing previously open.
    Trade.aggregate.mockReturnValue(sessionResolving([]));
    walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 0, GLOBAL: 0 });

    const outcome = await executeMatchedOrder({ id: 'trade1', side: 'BUY' }, 24990);

    // Blocks the full opening notional (2 × 25000) against the NSE pool.
    expect(walletService.block).toHaveBeenCalledWith('User', 'user1', 'NSE', 50000, fakeSession);
    expect(walletService.release).not.toHaveBeenCalled();
    expect(trade.status).toBe('completed');
    expect(outcome.kind).toBe('completed');
  });

  test('(b) opening fill where notional exceeds available is rejected (no block, never completed)', async () => {
    const trade = makeTradeDoc({ transaction_type: 'BUY', quantity: 2, price: 25000 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    Trade.aggregate.mockReturnValue(sessionResolving([]));
    // Pool cannot cover 2 × 25000 = 50000.
    walletService.getAvailable.mockResolvedValue({ NSE: 10000, MCX: 0, GLOBAL: 0 });

    const outcome = await executeMatchedOrder({ id: 'trade1', side: 'BUY' }, 24990);

    expect(walletService.block).not.toHaveBeenCalled();       // gate fails before block
    expect(trade.status).toBe('rejected');                    // order rejected
    expect(Trade.create).toHaveBeenCalledTimes(1);            // rejection-log Trade written
    expect(outcome.kind).toBe('rejected');                    // never 'completed'
    expect(outcome.category).toBe('NSE');
    // Remark names the category and the shortfall (50000 − 10000 = 40000).
    expect(trade.remarks).toMatch(/Insufficient NSE wallet balance at fill/);
    expect(trade.remarks).toMatch(/short ₹40000\.00/);
  });

  test('(c) closing fill releases the entry notional and does not block', async () => {
    // Pre-existing long: bought 5 @ 25000 (avgBuy = 25000).
    Trade.aggregate.mockReturnValue(sessionResolving([
      { total_buy_qty: 5, total_sell_qty: 0, total_buy_value: 125000, total_sell_value: 0 },
    ]));
    const trade = makeTradeDoc({ transaction_type: 'SELL', quantity: 5, price: 26000 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    walletService.getAvailable.mockResolvedValue({ NSE: 0, MCX: 0, GLOBAL: 0 });

    const outcome = await executeMatchedOrder({ id: 'trade1', side: 'SELL' }, 26010);

    // Releases the closed quantity's entry notional (5 × 25000), not the exit price.
    expect(walletService.release).toHaveBeenCalledWith('User', 'user1', 'NSE', 125000, fakeSession);
    expect(walletService.block).not.toHaveBeenCalled();
    expect(trade.status).toBe('completed');
    expect(outcome.kind).toBe('completed');
  });
});
