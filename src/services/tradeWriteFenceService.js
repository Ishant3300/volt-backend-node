'use strict';

const crypto = require('crypto');
const os = require('os');
const SettlementFence = require('../models/SettlementFence');
const SettlementRun = require('../models/SettlementRun');
const TradeWriteLease = require('../models/TradeWriteLease');

const TRADE_LEASE_MS = 2 * 60 * 1000;
const SETTLEMENT_FENCE_MS = 15 * 60 * 1000;
const DRAIN_TIMEOUT_MS = 2 * 60 * 1000;
const DRAIN_POLL_MS = 100;
const UNRESOLVED_RUN_STATUSES = ['running', 'committed', 'finalizing', 'failed', 'blocked'];

function ownerId(label) {
  return `${os.hostname()}:${process.pid}:${label}:${crypto.randomUUID()}`;
}

function settlementInProgressError() {
  const error = new Error('Weekly settlement is unresolved. Trading will resume after settlement completes or an operator resolves the blocked period.');
  error.code = 'SETTLEMENT_IN_PROGRESS';
  error.status = 423;
  return error;
}

function tradeWriteLeaseLostError(label) {
  const error = new Error(`Trade-write lease was lost during ${label}; the write was aborted before commit`);
  error.code = 'TRADE_WRITE_LEASE_LOST';
  error.status = 409;
  return error;
}

async function hasUnresolvedSettlement(now = new Date()) {
  const [lockedFence, durableRun] = await Promise.all([
    SettlementFence.exists({ _id: 'global', locked_until: { $gt: now } }),
    SettlementRun.exists({ status: { $in: UNRESOLVED_RUN_STATUSES } }),
  ]);
  return Boolean(lockedFence || durableRun);
}

async function beginTradeWrite(label = 'trade_write') {
  // Apply the latest durable position generation before any writer takes its
  // snapshot. On weekdays this rebuild never replays old settlement prices.
  const metricsEngine = require('./metricsEngine');
  await metricsEngine.synchronizeSettlementGeneration({ maxAgeMs: 0, broadcast: true });

  if (await hasUnresolvedSettlement()) throw settlementInProgressError();

  const owner = ownerId(label);
  const lease = await TradeWriteLease.create({
    owner,
    label,
    expires_at: new Date(Date.now() + TRADE_LEASE_MS),
  });

  // Close both races: settlement may create its durable run or acquire the
  // exclusive fence between our first check and lease insertion. Any failure
  // during this second check must also remove the inserted lease; otherwise a
  // heartbeat-less row can delay settlement until its TTL expires.
  try {
    if (await hasUnresolvedSettlement()) throw settlementInProgressError();
  } catch (error) {
    await TradeWriteLease.deleteOne({ _id: lease._id, owner }).catch(() => {});
    throw error;
  }

  let released = false;
  let lostError = null;
  let renewalInFlight = false;

  const markLost = error => {
    if (!lostError) {
      lostError = error?.code === 'TRADE_WRITE_LEASE_LOST'
        ? error
        : tradeWriteLeaseLostError(label);
      console.error(`[TradeWriteFence] ${lostError.message}${error?.message ? `: ${error.message}` : ''}`);
    }
  };

  const renew = async () => {
    if (released || lostError) return;
    const now = new Date();
    const result = await TradeWriteLease.updateOne({
      _id: lease._id,
      owner,
      claimed_by: null,
      expires_at: { $gt: now },
    }, {
      $set: { expires_at: new Date(now.getTime() + TRADE_LEASE_MS) },
    });
    if (result.matchedCount !== 1) throw tradeWriteLeaseLostError(label);
  };

  const heartbeat = setInterval(() => {
    if (renewalInFlight || released || lostError) return;
    renewalInFlight = true;
    renew().catch(markLost).finally(() => { renewalInFlight = false; });
  }, 30_000);
  heartbeat.unref?.();

  return {
    id: lease._id,
    owner,
    label,
    async assertActive(options = {}) {
      if (released || lostError) throw lostError || tradeWriteLeaseLostError(label);
      const filter = {
        _id: lease._id,
        owner,
        claimed_by: null,
        expires_at: { $gt: new Date() },
      };

      let active;
      if (options.session) {
        // Touch the lease in the same Mongo transaction as the financial write.
        // TTL deletion/settlement takeover then conflicts with this commit rather
        // than fitting into a check-then-write gap.
        const result = await TradeWriteLease.updateOne(filter, {
          $set: { expires_at: new Date(Date.now() + TRADE_LEASE_MS) },
        }, { session: options.session });
        active = result.matchedCount === 1;
      } else {
        active = Boolean(await TradeWriteLease.exists(filter));
      }

      if (!active) {
        markLost(tradeWriteLeaseLostError(label));
        throw lostError;
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await TradeWriteLease.deleteOne({ _id: lease._id, owner }).catch(() => {});
    },
  };
}

async function withTradeWriteLease(label, operation) {
  const lease = await beginTradeWrite(label);
  try {
    await lease.assertActive();
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

async function acquireSettlementFence(lockOwner, options = {}) {
  const now = new Date();
  const lockedUntil = new Date(Date.now() + SETTLEMENT_FENCE_MS);
  let fence;

  try {
    fence = await SettlementFence.findOneAndUpdate({
      _id: 'global',
      $or: [
        { locked_until: { $lte: now } },
        { locked_until: null },
        { lock_owner: lockOwner },
      ],
    }, {
      $set: { lock_owner: lockOwner, locked_until: lockedUntil },
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (error) {
    if (error?.code === 11000) throw settlementInProgressError();
    throw error;
  }
  if (!fence || fence.lock_owner !== lockOwner) throw settlementInProgressError();

  let released = false;
  const heartbeat = setInterval(() => {
    SettlementFence.updateOne(
      { _id: 'global', lock_owner: lockOwner },
      { $set: { locked_until: new Date(Date.now() + SETTLEMENT_FENCE_MS) } }
    ).then(result => {
      if (result.matchedCount !== 1) console.error('[SettlementFence] Ownership was lost during heartbeat');
    }).catch(error => console.error(`[SettlementFence] Heartbeat failed: ${error.message}`));
  }, 60_000);
  heartbeat.unref?.();

  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    // Keep the global fence closed until stale claimed leases are removed.
    await TradeWriteLease.deleteMany({ claimed_by: lockOwner }).catch(() => {});
    await SettlementFence.deleteOne({ _id: 'global', lock_owner: lockOwner }).catch(() => {});
  };

  const timeoutMs = options.drainTimeoutMs || DRAIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const activeWrites = await TradeWriteLease.countDocuments({
        claimed_by: null,
        expires_at: { $gt: new Date() },
      });
      if (activeWrites === 0) break;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${activeWrites} in-flight trade write(s) to finish`);
      }
      await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
    }

    // Claim every surviving lease, including committed-expired rows. This update
    // writes the same per-writer document touched by assertActive({ session }):
    // it therefore waits for an in-flight writer transaction to commit/abort,
    // or wins first and makes that transaction's lease proof fail. Unrelated
    // writers never contend with each other on a global generation document.
    await TradeWriteLease.updateMany({ claimed_by: null }, {
      $set: { claimed_by: lockOwner, claimed_at: new Date() },
    });
  } catch (error) {
    await release();
    throw error;
  }

  return { release };
}

module.exports = {
  acquireSettlementFence,
  beginTradeWrite,
  settlementInProgressError,
  tradeWriteLeaseLostError,
  withTradeWriteLease,
  _private: { hasUnresolvedSettlement, UNRESOLVED_RUN_STATUSES },
};
