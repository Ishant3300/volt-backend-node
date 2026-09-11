const Trade = require('../models/Trade');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const KiteInstrument = require('../models/KiteInstrument');
const mongoose = require('mongoose');
const kiteService = require('./kiteService');
const orderBookService = require('./orderBookService');
const redisService = require('./redisService');
const { calculateMargin } = require('./marginService');
const walletService = require('./walletService');
const { categoryForSegment } = require('../utils/walletCategory');
const { computeWalletSplit } = require('../utils/walletSplit');
const firebaseService = require('./firebaseService');
const { beginTradeWrite } = require('./tradeWriteFenceService');
const { calculateBrokerage } = require('./brokerageService');
const { LOG_REDIS_ORDERS } = require('../config/logFlags');

const _ts = () => new Date().toISOString();

/**
 * Fetches live prices from Kite for a list of instrument tokens.
 * Returns a Map<number, number> of instrumentToken -> lastPrice.
 */
const _getLivePrices = async (instrumentTokens) => {
    if (!instrumentTokens || instrumentTokens.length === 0) return new Map();
    try {
        const quotes = await kiteService.getLatestQuotes(instrumentTokens, 100);
        const ltpMap = new Map();
        quotes.forEach(q => {
            ltpMap.set(q.instrument_token, q.last_price);
        });
        return ltpMap;
    } catch (err) {
        console.error('[OrderExecution] Error fetching live quotes:', err.message);
        return new Map();
    }
};

/**
 * DB-based fallback: Checks all pending limit orders and executes them
 * if the live price satisfies the limit condition.
 *
 * This runs ONLY when Redis is unavailable. When Redis is up, the
 * BullMQ price queue worker handles execution instead.
 *
 * BUY LIMIT:  executes when live_price <= limit_price
 * SELL LIMIT: executes when live_price >= limit_price
 */
