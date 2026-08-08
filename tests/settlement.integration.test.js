'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const BrokerageSettings = require('../src/models/BrokerageSettings');
const KiteInstrument = require('../src/models/KiteInstrument');
const Master = require('../src/models/Master');
const SettlementFence = require('../src/models/SettlementFence');
const SettlementHistory = require('../src/models/SettlementHistory');
const SettlementRun = require('../src/models/SettlementRun');
const Trade = require('../src/models/Trade');
const TradeWriteLease = require('../src/models/TradeWriteLease');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');
const bhavcopyService = require('../src/services/bhavcopyService');
const cronService = require('../src/services/cronService');
const metricsEngine = require('../src/services/metricsEngine');
const livePriceService = require('../src/services/livePriceService');
const priceQueueService = require('../src/services/priceQueueService');
const settlementService = require('../src/services/settlementService');
const tradeWriteFenceService = require('../src/services/tradeWriteFenceService');
const { indiaDayRangeUtc, toIndiaDateOnly } = require('../src/utils/settlementDates');

const runIntegration = process.env.RUN_SETTLEMENT_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseName = `stkr_settle_it_${Date.now().toString(36)}_${process.pid.toString(36)}`;

jest.setTimeout(180_000);

function resetProcessCaches() {
  metricsEngine._userCache.clear();
  metricsEngine._tokenToUsers.clear();
  metricsEngine._metricsCache.clear();
  metricsEngine._ltpMap.clear();
  metricsEngine._bidMap.clear();
  metricsEngine._askMap.clear();
  metricsEngine._brokerageRules = [];
  metricsEngine._kiteMap = {};
  metricsEngine._masterParentMap = {};
  metricsEngine._masterChildrenMap = {};
  metricsEngine._settledTokens = null;
  metricsEngine._appliedSettlementRunId = null;
  metricsEngine._settlementSyncPromise = null;
  metricsEngine._lastSettlementCheckAt = 0;
  metricsEngine.livePriceService = livePriceService;
  metricsEngine._initialized = true;

  livePriceService.latestPrices.clear();
  if (livePriceService._settlementPrices) livePriceService._settlementPrices.clear();
}

async function clearDatabase() {
  await Promise.all([
    BrokerageSettings.deleteMany({}),
    KiteInstrument.deleteMany({}),
    Master.deleteMany({}),
    SettlementFence.deleteMany({}),
    SettlementHistory.deleteMany({}),
    SettlementRun.deleteMany({}),
    Trade.deleteMany({}),
    TradeWriteLease.deleteMany({}),
    Transaction.deleteMany({}),
    User.deleteMany({}),
  ]);
  resetProcessCaches();
  settlementService.resetState();
}

async function seedScenario(options = {}) {
  const periodKey = options.periodKey || '2026-07-31';
  const tradingDate = toIndiaDateOnly(periodKey);
  const cutoff = indiaDayRangeUtc(tradingDate).end;
  const prefix = options.prefix || periodKey.replace(/-/g, '');
  const serverId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();

  const master = await Master.create({
    name: `Integration Master ${prefix}`,
    username: `it_master_${prefix}`,
    password: 'not-used',
    credits: 1_000_000,
    equity: 1_000_000,
    server_id: serverId,
    admin_id: adminId,
    exchanges_allowed: ['NFO-FUT', 'MCX-FUT'],
  });

  // --- Wallet re-base fixtures (design §6.5) --------------------------------
  // Seed each user's wallet to the AVAILABLE balance *after* opening its
  // position: `WALLET_FUNDING − |qty|×entryPrice` for the traded category (the
  // entry notional blocked on open). Settlement re-bases that block from the
  // entry price to the official settlement price, so assertions afterwards can
  // check `WALLET_FUNDING − |qty|×settlementPrice`.
  const WALLET_FUNDING = 100_000;
  const NFO_ENTRY_BLOCK = 6 * 100;    // user 1: net 6 long @ 100 (NSE)
  const MCX_ENTRY_BLOCK = 20 * 200;   // user 2: net 20 short @ 200 (MCX)
  const walletForUser = index => {
    if (index === 1) return { NSE: WALLET_FUNDING - NFO_ENTRY_BLOCK, MCX: WALLET_FUNDING, GLOBAL: 0 };
    if (index === 2) return { NSE: WALLET_FUNDING, MCX: WALLET_FUNDING - MCX_ENTRY_BLOCK, GLOBAL: 0 };
    return { NSE: WALLET_FUNDING, MCX: WALLET_FUNDING, GLOBAL: 0 }; // user 3 is flat
  };

  const userPayload = index => ({
    name: `Integration User ${index}`,
    username: `it_user_${prefix}_${index}`,
    password: 'not-used',
    credits: 100_000,
    equity: 100_000,
    settled_pnl: 0,
    server_id: serverId,
    master_id: master._id,
    wallet: walletForUser(index),
    exchanges_allowed: [
      { exchange_name: 'NFO-FUT', turnover: true, lot: false, group_name: 'IT' },
      { exchange_name: 'MCX-FUT', turnover: true, lot: false, group_name: 'IT' },
    ],
  });

  const users = await User.create([
    userPayload(1),
    userPayload(2),
    ...(options.includeFlat === false ? [] : [userPayload(3)]),
  ]);

  const nfoToken = `${prefix.slice(-6)}01`;
  const mcxToken = `${prefix.slice(-6)}02`;
  const instruments = await KiteInstrument.create([
    {
      instrument_token: nfoToken,
      exchange_token: `${prefix.slice(-6)}11`,
      tradingsymbol: 'NIFTY26AUGFUT',
      name: 'NIFTY',
      raw_name: 'NIFTY',
      display_name: 'NIFTY FUT Aug 2026',
      last_price: 111,
      settlement_price: 130,
      settlement_price_date: tradingDate,
      settlement_price_source: 'NSE_OFFICIAL_BHAVCOPY_TEST',
      ohlc_close: 130,
      expiry: new Date('2026-08-25T00:00:00.000Z'),
      strike: 0,
      tick_size: 0.05,
      lot_size: 25,
      instrument_type: 'FUT',
      segment: 'NFO-FUT',
      exchange: 'NFO',
    },
    {
      instrument_token: mcxToken,
      exchange_token: `${prefix.slice(-6)}12`,
      tradingsymbol: 'GOLD26AUGFUT',
      name: 'GOLD',
      raw_name: 'GOLD',
      display_name: 'GOLD FUT Aug 2026',
      last_price: 190,
      settlement_price: 180,
      settlement_price_date: tradingDate,
      settlement_price_source: 'MCX_OFFICIAL_BHAVCOPY_CLOSE_TEST',
      ohlc_close: 180,
      expiry: new Date('2026-08-31T00:00:00.000Z'),
      strike: 0,
      tick_size: 1,
      lot_size: 10,
      instrument_type: 'FUT',
      segment: 'MCX-FUT',
      exchange: 'MCX',
    },
  ]);

  const executedAt = new Date(cutoff.getTime() - (8 * 60 * 60 * 1000));
  const createdAt = new Date(executedAt.getTime() - 1000);
  const trades = [
    {
      user_id: users[0]._id,
      master_id: master._id,
      admin_id: adminId,
      instrument_token: nfoToken,
      tradingsymbol: instruments[0].tradingsymbol,
      exchange: 'NFO',
      transaction_type: 'BUY',
      quantity: 10,
      price: 100,
      order_type: 'MARKET',
      status: 'completed',
      executed_at: executedAt,
      executed_price: 100,
      executed_quantity: 10,
      pnl: 0,
      createdAt,
      updatedAt: createdAt,
    },
    {
      user_id: users[0]._id,
      master_id: master._id,
      admin_id: adminId,
      instrument_token: nfoToken,
      tradingsymbol: instruments[0].tradingsymbol,
      exchange: 'NFO',
      transaction_type: 'SELL',
      quantity: 4,
      price: 120,
      order_type: 'MARKET',
      status: 'completed',
      executed_at: new Date(executedAt.getTime() + 1000),
      executed_price: 120,
      executed_quantity: 4,
      pnl: 80,
      createdAt: new Date(createdAt.getTime() + 1000),
      updatedAt: new Date(createdAt.getTime() + 1000),
    },
    {
      user_id: users[1]._id,
      master_id: master._id,
      admin_id: adminId,
      instrument_token: mcxToken,
      tradingsymbol: instruments[1].tradingsymbol,
      exchange: 'MCX',
      transaction_type: 'SELL',
      quantity: 20,
      price: 200,
      order_type: 'MARKET',
      status: 'completed',
      executed_at: new Date(executedAt.getTime() + 2000),
      executed_price: 200,
      executed_quantity: 20,
      pnl: 0,
      createdAt: new Date(createdAt.getTime() + 2000),
      updatedAt: new Date(createdAt.getTime() + 2000),
    },
  ];

  if (options.includeFlat !== false) {
    trades.push(
      {
        user_id: users[2]._id,
        master_id: master._id,
        admin_id: adminId,
        instrument_token: nfoToken,
        tradingsymbol: instruments[0].tradingsymbol,
        exchange: 'NFO',
        transaction_type: 'BUY',
        quantity: 5,
        price: 50,
        order_type: 'MARKET',
        status: 'completed',
        executed_at: new Date(executedAt.getTime() + 3000),
        executed_price: 50,
        executed_quantity: 5,
        pnl: 0,
        createdAt: new Date(createdAt.getTime() + 3000),
        updatedAt: new Date(createdAt.getTime() + 3000),
      },
      {
        user_id: users[2]._id,
        master_id: master._id,
        admin_id: adminId,
        instrument_token: nfoToken,
        tradingsymbol: instruments[0].tradingsymbol,
        exchange: 'NFO',
        transaction_type: 'SELL',
        quantity: 5,
        price: 55,
        order_type: 'MARKET',
        status: 'completed',
        executed_at: new Date(executedAt.getTime() + 4000),
        executed_price: 55,
        executed_quantity: 5,
        pnl: 25,
        createdAt: new Date(createdAt.getTime() + 4000),
        updatedAt: new Date(createdAt.getTime() + 4000),
      }
    );
  }

  await Trade.create(trades);
  let pending = null;
  if (options.includePending !== false) {
    pending = await Trade.create({
      user_id: users[0]._id,
      master_id: master._id,
      admin_id: adminId,
      instrument_token: nfoToken,
      tradingsymbol: instruments[0].tradingsymbol,
      exchange: 'NFO',
      transaction_type: 'BUY',
      quantity: 1,
      price: 90,
      order_type: 'LIMIT',
      status: 'pending',
      executed_at: null,
      executed_price: null,
      executed_quantity: 0,
      createdAt: new Date(createdAt.getTime() + 5000),
      updatedAt: new Date(createdAt.getTime() + 5000),
    });
  }

  return {
    adminId,
    cutoff,
    instruments,
    master,
    mcxToken,
    nfoToken,
    pending,
    prefix,
    tradingDate,
    users,
    walletFunding: WALLET_FUNDING,
  };
}

