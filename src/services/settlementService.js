'use strict';

/**
 * Atomic weekly settlement.
 *
 * Financial writes are committed in one MongoDB transaction. A unique
 * SettlementRun period key and renewable lease coordinate all PM2 workers.
 * Cache rebuilds and WebSocket broadcasts happen after commit and can be
 * retried without repeating ledger, credit, or trade mutations.
 */

const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const SettlementHistory = require('../models/SettlementHistory');
const SettlementRun = require('../models/SettlementRun');
const Trade = require('../models/Trade');
const User = require('../models/User');
const {
  dateKey,
  dateRange,
  getLatestDueSettlementFriday,
  indiaDayRangeUtc,
  isWeekendInIndia,
  onOrBeforeTradingDay,
  toIndiaDateOnly,
} = require('../utils/settlementDates');
const { resolveSettlementPriceDates } = require('./marketCalendarService');
const { acquireSettlementFence } = require('./tradeWriteFenceService');

const LEASE_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MONEY_TOLERANCE = 0.005;
const UNRESOLVED_RUN_STATUSES = ['running', 'committed', 'finalizing', 'failed', 'blocked'];

let _activeExecution = null;
let _settlementState = createIdleState();

function createIdleState() {
  return {
    running: false,
    phase: 'idle',
    total: 0,
    processed: 0,
    currentInstrument: '',
    startedAt: null,
    completedAt: null,
    error: null,
    closedTrades: 0,
    reopenedTrades: 0,
    usersAffected: 0,
    pricesFetched: 0,
    activeTradesInDb: 0,
    periodKey: null,
    settlementRunId: null,
    trigger: null,
  };
}

function getState() {
  return { ..._settlementState };
}

function resetState() {
  _settlementState = createIdleState();
}

async function getStatus() {
  const durableRun = await SettlementRun.findOne({}).sort({ trading_date: -1, createdAt: -1 }).lean();
  if (!durableRun) return getState();

  const durable = {
    id: durableRun._id.toString(),
    period_key: durableRun.period_key,
    trading_date: durableRun.trading_date,
    trade_cutoff_at: durableRun.trade_cutoff_at,
    price_dates: durableRun.price_dates,
    status: durableRun.status,
    trigger: durableRun.trigger,
    attempts: durableRun.attempts,
    started_at: durableRun.started_at,
    committed_at: durableRun.committed_at,
    completed_at: durableRun.completed_at,
    failed_at: durableRun.failed_at,
    error: durableRun.error,
    stats: durableRun.stats || {},
    verification: durableRun.verification || {},
  };

  if (_settlementState.settlementRunId === durable.id) {
    return { ...getState(), durable };
  }

  const stats = durableRun.stats || {};
  const running = ['running', 'committed', 'finalizing'].includes(durableRun.status);
  const total = stats.open_positions || 0;
  return {
    ...createIdleState(),
    running,
    phase: durableRun.status,
    total,
    processed: ['committed', 'finalizing', 'completed'].includes(durableRun.status) ? total : 0,
    startedAt: durableRun.started_at,
    completedAt: durableRun.completed_at,
    error: durableRun.error,
    closedTrades: stats.closed_positions || 0,
    reopenedTrades: stats.reopened_positions || 0,
    usersAffected: stats.users_affected || 0,
    pricesFetched: stats.exact_position_prices || 0,
    activeTradesInDb: stats.active_trades || 0,
    periodKey: durableRun.period_key,
    settlementRunId: durable.id,
    trigger: durableRun.trigger,
    durable,
  };
}

function broadcastProgress() {
  try {
    const livePriceService = require('./livePriceService');
    if (!livePriceService.wss) return;
    const state = getState();
    const percentage = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    const message = JSON.stringify({ type: 'settlement_progress', data: { ...state, percentage } });
    livePriceService.wss.clients.forEach(client => {
      if (client.readyState === 1 && client.isAdmin) client.send(message);
    });
  } catch (_) {
    // Progress publication is best-effort and never controls financial commits.
  }
}

function setPhase(phase, currentInstrument = '') {
  _settlementState.phase = phase;
  _settlementState.currentInstrument = currentInstrument;
  broadcastProgress();
}

function leaseExpiry() {
  return new Date(Date.now() + LEASE_MS);
}

