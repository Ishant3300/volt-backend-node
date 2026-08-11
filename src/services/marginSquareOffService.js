/**
 * Tick-driven, transactionally fenced margin square-off service.
 */
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Trade = require('../models/Trade');
const User = require('../models/User');
const { beginTradeWrite } = require('./tradeWriteFenceService');
const walletService = require('./walletService');
const { categoryForSegment } = require('../utils/walletCategory');
const { calculateBrokerage } = require('./brokerageService');

let _livePriceService = null;
// Per-user re-entrancy guard: a user is squared off by at most one path at a time
// (a per-user tick OR the master cascade), never both concurrently.
const _squaringOff = new Set();
// Per-master re-entrancy guard for the master cascade (design §13.1).
const _squaringOffMasters = new Set();

const init = livePriceService => {
  _livePriceService = livePriceService;
  console.log('🛡️  [MarginSquareOff] Service initialized (tick-driven via metricsEngine)');
};

const shutdown = () => {
  console.log('🛡️  [MarginSquareOff] Service shut down');
};

/**
 * Decide whether an OWNER (User OR Master) should be squared off based on their
 * LIVE M2M P&L (design §8). Masters now carry `margin_square_off`,
 * `margin_square_off_percentage` and `credits` (Task 2), so the exact same rule
 * works for both. This replaces the old equity-based logic: after Task 9,
 * `metrics.equity` means "wallet sum", so the trigger is driven by `m2m_pnl`.
 *
 * - Requirement 7: boolean toggle → square off when the live M2M loss reaches
 *   the FULL credit (`m2m ≤ -credit`).
 * - Requirement 8: percentage → square off when the live M2M loss reaches
 *   pct% of credit (`m2m ≤ -(credit × pct/100)`).
 * - Requirement 7.3 / 8.3: toggle OFF and pct 0/unset → no trigger.
 * - Requirement 8.5: both active → whichever crossing is true first triggers.
 *
 * Uses `<=` (not `<`) so the exact boundaries `m2m === -credit` and
 * `m2m === -(credit × pct/100)` TRIGGER (Requirements 7.2 / 8.2).
 */
function shouldSquareOff(owner, metrics, log = false) {
  if (!owner || !metrics) return false;
  const credit = Number(owner.credits || 0);
  const m2m = Number(metrics.m2m_pnl || 0);

  // Requirement 7: boolean toggle → square off when the live M2M loss reaches the full credit.
  if (owner.margin_square_off && m2m <= -credit) {
    if (log) console.log(`🛡️  [MarginSquareOff] ${owner.username}: m2m=₹${m2m.toFixed(2)} ≤ -credit ₹${credit.toFixed(2)} (toggle ON) → square off`);
    return true;
  }

  // Requirement 8: percentage → square off when the live M2M loss reaches pct% of credit.
  const pct = Number(owner.margin_square_off_percentage || 0);
  if (pct > 0 && credit > 0 && m2m <= -(credit * pct / 100)) {
    if (log) console.log(`🛡️  [MarginSquareOff] ${owner.username}: m2m=₹${m2m.toFixed(2)} ≤ -(credit ₹${credit} × ${pct}%) → square off`);
    return true;
  }
  return false;
}

/**
 * Called by metricsEngine after computing metrics for a user. The tick metrics
 * are only a trigger; the fenced path takes a fresh snapshot before writing.
 */
const checkUser = async (userId, metrics) => {
  if (_squaringOff.has(userId)) return;

  try {
    const user = await User.findById(userId)
      .select('margin_square_off margin_square_off_percentage credits master_id server_id username active_status deleted_at')
      .lean();
    if (!user || !user.active_status || user.deleted_at) return;
    if (!user.margin_square_off && !(user.margin_square_off_percentage > 0)) return;
    if (!metrics?.positions?.length || !shouldSquareOff(user, metrics, true)) return;

    _squaringOff.add(userId);
    try {
      await _squareOffAllPositions(user);
    } finally {
      _squaringOff.delete(userId);
    }
  } catch (error) {
    _squaringOff.delete(userId);
    console.error(`🛡️  [MarginSquareOff] Error checking user ${userId}:`, error.message);
  }
};

