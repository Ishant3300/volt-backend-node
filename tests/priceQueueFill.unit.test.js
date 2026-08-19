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
jest.mock('../src/models/Trade', () => ({ findById: jest.fn(), find: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/BrokerageSettings', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../src/models/ScriptQuantity', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/Transaction', () => jest.fn().mockImplementation(() => ({ save: jest.fn().mockResolvedValue(undefined) })));
jest.mock('../src/services/tradeWriteFenceService', () => ({ beginTradeWrite: jest.fn() }));
jest.mock('../src/services/marginService', () => ({ calculateMargin: jest.fn() }));
jest.mock('../src/services/walletService', () => ({ getAvailable: jest.fn(), block: jest.fn(), release: jest.fn() }));
jest.mock('../src/services/firebaseService', () => ({ sendNotification: jest.fn() }));
jest.mock('../src/services/metricsEngine', () => ({ getFreshMetrics: jest.fn(), onTradeExecuted: jest.fn() }));
jest.mock('../src/services/orderBookService', () => ({
  getMatchingBuyOrders: jest.fn(),
  getMatchingSellOrders: jest.fn(),
  getMatchingStopBuyOrders: jest.fn(),
  getMatchingStopSellOrders: jest.fn(),
  removeMany: jest.fn(),
}));
jest.mock('../src/services/redisService', () => ({ isAvailable: jest.fn(), getClient: jest.fn() }));
jest.mock('../src/services/livePriceService', () => ({ broadcastToUser: jest.fn() }));

const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const walletService = require('../src/services/walletService');
const { beginTradeWrite } = require('../src/services/tradeWriteFenceService');
const { calculateMargin } = require('../src/services/marginService');
const orderBookService = require('../src/services/orderBookService');
const priceQueueService = require('../src/services/priceQueueService');

const { executeMatchedOrder, _processJob } = priceQueueService._private;

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

// `Trade.find(...).select().sort().session().lean()` for positionStateSinceLastFlat —
// resolves to an array of raw trade docs, chronologically ordered by the caller.
function priorTrades(trades) {
  const chain = {};
  chain.select = jest.fn(() => chain);
  chain.sort = jest.fn(() => chain);
  chain.session = jest.fn(() => chain);
  chain.lean = jest.fn(() => Promise.resolve(trades));
  return chain;
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
  // calculateBrokerage now queries BrokerageSettings.find(...) (all rules
  // for the user, or global) instead of a single findOne — empty array
  // means no rule matches, same "brokerage resolves to 0" default as before.
  BrokerageSettings.find.mockImplementation(() => queryChain([]));

  calculateMargin.mockResolvedValue(25000); // per-unit notional (doesn't affect wallet asserts)
  walletService.block.mockResolvedValue({ category: 'NSE', amount: 0 });
  walletService.release.mockResolvedValue({ category: 'NSE', amount: 0 });
  walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 100000, GLOBAL: 100000 });

  User.findById.mockReturnValue(sessionResolving({ equity: 1000000, save: jest.fn().mockResolvedValue(undefined) }));
  Trade.create.mockResolvedValue([{}]);

  // Default: no stop (SL/SL-M) orders match this tick, unless a test
  // overrides it — mirrors the existing LIMIT-only defaults above.
  orderBookService.getMatchingStopBuyOrders.mockResolvedValue([]);
  orderBookService.getMatchingStopSellOrders.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('executeMatchedOrder — category wallet block/release at fill time', () => {
  test('(a) opening fill with sufficient balance blocks openingQty×price and completes', async () => {
    const trade = makeTradeDoc({ transaction_type: 'BUY', quantity: 2, price: 25000 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    // Flat book → nothing previously open.
    Trade.find.mockReturnValue(priorTrades([]));
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
    Trade.find.mockReturnValue(priorTrades([]));
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
    Trade.find.mockReturnValue(priorTrades([
      { transaction_type: 'BUY', executed_quantity: 5, executed_price: 25000, executed_at: new Date('2026-08-18T09:00:00Z') },
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

  test('(d) P&L and wallet release basis ignore an earlier, already-closed round trip in the same contract', async () => {
    // Regression test for a real bug: an unbounded average-cost aggregate
    // blended an unrelated, already-flat-closed round trip's prices into
    // "today's" entry basis. Real report: BUY 30 @ 57562.60, SELL 30 @
    // 57810.00 showed P&L +3171.00 instead of the correct 7422.00 — only
    // explainable by an earlier round trip contaminating the average.
    //
    // Trade history for this (user, instrument), chronological:
    //   1) BUY  20 @ 57000.00  — opens a position
    //   2) SELL 20 @ 57200.00  — fully closes it (net qty returns to 0)
    //   3) BUY  30 @ 57562.60  — opens a NEW, unrelated position
    // Then this fill: SELL 30 @ 57810.00 should close #3 using ONLY its own
    // entry price, ignoring the unrelated #1/#2 round trip entirely.
    Trade.find.mockReturnValue(priorTrades([
      { transaction_type: 'BUY', executed_quantity: 20, executed_price: 57000.00, executed_at: new Date('2026-08-15T09:00:00Z') },
      { transaction_type: 'SELL', executed_quantity: 20, executed_price: 57200.00, executed_at: new Date('2026-08-15T10:00:00Z') },
      { transaction_type: 'BUY', executed_quantity: 30, executed_price: 57562.60, executed_at: new Date('2026-08-19T09:35:00Z') },
    ]));
    const trade = makeTradeDoc({ transaction_type: 'SELL', quantity: 30, price: 57810.00 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    walletService.getAvailable.mockResolvedValue({ NSE: 0, MCX: 0, GLOBAL: 0 });

    const outcome = await executeMatchedOrder({ id: 'trade1', side: 'SELL' }, 57810.00);

    expect(trade.pnl).toBeCloseTo(7422.00, 2); // (57810.00 - 57562.60) * 30, NOT contaminated by the earlier round trip
    // Releases against the #3 entry price (57562.60 * 30), not a blended average.
    expect(walletService.release).toHaveBeenCalledWith('User', 'user1', 'NSE', 1726878, fakeSession);
    expect(outcome.kind).toBe('completed');
  });

  test('(e) a same-trade flip through zero starts a fresh average on the new side, not a blend', async () => {
    // This platform allows a single fill larger than the current net
    // position (closing it AND opening the opposite side in one trade) —
    // order size is only capped at the current position when an admin has
    // disabled the instrument, not in general. A plain "reset on exact
    // zero" check misses this, since quantity can jump straight past zero
    // without ever equaling it.
    //
    // Trade history: BUY 10 @ 100 (long 10) -> SELL 15 @ 110 (flip: closes
    // the 10 long, opens a short 5). Then THIS fill closes that short:
    // BUY 5 @ 90. P&L must be computed against the flip's own price (110),
    // not any blend involving the original long's 100 entry.
    Trade.find.mockReturnValue(priorTrades([
      { transaction_type: 'BUY', executed_quantity: 10, executed_price: 100, executed_at: new Date('2026-08-19T09:00:00Z') },
      { transaction_type: 'SELL', executed_quantity: 15, executed_price: 110, executed_at: new Date('2026-08-19T09:05:00Z') },
    ]));
    const trade = makeTradeDoc({ transaction_type: 'BUY', quantity: 5, price: 90 });
    Trade.findById.mockReturnValue(sessionResolving(trade));
    walletService.getAvailable.mockResolvedValue({ NSE: 0, MCX: 0, GLOBAL: 0 });

    const outcome = await executeMatchedOrder({ id: 'trade1', side: 'BUY' }, 90);

    expect(trade.pnl).toBeCloseTo((110 - 90) * 5, 2); // avgSell must be 110 (the flip price), not blended with the old long's 100
    expect(walletService.release).toHaveBeenCalledWith('User', 'user1', 'NSE', 5 * 110, fakeSession);
    expect(outcome.kind).toBe('completed');
  });
});

describe('_processJob — one matched order failing does not abort the rest of the batch', () => {
  test('a failing sibling order does not block cleanup for orders that succeeded in the same price tick', async () => {
    // Regression test for a real bug: a single price tick can match several
    // pending orders at once. The old code re-threw on the FIRST failure,
    // aborting the loop entirely — so any order that had already executed
    // successfully earlier in that same batch never reached the
    // removeMany() cleanup below, leaving it stuck in the Redis order book
    // (re-matched and harmlessly no-op'd on every later tick, but never
    // actually cleaned up, until the next market-close sweep).
    const tradeA = makeTradeDoc({ _id: 'tradeA', transaction_type: 'BUY', quantity: 2, price: 25000, user_id: 'userA' });

    Trade.findById.mockImplementation((id) => {
      if (id === 'tradeA') return sessionResolving(tradeA);
      // Simulates tradeB failing for any reason (insufficient funds, a data
      // issue, a transient DB error) partway through its own execution.
      if (id === 'tradeB') return { session: jest.fn().mockRejectedValue(new Error('Simulated failure for tradeB')) };
      return sessionResolving(null);
    });
    Trade.find.mockReturnValue(priorTrades([])); // flat book for tradeA
    walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 0, GLOBAL: 0 });

    orderBookService.getMatchingBuyOrders.mockResolvedValue(['tradeA', 'tradeB']);
    orderBookService.getMatchingSellOrders.mockResolvedValue([]);

    // Must not throw — one bad order in the batch must not crash the whole tick.
    await expect(_processJob({ data: { instrument_token: 111, live_price: 24990 } })).resolves.toBeUndefined();

    // tradeA executed successfully...
    expect(walletService.block).toHaveBeenCalledWith('User', 'userA', 'NSE', 50000, expect.anything());
    // ...and still gets cleaned out of the order book, despite tradeB's failure.
    expect(orderBookService.removeMany).toHaveBeenCalledWith(111, 'BUY', ['tradeA'], 'LIMIT');
    // tradeB itself is left OUT of cleanup — it stays pending for a retry
    // on the next tick, not silently dropped or wrongly marked done.
    const removedIds = orderBookService.removeMany.mock.calls.flatMap((call) => call[2]);
    expect(removedIds).not.toContain('tradeB');
  });
});

describe('_processJob — SL/SL-M orders are matched and cleaned up separately from LIMIT orders', () => {
  // Regression test for a real bug: SL/SL-M orders were accepted at
  // placement but NEVER registered anywhere (Redis order book, DB-fallback
  // query, boot-time sync all filtered to 'LIMIT' only) — they sat pending
  // forever with zero actual stop-loss protection until end-of-day cleanup
  // silently cancelled them. _processJob must now also query the stop
  // order book and execute matches from it exactly like LIMIT matches.
  test('a matched stop order executes and is cleaned up via the stop-order removeMany call, not the LIMIT one', async () => {
    const stopTrade = makeTradeDoc({ _id: 'stopTradeA', transaction_type: 'BUY', quantity: 2, price: 25000, user_id: 'userA', order_type: 'SL' });

    Trade.findById.mockImplementation((id) => {
      if (id === 'stopTradeA') return sessionResolving(stopTrade);
      return sessionResolving(null);
    });
    Trade.find.mockReturnValue(priorTrades([]));
    walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 0, GLOBAL: 0 });

    orderBookService.getMatchingBuyOrders.mockResolvedValue([]);
    orderBookService.getMatchingSellOrders.mockResolvedValue([]);
    orderBookService.getMatchingStopBuyOrders.mockResolvedValue(['stopTradeA']);
    orderBookService.getMatchingStopSellOrders.mockResolvedValue([]);

    await expect(_processJob({ data: { instrument_token: 111, live_price: 25010 } })).resolves.toBeUndefined();

    expect(walletService.block).toHaveBeenCalledWith('User', 'userA', 'NSE', 50000, expect.anything());
    // Cleaned up via the SL-tagged removeMany call (4th arg 'SL'), not the LIMIT one.
    expect(orderBookService.removeMany).toHaveBeenCalledWith(111, 'BUY', ['stopTradeA'], 'SL');
    expect(orderBookService.removeMany).not.toHaveBeenCalledWith(111, 'BUY', ['stopTradeA'], 'LIMIT');
  });

  test('LIMIT and stop matches in the same tick are cleaned up into their own separate removeMany calls', async () => {
    const limitTrade = makeTradeDoc({ _id: 'limitTradeA', transaction_type: 'BUY', quantity: 1, price: 25000, user_id: 'userA' });
    const stopTrade = makeTradeDoc({ _id: 'stopTradeB', transaction_type: 'SELL', quantity: 1, price: 25000, user_id: 'userA', order_type: 'SL-M' });

    Trade.findById.mockImplementation((id) => {
      if (id === 'limitTradeA') return sessionResolving(limitTrade);
      if (id === 'stopTradeB') return sessionResolving(stopTrade);
      return sessionResolving(null);
    });
    Trade.find.mockReturnValue(priorTrades([]));
    walletService.getAvailable.mockResolvedValue({ NSE: 100000, MCX: 0, GLOBAL: 0 });

    orderBookService.getMatchingBuyOrders.mockResolvedValue(['limitTradeA']);
    orderBookService.getMatchingSellOrders.mockResolvedValue([]);
    orderBookService.getMatchingStopBuyOrders.mockResolvedValue([]);
    orderBookService.getMatchingStopSellOrders.mockResolvedValue(['stopTradeB']);

    await expect(_processJob({ data: { instrument_token: 111, live_price: 25000 } })).resolves.toBeUndefined();

    expect(orderBookService.removeMany).toHaveBeenCalledWith(111, 'BUY', ['limitTradeA'], 'LIMIT');
    expect(orderBookService.removeMany).toHaveBeenCalledWith(111, 'SELL', ['stopTradeB'], 'SL');
  });
});