const processPendingOrders = async () => {
    // Skip if Redis + BullMQ are handling execution
    if (redisService.isAvailable()) {
        if (LOG_REDIS_ORDERS) {
            console.log(`⏭️  [OrderExecution] [${_ts()}] processPendingOrders SKIPPED — Redis available (BullMQ handling execution)`);
        }
        return;
    }

    console.log(`🟠 [OrderExecution] [${_ts()}] processPendingOrders ACTIVE — Redis UNAVAILABLE, DB fallback running | diagnostics=${JSON.stringify(redisService.getDiagnostics())}`);

    try {
        // Previously 'LIMIT' only — SL/SL-M orders were accepted at
        // placement but this query (and the matching Redis-path query in
        // orderBookService.js / registration gate in tradeController.js)
        // silently excluded them, so the SL/SL-M trigger-matching logic
        // just below was unreachable dead code. Now all three are aligned.
        // deleted_at: null — a trade admin-soft-deleted while still 'pending'
        // (deleteTrade only sets deleted_at, never touches status) must not be
        // matched/executed by this DB-fallback path.
        const pendingTrades = await Trade.find({
            status: 'pending',
            order_type: { $in: ['LIMIT', 'SL', 'SL-M'] },
            deleted_at: null,
        });

        if (pendingTrades.length === 0) {
            if (LOG_REDIS_ORDERS) {
                console.log(`   ↳ [OrderExecution] [${_ts()}] No pending orders found in DB`);
            }
            return;
        }

        console.log(`   ↳ [OrderExecution] [${_ts()}] Found ${pendingTrades.length} pending order(s) in DB`);

        // Collect distinct instrument tokens
        const tokenSet = new Set(pendingTrades.map(t => parseInt(t.instrument_token)));
        const tokenArray = [...tokenSet];

        const ltpMap = await _getLivePrices(tokenArray);

        if (ltpMap.size === 0) {
            // Could not fetch any prices, skip this cycle
            console.log(`   ↳ [OrderExecution] [${_ts()}] Could not fetch ANY live prices (${tokenArray.length} tokens requested) — skipping cycle`);
            return;
        }

        if (LOG_REDIS_ORDERS) {
            console.log(`   ↳ [OrderExecution] [${_ts()}] Fetched LTP for ${ltpMap.size}/${tokenArray.length} tokens`);
        }

        let executedCount = 0;

        for (const trade of pendingTrades) {
            const livePrice = ltpMap.get(parseInt(trade.instrument_token));
            if (!livePrice) continue; // No price available for this instrument

            let shouldExecute = false;

            if (trade.order_type === 'SL' || trade.order_type === 'SL-M') {
                // Direction-based, matching orderBookService.js/tradeController.js —
                // NOT hardcoded by transaction_type. trigger_direction is decided
                // once at placement (trigger vs live price at that moment); a
                // legacy trade placed before that field existed (null) falls
                // back to the old BUY=rise/SELL=fall mapping so it keeps
                // matching exactly as it always did.
                const direction = trade.trigger_direction || (trade.transaction_type === 'BUY' ? 'RISE' : 'FALL');
                if (direction === 'RISE' && livePrice >= trade.price) {
                    shouldExecute = true;
                } else if (direction === 'FALL' && livePrice <= trade.price) {
                    shouldExecute = true;
                }
            } else {
                // LIMIT: BUY triggers when price <= limit, SELL triggers when price >= limit
                if (trade.transaction_type === 'BUY' && livePrice <= trade.price) {
                    shouldExecute = true;
                } else if (trade.transaction_type === 'SELL' && livePrice >= trade.price) {
                    shouldExecute = true;
                }
            }

            if (shouldExecute) {
                if (LOG_REDIS_ORDERS) {
                    console.log(`   ↳ [OrderExecution] [${_ts()}] TRIGGERING tradeId=${trade._id} ${trade.order_type} ${trade.transaction_type} ${trade.tradingsymbol} @ ${trade.price} | livePrice=${livePrice}`);
                }
                const session = await mongoose.startSession();
                let tradeWriteLease = null;
                try {
                    tradeWriteLease = await beginTradeWrite('db_limit_execution');
                    await session.withTransaction(async () => {
                        await tradeWriteLease.assertActive({ session });
                        // Idempotency: re-check status before executing
                        const freshTrade = await Trade.findById(trade._id).session(session);
                        if (!freshTrade || freshTrade.status !== 'pending' || freshTrade.deleted_at) return;

                        // Calculate realised P&L using the average-price method — aligned with
                        // the primary live path (priceQueueService.js's realisedPnlFor /
                        // positionStateSinceLastFlat) and the /trade/report PDF
                        // (tradeReportController.js's _computeAveragePricePnl). This was
                        // previously true FIFO — the one outlier among all three — so a
                        // trade's P&L could differ depending on whether Redis happened to be
                        // up or down at the moment it filled. Aligned so it can't.
                        let realisedPnl = 0;

                        // Fetch all previous completed trades chronologically.
                        const prevTrades = await Trade.find({
                            user_id: freshTrade.user_id,
                            instrument_token: freshTrade.instrument_token,
                            status: 'completed',
                            deleted_at: null
                        }).sort({ executed_at: 1 }).session(session);

                        let netQtyFromPrev = 0; // positive = long, negative = short

                        // Average buy/sell state for the CURRENTLY open position only — resets
                        // whenever net quantity crosses or lands on 0, exactly like
                        // priceQueueService.js's positionStateSinceLastFlat: an unbounded sum
                        // since last settlement blends an already-closed prior round trip's
                        // prices into "today's" entry basis. Net qty itself doesn't need this
                        // treatment — a full round trip's buys and sells cancel out in a plain
                        // qty sum regardless of order, so only the VALUE-weighted average is
                        // at risk, not the position size.
                        //
                        // Also handles a same-trade flip (one fill larger than the current net
                        // position, closing it AND opening the opposite side — this platform
                        // allows that; order size is only capped at the current position when
                        // an admin has disabled the instrument, not in general) — the excess
                        // beyond the close seeds a fresh average on the new side, since net qty
                        // can jump straight past zero without ever equaling it exactly.
                        //
                        // A PARTIAL close (order smaller than the open position) must decrement
                        // the closed side's own totals by the qty matched — folding it into the
                        // opposite side's totals (or leaving the closed side untouched) makes a
                        // later same-side open average against the position's pre-partial-close
                        // qty instead of what's truly still open. Worked example: BUY 50@100,
                        // partial SELL 20 (still long 30), BUY 30@120 (now long 60) must average
                        // to (30*100 + 30*120)/60 = 110, not 107.5 against a phantom 80-qty long.
                        let sinceFlatBuyQty = 0, sinceFlatSellQty = 0, sinceFlatBuyValue = 0, sinceFlatSellValue = 0;

                        for (const pt of prevTrades) {
                            const isBuy = pt.transaction_type === 'BUY';
                            const qty = pt.executed_quantity;
                            const price = pt.executed_price;
                            const prevNet = netQtyFromPrev;
                            const afterNet = prevNet + (isBuy ? qty : -qty);
                            const isClosing = (isBuy && prevNet < 0) || (!isBuy && prevNet > 0);

                            if (isClosing) {
                                const closingQty = Math.min(qty, Math.abs(prevNet));
                                if (isBuy) {
                                    const avgSellNow = sinceFlatSellQty > 0 ? sinceFlatSellValue / sinceFlatSellQty : 0;
                                    sinceFlatSellQty -= closingQty;
                                    sinceFlatSellValue -= closingQty * avgSellNow;
                                } else {
                                    const avgBuyNow = sinceFlatBuyQty > 0 ? sinceFlatBuyValue / sinceFlatBuyQty : 0;
                                    sinceFlatBuyQty -= closingQty;
                                    sinceFlatBuyValue -= closingQty * avgBuyNow;
                                }

                                const excessQty = qty - closingQty;
                                if (excessQty > 0) {
                                    if (isBuy) { sinceFlatBuyQty += excessQty; sinceFlatBuyValue += excessQty * price; }
                                    else { sinceFlatSellQty += excessQty; sinceFlatSellValue += excessQty * price; }
                                }
                            } else if (isBuy) {
                                sinceFlatBuyQty += qty;
                                sinceFlatBuyValue += qty * price;
                            } else {
                                sinceFlatSellQty += qty;
                                sinceFlatSellValue += qty * price;
                            }

                            netQtyFromPrev = afterNet;
                        }

                        // Shared by the P&L calc below and the wallet release basis further
                        // down — same average, computed once.
                        const avgBuy = sinceFlatBuyQty > 0 ? sinceFlatBuyValue / sinceFlatBuyQty : 0;
                        const avgSell = sinceFlatSellQty > 0 ? sinceFlatSellValue / sinceFlatSellQty : 0;

                        if (freshTrade.transaction_type === 'SELL' && netQtyFromPrev > 0) {
                            realisedPnl = (freshTrade.price - avgBuy) * Math.min(freshTrade.quantity, netQtyFromPrev);
                        } else if (freshTrade.transaction_type === 'BUY' && netQtyFromPrev < 0) {
                            realisedPnl = (avgSell - freshTrade.price) * Math.min(freshTrade.quantity, Math.abs(netQtyFromPrev));
                        }
                        realisedPnl = Math.round(realisedPnl * 100) / 100;

                        // Net position and wallet-release basis both derive from prevTrades,
                        // already walked above — no second query needed.
                        const prevNetQtyCheck = netQtyFromPrev;

                        // ── Category trade-wallet gate at FILL time (Task 6 / Requirements
                        //    3.1, 4.1; design §6.2 / §13.2). Mirrors priceQueueService (the
                        //    primary Redis path); this DB fallback runs only when Redis is
                        //    down. Placing the pending order did NOT touch the wallet — the
                        //    block/release happens here at fill. REPLACES the old free-margin
                        //    + equity gates.
                        //
                        //    Category MUST come from the instrument SEGMENT, not
                        //    `freshTrade.exchange` (which carries no segment), so 'NFO-FUT'
                        //    maps to NSE and 'MCX-FUT' to MCX rather than GLOBAL.
                        const walletInstrument = await KiteInstrument.findOne({ instrument_token: freshTrade.instrument_token })
                            .select('segment enabled deleted_at instrument_type').session(session).lean();
                        const walletCategory = categoryForSegment(walletInstrument?.segment || freshTrade.exchange || '');

                        const { closingQty: walletClosingQty, openingQty: walletOpeningQty } =
                            computeWalletSplit(prevNetQtyCheck, freshTrade.transaction_type, freshTrade.quantity);

                        // Instrument enabled/deleted gate at FILL time — mirrors placeTrade's
                        // placement-time check and priceQueueService's primary-path fill gate.
                        // Deleted blocks unconditionally (even a close); disabled-only still
                        // allows closing/reducing.
                        const instrumentBlocked = walletInstrument?.deleted_at
                            || (walletInstrument?.enabled === false && walletOpeningQty > 0);
                        if (instrumentBlocked) {
                            const instrumentRejectRemark = walletInstrument?.deleted_at
                                ? 'Admin has deactivated this script. Trading is not allowed.'
                                : 'This instrument has been disabled by admin. You cannot open new positions on this script.';
                            freshTrade.status = 'rejected';
                            freshTrade.pnl = 0;
                            freshTrade.net_amount = 0;
                            freshTrade.remarks = instrumentRejectRemark;
                            await freshTrade.save({ session });
                            try {
                                await Trade.create([{
                                    user_id: freshTrade.user_id,
                                    master_id: freshTrade.master_id,
                                    admin_id: freshTrade.admin_id || null,
                                    instrument_token: freshTrade.instrument_token,
                                    tradingsymbol: freshTrade.tradingsymbol,
                                    exchange: freshTrade.exchange,
                                    transaction_type: freshTrade.transaction_type,
                                    quantity: freshTrade.quantity,
                                    price: freshTrade.price,
                                    order_type: freshTrade.order_type,
                                    status: 'rejected',
                                    remarks: instrumentRejectRemark,
                                }], { session });
                            } catch (_) {}
                            console.log(`⚠️ [OrderExecution] Rejected ${freshTrade.tradingsymbol} — ${instrumentRejectRemark}`);
                            return;
                        }

                        // Bet / close-only gate at FILL time — mirrors placeTrade's
                        // placement-time checks (tradeController.js) and priceQueueService's
                        // primary-path fill gate. An admin flips bet=false or
                        // close_only=true specifically to stop a user opening further risk
                        // right now; a LIMIT/SL/SL-M order already pending at that moment
                        // would otherwise still fill and open a fresh position, bypassing
                        // the admin's intent entirely. Same rejection shape as the
                        // instrument-blocked gate above.
                        const gateUser = await User.findById(freshTrade.user_id).select('bet close_only exchanges_allowed margin_call_blocked margin_square_off margin_square_off_percentage credits').session(session).lean();
                        const isClosingForCloseOnly = (freshTrade.transaction_type === 'SELL' && prevNetQtyCheck > 0)
                            || (freshTrade.transaction_type === 'BUY' && prevNetQtyCheck < 0);
                        const betBlocked = gateUser?.bet === false;
                        const closeOnlyBlocked = gateUser?.close_only === true && !isClosingForCloseOnly;

                        // Margin-call gate at FILL time — mirrors placeTrade's
                        // placement-time checks and priceQueueService's fill gate.
                        const marginCallFullyBlocked = gateUser?.margin_call_blocked === true;
                        let marginCallLiveBlocked = false;
                        if (!marginCallFullyBlocked && !gateUser?.margin_square_off && !(gateUser?.margin_square_off_percentage > 0)) {
                            const metricsEngineForMarginCall = require('./metricsEngine');
                            const liveMetricsForMarginCall = metricsEngineForMarginCall.getCachedMetrics(freshTrade.user_id.toString());
                            const creditForMarginCall = Number(gateUser?.credits || 0);
                            marginCallLiveBlocked = !!liveMetricsForMarginCall
                                && Number(liveMetricsForMarginCall.m2m_pnl || 0) <= -creditForMarginCall
                                && !isClosingForCloseOnly;
                        }

                        // Exchange-permission gate — mirrors placeTrade's placement-time
                        // check and priceQueueService's primary-path fill gate.
                        const rawSegmentForAllow = (walletInstrument?.segment || freshTrade.exchange || '').toUpperCase();
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
                            freshTrade.status = 'rejected';
                            freshTrade.pnl = 0;
                            freshTrade.net_amount = 0;
                            freshTrade.remarks = userGateRejectRemark;
                            await freshTrade.save({ session });
                            try {
                                await Trade.create([{
                                    user_id: freshTrade.user_id,
                                    master_id: freshTrade.master_id,
                                    admin_id: freshTrade.admin_id || null,
                                    instrument_token: freshTrade.instrument_token,
                                    tradingsymbol: freshTrade.tradingsymbol,
                                    exchange: freshTrade.exchange,
                                    transaction_type: freshTrade.transaction_type,
                                    quantity: freshTrade.quantity,
                                    price: freshTrade.price,
                                    order_type: freshTrade.order_type,
                                    status: 'rejected',
                                    remarks: userGateRejectRemark,
                                }], { session });
                            } catch (_) {}
                            console.log(`⚠️ [OrderExecution] Rejected ${freshTrade.tradingsymbol} — ${userGateRejectRemark}`);
                            return;
                        }

                        // Naked-option-short gate at FILL time — mirrors placeTrade's
                        // placement-time check (tradeController.js), which only runs once,
                        // at the moment the order is PLACED. A pending SELL LIMIT/SL/SL-M
                        // order placed while the user still held the option stays queued
                        // even if that position gets closed by some other trade before this
                        // one fills — without re-checking here, it fills anyway and opens a
                        // fresh naked short the placement-time check exists specifically to
                        // prevent. Same rejection shape as the instrument-blocked gate above.
                        const isOptionInstrument = ['CE', 'PE'].includes(walletInstrument?.instrument_type);
                        const nakedOptionShort = isOptionInstrument
                            && freshTrade.transaction_type === 'SELL'
                            && prevNetQtyCheck <= 0;
                        if (nakedOptionShort) {
                            const nakedShortRejectRemark = 'Option selling is not allowed. You must own this option before you can sell it.';
                            freshTrade.status = 'rejected';
                            freshTrade.pnl = 0;
                            freshTrade.net_amount = 0;
                            freshTrade.remarks = nakedShortRejectRemark;
                            await freshTrade.save({ session });
                            try {
                                await Trade.create([{
                                    user_id: freshTrade.user_id,
                                    master_id: freshTrade.master_id,
                                    admin_id: freshTrade.admin_id || null,
                                    instrument_token: freshTrade.instrument_token,
                                    tradingsymbol: freshTrade.tradingsymbol,
                                    exchange: freshTrade.exchange,
                                    transaction_type: freshTrade.transaction_type,
                                    quantity: freshTrade.quantity,
                                    price: freshTrade.price,
                                    order_type: freshTrade.order_type,
                                    status: 'rejected',
                                    remarks: nakedShortRejectRemark,
                                }], { session });
                            } catch (_) {}
                            console.log(`⚠️ [OrderExecution] Rejected ${freshTrade.tradingsymbol} — ${nakedShortRejectRemark}`);
                            return;
                        }

                        // Closed long lots release at avgBuy; closed short lots at avgSell —
                        // same avgBuy/avgSell already computed above for the P&L calc.
                        const walletReleaseBasis = prevNetQtyCheck > 0 ? avgBuy : avgSell;
                        const walletReleaseAmount = walletClosingQty * walletReleaseBasis;
                        // LIMIT/SL fills at the limit price: executed_price = freshTrade.price.
                        const walletOpeningNotional = walletOpeningQty * freshTrade.price;

                        // Affordability pre-check. A reversal's release funds the new opening.
                        const walletAvailable = (await walletService.getAvailable('User', freshTrade.user_id, session))[walletCategory];
                        const walletEffectiveAvailable = walletAvailable + walletReleaseAmount;
                        if (walletOpeningQty > 0 && walletOpeningNotional > walletEffectiveAvailable) {
                            const walletShortfall = walletOpeningNotional - walletEffectiveAvailable;
                            const walletRejectRemark = `Insufficient ${walletCategory} wallet balance at fill. Required ₹${walletOpeningNotional.toFixed(2)}, available ₹${walletEffectiveAvailable.toFixed(2)} (short ₹${walletShortfall.toFixed(2)}).`;
                            freshTrade.status = 'rejected';
                            freshTrade.pnl = 0;
                            freshTrade.net_amount = 0;
                            freshTrade.remarks = walletRejectRemark;
                            await freshTrade.save({ session });

                            // Save rejection log (same shape as the previous rejection path).
                            try {
                                await Trade.create([{
                                    user_id: freshTrade.user_id,
                                    master_id: freshTrade.master_id,
                                    admin_id: freshTrade.admin_id || null,
                                    instrument_token: freshTrade.instrument_token,
                                    tradingsymbol: freshTrade.tradingsymbol,
                                    exchange: freshTrade.exchange,
                                    transaction_type: freshTrade.transaction_type,
                                    quantity: freshTrade.quantity,
                                    price: freshTrade.price,
                                    order_type: freshTrade.order_type,
                                    status: 'rejected',
                                    remarks: walletRejectRemark,
                                }], { session });
                            } catch (_) {}

                            console.log(`⚠️ [OrderExecution] Rejected ${freshTrade.tradingsymbol} — ${walletRejectRemark}`);
                            return;
                        }

                        // Gate passed — apply wallet mutations inside this transaction:
                        // release the closed portion's entry notional first, then block the
                        // opened portion. block() is the atomic never-negative backstop; if a
                        // concurrent race makes it throw INSUFFICIENT_WALLET we let it
                        // propagate so the transaction aborts and the order stays pending to
                        // retry on the next cycle (never silently completed).
                        if (walletClosingQty > 0 && walletReleaseBasis > 0) {
                            await walletService.release('User', freshTrade.user_id, walletCategory, walletReleaseAmount, session);
                        }
                        if (walletOpeningQty > 0) {
                            await walletService.block('User', freshTrade.user_id, walletCategory, walletOpeningNotional, session);
                        }

                        // Brokerage — this DB-fallback path previously never computed or
                        // charged it at all (freshTrade.brokerage was left unset and
                        // balanceChange never subtracted it), so every fill that happened
                        // to go through this path (Redis down) was brokerage-free. Mirrors
                        // priceQueueService.js's calculateBrokerage call, now via the shared
                        // brokerageService so both paths use identical rule-matching logic.
                        const brokerage = await calculateBrokerage(freshTrade, session);

                        // Execute the trade
                        freshTrade.status = 'completed';
                        freshTrade.executed_at = new Date();
                        freshTrade.executed_price = freshTrade.price;
                        freshTrade.executed_quantity = freshTrade.quantity;
                        freshTrade.pnl = realisedPnl;
                        freshTrade.brokerage = brokerage;
                        freshTrade.net_amount = realisedPnl - brokerage;
                        await freshTrade.save({ session });

                        // Calculate margin impact and update balance
                        const prevNetQtyForMargin = prevNetQtyCheck;
                        const isBuy = freshTrade.transaction_type === 'BUY';
                        const newNetQty = prevNetQtyForMargin + (isBuy ? freshTrade.quantity : -freshTrade.quantity);
                        const marginPerUnit = await calculateMargin(freshTrade.exchange, 1, freshTrade.price);
                        const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
                        const newMargin = Math.abs(newNetQty) * marginPerUnit;
                        // marginDelta is notional (calculateMargin returns |qty|×price since
                        // Task 3), computed here for transaction metadata only — NOT
                        // subtracted from persisted user.equity below. wallet.block/release
                        // (this path's DB-fallback equivalent) already reserves/frees this
                        // exact notional from the wallet balance, so subtracting it again
                        // here double-counted the same margin against two balance fields
                        // (design D2: persisted equity = credit + realised P&L only,
                        // matching the same fix in placeTrade / priceQueueService).
                        const marginDelta = newMargin - prevMargin;
                        const balanceChange = realisedPnl - brokerage;

                        const user = await User.findById(freshTrade.user_id).session(session);
                        if (user) {
                            const balanceBefore = user.equity;
                            user.equity += balanceChange;
                            await user.save({ session });

                            // Log transaction
                            try {
                                const tradeValue = freshTrade.price * freshTrade.quantity;
                                const tx = new Transaction({
                                    transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_LE`,
                                    userId: freshTrade.user_id,
                                    userModel: 'User',
                                    type: freshTrade.transaction_type,
                                    status: 'SUCCESS',
                                    amount: tradeValue,
                                    referenceId: freshTrade._id,
                                    referenceModel: 'Trade',
                                    balanceBefore,
                                    balanceAfter: user.equity,
                                    metadata: {
                                        tradingsymbol: freshTrade.tradingsymbol,
                                        quantity: freshTrade.quantity,
                                        executedPrice: freshTrade.price,
                                        order_type: freshTrade.order_type,
                                        realisedPnl,
                                        brokerage,
                                        marginDelta,
                                        balanceChange,
                                        positionClosed: realisedPnl !== 0,
                                        executedBy: 'db_fallback_engine'
                                    }
                                });
                                await tx.save({ session });
                            } catch (txErr) {
                                console.error(`[OrderExecution] Error logging transaction for trade ${freshTrade._id}:`, txErr.message);
                            }
                        }
                        await tradeWriteLease.assertActive({ session });
                    }); // end session.withTransaction
                    session.endSession();
                    await tradeWriteLease.release();
                    tradeWriteLease = null;

                    executedCount++;
                    console.log(`✅ [OrderExecution/Fallback] [${_ts()}] Executed ${trade.transaction_type} ${trade.order_type} for ${trade.tradingsymbol} @ ${trade.price} (live: ${livePrice}) | tradeId=${trade._id}`);

                    // Notify the user's Flutter client via WebSocket
                    const livePriceService = require('./livePriceService');
                    livePriceService.broadcastToUser(trade.user_id.toString(), {
                        type: 'trade_executed',
                        trade_id: trade._id.toString(),
                        instrument_token: trade.instrument_token,
                        tradingsymbol: trade.tradingsymbol,
                        transaction_type: trade.transaction_type,
                        quantity: trade.quantity,
                        executed_price: trade.price,
                        pnl: trade.pnl || 0,
                        status: 'completed',
                    });

                    // Notify masters/admins on the Trade Alert live-log page — same
                    // broadcast as tradeController.js's placeTrade and
                    // priceQueueService.js's notifyOutcome; this is the DB-fallback
                    // fill path (used when Redis/BullMQ is unavailable), which never
                    // had this wired in even though tradeAlertController.js's own
                    // docblock claimed it did.
                    try {
                        const metricsEngine = require('./metricsEngine');
                        const [alertInst, alertUser] = await Promise.all([
                            KiteInstrument.findOne({ instrument_token: trade.instrument_token }).select('segment lot_size').lean(),
                            User.findById(trade.user_id).select('name username').lean(),
                        ]);
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
                            executed_at: trade.executed_at || new Date(),
                        });
                    } catch (alertErr) {
                        console.error('⚠️ [TradeAlert] broadcast error:', alertErr.message);
                    }

                    // FCM push notification for pending order execution
                    firebaseService.sendNotification(trade.user_id.toString(), 'pending_order', {
                        title: 'Limit Order Executed',
                        body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} @ ₹${trade.price}`,
                        data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
                    });
                } catch (sessionErr) {
                    session.endSession();
                    await tradeWriteLease?.release();
                    if (sessionErr.code !== 'SETTLEMENT_IN_PROGRESS') {
                        console.error(`❌ [OrderExecution] [${_ts()}] Session error for trade ${trade._id} (${trade.tradingsymbol}): ${sessionErr.message}`);
                    } else if (LOG_REDIS_ORDERS) {
                        console.log(`⏸️  [OrderExecution] [${_ts()}] tradeId=${trade._id} skipped — settlement in progress`);
                    }
                }
            }
        }

        if (executedCount > 0) {
            console.log(`📊 [OrderExecution/Fallback] [${_ts()}] Executed ${executedCount} pending limit order(s) this cycle.`);
        } else if (LOG_REDIS_ORDERS) {
            console.log(`   ↳ [OrderExecution] [${_ts()}] Cycle complete — 0 orders triggered out of ${pendingTrades.length} pending`);
        }
    } catch (error) {
        console.error(`❌ [OrderExecution] [${_ts()}] Error processing pending orders: ${error.message}`);
    }
};

module.exports = { processPendingOrders };