/**
 * Master cascade square-off (design §13.1, Requirements 7.4 / 8.4). Called by
 * metricsEngine on the master-AGGREGATE metrics path with the master's aggregate
 * live M2M. When the master's own threshold (`shouldSquareOff`, which supports
 * masters per Task 10) is breached, EVERY user in the master's subtree is squared
 * off by running the existing fenced per-user `_squareOffAllPositions` with
 * `force: true` — each user closes because the MASTER breached, not because their
 * own threshold did, and each release goes to that user's own wallet pool.
 *
 * `metrics` is the master aggregate `{ m2m_pnl }`. `masterConfig` carries
 * `{ credits, margin_square_off, margin_square_off_percentage, username,
 * active_status, deleted_at }` (cached in metricsEngine to keep the hot tick path
 * free of extra DB reads). `subtreeUserIds` is every user under the master.
 *
 * Re-entrancy: `_squaringOffMasters` prevents overlapping cascades for the same
 * master; the shared per-user `_squaringOff` set ensures a user already being
 * squared off by their own tick is skipped (never double-squared).
 */
const checkMaster = async (masterId, metrics, masterConfig, subtreeUserIds) => {
  if (!masterId || _squaringOffMasters.has(masterId)) return;
  if (!masterConfig || !masterConfig.active_status || masterConfig.deleted_at) return;
  if (!masterConfig.margin_square_off && !(masterConfig.margin_square_off_percentage > 0)) return;
  if (!Array.isArray(subtreeUserIds) || subtreeUserIds.length === 0) return;
  if (!shouldSquareOff(masterConfig, metrics, true)) return;   // reuse the Task 10 M2M rule (masters supported)

  _squaringOffMasters.add(masterId);
  try {
    console.log(`🛡️  [MarginSquareOff] Master ${masterConfig.username || masterId} aggregate M2M breached → cascading square-off to ${subtreeUserIds.length} user(s)`);
    for (const userId of subtreeUserIds) {
      const uid = userId.toString();
      if (_squaringOff.has(uid)) continue;         // a per-user square-off is already running
      _squaringOff.add(uid);
      try {
        // Invoke via the module object so the forced cascade is observable/mockable.
        await module.exports._squareOffAllPositions({ _id: uid }, { force: true });
      } catch (e) {
        console.error(`🛡️  [MarginSquareOff] Cascade square-off failed for user ${uid}: ${e.message}`);
      } finally {
        _squaringOff.delete(uid);
      }
    }
  } finally {
    _squaringOffMasters.delete(masterId);
  }
};