async function createOwnedRun(scenario, owner, periodKey) {
  return SettlementRun.create({
    period_key: periodKey,
    trading_date: scenario.tradingDate,
    trade_cutoff_at: scenario.cutoff,
    price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
    status: 'running',
    trigger: 'manual',
    lock_owner: owner,
    lease_expires_at: new Date(Date.now() + 15 * 60 * 1000),
    attempts: 1,
    started_at: new Date(),
  });
}

async function materializeLegacySettlement(scenario, options = {}) {
  const legacyRunId = new mongoose.Types.ObjectId();
  const settlementAt = new Date(scenario.cutoff.getTime() + (8 * 60 * 60 * 1000));
  const nfoSources = await Trade.find({
    user_id: scenario.users[0]._id,
    instrument_token: scenario.nfoToken,
    status: 'completed',
    deleted_at: null,
  }).sort({ executed_at: 1 }).lean();
  const mcxSources = await Trade.find({
    user_id: scenario.users[1]._id,
    instrument_token: scenario.mcxToken,
    status: 'completed',
    deleted_at: null,
  }).sort({ executed_at: 1 }).lean();
  const toLegacyFill = trade => ({
    transaction_type: trade.transaction_type,
    executed_quantity: trade.executed_quantity,
    executed_price: trade.executed_price,
    executed_at: trade.executed_at,
    pnl: trade.pnl || 0,
    brokerage: 0,
    order_type: trade.order_type,
    placed_by: trade.placed_by,
    trade_type: trade.trade_type,
  });

  await SettlementHistory.create([{
    settlement_run_id: legacyRunId,
    settlement_date: settlementAt,
    period_from: nfoSources[0].executed_at,
    period_to: settlementAt,
    user_id: scenario.users[0]._id,
    master_id: scenario.master._id,
    admin_id: scenario.adminId,
    exchange: 'NFO',
    tradingsymbol: scenario.instruments[0].tradingsymbol,
    instrument_token: scenario.nfoToken,
    fills: nfoSources.map(toLegacyFill),
    total_buy_qty: 10,
    total_buy_value: 1000,
    avg_buy_price: 100,
    total_sell_qty: 4,
    total_sell_value: 480,
    avg_sell_price: 120,
    settlement_price: 130,
    closing_qty: 6,
    closing_side: 'SELL',
    realized_pnl: 80,
    settlement_pnl: 180,
    total_pnl: 260,
    brokerage: 0,
    net_pnl: 260,
    carry_forward_qty: 6,
    carry_forward_price: 130,
    carry_forward_side: 'BUY',
  }, {
    settlement_run_id: legacyRunId,
    settlement_date: settlementAt,
    period_from: mcxSources[0].executed_at,
    period_to: settlementAt,
    user_id: scenario.users[1]._id,
    master_id: scenario.master._id,
    admin_id: scenario.adminId,
    exchange: 'MCX',
    tradingsymbol: scenario.instruments[1].tradingsymbol,
    instrument_token: scenario.mcxToken,
    fills: mcxSources.map(toLegacyFill),
    total_buy_qty: 0,
    total_buy_value: 0,
    avg_buy_price: 0,
    total_sell_qty: 20,
    total_sell_value: 4000,
    avg_sell_price: 200,
    settlement_price: 180,
    closing_qty: 20,
    closing_side: 'BUY',
    realized_pnl: 0,
    settlement_pnl: 400,
    total_pnl: 400,
    brokerage: 0,
    net_pnl: 400,
    carry_forward_qty: 20,
    carry_forward_price: 180,
    carry_forward_side: 'SELL',
  }]);

  if (options.applySettledPnl !== false) {
    await User.bulkWrite([{
      updateOne: {
        filter: { _id: scenario.users[0]._id },
        update: { $inc: { settled_pnl: 260 } },
      },
    }, {
      updateOne: {
        filter: { _id: scenario.users[1]._id },
        update: { $inc: { settled_pnl: 400 } },
      },
    }]);
  }

  await Trade.updateMany({ status: 'completed', deleted_at: null }, {
    $set: { deleted_at: settlementAt, remarks: 'Settlement: week reset' },
  });
  await Trade.create([{
    user_id: scenario.users[0]._id,
    master_id: scenario.master._id,
    admin_id: scenario.adminId,
    instrument_token: scenario.nfoToken,
    tradingsymbol: scenario.instruments[0].tradingsymbol,
    exchange: 'NFO',
    transaction_type: 'BUY',
    quantity: 6,
    price: 130,
    order_type: 'MARKET',
    placed_by: 'SYSTEM',
    trade_type: 'carry_forward',
    status: 'completed',
    executed_at: new Date(settlementAt.getTime() + 1000),
    executed_price: 130,
    executed_quantity: 6,
    pnl: 0,
    createdAt: new Date(settlementAt.getTime() + 1),
  }, {
    user_id: scenario.users[1]._id,
    master_id: scenario.master._id,
    admin_id: scenario.adminId,
    instrument_token: scenario.mcxToken,
    tradingsymbol: scenario.instruments[1].tradingsymbol,
    exchange: 'MCX',
    transaction_type: 'SELL',
    quantity: 20,
    price: 180,
    order_type: 'MARKET',
    placed_by: 'SYSTEM',
    trade_type: 'carry_forward',
    status: 'completed',
    executed_at: new Date(settlementAt.getTime() + 1000),
    executed_price: 180,
    executed_quantity: 20,
    pnl: 0,
    createdAt: new Date(settlementAt.getTime() + 1),
  }]);

  return {
    legacyRunId,
    settlementAt,
    sourceTradeIds: [...nfoSources, ...mcxSources].map(trade => trade._id),
  };
}