function createLockOwner() {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

function normalizeTradingDate(value) {
  return onOrBeforeTradingDay(toIndiaDateOnly(value));
}

function isLeaseExpired(run, now = new Date()) {
  return !run.lease_expires_at || run.lease_expires_at <= now;
}

function normalizePriceDates(priceDates, tradingDate) {
  const fallback = toIndiaDateOnly(tradingDate);
  return {
    nse: toIndiaDateOnly(priceDates?.nse || fallback),
    mcx: toIndiaDateOnly(priceDates?.mcx || fallback),
  };
}

function settlementHistoryRunId(run) {
  const value = run?.history_run_id || run?.stats?.legacy_settlement_run_id || run?._id;
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function expectedPriceDateForInstrument(run, instrument) {
  if (instrument?.exchange === 'MCX') return run.price_dates?.mcx;
  if (['NFO', 'NSE', 'BFO', 'BSE'].includes(instrument?.exchange)) return run.price_dates?.nse;
  return null;
}

function hasOfficialSettlementAuthority(instrument) {
  const source = String(instrument?.settlement_price_source || '');
  if (instrument?.exchange === 'MCX') return source.startsWith('MCX_OFFICIAL_BHAVCOPY_');
  if (['NFO', 'NSE', 'BFO', 'BSE'].includes(instrument?.exchange)) {
    return source.startsWith('NSE_OFFICIAL_BHAVCOPY_');
  }
  return false;
}

async function inspectLegacySettlement({ historyRunId, periodKey }) {
  const rows = await SettlementHistory.find({ settlement_run_id: historyRunId }).lean();
  const failures = [];
  if (rows.length === 0) {
    return {
      eligible: false,
      stats: { ledger_rows: 0 },
      verification: {
        adopted_existing_history: false,
        legacy_history_run_id: historyRunId.toString(),
        failures: [{ type: 'legacy_history_missing' }],
      },
    };
  }

  const settlementTimes = [...new Set(rows.map(row => new Date(row.settlement_date).getTime()))];
  if (settlementTimes.some(value => !Number.isFinite(value)) || settlementTimes.length !== 1) {
    failures.push({ type: 'legacy_settlement_timestamp_mismatch', count: settlementTimes.length });
  }
  const settlementAt = new Date(Math.max(...settlementTimes.filter(Number.isFinite)));
  const affectedUserIds = [...new Set(rows.map(row => row.user_id.toString()))];
  const ledgerKeys = new Set();
  const expectedCarry = new Map();

  for (const row of rows) {
    const key = `${row.user_id}::${row.instrument_token}`;
    if (ledgerKeys.has(key)) failures.push({ type: 'duplicate_legacy_ledger_position', key });
    ledgerKeys.add(key);

    const netPnl = Number(row.net_pnl);
    const calculatedNetPnl = Number(row.realized_pnl || 0)
      + Number(row.settlement_pnl || 0)
      - Number(row.brokerage || 0);
    if (!Number.isFinite(netPnl) || !Number.isFinite(calculatedNetPnl)
      || Math.abs(netPnl - calculatedNetPnl) >= MONEY_TOLERANCE) {
      failures.push({ type: 'invalid_legacy_ledger_pnl', key });
    }
    if (!Array.isArray(row.fills) || row.fills.length === 0) {
      failures.push({ type: 'legacy_ledger_fills_missing', key });
    }

    const quantity = Number(row.carry_forward_qty || 0);
    if (quantity < 0 || !Number.isFinite(quantity)) {
      failures.push({ type: 'invalid_legacy_carry_forward', key });
      continue;
    }
    if (quantity === 0) continue;

    const price = Number(row.carry_forward_price || row.settlement_price || 0);
    const side = row.carry_forward_side;
    const expectedClosingSide = side === 'BUY' ? 'SELL' : 'BUY';
    if (!['BUY', 'SELL'].includes(side) || price <= 0
      || Math.abs(price - Number(row.settlement_price || 0)) >= MONEY_TOLERANCE
      || Number(row.closing_qty || 0) !== quantity
      || row.closing_side !== expectedClosingSide) {
      failures.push({ type: 'invalid_legacy_carry_forward', key });
      continue;
    }
    expectedCarry.set(key, { quantity, price, side });
  }

  const [activeTrades, preSettlementActiveTrades, stalePendingCount, cumulativeHistory, users] = await Promise.all([
    Trade.find({
      user_id: { $in: affectedUserIds },
      status: 'completed',
      deleted_at: null,
    }).select('_id user_id instrument_token tradingsymbol transaction_type executed_quantity executed_price trade_type createdAt').lean(),
    Trade.find({
      status: 'completed',
      deleted_at: null,
      createdAt: { $lte: settlementAt },
    }).select('_id user_id instrument_token tradingsymbol transaction_type executed_quantity executed_price trade_type createdAt').lean(),
    Trade.countDocuments({
      status: 'pending',
      deleted_at: null,
      createdAt: { $lte: settlementAt },
    }),
    SettlementHistory.find({ user_id: { $in: affectedUserIds } })
      .select('user_id settlement_run_id net_pnl')
      .lean(),
    User.find({ _id: { $in: affectedUserIds }, deleted_at: null })
      .select('_id settled_pnl')
      .lean(),
  ]);

  const activeByKey = new Map();
  for (const trade of activeTrades) {
    const key = `${trade.user_id}::${trade.instrument_token}`;
    if (!activeByKey.has(key)) activeByKey.set(key, []);
    activeByKey.get(key).push(trade);
  }

  const matchedCarryIds = new Set();
  let matchedCarryPositions = 0;
  for (const [key, expected] of expectedCarry) {
    const matching = (activeByKey.get(key) || []).filter(trade =>
      trade.trade_type === 'carry_forward'
      && trade.transaction_type === expected.side
      && Number(trade.executed_quantity) === expected.quantity
      && Math.abs(Number(trade.executed_price) - expected.price) < MONEY_TOLERANCE
      && new Date(trade.createdAt) >= settlementAt
    );
    if (matching.length !== 1) {
      failures.push({ type: 'legacy_carry_forward_mismatch', key, matching_rows: matching.length });
    } else {
      matchedCarryPositions++;
      matchedCarryIds.add(matching[0]._id.toString());
    }
  }

  // The legacy engine wrote the full ledger and all settled-P&L increments
  // before it reset any source trade or created any carry-forward. Looking at
  // every pre-settlement active row (not only ledger users) prevents a partial
  // ledger from defining its own supposedly-complete reconciliation universe.
  const unresolvedLegacyTrades = preSettlementActiveTrades
    .filter(trade => !matchedCarryIds.has(trade._id.toString()));
  const sourceRowsRemaining = unresolvedLegacyTrades.filter(trade =>
    ledgerKeys.has(`${trade.user_id}::${trade.instrument_token}`)
  );
  const legacyExceptions = unresolvedLegacyTrades
    .filter(trade => !ledgerKeys.has(`${trade.user_id}::${trade.instrument_token}`))
    .map(trade => ({
      trade_id: trade._id.toString(),
      user_id: trade.user_id.toString(),
      instrument_token: trade.instrument_token.toString(),
      tradingsymbol: trade.tradingsymbol,
    }));

  if (sourceRowsRemaining.length > 0) {
    failures.push({ type: 'legacy_source_rows_still_active', count: sourceRowsRemaining.length });
  }
  if (legacyExceptions.length > 0) {
    failures.push({ type: 'legacy_unsettled_positions', count: legacyExceptions.length });
  }
  if (stalePendingCount > 0) {
    failures.push({ type: 'legacy_pending_rows_still_active', count: stalePendingCount });
  }

  // settled_pnl is cumulative. Rebuild its independently observable expected
  // value by rounding each immutable settlement run's per-user delta exactly as
  // the legacy writer did, then compare it with the current user record.
  const pnlByUserRun = new Map();
  for (const row of cumulativeHistory) {
    const key = `${row.user_id}::${row.settlement_run_id}`;
    const netPnl = Number(row.net_pnl);
    if (!Number.isFinite(netPnl)) {
      failures.push({ type: 'invalid_cumulative_legacy_pnl', key });
      continue;
    }
    pnlByUserRun.set(key, (pnlByUserRun.get(key) || 0) + netPnl);
  }
  const expectedSettledPnl = new Map(affectedUserIds.map(userId => [userId, 0]));
  for (const [key, delta] of pnlByUserRun) {
    const userId = key.split('::')[0];
    expectedSettledPnl.set(userId, (expectedSettledPnl.get(userId) || 0) + roundMoney(delta));
  }
  const actualSettledPnl = new Map(users.map(user => [user._id.toString(), roundMoney(user.settled_pnl || 0)]));
  const settledPnlMismatches = [];
  for (const userId of affectedUserIds) {
    const expected = roundMoney(expectedSettledPnl.get(userId) || 0);
    const actual = actualSettledPnl.get(userId);
    if (actual === undefined || Math.abs(actual - expected) >= MONEY_TOLERANCE) {
      settledPnlMismatches.push({ user_id: userId, expected, actual: actual ?? null });
    }
  }
  if (settledPnlMismatches.length > 0) {
    failures.push({ type: 'legacy_settled_pnl_mismatch', count: settledPnlMismatches.length });
  }

  const eligible = failures.length === 0;
  return {
    eligible,
    settlementAt,
    stats: {
      ledger_rows: rows.length,
      users_affected: affectedUserIds.length,
      carry_forward_positions: expectedCarry.size,
      matched_carry_forward_positions: matchedCarryPositions,
      stale_pending_orders: stalePendingCount,
      active_source_rows: sourceRowsRemaining.length,
      legacy_exceptions: legacyExceptions.length,
      settled_pnl_mismatches: settledPnlMismatches.length,
      legacy_settlement_run_id: historyRunId.toString(),
    },
    verification: {
      adopted_existing_history: eligible,
      legacy_history_run_id: historyRunId.toString(),
      period_key: periodKey,
      ledger_integrity_verified: !failures.some(item => [
        'duplicate_legacy_ledger_position',
        'invalid_legacy_ledger_pnl',
        'legacy_ledger_fills_missing',
      ].includes(item.type)),
      carry_forward_set_verified: matchedCarryPositions === expectedCarry.size
        && !failures.some(item => item.type === 'invalid_legacy_carry_forward'),
      complete_position_universe_verified: legacyExceptions.length === 0,
      pending_order_reset_verified: stalePendingCount === 0,
      source_trade_reset_verified: sourceRowsRemaining.length === 0,
      settled_pnl_verified: settledPnlMismatches.length === 0,
      financial_writes_replayed: false,
      financial_atomicity: eligible ? 'legacy_observable_state_reconciled' : 'legacy_not_provable',
      manual_review_required: !eligible,
      legacy_exceptions: legacyExceptions,
      settled_pnl_mismatches: settledPnlMismatches,
      failures,
    },
  };
}

async function reconcileBlockedLegacySettlement(run, options = {}) {
  if (run?.status !== 'blocked' || run?.adopted_legacy_history !== true) {
    return null;
  }
  const historyRunId = settlementHistoryRunId(run);
  if (!historyRunId) return null;

  const now = options.now || new Date();
  const lockOwner = createLockOwner();
  const claimed = await SettlementRun.findOneAndUpdate({
    _id: run._id,
    status: 'blocked',
    adopted_legacy_history: true,
    $or: [
      { lock_owner: null },
      { lock_owner: { $exists: false } },
      { lease_expires_at: null },
      { lease_expires_at: { $lte: now } },
    ],
  }, {
    $set: { lock_owner: lockOwner, lease_expires_at: leaseExpiry() },
    $inc: { attempts: 1 },
  }, { new: true }).lean();

  if (!claimed) {
    const current = await SettlementRun.findById(run._id).lean();
    if (current?.status === 'completed') {
      return {
        success: true,
        recovered: true,
        completed: true,
        alreadyCompleted: true,
        periodKey: current.period_key,
        runId: current._id.toString(),
        message: `Legacy settlement ${current.period_key} already adopted`,
      };
    }
    return {
      success: false,
      recovered: false,
      busy: true,
      periodKey: run.period_key,
      runId: run._id.toString(),
      message: `Legacy settlement ${run.period_key} reconciliation is owned by another worker`,
    };
  }

  let fence = null;
  try {
    fence = await acquireSettlementFence(lockOwner);
    const audit = await inspectLegacySettlement({ historyRunId, periodKey: run.period_key });
    if (options.faultInjector) {
      await options.faultInjector({ phase: 'after_legacy_audit', audit, run: claimed });
    }
    if (!audit.eligible) {
      const error = `Legacy settlement ${historyRunId} failed observable-state reconciliation`;
      await SettlementRun.updateOne({ _id: run._id, status: 'blocked', lock_owner: lockOwner }, {
        $set: {
          lock_owner: null,
          lease_expires_at: now,
          failed_at: now,
          error,
          stats: audit.stats,
          verification: audit.verification,
        },
      });
      return {
        success: false,
        recovered: false,
        blocked: true,
        periodKey: run.period_key,
        runId: run._id.toString(),
        message: error,
      };
    }

    const completedAt = new Date();
    const completed = await SettlementRun.updateOne({
      _id: run._id,
      status: 'blocked',
      lock_owner: lockOwner,
      adopted_legacy_history: true,
    }, {
      $set: {
        status: 'completed',
        history_run_id: historyRunId,
        committed_at: audit.settlementAt,
        completed_at: completedAt,
        failed_at: null,
        lock_owner: null,
        lease_expires_at: completedAt,
        error: null,
        stats: audit.stats,
        verification: audit.verification,
      },
    });
    if (completed.matchedCount !== 1) {
      throw new Error(`Legacy settlement ${run.period_key} reconciliation ownership was lost`);
    }

    try {
      const metricsEngine = require('./metricsEngine');
      await metricsEngine.synchronizeSettlementGeneration({
        runId: run._id,
        force: true,
        broadcast: true,
        applyPrices: options.applySettlementPrices ?? isWeekendInIndia(options.now || new Date()),
      });
    } catch (error) {
      // Coordinator adoption is durable; normal generation polling retries cache
      // synchronization without replaying any legacy financial write.
      console.error(`[Settlement] Adopted legacy generation sync failed: ${error.message}`);
    }

    return {
      success: true,
      recovered: true,
      completed: true,
      adoptedLegacy: true,
      periodKey: run.period_key,
      runId: run._id.toString(),
      message: `Legacy settlement ${run.period_key} adopted after observable-state reconciliation`,
      verification: audit.verification,
    };
  } catch (error) {
    // Keep the run fail-closed, but release this worker's coordinator claim so
    // a transient audit/fence failure can be retried safely on the next pass.
    const failedAt = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    await SettlementRun.updateOne({
      _id: run._id,
      status: 'blocked',
      lock_owner: lockOwner,
    }, {
      $set: {
        lock_owner: null,
        lease_expires_at: failedAt,
        failed_at: failedAt,
        error: `Legacy settlement ${run.period_key} reconciliation failed unexpectedly: ${errorMessage}`,
      },
    }).catch(cleanupError => {
      console.error(`[Settlement] Failed to release legacy reconciliation claim: ${cleanupError.message}`);
    });
    throw error;
  } finally {
    await fence?.release().catch(() => {});
  }
}

async function adoptLegacySettlement(periodKey, tradingDate, trigger, priceDates) {
  const { start, end } = indiaDayRangeUtc(tradingDate);
  const legacy = await SettlementHistory.findOne({
    settlement_date: { $gte: start, $lt: new Date(end.getTime() + (7 * 24 * 60 * 60 * 1000)) },
    settlement_period_key: { $in: [null, ''] },
  }).sort({ settlement_date: -1 }).lean();
  if (!legacy) return null;

  const historyRunId = legacy.settlement_run_id;
  const rows = await SettlementHistory.find({ settlement_run_id: historyRunId }).lean();
  const errorMessage = `Legacy settlement ${historyRunId} is awaiting observable-state reconciliation`;
  let run;
  try {
    run = await SettlementRun.create({
      period_key: periodKey,
      trading_date: tradingDate,
      trade_cutoff_at: indiaDayRangeUtc(tradingDate).end,
      price_dates: normalizePriceDates(priceDates, tradingDate),
      status: 'blocked',
      trigger,
      attempts: 0,
      started_at: legacy.settlement_date,
      failed_at: new Date(),
      error: errorMessage,
      adopted_legacy_history: true,
      history_run_id: historyRunId,
      stats: {
        ledger_rows: rows.length,
        users_affected: new Set(rows.map(row => row.user_id.toString())).size,
        legacy_settlement_run_id: historyRunId.toString(),
      },
      verification: {
        adopted_existing_history: false,
        reason: 'observable-state reconciliation pending',
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    run = await SettlementRun.findOne({ period_key: periodKey });
  }

  if (run?.status === 'blocked' && run.adopted_legacy_history === true) {
    await reconcileBlockedLegacySettlement(run, { applySettlementPrices: isWeekendInIndia() });
    return SettlementRun.findById(run._id);
  }
  return run;
}

/** Acquire execution or finalization ownership atomically. */
async function acquireSettlementRun({ tradingDate, priceDates, priceDatesResolved = true, trigger }) {
  const periodKey = dateKey(tradingDate);
  const normalizedPriceDates = normalizePriceDates(priceDates, tradingDate);
  const now = new Date();
  const lockOwner = createLockOwner();

  // Settlement periods are a strict sequence. A blocked/failed/active earlier
  // period must be resolved before a later period can snapshot changing trades.
  const predecessor = await SettlementRun.findOne({
    trading_date: { $lt: tradingDate },
    status: { $in: UNRESOLVED_RUN_STATUSES },
  }).sort({ trading_date: 1, createdAt: 1 }).lean();
  if (predecessor) {
    return {
      acquired: false,
      blocked: predecessor.status === 'blocked',
      busy: predecessor.status !== 'blocked',
      run: predecessor,
      message: `Settlement ${periodKey} cannot start until earlier period ${predecessor.period_key} (${predecessor.status}) is resolved`,
    };
  }

  let existing = await SettlementRun.findOne({ period_key: periodKey });

  if (!existing) {
    const adopted = await adoptLegacySettlement(periodKey, tradingDate, trigger, normalizedPriceDates);
    if (adopted) {
      const completed = adopted.status === 'completed';
      return {
        acquired: false,
        completed,
        blocked: adopted.status === 'blocked',
        run: adopted,
        message: completed
          ? `Settlement ${periodKey} already exists in verified history`
          : adopted.error,
      };
    }

    try {
      const run = await SettlementRun.create({
        period_key: periodKey,
        trading_date: tradingDate,
        trade_cutoff_at: indiaDayRangeUtc(tradingDate).end,
        price_dates: normalizedPriceDates,
        price_dates_resolved: priceDatesResolved,
        status: 'running',
        trigger,
        lock_owner: lockOwner,
        lease_expires_at: leaseExpiry(),
        attempts: 1,
        started_at: now,
        error: null,
      });
      return { acquired: true, action: 'execute', run, lockOwner };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      existing = await SettlementRun.findOne({ period_key: periodKey });
    }
  }

  if (!existing) throw new Error(`Unable to acquire settlement period ${periodKey}`);
  if (existing.status === 'completed') {
    return { acquired: false, completed: true, run: existing, message: `Settlement ${periodKey} already completed` };
  }
  if (existing.status === 'blocked') {
    return { acquired: false, blocked: true, run: existing, message: existing.error || `Settlement ${periodKey} requires manual reconciliation` };
  }

  if (['committed', 'finalizing'].includes(existing.status)) {
    if (!isLeaseExpired(existing, now)) {
      return { acquired: false, busy: true, run: existing, message: `Settlement ${periodKey} is finalizing` };
    }

    const run = await SettlementRun.findOneAndUpdate({
      _id: existing._id,
      status: { $in: ['committed', 'finalizing'] },
      $or: [{ lease_expires_at: { $lte: now } }, { lease_expires_at: null }],
    }, {
      $set: {
        status: 'finalizing',
        trigger: 'recovery',
        lock_owner: lockOwner,
        lease_expires_at: leaseExpiry(),
        error: null,
      },
      $inc: { attempts: 1 },
    }, { new: true });

    if (run) return { acquired: true, action: 'finalize', run, lockOwner };
    return { acquired: false, busy: true, run: existing, message: `Settlement ${periodKey} was claimed by another worker` };
  }

  if (existing.status === 'running' && !isLeaseExpired(existing, now)) {
    return { acquired: false, busy: true, run: existing, message: `Settlement ${periodKey} already in progress` };
  }

  const retryFilter = {
    _id: existing._id,
    $or: [
      { status: 'failed' },
      { status: 'running', lease_expires_at: { $lte: now } },
      { status: 'running', lease_expires_at: null },
    ],
  };
  const run = await SettlementRun.findOneAndUpdate(retryFilter, {
    $set: {
      status: 'running',
      trigger,
      price_dates: normalizedPriceDates,
      price_dates_resolved: priceDatesResolved,
      lock_owner: lockOwner,
      lease_expires_at: leaseExpiry(),
      started_at: now,
      failed_at: null,
      error: null,
    },
    $inc: { attempts: 1 },
  }, { new: true });

  if (run) return { acquired: true, action: 'execute', run, lockOwner };
  return { acquired: false, busy: true, run: existing, message: `Settlement ${periodKey} was claimed by another worker` };
}

function startLeaseHeartbeat(runId, lockOwner) {
  const timer = setInterval(() => {
    SettlementRun.updateOne({
      _id: runId,
      lock_owner: lockOwner,
      status: { $in: ['running', 'committed', 'finalizing'] },
    }, { $set: { lease_expires_at: leaseExpiry() } }).catch(error => {
      console.error(`[Settlement] Lease heartbeat failed: ${error.message}`);
    });
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function materializeCalendarFailure({ tradingDate, trigger, error }) {
  const periodKey = dateKey(tradingDate);
  const fallbackDates = { nse: tradingDate, mcx: tradingDate };
  const acquisition = await acquireSettlementRun({
    tradingDate,
    priceDates: fallbackDates,
    priceDatesResolved: false,
    trigger,
  });

  if (!acquisition.acquired) {
    return {
      success: Boolean(acquisition.completed),
      started: false,
      alreadyCompleted: Boolean(acquisition.completed),
      message: acquisition.message || error.message,
      periodKey,
      runId: acquisition.run?._id?.toString() || null,
    };
  }

  const failedAt = new Date();
  const message = `Settlement calendar unavailable for ${periodKey}: ${error.message}`;
  await SettlementRun.updateOne({
    _id: acquisition.run._id,
    lock_owner: acquisition.lockOwner,
    status: 'running',
  }, {
    $set: {
      status: 'failed',
      failed_at: failedAt,
      lease_expires_at: failedAt,
      price_dates_resolved: false,
      error: message,
    },
  });

  return {
    success: false,
    started: true,
    completed: false,
    message,
    periodKey,
    runId: acquisition.run._id.toString(),
  };
}

async function runSettlement(options = {}) {
  const trigger = options.trigger === 'cron' ? 'cron' : (options.trigger === 'recovery' ? 'recovery' : 'manual');
  let tradingDate;
  let priceDates;
  let priceDatesResolved = true;
  const now = options.now || new Date();

  if (options.tradingDate) {
    tradingDate = normalizeTradingDate(options.tradingDate);
    if (options.priceDates) {
      priceDates = normalizePriceDates(options.priceDates, tradingDate);
    } else {
      try {
        const resolved = await resolveSettlementPriceDates(tradingDate, options.calendarOptions || {});
        priceDates = { nse: resolved.nseDate, mcx: resolved.mcxDate };
      } catch (error) {
        return materializeCalendarFailure({ tradingDate, trigger, error });
      }
    }
  } else {
    // The logical Friday is local and deterministic. Materialize it before any
    // network calendar lookup can fail so startup can never continue unfenced.
    tradingDate = getLatestDueSettlementFriday(now);
    const existing = await SettlementRun.findOne({ period_key: dateKey(tradingDate) })
      .select('price_dates price_dates_resolved')
      .lean();
    if (existing && existing.price_dates_resolved !== false) {
      priceDates = normalizePriceDates(existing.price_dates, tradingDate);
    } else {
      try {
        const resolved = await resolveSettlementPriceDates(tradingDate, options.calendarOptions || {});
        priceDates = { nse: resolved.nseDate, mcx: resolved.mcxDate };
      } catch (error) {
        return materializeCalendarFailure({ tradingDate, trigger, error });
      }
    }
  }

  const acquisition = await acquireSettlementRun({
    tradingDate,
    priceDates,
    priceDatesResolved,
    trigger,
  });
  if (!acquisition.acquired) {
    const success = Boolean(acquisition.completed);
    return {
      success,
      started: false,
      alreadyCompleted: Boolean(acquisition.completed),
      message: acquisition.message,
      periodKey: dateKey(tradingDate),
      runId: acquisition.run?._id?.toString() || null,
    };
  }

  resetState();
  _settlementState.running = true;
  _settlementState.phase = acquisition.action === 'finalize' ? 'finalizing' : 'starting';
  _settlementState.startedAt = new Date();
  _settlementState.periodKey = acquisition.run.period_key;
  _settlementState.settlementRunId = acquisition.run._id.toString();
  _settlementState.trigger = trigger;
  broadcastProgress();

  const execution = executeOwnedRun({
    ...acquisition,
    tradingDate,
    refreshPrices: options.refreshPrices !== false,
    applySettlementPrices: options.applySettlementPrices ?? isWeekendInIndia(options.now || new Date()),
  });
  _activeExecution = execution;

  if (options.waitForCompletion) {
    try {
      const result = await execution;
      return {
        success: true,
        started: true,
        completed: true,
        message: `Settlement ${acquisition.run.period_key} completed`,
        periodKey: acquisition.run.period_key,
        runId: acquisition.run._id.toString(),
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        started: true,
        completed: false,
        message: error.message,
        periodKey: acquisition.run.period_key,
        runId: acquisition.run._id.toString(),
      };
    }
  }

  execution.catch(error => {
    console.error(`[Settlement] Run ${acquisition.run.period_key} failed: ${error.message}`);
  });
  return {
    success: true,
    started: true,
    message: `Settlement ${acquisition.run.period_key} started`,
    periodKey: acquisition.run.period_key,
    runId: acquisition.run._id.toString(),
  };
}

async function executeOwnedRun(context) {
  const { run, lockOwner, tradingDate, action, refreshPrices, applySettlementPrices } = context;
  let stopHeartbeat = startLeaseHeartbeat(run._id, lockOwner);
  let settlementFence = null;

  try {
    let commitResult = { stats: run.stats || {} };
    if (action === 'execute' && refreshPrices) {
      setPhase('fetching_prices', `Fetching official prices for ${run.period_key}`);
      const { fetchAndApplyBhavcopy } = require('./bhavcopyService');
      const fetched = await fetchAndApplyBhavcopy(undefined, {
        exchangeDates: {
          nse: run.price_dates.nse,
          mcx: run.price_dates.mcx,
        },
        applyToLivePrices: applySettlementPrices,
      });
      _settlementState.pricesFetched = Object.keys(fetched.closePriceMap || {}).length;
      broadcastProgress();
    }

    setPhase('draining_trade_writes', 'Waiting for in-flight trade writes');
    settlementFence = await acquireSettlementFence(lockOwner);

    if (action === 'execute') {
      // SettlementRun participates in the financial transaction. Pause only its
      // heartbeat during that transaction, while the independent fence heartbeat
      // continues to exclude trade writers; resume immediately after commit.
      stopHeartbeat();
      stopHeartbeat = () => {};

      setPhase('processing', 'Validating positions and committing transaction');
      commitResult = await commitSettlementTransaction({ run, lockOwner, tradingDate });
      stopHeartbeat = startLeaseHeartbeat(run._id, lockOwner);
      await SettlementRun.updateOne({
        _id: run._id,
        lock_owner: lockOwner,
        status: 'committed',
      }, {
        $set: { status: 'finalizing', lease_expires_at: leaseExpiry() },
      });

      Object.assign(_settlementState, {
        total: commitResult.stats.open_positions,
        processed: commitResult.stats.open_positions,
        activeTradesInDb: commitResult.stats.active_trades,
        closedTrades: commitResult.stats.closed_positions,
        reopenedTrades: commitResult.stats.reopened_positions,
        usersAffected: commitResult.stats.users_affected,
      });
      broadcastProgress();
    }

    const finalization = await finalizeCommittedRun({ run, lockOwner, applySettlementPrices });
    return { ...commitResult, finalization };
  } catch (error) {
    const current = await SettlementRun.findById(run._id).select('status').lean().catch(() => null);
    const now = new Date();

    if (current && ['committed', 'finalizing'].includes(current.status)) {
      await SettlementRun.updateOne({ _id: run._id, lock_owner: lockOwner }, {
        $set: {
          status: 'committed',
          lease_expires_at: now,
          error: `Post-commit finalization failed: ${error.message}`,
        },
      }).catch(() => {});
    } else {
      const blockedCodes = new Set(['SETTLEMENT_POSITION_INVALID', 'SETTLEMENT_PERIOD_CONTAMINATED']);
      const blocked = blockedCodes.has(error.code);
      await SettlementRun.updateOne({ _id: run._id, lock_owner: lockOwner }, {
        $set: {
          status: blocked ? 'blocked' : 'failed',
          failed_at: now,
          lease_expires_at: now,
          error: error.message,
        },
      }).catch(() => {});
    }

    _settlementState.phase = 'error';
    _settlementState.error = error.message;
    _settlementState.running = false;
    _settlementState.currentInstrument = '';
    broadcastProgress();
    throw error;
  } finally {
    await settlementFence?.release().catch(() => {});
    stopHeartbeat();
    _activeExecution = null;
  }
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function buildPositionGroups(trades) {
  const groups = new Map();

  for (const trade of trades) {
    const token = trade.instrument_token.toString();
    const key = `${trade.user_id.toString()}::${token}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        userId: trade.user_id,
        token,
        first: trade,
        fills: [],
        netQty: 0,
        avgBuy: 0,
        avgSell: 0,
        totalBuyQty: 0,
        totalBuyValue: 0,
        totalSellQty: 0,
        totalSellValue: 0,
      });
    }

    const group = groups.get(key);
    const quantity = Number(trade.executed_quantity || 0);
    const price = Number(trade.executed_price || 0);
    group.fills.push(trade);

    if (trade.transaction_type === 'BUY') {
      const newQty = group.netQty + quantity;
      if (group.netQty >= 0) {
        group.avgBuy = group.netQty > 0
          ? ((group.avgBuy * group.netQty) + (price * quantity)) / newQty
          : price;
      } else if (newQty >= 0) {
        group.avgBuy = newQty > 0 ? price : 0;
      }
      group.netQty = newQty;
      group.totalBuyQty += quantity;
      group.totalBuyValue += quantity * price;
    } else {
      const newQty = group.netQty - quantity;
      if (group.netQty <= 0) {
        const oldAbsQty = Math.abs(group.netQty);
        const newAbsQty = oldAbsQty + quantity;
        group.avgSell = oldAbsQty > 0
          ? ((group.avgSell * oldAbsQty) + (price * quantity)) / newAbsQty
          : price;
      } else if (newQty <= 0) {
        group.avgSell = newQty < 0 ? price : 0;
      }
      group.netQty = newQty;
      group.totalSellQty += quantity;
      group.totalSellValue += quantity * price;
    }

    if (group.netQty === 0) {
      group.avgBuy = 0;
      group.avgSell = 0;
    }
  }

  return [...groups.values()];
}

function findBrokerageRule(rules, instrument) {
  if (!instrument) return null;
  const segment = (instrument.segment || '').toUpperCase();
  const rawName = instrument.raw_name || '';
  let rule = null;
  if (rawName && segment) rule = rules.find(item => item.script_name?.toUpperCase() === rawName.toUpperCase() && item.exchange_name === segment);
  if (!rule && rawName) rule = rules.find(item => item.script_name?.toUpperCase() === rawName.toUpperCase());
  if (!rule && segment) rule = rules.find(item => item.exchange_name === segment && !item.script_name);
  if (!rule && segment) rule = rules.find(item => item.exchange_name === segment.split('-')[0] && !item.script_name);
  return rule;
}

function computeBrokerage(rules, instrument, quantity, price) {
  const rule = findBrokerageRule(rules, instrument);
  if (!rule) return 0;
  if (rule.type === 'TURNOVER WISE') return roundMoney(price * quantity * (rule.brk_value / 10000));
  if (rule.type === 'LOT WISE') {
    const lotSize = instrument?.lot_size || 1;
    return roundMoney((lotSize > 1 ? quantity / lotSize : quantity) * rule.brk_value);
  }
  return 0;
}

function buildDisplayName(instrument, fallback) {
  if (!instrument?.name) return instrument?.display_name || fallback;
  if (!instrument.expiry) return instrument.name;
  const expiry = new Date(instrument.expiry);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][expiry.getUTCMonth()];
  if (instrument.instrument_type === 'FUT') return `${instrument.name} ${expiry.getUTCDate()} ${month} FUT`;
  if (['CE', 'PE'].includes(instrument.instrument_type)) {
    return `${instrument.name} ${instrument.strike || ''} ${instrument.instrument_type} ${expiry.getUTCDate()} ${month}`;
  }
  return `${instrument.name} ${expiry.getUTCDate()} ${month}`;
}

function buildSnapshot({ group, instrument, settlementPrice, settlementPriceDate, run, settlementTime, brokerageRules }) {
  let realizedPnl = 0;
  let brokerage = 0;
  const openingFill = group.fills.find(fill => fill.trade_type === 'carry_forward');
  const fillDocs = group.fills.map(fill => {
    const quantity = Number(fill.executed_quantity || 0);
    const price = Number(fill.executed_price || 0);
    const fillBrokerage = ['carry_forward', 'margin_square_off'].includes(fill.trade_type)
      ? 0
      : computeBrokerage(brokerageRules, instrument, quantity, price);
    realizedPnl += Number(fill.pnl || 0);
    brokerage += fillBrokerage;
    return {
      source_trade_id: fill._id,
      transaction_type: fill.transaction_type,
      executed_quantity: quantity,
      executed_price: price,
      executed_at: fill.executed_at,
      pnl: Number(fill.pnl || 0),
      brokerage: fillBrokerage,
      order_type: fill.order_type || 'MARKET',
      placed_by: fill.placed_by || 'USER',
      trade_type: fill.trade_type || 'regular',
    };
  });

  const absNetQty = Math.abs(group.netQty);
  const isLong = group.netQty > 0;
  const atp = isLong ? group.avgBuy : group.avgSell;
  const settlementPnl = absNetQty > 0
    ? (isLong ? (settlementPrice - atp) * absNetQty : (atp - settlementPrice) * absNetQty)
    : 0;
  const totalPnl = realizedPnl + settlementPnl;
  const first = group.first;

  return {
    settlement_run_id: run._id,
    settlement_period_key: run.period_key,
    settlement_trading_date: run.trading_date,
    settlement_price_date: absNetQty > 0 ? settlementPriceDate : null,
    settlement_price_source: absNetQty > 0 ? instrument?.settlement_price_source || null : null,
    settlement_date: settlementTime,
    period_from: first.executed_at || first.createdAt || settlementTime,
    period_to: settlementTime,
    user_id: first.user_id,
    master_id: first.master_id || null,
    admin_id: first.admin_id || null,
    exchange: first.exchange,
    tradingsymbol: first.tradingsymbol,
    instrument_token: group.token,
    display_name: buildDisplayName(instrument, first.tradingsymbol),
    opening_qty: openingFill ? Number(openingFill.executed_quantity || 0) : 0,
    opening_price: openingFill ? Number(openingFill.executed_price || 0) : 0,
    opening_side: openingFill?.transaction_type || null,
    fills: fillDocs,
    total_buy_qty: group.totalBuyQty,
    total_buy_value: group.totalBuyValue,
    avg_buy_price: group.totalBuyQty > 0 ? group.totalBuyValue / group.totalBuyQty : 0,
    total_sell_qty: group.totalSellQty,
    total_sell_value: group.totalSellValue,
    avg_sell_price: group.totalSellQty > 0 ? group.totalSellValue / group.totalSellQty : 0,
    closing_qty: absNetQty,
    closing_side: absNetQty > 0 ? (isLong ? 'SELL' : 'BUY') : null,
    settlement_price: settlementPrice,
    close_method: 'settlement',
    realized_pnl: realizedPnl,
    settlement_pnl: settlementPnl,
    total_pnl: totalPnl,
    brokerage,
    net_pnl: totalPnl - brokerage,
    carry_forward_qty: absNetQty,
    carry_forward_price: absNetQty > 0 ? settlementPrice : 0,
    carry_forward_side: absNetQty > 0 ? (isLong ? 'BUY' : 'SELL') : null,
  };
}

async function commitSettlementTransaction({ run, lockOwner, tradingDate, faultInjector }) {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      const cutoff = run.trade_cutoff_at ? new Date(run.trade_cutoff_at) : indiaDayRangeUtc(tradingDate).end;
      const laterTrade = await Trade.findOne({
        deleted_at: null,
        $or: [
          { status: 'completed', executed_at: { $gte: cutoff } },
          { status: 'completed', executed_at: null, createdAt: { $gte: cutoff } },
          { status: 'pending', createdAt: { $gte: cutoff } },
        ],
      }).select('_id status createdAt executed_at').session(session).lean();
      if (laterTrade) {
        const error = new Error(`Settlement ${run.period_key} cannot execute after later-period trade ${laterTrade._id}; manual reconciliation is required`);
        error.code = 'SETTLEMENT_PERIOD_CONTAMINATED';
        error.details = { trade_id: laterTrade._id.toString(), cutoff, status: laterTrade.status };
        throw error;
      }

      const activeTrades = await Trade.find({
        status: 'completed',
        deleted_at: null,
        $or: [
          { executed_at: { $lt: cutoff } },
          { executed_at: null, createdAt: { $lt: cutoff } },
        ],
      }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
      const groups = buildPositionGroups(activeTrades);
      const openGroups = groups.filter(group => group.netQty !== 0);
      const tokens = [...new Set(groups.map(group => group.token))];
      const userIds = [...new Set(groups.map(group => group.userId.toString()))];

      // MongoDB does not support parallel operations on one transaction session.
      const instruments = await KiteInstrument.find({ instrument_token: { $in: tokens } })
        .select('instrument_token tradingsymbol display_name name raw_name expiry strike instrument_type exchange segment lot_size settlement_price settlement_price_date settlement_price_source')
        .session(session)
        .lean();
      const brokerageRules = await BrokerageSettings.find({ deleted_at: null }).session(session).lean();
      const settlementUsers = await User.find({ _id: { $in: userIds }, deleted_at: null }).select('_id').session(session).lean();
      const pendingIds = await Trade.find({
        status: 'pending',
        deleted_at: null,
        createdAt: { $lt: cutoff },
      }).select('_id instrument_token transaction_type').session(session).lean();

      const instrumentMap = new Map(instruments.map(instrument => [instrument.instrument_token.toString(), instrument]));
      const existingUserIds = new Set(settlementUsers.map(user => user._id.toString()));
      const priceMap = {};
      const priceDateMap = {};
      const missingPrices = [];
      const invalidPositions = [];
      for (const userId of userIds) {
        if (!existingUserIds.has(userId)) {
          invalidPositions.push({ user_id: userId, reason: 'user missing or deleted' });
        }
      }

      for (const group of openGroups) {
        const instrument = instrumentMap.get(group.token);
        const expectedPriceDate = expectedPriceDateForInstrument(run, instrument);
        if (!instrument) {
          missingPrices.push({ token: group.token, symbol: group.first.tradingsymbol, user_id: group.userId.toString(), reason: 'instrument missing' });
          continue;
        }
        if (!expectedPriceDate) {
          invalidPositions.push({
            token: group.token,
            symbol: group.first.tradingsymbol,
            user_id: group.userId.toString(),
            reason: `official settlement source unsupported for ${instrument.exchange}`,
          });
          continue;
        }

        const { start, end } = dateRange(expectedPriceDate);
        const priceDate = instrument.settlement_price_date ? new Date(instrument.settlement_price_date) : null;
        const hasExactDate = priceDate && priceDate >= start && priceDate < end;
        const hasOfficialAuthority = hasOfficialSettlementAuthority(instrument);
        const price = Number(instrument.settlement_price || 0);
        if (!hasExactDate || !hasOfficialAuthority || price <= 0) {
          missingPrices.push({
            token: group.token,
            symbol: group.first.tradingsymbol,
            user_id: group.userId.toString(),
            expected_date: dateKey(expectedPriceDate),
            reason: !hasExactDate
              ? 'source date mismatch'
              : (!hasOfficialAuthority ? `unofficial source ${instrument.settlement_price_source || 'missing'}` : 'invalid price'),
          });
          continue;
        }
        priceMap[group.token] = price;
        priceDateMap[group.token] = toIndiaDateOnly(expectedPriceDate);
        if (!group.first.master_id) {
          invalidPositions.push({ token: group.token, symbol: group.first.tradingsymbol, user_id: group.userId.toString(), reason: 'master_id missing' });
        }
      }

      if (missingPrices.length > 0) {
        const error = new Error(`Official settlement price missing for ${missingPrices.length} open position(s): ${missingPrices.slice(0, 8).map(item => item.symbol || item.token).join(', ')}`);
        error.code = 'SETTLEMENT_PRICES_NOT_READY';
        error.details = missingPrices;
        throw error;
      }
      if (invalidPositions.length > 0) {
        const error = new Error(`Settlement validation failed for ${invalidPositions.length} position(s): ${invalidPositions.slice(0, 8).map(item => `${item.symbol || item.token || item.user_id} (${item.reason})`).join(', ')}`);
        error.code = 'SETTLEMENT_POSITION_INVALID';
        error.details = invalidPositions;
        throw error;
      }

      const settlementTime = new Date();
      const snapshots = groups.map(group => buildSnapshot({
        group,
        instrument: instrumentMap.get(group.token),
        settlementPrice: group.netQty === 0 ? 0 : priceMap[group.token],
        settlementPriceDate: group.netQty === 0 ? null : priceDateMap[group.token],
        run,
        settlementTime,
        brokerageRules,
      }));

      const creditByUser = new Map();
      for (const snapshot of snapshots) {
        const userId = snapshot.user_id.toString();
        creditByUser.set(userId, (creditByUser.get(userId) || 0) + snapshot.net_pnl);
      }

      const settlementTrades = [];
      for (const group of openGroups) {
        const first = group.first;
        const price = priceMap[group.token];
        const absQty = Math.abs(group.netQty);
        const isLong = group.netQty > 0;
        const atp = isLong ? group.avgBuy : group.avgSell;
        const closingPnl = isLong ? (price - atp) * absQty : (atp - price) * absQty;
        const closeTime = settlementTime;
        const reopenTime = new Date(settlementTime.getTime() + 1);

        settlementTrades.push({
          user_id: first.user_id,
          master_id: first.master_id,
          admin_id: first.admin_id || null,
          settlement_run_id: run._id,
          settlement_period_key: run.period_key,
          instrument_token: group.token,
          tradingsymbol: first.tradingsymbol,
          exchange: first.exchange,
          transaction_type: isLong ? 'SELL' : 'BUY',
          quantity: absQty,
          price,
          order_type: 'MARKET',
          placed_by: 'SYSTEM',
          trade_type: 'carry_forward',
          status: 'completed',
          executed_at: closeTime,
          executed_price: price,
          executed_quantity: absQty,
          pnl: closingPnl,
          deleted_at: closeTime,
          remarks: `Settlement ${run.period_key}: position closed at official price`,
        }, {
          user_id: first.user_id,
          master_id: first.master_id,
          admin_id: first.admin_id || null,
          settlement_run_id: run._id,
          settlement_period_key: run.period_key,
          instrument_token: group.token,
          tradingsymbol: first.tradingsymbol,
          exchange: first.exchange,
          transaction_type: isLong ? 'BUY' : 'SELL',
          quantity: absQty,
          price,
          order_type: 'MARKET',
          placed_by: 'SYSTEM',
          trade_type: 'carry_forward',
          status: 'completed',
          executed_at: reopenTime,
          executed_price: price,
          executed_quantity: absQty,
          pnl: 0,
          remarks: `Settlement ${run.period_key}: carried forward at official price`,
        });
      }

      if (snapshots.length > 0) await SettlementHistory.insertMany(snapshots, { session, ordered: true });

      const userCreditOps = [...creditByUser.entries()]
        .filter(([, delta]) => Math.abs(delta) >= MONEY_TOLERANCE)
        .map(([userId, delta]) => ({
          updateOne: {
            filter: { _id: userId },
            update: { $inc: { settled_pnl: roundMoney(delta) } },
          },
        }));
      if (userCreditOps.length > 0) await User.bulkWrite(userCreditOps, { session, ordered: true });
      if (settlementTrades.length > 0) await Trade.insertMany(settlementTrades, { session, ordered: true });

      const oldTradeIds = activeTrades.map(trade => trade._id);
      if (oldTradeIds.length > 0) {
        await Trade.updateMany({ _id: { $in: oldTradeIds }, status: 'completed', deleted_at: null }, {
          $set: {
            settlement_run_id: run._id,
            settlement_period_key: run.period_key,
            deleted_at: settlementTime,
            remarks: `Settlement ${run.period_key}: week reset`,
          },
        }, { session });
      }

      if (pendingIds.length > 0) {
        await Trade.updateMany({ _id: { $in: pendingIds.map(item => item._id) }, status: 'pending', deleted_at: null }, {
          $set: {
            settlement_run_id: run._id,
            settlement_period_key: run.period_key,
            status: 'cancelled',
            remarks: `Settlement ${run.period_key}: pending order expired`,
          },
        }, { session });
      }

      const usersAffected = new Set(groups.map(group => group.userId.toString()));
      const stats = {
        active_trades: activeTrades.length,
        position_groups: groups.length,
        open_positions: openGroups.length,
        flat_positions: groups.length - openGroups.length,
        ledger_rows: snapshots.length,
        credited_users: userCreditOps.length,
        cancelled_pending_orders: pendingIds.length,
        closed_positions: openGroups.length,
        reopened_positions: openGroups.length,
        users_affected: usersAffected.size,
        exact_position_prices: Object.keys(priceMap).length,
        trade_cutoff_at: cutoff,
        nse_price_date: run.price_dates?.nse,
        mcx_price_date: run.price_dates?.mcx,
      };

      if (faultInjector) await faultInjector({ phase: 'before_run_commit', session, stats });

      const committed = await SettlementRun.updateOne({
        _id: run._id,
        lock_owner: lockOwner,
        status: 'running',
      }, {
        $set: {
          status: 'committed',
          committed_at: settlementTime,
          lease_expires_at: leaseExpiry(),
          error: null,
          stats,
        },
      }, { session });
      if (committed.matchedCount !== 1) throw new Error('Settlement lease was lost before commit');

      result = { stats, positionPriceMap: priceMap };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      maxCommitTimeMS: 60_000,
    });
  } finally {
    await session.endSession();
  }

  if (!result) throw new Error('Settlement transaction ended without a commit result');
  return result;
}

async function loadCommittedSettlementPrices(runOrId, legacyTradingDate) {
  const run = runOrId?._id
    ? runOrId
    : await SettlementRun.findById(runOrId).select('_id trading_date price_dates history_run_id stats').lean();
  if (!run) throw new Error(`Settlement run ${runOrId} not found`);

  // Position prices come from the immutable ledger committed in the same
  // transaction as trade replacement. Instrument rows are only a watchlist
  // supplement and can never override a committed position price.
  const historyRunId = settlementHistoryRunId(run);
  const snapshots = await SettlementHistory.find({
    settlement_run_id: historyRunId,
    carry_forward_qty: { $gt: 0 },
    settlement_price: { $gt: 0 },
  }).select('instrument_token settlement_price').lean();

  const positionPriceMap = {};
  for (const snapshot of snapshots) {
    const token = snapshot.instrument_token.toString();
    const price = Number(snapshot.settlement_price);
    if (positionPriceMap[token] && Math.abs(positionPriceMap[token] - price) >= MONEY_TOLERANCE) {
      throw new Error(`Committed settlement contains conflicting prices for token ${token}`);
    }
    positionPriceMap[token] = price;
  }

  const priceDates = normalizePriceDates(run.price_dates, legacyTradingDate || run.trading_date);
  const nseRange = dateRange(priceDates.nse);
  const mcxRange = dateRange(priceDates.mcx);
  const instruments = await KiteInstrument.find({
    is_active: true,
    deleted_at: null,
    settlement_price: { $gt: 0 },
    $or: [
      { exchange: 'MCX', settlement_price_date: { $gte: mcxRange.start, $lt: mcxRange.end } },
      { exchange: { $ne: 'MCX' }, settlement_price_date: { $gte: nseRange.start, $lt: nseRange.end } },
    ],
  }).select('instrument_token settlement_price').lean();

  const allPriceMap = {};
  for (const instrument of instruments) {
    allPriceMap[instrument.instrument_token.toString()] = Number(instrument.settlement_price);
  }
  Object.assign(allPriceMap, positionPriceMap);
  return { allPriceMap, positionPriceMap };
}

async function verifySettlementInvariants({ run, metricsEngine, enforceSettlementCmp = true }) {
  const snapshots = await SettlementHistory.find({ settlement_run_id: run._id })
    .select('user_id instrument_token carry_forward_qty carry_forward_side carry_forward_price')
    .lean();
  const expectedCarry = snapshots.filter(snapshot => Number(snapshot.carry_forward_qty || 0) > 0);
  const activeTrades = await Trade.find({ status: 'completed', deleted_at: null })
    .select('user_id instrument_token transaction_type executed_price executed_quantity settlement_run_id settlement_period_key')
    .lean();

  const failures = [];
  const expectedMap = new Map();
  for (const snapshot of expectedCarry) {
    const key = `${snapshot.user_id}::${snapshot.instrument_token}`;
    if (expectedMap.has(key)) failures.push({ type: 'duplicate_ledger_position', key });
    expectedMap.set(key, snapshot);
  }

  const activeMap = new Map();
  for (const trade of activeTrades) {
    const key = `${trade.user_id}::${trade.instrument_token}`;
    if (activeMap.has(key)) {
      failures.push({ type: 'duplicate_active_position', key });
      continue;
    }
    activeMap.set(key, trade);
    const expected = expectedMap.get(key);
    if (!expected) {
      failures.push({ type: 'unexpected_active_position', key, trade_id: trade._id.toString() });
      continue;
    }
    if (trade.settlement_run_id?.toString() !== run._id.toString()
      || trade.settlement_period_key !== run.period_key
      || trade.transaction_type !== expected.carry_forward_side
      || Number(trade.executed_quantity) !== Number(expected.carry_forward_qty)
      || Math.abs(Number(trade.executed_price) - Number(expected.carry_forward_price)) >= MONEY_TOLERANCE) {
      failures.push({ type: 'database_carry_forward_mismatch', key });
    }
  }
  for (const key of expectedMap.keys()) {
    if (!activeMap.has(key)) failures.push({ type: 'missing_active_carry_forward', key });
  }

  const affectedUsers = new Set(snapshots.map(snapshot => snapshot.user_id.toString()));
  for (const userId of affectedUsers) {
    const metrics = metricsEngine.getCachedMetrics(userId);
    if (!metrics) {
      failures.push({ type: 'metrics_missing', user_id: userId });
      continue;
    }

    const metricPositions = new Map((metrics.positions || []).map(position => [
      `${userId}::${position.instrument_token}`,
      position,
    ]));
    const expectedForUser = [...expectedMap.entries()].filter(([key]) => key.startsWith(`${userId}::`));

    for (const [key, expected] of expectedForUser) {
      const position = metricPositions.get(key);
      if (!position) {
        failures.push({ type: 'metrics_position_missing', key });
        continue;
      }
      const expectedPrice = roundMoney(Number(expected.carry_forward_price));
      const atp = position.net_qty > 0 ? position.avg_buy_price : position.avg_sell_price;
      const positionIdentityMismatch = Number(position.net_qty) !== (expected.carry_forward_side === 'BUY' ? Number(expected.carry_forward_qty) : -Number(expected.carry_forward_qty))
        || Math.abs(atp - expectedPrice) >= MONEY_TOLERANCE;
      const weekendPriceMismatch = enforceSettlementCmp && (
        Math.abs(position.cmp - expectedPrice) >= MONEY_TOLERANCE
        || Math.abs(position.floating_pnl) >= MONEY_TOLERANCE
      );
      if (positionIdentityMismatch || weekendPriceMismatch) {
        failures.push({
          type: 'metrics_invariant',
          key,
          net_qty: position.net_qty,
          atp,
          cmp: position.cmp,
          floating_pnl: position.floating_pnl,
          expected: expectedPrice,
          settlement_cmp_enforced: enforceSettlementCmp,
        });
      }
    }

    for (const key of metricPositions.keys()) {
      if (!expectedMap.has(key)) failures.push({ type: 'unexpected_metrics_position', key });
    }
  }

  if (failures.length > 0) {
    const error = new Error(`Settlement invariant failed for ${failures.length} check(s)`);
    error.code = 'SETTLEMENT_INVARIANT_FAILED';
    error.details = failures;
    throw error;
  }

  return {
    carry_forward_positions: expectedCarry.length,
    flat_position_groups: snapshots.length - expectedCarry.length,
    users_checked: affectedUsers.size,
    active_position_set_exact: true,
    atp_equals_settlement: true,
    atp_equals_cmp: enforceSettlementCmp ? true : null,
    floating_pnl_zero: enforceSettlementCmp ? true : null,
    cmp_validation: enforceSettlementCmp ? 'official_settlement_price' : 'live_market_price_preserved',
  };
}

async function finalizeCommittedRun({ run, lockOwner, applySettlementPrices = isWeekendInIndia() }) {
  const periodKey = run.period_key;
  setPhase('rebuilding_metrics', 'Applying durable settlement generation');
  const metricsEngine = require('./metricsEngine');
  const { allPriceMap } = await loadCommittedSettlementPrices(run);
  _settlementState.pricesFetched = Object.keys(allPriceMap).length;

  // A generation always rebuilds positions/ATP. Official prices are only locked
  // into CMP during the weekend boundary; a Monday recovery or worker restart
  // must preserve newer live LTP/bid/ask values.
  await metricsEngine.synchronizeSettlementGeneration({
    runId: run._id,
    force: true,
    broadcast: true,
    applyPrices: applySettlementPrices,
  });
  const verification = await verifySettlementInvariants({
    run,
    metricsEngine,
    enforceSettlementCmp: applySettlementPrices,
  });

  if (applySettlementPrices) {
    setPhase('broadcasting_prices', 'Publishing official settlement prices');
  }

  try {
    const orderBookService = require('./orderBookService');
    const redisService = require('./redisService');
    if (redisService.isAvailable()) {
      const cancelled = await Trade.find({
        status: 'cancelled',
        settlement_run_id: run._id,
        settlement_period_key: periodKey,
      }).select('_id instrument_token transaction_type').lean();
      for (const trade of cancelled) {
        try {
          await orderBookService.removeOrder(
            trade._id.toString(),
            trade.instrument_token.toString(),
            trade.transaction_type
          );
        } catch (_) {}
      }
    }
  } catch (_) {
    // Mongo is authoritative; Redis cleanup is repaired by normal order sync.
  }

  const completedAt = new Date();
  const completed = await SettlementRun.updateOne({
    _id: run._id,
    lock_owner: lockOwner,
    status: { $in: ['committed', 'finalizing'] },
  }, {
    $set: {
      status: 'completed',
      completed_at: completedAt,
      lease_expires_at: completedAt,
      error: null,
      verification,
    },
  });
  if (completed.matchedCount !== 1) throw new Error('Settlement lease was lost during finalization');

  _settlementState.phase = 'done';
  _settlementState.processed = _settlementState.total;
  _settlementState.currentInstrument = '';
  _settlementState.completedAt = completedAt;
  _settlementState.running = false;
  _settlementState.error = null;
  broadcastProgress();

  const priceMessage = applySettlementPrices
    ? 'ATP=CMP and floating P&L=0 verified'
    : 'ATP reset verified; live weekday CMP preserved';
  console.log(`[Settlement] Completed ${periodKey}: ${verification.carry_forward_positions} carry-forward position(s), ${priceMessage}.`);
  return {
    prices_broadcast: applySettlementPrices ? Object.keys(allPriceMap).length : 0,
    verification,
  };
}

async function recoverIncompleteSettlements(options = {}) {
  const now = options.now || new Date();
  const run = await SettlementRun.findOne({
    status: { $in: UNRESOLVED_RUN_STATUSES },
  }).sort({ trading_date: 1, createdAt: 1 }).lean();

  if (run) {
    if (run.status === 'blocked') {
      if (run.adopted_legacy_history === true) {
        const reconciled = await reconcileBlockedLegacySettlement(run, {
          now,
          applySettlementPrices: options.applySettlementPrices,
        });
        if (reconciled) return reconciled;
      }
      return {
        success: false,
        recovered: false,
        blocked: true,
        periodKey: run.period_key,
        runId: run._id.toString(),
        message: run.error || `Settlement ${run.period_key} requires audited operator resolution`,
      };
    }

    if (['running', 'committed', 'finalizing'].includes(run.status) && !isLeaseExpired(run, now)) {
      return {
        success: false,
        recovered: false,
        busy: true,
        periodKey: run.period_key,
        runId: run._id.toString(),
        message: `Settlement ${run.period_key} is owned by another worker`,
      };
    }

    const result = await runSettlement({
      trigger: 'recovery',
      tradingDate: run.trading_date,
      priceDates: run.price_dates_resolved === false ? undefined : run.price_dates,
      now,
      waitForCompletion: true,
      refreshPrices: options.refreshPrices !== false && !['committed', 'finalizing'].includes(run.status),
      applySettlementPrices: options.applySettlementPrices,
      calendarOptions: options.calendarOptions,
    });
    return { ...result, recovered: true };
  }

  if (options.ensureCurrentPeriod) {
    const result = await runSettlement({
      trigger: 'recovery',
      now,
      waitForCompletion: true,
      refreshPrices: options.refreshPrices !== false,
      applySettlementPrices: options.applySettlementPrices,
      calendarOptions: options.calendarOptions,
    });
    return { ...result, recovered: Boolean(result.started), ensuredCurrentPeriod: true };
  }

  return { success: true, recovered: false, message: 'No incomplete settlement run' };
}

module.exports = {
  getState,
  getStatus,
  recoverIncompleteSettlements,
  resetState,
  runSettlement,
  _private: {
    acquireSettlementRun,
    adoptLegacySettlement,
    buildPositionGroups,
    commitSettlementTransaction,
    finalizeCommittedRun,
    inspectLegacySettlement,
    loadCommittedSettlementPrices,
    materializeCalendarFailure,
    normalizePriceDates,
    reconcileBlockedLegacySettlement,
    settlementHistoryRunId,
    verifySettlementInvariants,
  },
};
