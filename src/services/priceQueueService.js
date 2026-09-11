/**
 * BullMQ-backed live-price producer and pending-order consumer.
 * Every financial mutation is committed in one Mongo transaction whose lease
 * proof is touched inside that same transaction.
 */
const mongoose = require('mongoose');
const { Queue, Worker } = require('bullmq');
const KiteInstrument = require('../models/KiteInstrument');
const Trade = require('../models/Trade');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { LOG_PRICE_QUEUE, LOG_REDIS_ORDERS } = require('../config/logFlags');
const { beginTradeWrite } = require('./tradeWriteFenceService');
const { calculateMargin } = require('./marginService');
const { calculateBrokerage } = require('./brokerageService');
const walletService = require('./walletService');
const { categoryForSegment } = require('../utils/walletCategory');
const { computeWalletSplit } = require('../utils/walletSplit');
const firebaseService = require('./firebaseService');
const metricsEngine = require('./metricsEngine');
const orderBookService = require('./orderBookService');
const redisService = require('./redisService');

const QUEUE_NAME = 'price-updates';
let queue = null;
let worker = null;
let _jobsProcessed = 0;
let _lastHeartbeat = Date.now();
const HEARTBEAT_INTERVAL_MS = 60000; // Log heartbeat every 60s

const _ts = () => new Date().toISOString();