describeIntegration('isolated replica-set weekend settlement', () => {
  beforeAll(async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required for isolated integration tests');
    if (!databaseName.startsWith('stkr_settle_it_') || Buffer.byteLength(databaseName) > 38) {
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

    for (const model of [
      KiteInstrument,
      Master,
      SettlementFence,
      SettlementHistory,
      SettlementRun,
      Trade,
      TradeWriteLease,
      Transaction,
      User,
    ]) {
      await model.syncIndexes();
    }
  });

  beforeEach(clearDatabase);

  afterAll(async () => {
    try {
      if (mongoose.connection.readyState === 1
        && mongoose.connection.name === databaseName
        && databaseName.startsWith('stkr_settle_it_')) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  });

  test('one concurrent worker commits and final ATP = CMP = settlement with zero floating P&L', async () => {
    const scenario = await seedScenario({ includeFlat: true, includePending: true, prefix: 'fullrun' });

    const results = await Promise.all([
      settlementService.runSettlement({
        tradingDate: scenario.tradingDate,
        priceDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
        refreshPrices: false,
        applySettlementPrices: true,
        waitForCompletion: true,
      }),
      settlementService.runSettlement({
        tradingDate: scenario.tradingDate,
        priceDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
        refreshPrices: false,
        applySettlementPrices: true,
        waitForCompletion: true,
      }),
    ]);

    expect(results.filter(result => result.started)).toHaveLength(1);
    expect(results.some(result => result.success && result.completed)).toBe(true);

    const run = await SettlementRun.findOne({ period_key: '2026-07-31' }).lean();
    expect(run.status).toBe('completed');
    expect(run.verification).toMatchObject({
      carry_forward_positions: 2,
      flat_position_groups: 1,
      active_position_set_exact: true,
      atp_equals_cmp: true,
      floating_pnl_zero: true,
    });
    expect(await SettlementRun.countDocuments({ period_key: '2026-07-31' })).toBe(1);
    expect(await SettlementHistory.countDocuments({ settlement_run_id: run._id })).toBe(3);

    const ledgerRows = await SettlementHistory.find({ settlement_run_id: run._id }).lean();
    expect(ledgerRows.every(row => row.fills.every(fill => Boolean(fill.source_trade_id)))).toBe(true);
    expect(ledgerRows.filter(row => row.carry_forward_qty > 0).map(row => row.settlement_price_source).sort()).toEqual([
      'MCX_OFFICIAL_BHAVCOPY_CLOSE_TEST',
      'NSE_OFFICIAL_BHAVCOPY_TEST',
    ]);
    const resetSourceFills = await Trade.find({
      trade_type: 'regular',
      status: 'completed',
      deleted_at: { $ne: null },
    }).lean();
    expect(resetSourceFills).toHaveLength(5);
    expect(resetSourceFills.every(trade =>
      trade.settlement_run_id?.toString() === run._id.toString()
      && trade.settlement_period_key === run.period_key
    )).toBe(true);

    const active = await Trade.find({ status: 'completed', deleted_at: null }).sort({ instrument_token: 1 }).lean();
    expect(active).toHaveLength(2);
    const nfoCarry = active.find(trade => trade.instrument_token === scenario.nfoToken);
    const mcxCarry = active.find(trade => trade.instrument_token === scenario.mcxToken);
    expect(nfoCarry).toMatchObject({
      trade_type: 'carry_forward',
      transaction_type: 'BUY',
      executed_quantity: 6,
      executed_price: 130,
      settlement_period_key: '2026-07-31',
    });
    expect(mcxCarry).toMatchObject({
      trade_type: 'carry_forward',
      transaction_type: 'SELL',
      executed_quantity: 20,
      executed_price: 180,
      settlement_period_key: '2026-07-31',
    });

    const refreshedUsers = await User.find({ _id: { $in: scenario.users.map(user => user._id) } }).sort({ username: 1 }).lean();
    expect(refreshedUsers.map(user => user.settled_pnl)).toEqual([260, 400, 25]);
    const cancelledPending = await Trade.findById(scenario.pending._id).lean();
    expect(cancelledPending).toMatchObject({
      status: 'cancelled',
      settlement_period_key: '2026-07-31',
    });
    expect(cancelledPending.settlement_run_id.toString()).toBe(run._id.toString());

    const nfoMetrics = metricsEngine.getCachedMetrics(scenario.users[0]._id.toString());
    const mcxMetrics = metricsEngine.getCachedMetrics(scenario.users[1]._id.toString());
    const flatMetrics = metricsEngine.getCachedMetrics(scenario.users[2]._id.toString());
    expect(nfoMetrics.positions[0]).toMatchObject({
      net_qty: 6,
      avg_buy_price: 130,
      cmp: 130,
      floating_pnl: 0,
    });
    expect(mcxMetrics.positions[0]).toMatchObject({
      net_qty: -20,
      avg_sell_price: 180,
      cmp: 180,
      floating_pnl: 0,
    });
    expect(flatMetrics.positions).toEqual([]);
    expect(flatMetrics.position_pnl).toBe(0);

    const beforeCounts = {
      history: await SettlementHistory.countDocuments({}),
      trades: await Trade.countDocuments({}),
      pnl: refreshedUsers.map(user => user.settled_pnl),
    };
    const duplicate = await settlementService.runSettlement({
      tradingDate: scenario.tradingDate,
      priceDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      refreshPrices: false,
      waitForCompletion: true,
    });
    expect(duplicate).toMatchObject({ success: true, started: false, alreadyCompleted: true });
    expect(await SettlementHistory.countDocuments({})).toBe(beforeCounts.history);
    expect(await Trade.countDocuments({})).toBe(beforeCounts.trades);
    expect((await User.find({ _id: { $in: scenario.users.map(user => user._id) } }).sort({ username: 1 }).lean()).map(user => user.settled_pnl)).toEqual(beforeCounts.pnl);
  });

  test('a failure after all financial writes rolls the transaction back completely', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: true, prefix: 'rollback' });
    const owner = 'integration:rollback';
    const run = await createOwnedRun(scenario, owner, '2026-07-31');

    await expect(settlementService._private.commitSettlementTransaction({
      run,
      lockOwner: owner,
      tradingDate: scenario.tradingDate,
      faultInjector: async ({ phase }) => {
        if (phase === 'before_run_commit') throw new Error('injected transaction failure');
      },
    })).rejects.toThrow('injected transaction failure');

    expect(await SettlementHistory.countDocuments({})).toBe(0);
    expect(await Trade.countDocuments({ settlement_period_key: '2026-07-31' })).toBe(0);
    expect(await Trade.countDocuments({ status: 'completed', deleted_at: null })).toBe(3);
    expect((await Trade.findById(scenario.pending._id).lean()).status).toBe('pending');
    expect((await User.findById(scenario.users[0]._id).lean()).settled_pnl).toBe(0);
    expect((await User.findById(scenario.users[1]._id).lean()).settled_pnl).toBe(0);
    // The wallet carry-forward re-base is part of the same transaction, so an
    // aborted settlement leaves the seeded available balances untouched
    // (atomicity — Requirement 3.5 / cross-cutting 3).
    const rolledBackNfoUser = await User.findById(scenario.users[0]._id).select('wallet').lean();
    const rolledBackMcxUser = await User.findById(scenario.users[1]._id).select('wallet').lean();
    expect(rolledBackNfoUser.wallet.NSE).toBeCloseTo(scenario.walletFunding - (6 * 100), 2);
    expect(rolledBackMcxUser.wallet.MCX).toBeCloseTo(scenario.walletFunding - (20 * 200), 2);
    expect((await KiteInstrument.findOne({ instrument_token: scenario.nfoToken }).lean()).last_price).toBe(111);
    expect((await SettlementRun.findById(run._id).lean()).status).toBe('running');
  });

  test('settlement re-bases carried-forward wallet margin to the official settlement price', async () => {
    const scenario = await seedScenario({ includeFlat: true, includePending: false, prefix: 'walletrebase' });
    const owner = 'integration:wallet-rebase';
    const run = await createOwnedRun(scenario, owner, '2026-07-31');

    const commit = await settlementService._private.commitSettlementTransaction({
      run,
      lockOwner: owner,
      tradingDate: scenario.tradingDate,
    });
    // Two carried-forward positions in two categories → two per-user wallet ops.
    expect(commit.stats.open_positions_rebased).toBe(2);
    expect(commit.stats.wallet_rebase_ops).toBe(2);

    const funding = scenario.walletFunding;
    const nfoSettlement = scenario.instruments[0].settlement_price; // 130 (> entry 100)
    const mcxSettlement = scenario.instruments[1].settlement_price; // 180 (< entry 200)

    const [nfoUser, mcxUser, flatUser] = await Promise.all([
      User.findById(scenario.users[0]._id).select('wallet').lean(),
      User.findById(scenario.users[1]._id).select('wallet').lean(),
      User.findById(scenario.users[2]._id).select('wallet').lean(),
    ]);

    // NFO long 6 @ entry 100, settled at 130 (ABOVE entry): more margin blocked,
    // so the NSE available balance DECREASES to funding − 6×130.
    expect(nfoUser.wallet.NSE).toBeCloseTo(funding - (6 * nfoSettlement), 2);
    // The user holds no MCX position, so that pool is left untouched.
    expect(nfoUser.wallet.MCX).toBeCloseTo(funding, 2);

    // MCX short 20 @ entry 200, settled at 180: less margin blocked, so the MCX
    // available balance INCREASES to funding − 20×180.
    expect(mcxUser.wallet.MCX).toBeCloseTo(funding - (20 * mcxSettlement), 2);
    expect(mcxUser.wallet.NSE).toBeCloseTo(funding, 2);

    // The flat user (net 0) is fully closed — no carry-forward, no wallet re-base.
    expect(flatUser.wallet.NSE).toBeCloseTo(funding, 2);
    expect(flatUser.wallet.MCX).toBeCloseTo(funding, 2);

    // The wallet re-base is independent of P&L: settled_pnl is credited exactly
    // as before (Requirement 3.4 — P&L never touches the wallet).
    const settled = await User.find({ _id: { $in: scenario.users.map(user => user._id) } })
      .sort({ username: 1 })
      .select('settled_pnl')
      .lean();
    expect(settled.map(user => user.settled_pnl)).toEqual([260, 400, 25]);
  });

  test('post-commit crash recovery finalizes from immutable history without replaying finance', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: true, prefix: 'recovery' });
    const owner = 'integration:crash-owner';
    const run = await createOwnedRun(scenario, owner, '2026-07-31');

    await settlementService._private.commitSettlementTransaction({
      run,
      lockOwner: owner,
      tradingDate: scenario.tradingDate,
    });
    const before = {
      history: await SettlementHistory.countDocuments({}),
      trades: await Trade.countDocuments({}),
      pnls: (await User.find({ _id: { $in: scenario.users.map(user => user._id) } }).sort({ username: 1 }).lean()).map(user => user.settled_pnl),
    };

    await KiteInstrument.updateMany({}, {
      $set: {
        settlement_price: 999,
        settlement_price_date: toIndiaDateOnly('2026-08-03'),
        last_price: 999,
      },
    });
    await SettlementRun.updateOne({ _id: run._id }, { $set: { lease_expires_at: new Date(0) } });
    resetProcessCaches();
    metricsEngine._ltpMap.set(scenario.nfoToken, 999);
    metricsEngine._bidMap.set(scenario.nfoToken, 999);
    metricsEngine._askMap.set(scenario.nfoToken, 999);

    const recovered = await settlementService.recoverIncompleteSettlements({ applySettlementPrices: true });
    expect(recovered.success).toBe(true);
    expect(recovered.recovered).toBe(true);
    expect((await SettlementRun.findById(run._id).lean()).status).toBe('completed');
    expect(await SettlementHistory.countDocuments({})).toBe(before.history);
    expect(await Trade.countDocuments({})).toBe(before.trades);
    expect((await User.find({ _id: { $in: scenario.users.map(user => user._id) } }).sort({ username: 1 }).lean()).map(user => user.settled_pnl)).toEqual(before.pnls);

    expect(metricsEngine.getCachedMetrics(scenario.users[0]._id.toString()).positions[0]).toMatchObject({
      avg_buy_price: 130,
      cmp: 130,
      floating_pnl: 0,
    });
    expect(metricsEngine.getCachedMetrics(scenario.users[1]._id.toString()).positions[0]).toMatchObject({
      avg_sell_price: 180,
      cmp: 180,
      floating_pnl: 0,
    });
  });

  test('recovery cannot absorb a trade created after the immutable Friday cutoff', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'cutoff' });
    await Trade.create({
      user_id: scenario.users[0]._id,
      master_id: scenario.master._id,
      admin_id: scenario.adminId,
      instrument_token: scenario.nfoToken,
      tradingsymbol: 'NIFTY26AUGFUT',
      exchange: 'NFO',
      transaction_type: 'BUY',
      quantity: 1,
      price: 140,
      order_type: 'MARKET',
      status: 'completed',
      executed_at: new Date(scenario.cutoff.getTime() + (2 * 24 * 60 * 60 * 1000)),
      executed_price: 140,
      executed_quantity: 1,
      pnl: 0,
    });
    const owner = 'integration:cutoff';
    const run = await createOwnedRun(scenario, owner, '2026-07-31');

    await expect(settlementService._private.commitSettlementTransaction({
      run,
      lockOwner: owner,
      tradingDate: scenario.tradingDate,
    })).rejects.toMatchObject({ code: 'SETTLEMENT_PERIOD_CONTAMINATED' });
    expect(await SettlementHistory.countDocuments({})).toBe(0);
    expect(await Trade.countDocuments({ settlement_period_key: '2026-07-31' })).toBe(0);
    expect((await User.findById(scenario.users[0]._id).lean()).settled_pnl).toBe(0);
  });

  test('a verified legacy settlement is adopted without replaying financial writes', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacyauto' });
    const legacy = await materializeLegacySettlement(scenario);
    const before = {
      history: await SettlementHistory.find({}).sort({ _id: 1 }).lean(),
      trades: await Trade.find({}).sort({ _id: 1 }).lean(),
      users: await User.find({ _id: { $in: scenario.users.map(user => user._id) } })
        .select('_id credits settled_pnl')
        .sort({ _id: 1 })
        .lean(),
    };

    const result = await settlementService.runSettlement({
      trigger: 'recovery',
      tradingDate: scenario.tradingDate,
      priceDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      refreshPrices: false,
      applySettlementPrices: false,
      waitForCompletion: true,
    });

    expect(result).toMatchObject({
      success: true,
      started: false,
      alreadyCompleted: true,
      periodKey: '2026-07-31',
    });
    const run = await SettlementRun.findOne({ period_key: '2026-07-31' }).lean();
    expect(run).toMatchObject({
      status: 'completed',
      adopted_legacy_history: true,
    });
    expect(run.history_run_id.toString()).toBe(legacy.legacyRunId.toString());
    expect(run.verification).toMatchObject({
      adopted_existing_history: true,
      ledger_integrity_verified: true,
      carry_forward_set_verified: true,
      complete_position_universe_verified: true,
      pending_order_reset_verified: true,
      source_trade_reset_verified: true,
      settled_pnl_verified: true,
      financial_writes_replayed: false,
    });
    expect(await SettlementHistory.find({}).sort({ _id: 1 }).lean()).toEqual(before.history);
    expect(await Trade.find({}).sort({ _id: 1 }).lean()).toEqual(before.trades);
    expect(await User.find({ _id: { $in: scenario.users.map(user => user._id) } })
      .select('_id credits settled_pnl')
      .sort({ _id: 1 })
      .lean()).toEqual(before.users);
    expect(await SettlementHistory.countDocuments({ settlement_run_id: run._id })).toBe(0);
  });

  test('startup reconciles the already-materialized legacy block and releases writers', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacyblocked' });
    const legacy = await materializeLegacySettlement(scenario);
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: scenario.tradingDate,
      trade_cutoff_at: scenario.cutoff,
      price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 0,
      started_at: legacy.settlementAt,
      failed_at: new Date(),
      error: 'legacy financial writes are not transactionally reconcilable',
      adopted_legacy_history: true,
      stats: { legacy_settlement_run_id: legacy.legacyRunId.toString() },
    });

    await expect(tradeWriteFenceService.beginTradeWrite('before_legacy_reconciliation')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
    });
    const recovered = await settlementService.recoverIncompleteSettlements({
      now: new Date('2026-08-03T04:30:00.000Z'),
      applySettlementPrices: false,
    });
    expect(recovered).toMatchObject({
      success: true,
      recovered: true,
      completed: true,
      adoptedLegacy: true,
      runId: blocked._id.toString(),
    });
    expect(await SettlementRun.findById(blocked._id).lean()).toMatchObject({
      status: 'completed',
      adopted_legacy_history: true,
    });

    const lease = await tradeWriteFenceService.beginTradeWrite('after_legacy_reconciliation');
    await lease.release();
  });

  test('legacy reconciliation stays blocked when an expected carry-forward is missing', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacyinvalid' });
    const legacy = await materializeLegacySettlement(scenario);
    await Trade.deleteOne({
      user_id: scenario.users[0]._id,
      instrument_token: scenario.nfoToken,
      status: 'completed',
      deleted_at: null,
    });
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: scenario.tradingDate,
      trade_cutoff_at: scenario.cutoff,
      price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 0,
      started_at: legacy.settlementAt,
      error: 'legacy reconciliation pending',
      adopted_legacy_history: true,
      stats: { legacy_settlement_run_id: legacy.legacyRunId.toString() },
    });

    const recovered = await settlementService.recoverIncompleteSettlements({
      now: new Date('2026-08-03T04:30:00.000Z'),
      applySettlementPrices: false,
    });
    expect(recovered).toMatchObject({
      success: false,
      recovered: false,
      blocked: true,
      runId: blocked._id.toString(),
    });
    const stillBlocked = await SettlementRun.findById(blocked._id).lean();
    expect(stillBlocked.status).toBe('blocked');
    expect(stillBlocked.verification.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'legacy_carry_forward_mismatch' }),
    ]));
    await expect(tradeWriteFenceService.beginTradeWrite('invalid_legacy_writer')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
    });
  });

  test('legacy reconciliation stays blocked when cumulative settled P&L cannot be proven', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacypnl' });
    const legacy = await materializeLegacySettlement(scenario, { applySettledPnl: false });
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: scenario.tradingDate,
      trade_cutoff_at: scenario.cutoff,
      price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 0,
      started_at: legacy.settlementAt,
      error: 'legacy reconciliation pending',
      adopted_legacy_history: true,
      history_run_id: legacy.legacyRunId,
    });

    const recovered = await settlementService.recoverIncompleteSettlements({
      now: new Date('2026-08-03T04:30:00.000Z'),
      applySettlementPrices: false,
    });

    expect(recovered).toMatchObject({ success: false, recovered: false, blocked: true });
    const stillBlocked = await SettlementRun.findById(blocked._id).lean();
    expect(stillBlocked.status).toBe('blocked');
    expect(stillBlocked.verification.settled_pnl_verified).toBe(false);
    expect(stillBlocked.verification.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'legacy_settled_pnl_mismatch', count: 2 }),
    ]));
  });

  test('legacy reconciliation stays blocked for a pre-settlement position omitted from history', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacyomitted' });
    const legacy = await materializeLegacySettlement(scenario);
    await Trade.create({
      user_id: scenario.users[0]._id,
      master_id: scenario.master._id,
      admin_id: scenario.adminId,
      instrument_token: 'legacy-unsettled-token',
      tradingsymbol: 'EXPIRED26MAYFUT',
      exchange: 'NFO',
      transaction_type: 'BUY',
      quantity: 1,
      price: 100,
      order_type: 'MARKET',
      status: 'completed',
      executed_at: new Date(legacy.settlementAt.getTime() - 2000),
      executed_price: 100,
      executed_quantity: 1,
      pnl: 0,
      createdAt: new Date(legacy.settlementAt.getTime() - 3000),
    });
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: scenario.tradingDate,
      trade_cutoff_at: scenario.cutoff,
      price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 0,
      started_at: legacy.settlementAt,
      error: 'legacy reconciliation pending',
      adopted_legacy_history: true,
      history_run_id: legacy.legacyRunId,
    });

    const recovered = await settlementService.recoverIncompleteSettlements({
      now: new Date('2026-08-03T04:30:00.000Z'),
      applySettlementPrices: false,
    });

    expect(recovered).toMatchObject({ success: false, recovered: false, blocked: true });
    const stillBlocked = await SettlementRun.findById(blocked._id).lean();
    expect(stillBlocked.status).toBe('blocked');
    expect(stillBlocked.verification.complete_position_universe_verified).toBe(false);
    expect(stillBlocked.verification.legacy_exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tradingsymbol: 'EXPIRED26MAYFUT' }),
    ]));
    expect(stillBlocked.verification.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'legacy_unsettled_positions', count: 1 }),
    ]));
  });

  test('legacy reconciliation releases its coordinator claim and owned fence after an unexpected audit failure', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'legacyretry' });
    const legacy = await materializeLegacySettlement(scenario);
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: scenario.tradingDate,
      trade_cutoff_at: scenario.cutoff,
      price_dates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 0,
      started_at: legacy.settlementAt,
      error: 'legacy reconciliation pending',
      adopted_legacy_history: true,
      history_run_id: legacy.legacyRunId,
    });
    await SettlementFence.create({
      _id: 'global',
      lock_owner: 'another-settlement-worker',
      locked_until: new Date(Date.now() + (5 * 60 * 1000)),
    });
    const failureStartedAt = Date.now();

    await expect(settlementService._private.reconcileBlockedLegacySettlement(blocked, {
      now: new Date('2026-08-03T04:30:00.000Z'),
      applySettlementPrices: false,
    })).rejects.toMatchObject({ code: 'SETTLEMENT_IN_PROGRESS' });

    const released = await SettlementRun.findById(blocked._id).lean();
    expect(released.status).toBe('blocked');
    expect(released.lock_owner).toBeNull();
    expect(released.lease_expires_at.getTime()).toBeGreaterThanOrEqual(failureStartedAt);
    expect(released.error).toContain('reconciliation failed unexpectedly');
    expect(await SettlementFence.countDocuments({ lock_owner: 'another-settlement-worker' })).toBe(1);
  });

  test('a blocked earlier period fences writers and prevents creation of a later period', async () => {
    const blockedDate = toIndiaDateOnly('2026-07-31');
    const blocked = await SettlementRun.create({
      period_key: '2026-07-31',
      trading_date: blockedDate,
      trade_cutoff_at: indiaDayRangeUtc(blockedDate).end,
      price_dates: { nse: blockedDate, mcx: blockedDate },
      status: 'blocked',
      trigger: 'recovery',
      attempts: 1,
      error: 'manual reconciliation required',
    });

    await expect(tradeWriteFenceService.beginTradeWrite('blocked_period_writer')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
      status: 423,
    });

    const laterDate = toIndiaDateOnly('2026-08-07');
    const later = await settlementService.runSettlement({
      tradingDate: laterDate,
      priceDates: { nse: laterDate, mcx: laterDate },
      refreshPrices: false,
      waitForCompletion: true,
    });
    expect(later).toMatchObject({ success: false, started: false, runId: blocked._id.toString() });
    expect(later.message).toContain('earlier period 2026-07-31 (blocked)');
    expect(await SettlementRun.countDocuments({ period_key: '2026-08-07' })).toBe(0);

    const recovery = await settlementService.recoverIncompleteSettlements({
      ensureCurrentPeriod: true,
      now: new Date('2026-08-08T02:00:00.000Z'),
    });
    expect(recovery).toMatchObject({ success: false, recovered: false, blocked: true });
  });

  test('a lost trade-write lease is observable and fails closed before commit', async () => {
    const lease = await tradeWriteFenceService.beginTradeWrite('integration_lease_loss');
    await TradeWriteLease.deleteOne({ _id: lease.id });
    await expect(lease.assertActive()).rejects.toMatchObject({
      code: 'TRADE_WRITE_LEASE_LOST',
      status: 409,
    });
    await lease.release();
  });

  test('settlement lease claiming waits for an externally expired writer transaction to commit', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'externalclaim' });
    const lease = await tradeWriteFenceService.beginTradeWrite('external_claim_writer');
    const session = await mongoose.startSession();
    let releaseWriter;
    let markStaged;
    const staged = new Promise(resolve => { markStaged = resolve; });
    const writerGate = new Promise(resolve => { releaseWriter = resolve; });
    let fence = null;

    try {
      await TradeWriteLease.updateOne(
        { _id: lease.id },
        { $set: { expires_at: new Date(Date.now() + 1000) } }
      );

      const writer = session.withTransaction(async () => {
        await lease.assertActive({ session });
        await Trade.create([{
          user_id: scenario.users[0]._id,
          master_id: scenario.master._id,
          admin_id: scenario.adminId,
          instrument_token: scenario.nfoToken,
          tradingsymbol: 'NIFTY26AUGFUT',
          exchange: 'NFO',
          transaction_type: 'BUY',
          quantity: 1,
          price: 125,
          order_type: 'MARKET',
          placed_by: 'SYSTEM',
          trade_type: 'margin_square_off',
          status: 'completed',
          executed_at: new Date(),
          executed_price: 125,
          executed_quantity: 1,
          pnl: 0,
          remarks: 'integration external lease claim',
        }], { session });
        markStaged();
        await writerGate;
        await lease.assertActive({ session });
      });

      await staged;
      await new Promise(resolve => setTimeout(resolve, 1100));
      let fenceAcquired = false;
      const pendingFence = tradeWriteFenceService.acquireSettlementFence(
        'integration:external-claim',
        { drainTimeoutMs: 3000 }
      ).then(result => {
        fenceAcquired = true;
        return result;
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(fenceAcquired).toBe(false);
      releaseWriter();
      await writer;
      fence = await pendingFence;
      expect(fenceAcquired).toBe(true);
      expect(await Trade.countDocuments({ remarks: 'integration external lease claim' })).toBe(1);
    } finally {
      releaseWriter?.();
      await session.endSession().catch(() => {});
      await fence?.release();
      await lease.release();
    }
  });

  test('intraday square-off releases its renewable lease when Mongo session setup fails', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'sessionfail' });
    const { _squareOffUserSegments } = require('../src/controllers/masterUserController');
    await expect(_squareOffUserSegments(
      scenario.users[0]._id.toString(),
      ['NFO-FUT'],
      { startSession: async () => { throw new Error('injected session setup failure'); } }
    )).rejects.toThrow('injected session setup failure');
    expect(await TradeWriteLease.countDocuments({})).toBe(0);
  });

  test('Monday startup materializes and completes the latest due Friday before writes', async () => {
    await seedScenario({ includeFlat: false, includePending: false, prefix: 'monday' });
    const result = await settlementService.recoverIncompleteSettlements({
      ensureCurrentPeriod: true,
      now: new Date('2026-08-03T04:30:00.000Z'),
      refreshPrices: false,
      applySettlementPrices: false,
      calendarOptions: { nseHolidays: new Set(), mcxHolidays: new Set() },
    });

    expect(result).toMatchObject({
      success: true,
      recovered: true,
      ensuredCurrentPeriod: true,
      periodKey: '2026-07-31',
    });
    expect(await SettlementRun.countDocuments({ period_key: '2026-07-31', status: 'completed' })).toBe(1);
    expect(await SettlementRun.countDocuments({ period_key: '2026-08-03' })).toBe(0);
  });

  test('weekday worker generation sync rebuilds ATP without replaying settlement over live CMP', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'weekday' });
    const settled = await settlementService.runSettlement({
      tradingDate: scenario.tradingDate,
      priceDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
      refreshPrices: false,
      applySettlementPrices: true,
      waitForCompletion: true,
    });
    expect(settled.success).toBe(true);

    metricsEngine._ltpMap.set(scenario.nfoToken, 999);
    metricsEngine._bidMap.set(scenario.nfoToken, 999);
    metricsEngine._askMap.set(scenario.nfoToken, 999);
    livePriceService.latestPrices.set(scenario.nfoToken, 999);
    metricsEngine._appliedSettlementRunId = null;

    const synchronized = await metricsEngine.synchronizeSettlementGeneration({
      force: true,
      broadcast: false,
      now: new Date('2026-08-03T04:30:00.000Z'),
    });
    expect(synchronized).toMatchObject({ changed: true, pricesApplied: false });
    expect(metricsEngine._ltpMap.get(scenario.nfoToken)).toBe(999);
    expect(metricsEngine._bidMap.get(scenario.nfoToken)).toBe(999);
    expect(livePriceService.latestPrices.get(scenario.nfoToken)).toBe(999);
    expect(livePriceService._settlementPrices.size).toBe(0);

    const position = metricsEngine.getCachedMetrics(scenario.users[0]._id.toString()).positions[0];
    expect(position.avg_buy_price).toBe(130);
    expect(position.cmp).toBe(999);
    expect(position.floating_pnl).toBe((999 - 130) * 6);
  });

  test('calendar failure creates a durable writer fence and recovery re-resolves exact price dates', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'calendar' });
    await Promise.all([
      KiteInstrument.updateOne({ instrument_token: scenario.nfoToken }, { $set: { last_price: 777 } }),
      KiteInstrument.updateOne({ instrument_token: scenario.mcxToken }, { $set: { last_price: 888 } }),
    ]);
    const failed = await settlementService._private.materializeCalendarFailure({
      tradingDate: scenario.tradingDate,
      trigger: 'recovery',
      error: new Error('injected exchange-calendar outage'),
    });

    expect(failed).toMatchObject({ success: false, started: true, periodKey: '2026-07-31' });
    const failedRun = await SettlementRun.findById(failed.runId).lean();
    expect(failedRun).toMatchObject({
      status: 'failed',
      price_dates_resolved: false,
    });
    expect(failedRun.error).toContain('injected exchange-calendar outage');
    await expect(tradeWriteFenceService.beginTradeWrite('calendar_failure_writer')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
      status: 423,
    });

    const recovered = await settlementService.recoverIncompleteSettlements({
      now: new Date('2026-08-03T04:30:00.000Z'),
      refreshPrices: false,
      applySettlementPrices: false,
      calendarOptions: { nseHolidays: new Set(), mcxHolidays: new Set() },
    });
    expect(recovered).toMatchObject({
      success: true,
      recovered: true,
      completed: true,
      periodKey: '2026-07-31',
    });

    const completedRun = await SettlementRun.findById(failed.runId).lean();
    expect(completedRun).toMatchObject({
      status: 'completed',
      price_dates_resolved: true,
      attempts: 2,
    });
    expect(completedRun.price_dates.nse).toEqual(scenario.tradingDate);
    expect(completedRun.price_dates.mcx).toEqual(scenario.tradingDate);

    const persisted = await KiteInstrument.find({
      instrument_token: { $in: [scenario.nfoToken, scenario.mcxToken] },
    }).sort({ instrument_token: 1 }).lean();
    expect(persisted.map(instrument => instrument.last_price).sort((a, b) => a - b)).toEqual([777, 888]);

    // Simulate a Monday process restart before any genuine market tick. ATP is
    // rebuilt from the durable generation while ordinary CMP comes only from
    // the last genuine live value, never Friday's official settlement field.
    resetProcessCaches();
    const monday = new Date('2026-08-03T04:30:00.000Z');
    await livePriceService._preloadSettlementPrices({ now: monday });
    await metricsEngine.init(livePriceService, { now: monday });
    expect(livePriceService.latestPrices.get(scenario.nfoToken)).toBe(777);
    expect(livePriceService.latestPrices.get(scenario.mcxToken)).toBe(888);
    expect(livePriceService._settlementPrices.size).toBe(0);
    expect(metricsEngine._ltpMap.get(scenario.nfoToken)).toBe(777);
    expect(metricsEngine._bidMap.get(scenario.nfoToken)).toBe(777);
    expect(metricsEngine._askMap.get(scenario.nfoToken)).toBe(777);
    expect(metricsEngine.getCachedMetrics(scenario.users[0]._id.toString()).positions[0]).toMatchObject({
      avg_buy_price: 130,
      cmp: 777,
      floating_pnl: (777 - 130) * 6,
    });
  });

  test('weekday bhavcopy refresh persists official prices without changing live CMP or settlement locks', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'nolive' });
    const nfoLive = 777;
    const mcxLive = 888;
    metricsEngine._ltpMap.set(scenario.nfoToken, nfoLive);
    metricsEngine._bidMap.set(scenario.nfoToken, nfoLive - 1);
    metricsEngine._askMap.set(scenario.nfoToken, nfoLive + 1);
    livePriceService.latestPrices.set(scenario.nfoToken, nfoLive);
    livePriceService.latestPrices.set(scenario.mcxToken, mcxLive);
    livePriceService._settlementPrices.set(scenario.nfoToken, nfoLive);
    livePriceService._settlementPrices.set(scenario.mcxToken, mcxLive);
    const broadcast = jest.spyOn(livePriceService, '_broadcastToClients').mockImplementation(() => {});

    const nseFetcher = async (date, instruments, closePriceMap, options) => {
      expect(options.applyToLivePrices).toBe(false);
      const instrument = instruments.find(item => item.instrument_token === scenario.nfoToken);
      const parsed = new Map([[bhavcopyService._private.buildMatchKey(instrument), {
        open: 129,
        high: 132,
        low: 128,
        close: 130,
        settle_pr: 131,
      }]]);
      const result = bhavcopyService._private.buildNseSettlementOperations(
        date,
        instruments,
        parsed,
        closePriceMap,
        new Date('2026-08-03T04:30:00.000Z')
      );
      await KiteInstrument.bulkWrite(result.bulkOps, { ordered: false });
      return { matched: result.matched, tradingDate: '2026-07-31' };
    };
    const mcxFetcher = async (date, instruments, closePriceMap, options) => {
      expect(options.applyToLivePrices).toBe(false);
      const instrument = instruments.find(item => item.instrument_token === scenario.mcxToken);
      const parsed = new Map([[bhavcopyService._private.buildMatchKey(instrument), {
        open: 179,
        high: 182,
        low: 178,
        close: 180,
        settlementPrice: 181,
      }]]);
      parsed.ambiguousKeys = new Set();
      parsed.priceField = 'SETTLEMENT_PRICE';
      const result = bhavcopyService._private.buildMcxSettlementOperations(
        date,
        instruments,
        parsed,
        closePriceMap,
        new Date('2026-08-03T04:30:00.000Z'),
        { provider: 'MCX', authority: 'official' }
      );
      await KiteInstrument.bulkWrite(result.bulkOps, { ordered: false });
      return { matched: result.matched, tradingDate: '2026-07-31' };
    };

    try {
      const result = await bhavcopyService.fetchAndApplyBhavcopy(undefined, {
        exchangeDates: { nse: scenario.tradingDate, mcx: scenario.tradingDate },
        applyToLivePrices: false,
        _fetchNseBhavcopy: nseFetcher,
        _fetchMcxBhavcopy: mcxFetcher,
      });
      expect(result.closePriceMap).toEqual({
        [scenario.nfoToken]: 131,
        [scenario.mcxToken]: 181,
      });

      const [nfo, mcx] = await Promise.all([
        KiteInstrument.findOne({ instrument_token: scenario.nfoToken }).lean(),
        KiteInstrument.findOne({ instrument_token: scenario.mcxToken }).lean(),
      ]);
      expect(nfo).toMatchObject({ settlement_price: 131, last_price: 111, ohlc_close: 131 });
      expect(mcx).toMatchObject({ settlement_price: 181, last_price: 190, ohlc_close: 181 });
      expect(metricsEngine._ltpMap.get(scenario.nfoToken)).toBe(nfoLive);
      expect(metricsEngine._bidMap.get(scenario.nfoToken)).toBe(nfoLive - 1);
      expect(metricsEngine._askMap.get(scenario.nfoToken)).toBe(nfoLive + 1);
      expect(livePriceService.latestPrices.get(scenario.nfoToken)).toBe(nfoLive);
      expect(livePriceService.latestPrices.get(scenario.mcxToken)).toBe(mcxLive);
      expect(livePriceService._settlementPrices.get(scenario.nfoToken)).toBe(nfoLive);
      expect(livePriceService._settlementPrices.get(scenario.mcxToken)).toBe(mcxLive);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      broadcast.mockRestore();
    }
  });

  test('queue execution rolls back status, balance, and audit log when its transactional lease proof is lost', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: true, prefix: 'queuelease' });
    const beforeUser = await User.findById(scenario.users[0]._id).lean();

    await expect(priceQueueService._private.executeMatchedOrder(
      { id: scenario.pending._id.toString(), side: 'BUY' },
      scenario.pending.price,
      {
        faultInjector: async ({ phase, lease, session }) => {
          if (phase === 'before_final_lease_proof') {
            await TradeWriteLease.deleteOne({ _id: lease.id }, { session });
          }
        },
      }
    )).rejects.toMatchObject({ code: 'TRADE_WRITE_LEASE_LOST', status: 409 });

    expect(await Trade.findById(scenario.pending._id).lean()).toMatchObject({
      status: 'pending',
      executed_quantity: 0,
    });
    expect((await User.findById(scenario.users[0]._id).lean()).equity).toBe(beforeUser.equity);
    expect(await Transaction.countDocuments({ referenceId: scenario.pending._id })).toBe(0);
    expect(await TradeWriteLease.countDocuments({})).toBe(0);
  });

  test('expiry square-off rolls its close trade back when the in-transaction lease proof is lost', async () => {
    const scenario = await seedScenario({ includeFlat: false, includePending: false, prefix: 'expirylease' });
    const now = new Date('2026-08-25T10:00:00.000Z');
    await KiteInstrument.updateOne(
      { instrument_token: scenario.nfoToken },
      { $set: { expiry: now, last_price: 125 } }
    );
    const beforeTradeCount = await Trade.countDocuments({});

    await expect(cronService.autoSquareOffExpiredPositions({
      now,
      faultInjector: async ({ phase, lease, session }) => {
        if (phase === 'before_final_lease_proof') {
          await TradeWriteLease.deleteOne({ _id: lease.id }, { session });
        }
      },
    })).rejects.toMatchObject({ code: 'TRADE_WRITE_LEASE_LOST', status: 409 });

    expect(await Trade.countDocuments({})).toBe(beforeTradeCount);
    expect(await Trade.countDocuments({ trade_type: 'margin_square_off' })).toBe(0);
    expect(await TradeWriteLease.countDocuments({})).toBe(0);
  });

  test('the settlement fence blocks new writers and drains an in-flight writer', async () => {
    const firstLease = await tradeWriteFenceService.beginTradeWrite('integration_in_flight');
    let acquired = false;
    const pendingFence = tradeWriteFenceService.acquireSettlementFence('integration:settlement', { drainTimeoutMs: 3000 })
      .then(fence => {
        acquired = true;
        return fence;
      });

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(acquired).toBe(false);
    await expect(tradeWriteFenceService.beginTradeWrite('integration_blocked')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
      status: 423,
    });

    await firstLease.release();
    const fence = await pendingFence;
    expect(acquired).toBe(true);
    await expect(tradeWriteFenceService.beginTradeWrite('integration_still_blocked')).rejects.toMatchObject({
      code: 'SETTLEMENT_IN_PROGRESS',
      status: 423,
    });
    await fence.release();

    const afterLease = await tradeWriteFenceService.beginTradeWrite('integration_after');
    await afterLease.release();
    expect(await TradeWriteLease.countDocuments({})).toBe(0);
  });
});