async function _squareOffAllPositions(triggerUser, options = {}) {
  // `force` bypasses ONLY the per-user `shouldSquareOff` self-guard. It is set by
  // the MASTER cascade (design §13.1): the user must be squared off because the
  // MASTER's aggregate M2M breached, NOT because the user's own threshold did.
  // All other guards (active/deleted/has-positions), the fenced transaction, the
  // wallet release (Task 7), P&L, Transaction and notification stay unchanged.
  const force = options.force === true;
  let lease = null;
  let session = null;
  let positionsSquared = 0;

  try {
    // Acquire before the authoritative metrics and price snapshot. Settlement
    // cannot drain writers and commit while this decision remains in flight.
    lease = await beginTradeWrite('margin_square_off');
    const metricsEngine = require('./metricsEngine');
    const [user, freshMetrics] = await Promise.all([
      User.findById(triggerUser._id)
        .select('margin_square_off margin_square_off_percentage credits master_id server_id username active_status deleted_at')
        .lean(),
      metricsEngine.getFreshMetrics(triggerUser._id.toString()),
    ]);

    if (!user || !user.active_status || user.deleted_at || !freshMetrics?.positions?.length) return 0;
    if (!force && !shouldSquareOff(user, freshMetrics)) return 0;

    const positions = freshMetrics.positions.filter(position => Number(position.net_qty || 0) !== 0);
    if (positions.length === 0) return 0;

    const priceSnapshot = new Map();
    for (const position of positions) {
      priceSnapshot.set(position.instrument_token.toString(), {
        bid: Number(position.bid_price || position.cmp || position.ltp || 0),
        ask: Number(position.ask_price || position.cmp || position.ltp || 0),
        ltp: Number(position.ltp || 0),
      });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await lease.assertActive({ session });
      const freshUser = await User.findById(user._id).session(session);
      if (!freshUser) throw new Error(`Margin square-off user ${user._id} no longer exists`);

      for (const position of positions) {
        const netQty = Number(position.net_qty || 0);
        const closeType = netQty > 0 ? 'SELL' : 'BUY';
        const closeQty = Math.abs(netQty);
        const snapshot = priceSnapshot.get(position.instrument_token.toString()) || {};
        const closePrice = closeType === 'SELL'
          ? Number(snapshot.bid || snapshot.ltp || position.avg_buy_price || 0)
          : Number(snapshot.ask || snapshot.ltp || position.avg_sell_price || 0);
        if (!Number.isFinite(closePrice) || closePrice <= 0) {
          throw new Error(`No valid fenced square-off price for ${position.tradingsymbol}`);
        }

        const pnl = netQty > 0
          ? (closePrice - position.avg_buy_price) * closeQty
          : (position.avg_sell_price - closePrice) * closeQty;
        const newTrade = new Trade({
          user_id: freshUser._id,
          master_id: freshUser.master_id,
          admin_id: freshUser.server_id,
          instrument_token: position.instrument_token,
          tradingsymbol: position.tradingsymbol,
          exchange: position.exchange,
          transaction_type: closeType,
          quantity: closeQty,
          price: closePrice,
          order_type: 'MARKET',
          placed_by: 'SYSTEM',
          trade_type: 'margin_square_off',
          status: 'completed',
          executed_at: new Date(),
          executed_price: closePrice,
          executed_quantity: closeQty,
          pnl,
          brokerage: 0,
          taxes: 0,
          net_amount: pnl,
          remarks: 'MARGIN_SQUARE_OFF',
        });
        
        // Calculate brokerage
        const brokerage = await calculateBrokerage(newTrade, session);
        newTrade.brokerage = brokerage;
        newTrade.net_amount = pnl - brokerage;
        
        await newTrade.save({ session });

        // Requirement 3.2 / 7.5: release the closed position's ENTRY notional
        // back to its category wallet inside this same transaction, so the
        // release commits atomically with the close trade. Entry notional is
        // independent of the exit/close price. The P&L / equity / Transaction
        // logic below is unchanged (this path computes no marginDelta, so there
        // is no equity double-count — this is a purely additive release).
        const avgEntry = netQty > 0 ? position.avg_buy_price : position.avg_sell_price;
        const releaseCategory = categoryForSegment(position.segment || position.exchange || '');
        if (closeQty > 0 && avgEntry > 0) {
          await walletService.release('User', freshUser._id, releaseCategory, closeQty * avgEntry, session);
        }

        const balanceBefore = Number(freshUser.equity || 0);
        const pnlNetBrokerage = pnl - brokerage;
        freshUser.equity = balanceBefore + pnlNetBrokerage;
        const transaction = new Transaction({
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_MSO`,
          userId: freshUser._id,
          userModel: 'User',
          type: closeType,
          status: 'SUCCESS',
          amount: closePrice * closeQty,
          referenceId: newTrade._id,
          referenceModel: 'Trade',
          balanceBefore,
          balanceAfter: freshUser.equity,
          metadata: {
            tradingsymbol: position.tradingsymbol,
            quantity: closeQty,
            executedPrice: closePrice,
            order_type: 'MARKET',
            realisedPnl: pnl,
            brokerage: brokerage,
            reason: 'MARGIN_SQUARE_OFF',
            positionClosed: true,
          },
        });
        await transaction.save({ session });
        positionsSquared++;

        console.log(`🛡️  [MarginSquareOff] Squared off ${position.tradingsymbol}: ${closeType} ${closeQty} @ ₹${closePrice.toFixed(2)}, P&L: ₹${pnl.toFixed(2)}`);
      }

      await lease.assertActive({ session });
      await freshUser.save({ session });
    });

    await metricsEngine.onTradeExecuted(user._id.toString());
    notifySquareOff(user);
    return positionsSquared;
  } catch (error) {
    if (error.code !== 'SETTLEMENT_IN_PROGRESS') {
      console.error(`🛡️  [MarginSquareOff] Failed to square off for ${triggerUser.username}:`, error.message);
    }
    return 0;
  } finally {
    if (session) await session.endSession();
    await lease?.release();
  }
}

function notifySquareOff(user) {
  if (_livePriceService) {
    _livePriceService.broadcastToUser(user._id.toString(), {
      type: 'margin_square_off',
      message: 'Your positions were auto-squared off: live M2M loss reached your square-off threshold.',
    });

    if (_livePriceService.wss) {
      const message = JSON.stringify({
        type: 'trade_executed',
        user_id: user._id.toString(),
        tradingsymbol: 'ALL',
        transaction_type: 'SQUARE_OFF',
        quantity: 0,
        status: 'completed',
        message: `Margin square-off: all positions closed for ${user.username}`,
      });
      _livePriceService.wss.clients.forEach(client => {
        if (client.readyState === 1
          && (client.isAdmin || client.userId === user._id.toString() || client.userId === user.master_id?.toString())) {
          client.send(message);
        }
      });
    }
  }

  try {
    const firebaseService = require('./firebaseService');
    firebaseService.sendNotification(user._id.toString(), 'admin_order_execution', {
      title: 'Margin Square Off',
      body: 'All positions squared off: live M2M loss reached your square-off threshold.',
      data: { reason: 'margin_square_off' },
    });
  } catch (_) {}
}

module.exports = { init, shutdown, checkUser, checkMaster, shouldSquareOff, _squareOffAllPositions };
