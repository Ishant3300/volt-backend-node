/**
 * Tick-driven, transactionally fenced margin square-off service.
 */
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Trade = require('../models/Trade');
const User = require('../models/User');
const KiteInstrument = require('../models/KiteInstrument');
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
// Tracks users who have already been alerted at 80% threshold — prevents spam.
// Cleared when user recovers below threshold or gets squared off.
const _alertedUsers80 = new Set();
const _alertedUsers90 = new Set();

const MARGIN_ALERT_THRESHOLD_80 = 80;
const MARGIN_ALERT_THRESHOLD_90 = 90;

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
    // ── Read margin config from metricsEngine in-memory cache (NO DB call) ──
    const metricsEngine = require('./metricsEngine');
    const user = metricsEngine.getUserMarginConfig(userId);
    if (!user || !user.active_status) return;
    if (!user.margin_square_off && !(user.margin_square_off_percentage > 0)) return;

    // ── Margin Alert at 80% and 90% — notify user before square-off triggers ──
    const credit = Number(user.credits || 0);
    const m2m = Number(metrics?.m2m_pnl || 0);
    if (credit > 0 && m2m < 0) {
      const lossPercent = Math.abs(m2m) / credit * 100;

      // 90% alert (higher priority — check first)
      if (lossPercent >= MARGIN_ALERT_THRESHOLD_90 && !_alertedUsers90.has(userId)) {
        _alertedUsers90.add(userId);
        try {
          const firebaseService = require('./firebaseService');
          if (firebaseService.isAvailable()) {
            firebaseService.sendNotification(userId, 'margin_alert', {
              title: 'Critical Margin Alert',
              body: `Your losses have reached ${Math.round(lossPercent)}% of your credit (₹${Math.abs(m2m).toFixed(0)} / ₹${credit.toFixed(0)}). Positions will be auto-closed imminently.`,
            });
            console.log(`🚨 [MarginAlert] ${user.username}: loss at ${lossPercent.toFixed(1)}% — 90% CRITICAL notification sent`);
          }
        } catch (alertErr) {
          console.error(`⚠️  [MarginAlert] Failed to send 90% alert for ${user.username}:`, alertErr.message);
        }
      }
      // 80% alert
      else if (lossPercent >= MARGIN_ALERT_THRESHOLD_80 && !_alertedUsers80.has(userId)) {
        _alertedUsers80.add(userId);
        try {
          const firebaseService = require('./firebaseService');
          if (firebaseService.isAvailable()) {
            firebaseService.sendNotification(userId, 'margin_alert', {
              title: 'Margin Alert',
              body: `Warning: Your losses have reached ${Math.round(lossPercent)}% of your credit (₹${Math.abs(m2m).toFixed(0)} / ₹${credit.toFixed(0)}). Positions may be auto-closed soon.`,
            });
            console.log(`⚠️  [MarginAlert] ${user.username}: loss at ${lossPercent.toFixed(1)}% — 80% warning notification sent`);
          }
        } catch (alertErr) {
          console.error(`⚠️  [MarginAlert] Failed to send 80% alert for ${user.username}:`, alertErr.message);
        }
      }

      // Clear flags if user recovers below thresholds
      if (lossPercent < MARGIN_ALERT_THRESHOLD_80) {
        _alertedUsers80.delete(userId);
        _alertedUsers90.delete(userId);
      } else if (lossPercent < MARGIN_ALERT_THRESHOLD_90) {
        _alertedUsers90.delete(userId);
      }
    } else {
      // No loss — clear both alerts
      _alertedUsers80.delete(userId);
      _alertedUsers90.delete(userId);
    }

    if (!metrics?.positions?.length || !shouldSquareOff(user, metrics, true)) return;

    _squaringOff.add(userId);
    try {
      await _squareOffAllPositions({ _id: userId, username: user.username });
      // Clear alert flags after square-off completes
      _alertedUsers80.delete(userId);
      _alertedUsers90.delete(userId);
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

    // `position.bid_price`/`ask_price` are genuinely 0 when no live tick has
    // arrived for that token today (unlike `.ltp`/`.cmp`, which metricsEngine
    // already silently fakes from the position's own average entry price
    // when no live price exists — giving a phantom ZERO floating P&L, not an
    // error). That matters here specifically: a multi-exchange account (e.g.
    // MCX + NSE) can trigger square-off from MCX's real move alone, before
    // NSE has opened for the day — closing the NSE leg at its own average
    // entry price would silently realize it at exactly zero P&L, discarding
    // whatever real unrealized loss/gain it was actually carrying from
    // yesterday's close. Falling back to KiteInstrument's own persisted
    // previous-close fields (ohlc_close / settlement_price — already the
    // codebase's authoritative "official close, kept separate from live
    // last_price" source, used elsewhere for weekend settlement) instead
    // books that leg at a real, meaningful price.
    const noLiveDataTokens = positions
      .filter((p) => !(Number(p.bid_price || 0) > 0) && !(Number(p.ask_price || 0) > 0))
      .map((p) => p.instrument_token);
    const previousCloseByToken = new Map();
    if (noLiveDataTokens.length > 0) {
      const instruments = await KiteInstrument.find(
        { instrument_token: { $in: noLiveDataTokens } },
        'instrument_token ohlc_close settlement_price last_price'
      ).lean();
      for (const inst of instruments) {
        // settlement_price first, not ohlc_close: bhavcopyService.js (MCX/NSE/
        // BSE) writes both together, always identical, but massiveSettlement
        // Service.js (COMEX/GLOBAL, via the Massive API) and giftNiftySettlement
        // Service.js (GiftNifty, scraped from NSEIX) only ever write
        // settlement_price — ohlc_close for those segments is stale or
        // unrelated (confirmed live: GIFT NIFTY's ohlc_close was just mirroring
        // its OWN live last_price, not a real close, while settlement_price
        // held the actual dated NSEIX_OFFICIAL_DAILY_SETTLEMENT value).
        // settlement_price is the one field every segment's own feed keeps
        // reliably current, so it's the safe universal first choice.
        const prevClose = Number(inst.settlement_price || 0) || Number(inst.ohlc_close || 0) || Number(inst.last_price || 0);
        if (prevClose > 0) previousCloseByToken.set(inst.instrument_token.toString(), prevClose);
      }
    }

    const priceSnapshot = new Map();
    for (const position of positions) {
      const tokenStr = position.instrument_token.toString();
      const hasLiveData = Number(position.bid_price || 0) > 0 || Number(position.ask_price || 0) > 0;
      const prevClose = !hasLiveData ? previousCloseByToken.get(tokenStr) : null;
      priceSnapshot.set(tokenStr, {
        bid: Number(prevClose || position.bid_price || position.cmp || position.ltp || 0),
        ask: Number(prevClose || position.ask_price || position.cmp || position.ltp || 0),
        ltp: Number(prevClose || position.ltp || 0),
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

      // Every position is now closed — block further trading until the
      // master/admin explicitly credits this account again (creditUser /
      // creditUserByAdmin clear this). Set inside the same transaction as
      // the closes so a crash between them can't leave positions closed but
      // trading still open.
      freshUser.margin_call_blocked = true;

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