const publishPriceUpdate = async (instrumentToken, livePrice) => {
  if (!queue) return;
  try {
    const jobId = `price_${instrumentToken}_${Date.now()}`;
    await queue.add('PRICE_UPDATE', {
      instrument_token: instrumentToken,
      live_price: livePrice,
      timestamp: Date.now(),
    }, {
      jobId,
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
    if (LOG_PRICE_QUEUE) console.log(`📤 [PriceQueue] Published: Token ${instrumentToken} @ ${livePrice} (Job: ${jobId})`);
  } catch (error) {
    console.error(`❌ [PriceQueue] publishPriceUpdate error: ${error.message}`);
  }
};

/**
 * Average buy/sell state for the CURRENTLY open position only — resets
 * whenever net quantity crosses or lands on 0, rather than summing every
 * completed trade since last settlement.
 *
 * Bug this fixes: the previous plain aggregate (still used by the wallet
 * release-basis calc a few lines below — same bug, same fix) summed EVERY
 * completed trade for this (user, instrument) since last settlement with no
 * regard for whether the position had been fully closed and reopened in
 * between. An account that round-trips the same contract more than once in
 * a week — completely normal for an active trader — got its average cost
 * silently contaminated by the PRIOR, already-closed round-trip, producing
 * a realised P&L that didn't match either fill actually shown to the user.
 * Confirmed against a real trade: BUY 30 @ 57562.60, SELL 30 @ 57810.00
 * showed P&L +3171.00 — only explainable by an implied avgBuy of 57704.30,
 * meaning at least one other buy fill (not the one shown) was blended in.
 *
 * Handles a same-trade flip (a single fill larger than the current net
 * position, closing it AND opening the opposite side in one row — this
 * platform allows that; order size is only capped at the current position
 * when an admin has disabled the instrument, not in general) by splitting
 * that trade's quantity: whatever closes the old side is discarded along
 * with all of that side's prior history, and only the EXCESS beyond the
 * close seeds the new side's average, at this trade's own price. A plain
 * `netQty === 0` check alone would miss this — quantity can jump straight
 * past zero to the opposite sign in one trade without ever equaling it.
 *
 * A PARTIAL close (order smaller than the open position — net qty changes
 * without crossing/landing on zero) must decrement the closed side's own
 * totals by the qty actually matched, not fold the closing trade into the
 * opposite side's totals and leave the closed side untouched. Left
 * untouched, a further same-side open after the partial close would
 * average against the position's ORIGINAL pre-partial-close qty instead
 * of what's truly still open. Worked example: BUY 50@100, partial SELL 20
 * (still long 30), BUY 30@120 (now long 60) must average to
 * (30*100 + 30*120)/60 = 110, not 107.5 against a phantom 80-qty long.
 */
async function positionStateSinceLastFlat(userId, instrumentToken, session) {
  const trades = await Trade.find({
    user_id: userId,
    instrument_token: instrumentToken,
    status: 'completed',
    deleted_at: null,
  })
    .select('transaction_type executed_quantity executed_price executed_at createdAt')
    .sort({ executed_at: 1, createdAt: 1 })
    .session(session)
    .lean();

  let netQty = 0;
  let totalBuyQty = 0, totalSellQty = 0, totalBuyValue = 0, totalSellValue = 0;
  for (const t of trades) {
    const qty = Number(t.executed_quantity || 0);
    const price = Number(t.executed_price || 0);
    const isBuy = t.transaction_type === 'BUY';
    const prevNetQty = netQty;
    const afterNetQty = prevNetQty + (isBuy ? qty : -qty);
    const isClosing = (isBuy && prevNetQty < 0) || (!isBuy && prevNetQty > 0);

    if (isClosing) {
      const closingQty = Math.min(qty, Math.abs(prevNetQty));
      if (isBuy) {
        // BUY closes/reduces a short — decrement the short side by the qty matched.
        const avgSell = totalSellQty > 0 ? totalSellValue / totalSellQty : 0;
        totalSellQty -= closingQty;
        totalSellValue -= closingQty * avgSell;
      } else {
        // SELL closes/reduces a long — decrement the long side by the qty matched.
        const avgBuy = totalBuyQty > 0 ? totalBuyValue / totalBuyQty : 0;
        totalBuyQty -= closingQty;
        totalBuyValue -= closingQty * avgBuy;
      }

      const excessQty = qty - closingQty;
      if (excessQty > 0) {
        // Same-trade flip — the excess beyond the close opens a fresh
        // position on this trade's own side, at this trade's own price.
        // The closed side is already at zero from the decrement above.
        if (isBuy) { totalBuyQty += excessQty; totalBuyValue += excessQty * price; }
        else { totalSellQty += excessQty; totalSellValue += excessQty * price; }
      }
    } else if (isBuy) {
      totalBuyQty += qty;
      totalBuyValue += qty * price;
    } else {
      totalSellQty += qty;
      totalSellValue += qty * price;
    }

    netQty = afterNetQty;
  }

  return { totalBuyQty, totalSellQty, totalBuyValue, totalSellValue };
}

function realisedPnlFor(trade, state) {
  const netQty = state.totalBuyQty - state.totalSellQty;
  const avgBuy = state.totalBuyQty > 0 ? state.totalBuyValue / state.totalBuyQty : 0;
  const avgSell = state.totalSellQty > 0 ? state.totalSellValue / state.totalSellQty : 0;
  if (trade.transaction_type === 'SELL' && netQty > 0) {
    return (trade.price - avgBuy) * Math.min(trade.quantity, netQty);
  }
  if (trade.transaction_type === 'BUY' && netQty < 0) {
    return (avgSell - trade.price) * Math.min(trade.quantity, Math.abs(netQty));
  }
  return 0;
}

async function executeMatchedOrder(match, livePrice, options = {}) {
  let lease = null;
  let session = null;
  let outcome = { kind: 'unchanged', trade: null };

  try {
    lease = await beginTradeWrite('redis_limit_execution');
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      outcome = { kind: 'unchanged', trade: null };
      await lease.assertActive({ session });
      const trade = await Trade.findById(match.id).session(session);
      if (!trade || trade.status !== 'pending' || trade.deleted_at) return;

      const state = await positionStateSinceLastFlat(trade.user_id, trade.instrument_token, session);
      const previousNetQty = state.totalBuyQty - state.totalSellQty;
      const afterNetQty = trade.transaction_type === 'BUY'
        ? previousNetQty + trade.quantity
        : previousNetQty - trade.quantity;

      // ── Category trade-wallet gate at FILL time (Task 6 / Requirements 3.1,
      //    4.1; design §6.2 / §13.2). Placing the pending order did NOT touch the
      //    wallet — the block/release happens here, when it fills, mirroring
      //    placeTrade. This REPLACES the old free-margin + equity gates.
      //
      //    Category MUST come from the instrument SEGMENT, not `trade.exchange`:
      //    the Trade stores `exchange` (NSE/NFO/MCX/…), which does NOT carry the
      //    segment, so categoryForSegment('NFO')→GLOBAL / ('MCX')→GLOBAL would be
      //    wrong. Resolving from segment maps 'NFO-FUT'→NSE, 'MCX-FUT'→MCX, etc.
      const walletInstrument = await KiteInstrument.findOne({ instrument_token: trade.instrument_token })
        .select('segment enabled deleted_at instrument_type').session(session).lean();
      const walletCategory = categoryForSegment(walletInstrument?.segment || trade.exchange || '');

      const { closingQty: walletClosingQty, openingQty: walletOpeningQty } =
        computeWalletSplit(previousNetQty, trade.transaction_type, trade.quantity);

      // Instrument enabled/deleted gate at FILL time — mirrors placeTrade's
      // placement-time check (tradeController.js). Disabling/deleting an
      // instrument previously only blocked NEW order placement; an already-
      // pending LIMIT/SL order sitting in the book would still fill and open
      // a fresh position once the price crossed, bypassing the admin's
      // intent entirely. Deleted blocks unconditionally (even a close);
      // disabled-only still allows closing/reducing, same as placeTrade.
      const instrumentBlocked = walletInstrument?.deleted_at
        || (walletInstrument?.enabled === false && walletOpeningQty > 0);
      if (instrumentBlocked) {
        const instrumentRejectRemark = walletInstrument?.deleted_at
          ? 'Admin has deactivated this script. Trading is not allowed.'
          : 'This instrument has been disabled by admin. You cannot open new positions on this script.';
        trade.status = 'rejected';
        trade.pnl = 0;
        trade.net_amount = 0;
        trade.remarks = instrumentRejectRemark;
        await trade.save({ session });
        await Trade.create([{
          user_id: trade.user_id,
          master_id: trade.master_id,
          admin_id: trade.admin_id || null,
          instrument_token: trade.instrument_token,
          tradingsymbol: trade.tradingsymbol,
          exchange: trade.exchange,
          transaction_type: trade.transaction_type,
          quantity: trade.quantity,
          price: trade.price,
          order_type: trade.order_type,
          status: 'rejected',
          remarks: instrumentRejectRemark,
        }], { session });
        await lease.assertActive({ session });
        outcome = { kind: 'rejected', trade: trade.toObject(), message: instrumentRejectRemark };
        return;
      }

      // Bet / close-only gate at FILL time — mirrors placeTrade's
      // placement-time checks (tradeController.js). An admin flips bet=false
      // or close_only=true specifically to stop a user opening further risk
      // right now; a LIMIT/SL/SL-M order already pending at that moment
      // would otherwise still fill and open a fresh position, bypassing the
      // admin's intent entirely — same shape as the instrument-blocked gate
      // above. Same rejection shape.
      const gateUser = await User.findById(trade.user_id).select('bet close_only exchanges_allowed margin_call_blocked margin_square_off margin_square_off_percentage credits').session(session).lean();
      const isClosingForCloseOnly = (trade.transaction_type === 'SELL' && previousNetQty > 0)
        || (trade.transaction_type === 'BUY' && previousNetQty < 0);
      const betBlocked = gateUser?.bet === false;
      const closeOnlyBlocked = gateUser?.close_only === true && !isClosingForCloseOnly;

      // Margin-call gate at FILL time — mirrors placeTrade's placement-time
      // checks (tradeController.js). See margin_call_blocked's own comment
      // (models/User.js) and the toggle-OFF live check in tradeController.js
      // for why these are separate from bet/close_only above.
      const marginCallFullyBlocked = gateUser?.margin_call_blocked === true;
      let marginCallLiveBlocked = false;
      if (!marginCallFullyBlocked && !gateUser?.margin_square_off && !(gateUser?.margin_square_off_percentage > 0)) {
        const metricsEngineForMarginCall = require('./metricsEngine');
        const liveMetricsForMarginCall = metricsEngineForMarginCall.getCachedMetrics(trade.user_id.toString());
        const creditForMarginCall = Number(gateUser?.credits || 0);
        marginCallLiveBlocked = !!liveMetricsForMarginCall
          && Number(liveMetricsForMarginCall.m2m_pnl || 0) <= -creditForMarginCall
          && !isClosingForCloseOnly;
      }

      // Exchange-permission gate — mirrors placeTrade's placement-time check.
      // Admin can revoke a segment from exchanges_allowed after a LIMIT/SL/SL-M
      // order is already pending; without re-checking here it would still fill.
      const rawSegmentForAllow = (walletInstrument?.segment || trade.exchange || '').toUpperCase();
      const allowCandidates = new Set([rawSegmentForAllow]);
      if (rawSegmentForAllow === 'GLOBAL') allowCandidates.add('INDICES');
      if (rawSegmentForAllow === 'INDICES') allowCandidates.add('GLOBAL');
      const exchangeBlocked = !(gateUser?.exchanges_allowed || []).some((ex) => {
        const name = (ex.exchange_name || '').toUpperCase();
        const normalized = name === 'INDICES' ? 'GLOBAL' : name;
        return allowCandidates.has(name) || allowCandidates.has(normalized);
      });

      if (betBlocked || closeOnlyBlocked || marginCallFullyBlocked || marginCallLiveBlocked || exchangeBlocked) {
        const userGateRejectRemark = betBlocked
          ? 'Trading is currently disabled for your account.'
          : closeOnlyBlocked
          ? 'Your account is in close-only mode. You can only close existing positions.'
          : marginCallFullyBlocked
          ? 'Trading is blocked: a margin square-off already closed all your positions. Contact your master/admin to add credit and resume.'
          : marginCallLiveBlocked
          ? 'Trading is blocked: your live M2M loss has reached your full credit. You can only close existing positions until your master/admin adds credit.'
          : `Your account is not permitted to trade ${rawSegmentForAllow || 'this instrument'}. Contact your master/admin.`;
        trade.status = 'rejected';
        trade.pnl = 0;
        trade.net_amount = 0;
        trade.remarks = userGateRejectRemark;
        await trade.save({ session });
        await Trade.create([{
          user_id: trade.user_id,
          master_id: trade.master_id,
          admin_id: trade.admin_id || null,
          instrument_token: trade.instrument_token,
          tradingsymbol: trade.tradingsymbol,
          exchange: trade.exchange,
          transaction_type: trade.transaction_type,
          quantity: trade.quantity,
          price: trade.price,
          order_type: trade.order_type,
          status: 'rejected',
          remarks: userGateRejectRemark,
        }], { session });
        await lease.assertActive({ session });
        outcome = { kind: 'rejected', trade: trade.toObject(), message: userGateRejectRemark };
        return;
      }

      // Naked-option-short gate at FILL time — mirrors placeTrade's
      // placement-time check (tradeController.js), which only runs once, at
      // the moment the order is PLACED. A pending SELL LIMIT/SL/SL-M order
      // placed while the user still held the option stays queued even if
      // that position gets closed by some other trade before this one
      // fills — without re-checking here, it fills anyway and opens a fresh
      // naked short the placement-time check exists specifically to
      // prevent. Same rejection shape as the instrument-blocked gate above.
      const isOptionInstrument = ['CE', 'PE'].includes(walletInstrument?.instrument_type);
      const nakedOptionShort = isOptionInstrument
        && trade.transaction_type === 'SELL'
        && previousNetQty <= 0;
      if (nakedOptionShort) {
        const nakedShortRejectRemark = 'Option selling is not allowed. You must own this option before you can sell it.';
        trade.status = 'rejected';
        trade.pnl = 0;
        trade.net_amount = 0;
        trade.remarks = nakedShortRejectRemark;
        await trade.save({ session });
        await Trade.create([{
          user_id: trade.user_id,
          master_id: trade.master_id,
          admin_id: trade.admin_id || null,
          instrument_token: trade.instrument_token,
          tradingsymbol: trade.tradingsymbol,
          exchange: trade.exchange,
          transaction_type: trade.transaction_type,
          quantity: trade.quantity,
          price: trade.price,
          order_type: trade.order_type,
          status: 'rejected',
          remarks: nakedShortRejectRemark,
        }], { session });
        await lease.assertActive({ session });
        outcome = { kind: 'rejected', trade: trade.toObject(), message: nakedShortRejectRemark };
        return;
      }

      const walletAvgBuy = state.totalBuyQty > 0 ? state.totalBuyValue / state.totalBuyQty : 0;
      const walletAvgSell = state.totalSellQty > 0 ? state.totalSellValue / state.totalSellQty : 0;
      // Closed long lots release at avgBuy; closed short lots at avgSell (entry basis).
      const walletReleaseBasis = previousNetQty > 0 ? walletAvgBuy : walletAvgSell;
      const walletReleaseAmount = walletClosingQty * walletReleaseBasis;
      // Limit/SL fills at the limit price: executed_price = trade.price (below).
      const walletOpeningNotional = walletOpeningQty * trade.price;

      // Affordability pre-check. A reversal's release funds the new opening, so
      // add it to the available balance (mirrors release-then-block ordering).
      const walletAvailable = (await walletService.getAvailable('User', trade.user_id, session))[walletCategory];
      const walletEffectiveAvailable = walletAvailable + walletReleaseAmount;
      if (walletOpeningQty > 0 && walletOpeningNotional > walletEffectiveAvailable) {
        const walletShortfall = walletOpeningNotional - walletEffectiveAvailable;
        const walletRejectRemark = `Insufficient ${walletCategory} wallet balance at fill. Required ₹${walletOpeningNotional.toFixed(2)}, available ₹${walletEffectiveAvailable.toFixed(2)} (short ₹${walletShortfall.toFixed(2)}).`;
        trade.status = 'rejected';
        trade.pnl = 0;
        trade.net_amount = 0;
        trade.remarks = walletRejectRemark;
        await trade.save({ session });
        // Rejection-log Trade (same shape as the previous rejection path).
        await Trade.create([{
          user_id: trade.user_id,
          master_id: trade.master_id,
          admin_id: trade.admin_id || null,
          instrument_token: trade.instrument_token,
          tradingsymbol: trade.tradingsymbol,
          exchange: trade.exchange,
          transaction_type: trade.transaction_type,
          quantity: trade.quantity,
          price: trade.price,
          order_type: trade.order_type,
          status: 'rejected',
          remarks: walletRejectRemark,
        }], { session });
        await lease.assertActive({ session });
        outcome = { kind: 'rejected', trade: trade.toObject(), category: walletCategory, shortfall: walletShortfall, message: walletRejectRemark };
        return;
      }

      const realisedPnl = realisedPnlFor(trade, state);
      const brokerage = await calculateBrokerage(trade, session);
      const marginPerUnit = await calculateMargin(trade.exchange, 1, trade.price);
      const previousMargin = Math.abs(previousNetQty) * marginPerUnit;
      const newMargin = Math.abs(afterNetQty) * marginPerUnit;
      // marginDelta is notional (calculateMargin returns |qty|×price since Task 3),
      // computed here for transaction metadata only — NOT subtracted from
      // persisted user.equity below. wallet.block/release above already
      // reserves/frees this exact notional from the wallet balance, so
      // subtracting it again here double-counted the same margin against two
      // balance fields (design D2: persisted equity = credit + realised P&L
      // only, matching placeTrade's fix and marginSquareOffService's
      // no-marginDelta square-off path).
      const marginDelta = newMargin - previousMargin;
      const balanceChange = realisedPnl - brokerage;
      const user = await User.findById(trade.user_id).session(session);
      if (!user) throw new Error(`Pending-order user ${trade.user_id} not found`);
      const currentEquity = Number(user.equity || 0);

      // Gate passed — apply the wallet mutations inside this transaction. Release
      // the closed portion's entry notional first, then block the opened portion.
      // block() is the atomic never-negative backstop; the pre-check above means
      // it normally succeeds, but if a concurrent race makes it throw
      // INSUFFICIENT_WALLET we let it propagate so the transaction aborts and the
      // order stays pending to retry on the next tick (never silently completed).
      if (walletClosingQty > 0 && walletReleaseBasis > 0) {
        await walletService.release('User', trade.user_id, walletCategory, walletReleaseAmount, session);
      }
      if (walletOpeningQty > 0) {
        await walletService.block('User', trade.user_id, walletCategory, walletOpeningNotional, session);
      }

      trade.status = 'completed';
      trade.executed_at = new Date();
      trade.executed_price = trade.price;
      trade.executed_quantity = trade.quantity;
      trade.pnl = realisedPnl;
      trade.brokerage = brokerage;
      trade.net_amount = realisedPnl - brokerage;
      await trade.save({ session });

      const balanceBefore = currentEquity;
      user.equity = currentEquity + balanceChange;
      await user.save({ session });
      const transaction = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_RQ`,
        userId: trade.user_id,
        userModel: 'User',
        type: trade.transaction_type,
        status: 'SUCCESS',
        amount: trade.price * trade.quantity,
        referenceId: trade._id,
        referenceModel: 'Trade',
        balanceBefore,
        balanceAfter: user.equity,
        metadata: {
          tradingsymbol: trade.tradingsymbol,
          quantity: trade.quantity,
          executedPrice: trade.price,
          livePrice,
          realisedPnl,
          brokerage,
          marginDelta,
          balanceChange,
          positionClosed: realisedPnl !== 0,
          order_type: trade.order_type,
          executedBy: 'redis_queue_engine',
        },
      });
      await transaction.save({ session });
      if (options.faultInjector) {
        await options.faultInjector({
          phase: 'before_final_lease_proof',
          lease,
          session,
          trade,
        });
      }
      await lease.assertActive({ session });
      outcome = { kind: 'completed', trade: trade.toObject(), realisedPnl };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    return outcome;
  } finally {
    try {
      if (session) await session.endSession();
    } finally {
      await lease?.release();
    }
  }
}

function addCleanupId(match, limitBuys, limitSells, stopRise, stopFall) {
  const isStop = match.orderType === 'SL' || match.orderType === 'SL-M';
  if (isStop) {
    (match.direction === 'FALL' ? stopFall : stopRise).push(match.id);
  } else if (match.side === 'BUY') {
    limitBuys.push(match.id);
  } else {
    limitSells.push(match.id);
  }
}

async function notifyOutcome(outcome, livePrice) {
  const trade = outcome.trade;
  if (!trade) return;
  const livePriceService = require('./livePriceService');

  if (outcome.kind === 'rejected') {
    const rejectMessage = outcome.message || 'Order rejected at fill.';
    console.log(`⚠️ [PriceQueue] Rejected ${trade.tradingsymbol} — ${rejectMessage}`);
    // Broadcast so the user's orders tab reflects the fill-time rejection.
    livePriceService.broadcastToUser(trade.user_id.toString(), {
      type: 'trade_rejected',
      trade_id: trade._id.toString(),
      tradingsymbol: trade.tradingsymbol,
      message: rejectMessage,
    });
    return;
  }

  if (outcome.kind !== 'completed') return;
  console.log(`✅ [PriceQueue] Executed ${trade.transaction_type} ${trade.order_type} ${trade.tradingsymbol} @ ${trade.price} (live: ${livePrice})`);
  livePriceService.broadcastToUser(trade.user_id.toString(), {
    type: 'trade_executed',
    trade_id: trade._id.toString(),
    instrument_token: trade.instrument_token,
    tradingsymbol: trade.tradingsymbol,
    transaction_type: trade.transaction_type,
    quantity: trade.quantity,
    executed_price: trade.price,
    pnl: outcome.realisedPnl,
    status: 'completed',
  });

  // Trade Alert (web-only) — this is the PRIMARY fill path when Redis/
  // BullMQ is handling execution (the common case in production; see the
  // DB-fallback engine in orderExecutionService.js for when it isn't).
  // Own try/catch, purely additive.
  try {
    const alertUser = await User.findById(trade.user_id).select('name username').lean();
    const alertInst = await KiteInstrument.findOne({ instrument_token: trade.instrument_token }).select('segment lot_size').lean();
    metricsEngine.broadcastTradeAlert(trade.user_id.toString(), {
      trade_id: trade._id.toString(),
      user_id: trade.user_id.toString(),
      client_name: alertUser?.name || null,
      client_username: alertUser?.username || null,
      instrument_token: trade.instrument_token,
      tradingsymbol: trade.tradingsymbol,
      segment: alertInst?.segment || null,
      lot_size: alertInst?.lot_size || null,
      transaction_type: trade.transaction_type,
      quantity: trade.quantity,
      price: trade.price,
      order_type: trade.order_type,
      status: 'completed',
      executed_at: new Date(),
    });
  } catch (alertErr) {
    console.error(`⚠️ [TradeAlert] broadcast error for trade ${trade._id}:`, alertErr.message);
  }

  await metricsEngine.onTradeExecuted(trade.user_id.toString());
  const isStopOrder = trade.order_type === 'SL' || trade.order_type === 'SL-M';
  firebaseService.sendNotification(trade.user_id.toString(), 'pending_order', {
    title: isStopOrder ? 'Stop-Loss Order Executed' : 'Limit Order Executed',
    body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} @ ₹${trade.price}`,
    data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
  });
}

const _processJob = async job => {
  const { instrument_token, live_price, timestamp: tickTimestamp } = job.data;
  _jobsProcessed++;

  // Periodic heartbeat — confirms worker is alive and processing
  const now = Date.now();
  if (LOG_REDIS_ORDERS && (now - _lastHeartbeat) >= HEARTBEAT_INTERVAL_MS) {
    console.log(`💓 [PriceQueue] [${_ts()}] Worker heartbeat | jobsProcessed=${_jobsProcessed} | queueActive=true`);
    _lastHeartbeat = now;
  }

  if (LOG_PRICE_QUEUE) console.log(`🔄 [PriceQueue] Processing price update: Token ${instrument_token} @ ${live_price}`);

  const [matchingBuys, matchingSells, matchingStopRise, matchingStopFall] = await Promise.all([
    orderBookService.getMatchingBuyOrders(instrument_token, live_price),
    orderBookService.getMatchingSellOrders(instrument_token, live_price),
    orderBookService.getMatchingStopRiseOrders(instrument_token, live_price),
    orderBookService.getMatchingStopFallOrders(instrument_token, live_price),
  ]);

  // Log near-misses: check if there are ANY orders for this token that didn't match
  // This helps trace "price crossed but order didn't fire" issues
  if (LOG_REDIS_ORDERS && matchingBuys.length === 0 && matchingSells.length === 0 &&
      matchingStopRise.length === 0 && matchingStopFall.length === 0) {
    // Check if there are any orders at all for this instrument in the book
    const [buyCount, sellCount, stopRiseCount, stopFallCount] = await Promise.all([
      orderBookService.getOrderCount(instrument_token, 'BUY', 'LIMIT'),
      orderBookService.getOrderCount(instrument_token, 'SELL', 'LIMIT'),
      orderBookService.getOrderCount(instrument_token, null, 'SL', 'RISE'),
      orderBookService.getOrderCount(instrument_token, null, 'SL', 'FALL'),
    ]);
    const totalPending = buyCount + sellCount + stopRiseCount + stopFallCount;
    if (totalPending > 0) {
      // There ARE pending orders for this token but none matched — log near-miss
      console.log(`🔸 [PriceQueue] [${_ts()}] NEAR-MISS | token=${instrument_token} livePrice=${live_price} | pendingOrders: limitBuy=${buyCount} limitSell=${sellCount} stopRise=${stopRiseCount} stopFall=${stopFallCount} | tickAge=${now - (tickTimestamp || now)}ms`);
    }
  }
  // orderType is tagged per match so cleanup below removes each executed
  // order from the RIGHT Redis set — LIMIT (side-keyed) and stop
  // (direction-keyed) orders live in separate key pairs (see
  // orderBookService.js) since they trigger on opposite price directions.
  // Stop matches carry `direction`, not `side` — direction is what
  // determined which Redis set matched them, side is unknown until
  // executeMatchedOrder loads the real Trade document from Mongo.
  const matches = [
    ...matchingBuys.map(id => ({ id, side: 'BUY', orderType: 'LIMIT' })),
    ...matchingSells.map(id => ({ id, side: 'SELL', orderType: 'LIMIT' })),
    ...matchingStopRise.map(id => ({ id, orderType: 'SL', direction: 'RISE' })),
    ...matchingStopFall.map(id => ({ id, orderType: 'SL', direction: 'FALL' })),
  ];
  if (matches.length === 0) return;

  console.log(`⚡ [PriceQueue] [${_ts()}] Token ${instrument_token} @ ${live_price} → ${matches.length} order(s) to execute | limitBuy=${matchingBuys.length} limitSell=${matchingSells.length} stopRise=${matchingStopRise.length} stopFall=${matchingStopFall.length}`);
  if (LOG_REDIS_ORDERS) {
    for (const match of matches) {
      console.log(`   ↳ [PriceQueue] executing tradeId=${match.id} ${match.orderType} ${match.side || match.direction} | livePrice=${live_price}`);
    }
  }
  const executedBuys = [];
  const executedSells = [];
  const executedStopRise = [];
  const executedStopFall = [];
  let failedCount = 0;
  for (const match of matches) {
    // Each match gets its own try/catch that does NOT re-throw. Previously
    // one order's failure (insufficient funds, a data issue, anything)
    // threw out of the whole loop — aborting every OTHER match in this same
    // batch too, including ones that had already executed successfully a
    // few lines above. Since the throw happened before reaching the
    // removeMany() cleanup below, those already-executed orders never got
    // removed from the Redis order book either, leaving them "stuck" —
    // every later price tick would re-match and re-attempt them
    // (harmlessly no-op via the idempotency check, since their trade is no
    // longer 'pending', but never actually cleaned up) until the next
    // market-close sweep. A failure now only affects the ONE order that
    // failed — it's simply left out of the cleanup list, so it stays in
    // the order book and gets a fair retry on the next price tick, same as
    // the existing per-order retry behavior already documented elsewhere.
    try {
      const outcome = await executeMatchedOrder(match, live_price);
      if (['unchanged', 'cancelled', 'rejected', 'completed'].includes(outcome.kind)) {
        addCleanupId(match, executedBuys, executedSells, executedStopRise, executedStopFall);
      }
      if (LOG_REDIS_ORDERS && outcome.kind === 'unchanged') {
        console.log(`   ↳ [PriceQueue] [${_ts()}] tradeId=${match.id} outcome=unchanged (already not pending or deleted)`);
      }
      await notifyOutcome(outcome, live_price);
    } catch (error) {
      failedCount++;
      if (error.code !== 'SETTLEMENT_IN_PROGRESS') {
        console.error(`❌ [PriceQueue] [${_ts()}] Execution error for trade ${match.id} (${match.orderType} ${match.side || match.direction}): ${error.message}`);
      } else if (LOG_REDIS_ORDERS) {
        console.log(`⏸️  [PriceQueue] [${_ts()}] tradeId=${match.id} skipped — settlement in progress`);
      }
    }
  }
  if (failedCount > 0) {
    console.log(`⚠️  [PriceQueue] Token ${instrument_token} @ ${live_price} → ${failedCount}/${matches.length} order(s) failed this tick, left pending for retry`);
  }

  if (executedBuys.length > 0) await orderBookService.removeMany(instrument_token, 'BUY', executedBuys, 'LIMIT');
  if (executedSells.length > 0) await orderBookService.removeMany(instrument_token, 'SELL', executedSells, 'LIMIT');
  if (executedStopRise.length > 0) await orderBookService.removeMany(instrument_token, null, executedStopRise, 'SL', 'RISE');
  if (executedStopFall.length > 0) await orderBookService.removeMany(instrument_token, null, executedStopFall, 'SL', 'FALL');
};

const init = () => {
  if (!redisService.isAvailable()) {
    console.log(`⚠️  [PriceQueue] [${_ts()}] Redis unavailable – queue not started`);
    return;
  }
  if (queue || worker) return;

  const connection = {
    host: redisService.getClient().options.host || '127.0.0.1',
    port: redisService.getClient().options.port || 6379,
    maxRetriesPerRequest: null,
  };
  queue = new Queue(QUEUE_NAME, { connection });
  worker = new Worker(QUEUE_NAME, _processJob, {
    connection,
    concurrency: 5,
    limiter: { max: 100, duration: 1000 },
  });
  worker.on('failed', (job, error) => {
    console.error(`❌ [PriceQueue] [${_ts()}] Job ${job?.id} failed: ${error.message}`);
  });
  worker.on('error', (error) => {
    console.error(`❌ [PriceQueue] [${_ts()}] Worker error: ${error.message}`);
  });
  if (LOG_REDIS_ORDERS) {
    worker.on('stalled', (jobId) => {
      console.log(`⚠️  [PriceQueue] [${_ts()}] Job stalled: ${jobId}`);
    });
  }
  console.log(`✅ [PriceQueue] [${_ts()}] Queue and worker initialised | concurrency=5, limiter=100/s`);
};

const shutdown = async () => {
  console.log(`🛑 [PriceQueue] [${_ts()}] Shutting down... | totalJobsProcessed=${_jobsProcessed}`);
  if (worker) await worker.close();
  if (queue) await queue.close();
  worker = null;
  queue = null;
};

module.exports = {
  init,
  publishPriceUpdate,
  shutdown,
  calculateBrokerage,
  _private: { executeMatchedOrder, positionStateSinceLastFlat, realisedPnlFor, _processJob },
};
