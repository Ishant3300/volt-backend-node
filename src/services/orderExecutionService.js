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
    if (redisService.isAvailable()) return;

    try {
        const pendingTrades = await Trade.find({ status: 'pending', order_type: 'LIMIT' });

        if (pendingTrades.length === 0) return;

        // Collect distinct instrument tokens
        const tokenSet = new Set(pendingTrades.map(t => parseInt(t.instrument_token)));
        const tokenArray = [...tokenSet];

        const ltpMap = await _getLivePrices(tokenArray);

        if (ltpMap.size === 0) {
            // Could not fetch any prices, skip this cycle
            return;
        }

        let executedCount = 0;

        for (const trade of pendingTrades) {
            const livePrice = ltpMap.get(parseInt(trade.instrument_token));
            if (!livePrice) continue; // No price available for this instrument

            let shouldExecute = false;

            if (trade.order_type === 'SL' || trade.order_type === 'SL-M') {
                // Stop-Loss: BUY triggers when price >= trigger, SELL triggers when price <= trigger
                if (trade.transaction_type === 'BUY' && livePrice >= trade.price) {
                    shouldExecute = true;
                } else if (trade.transaction_type === 'SELL' && livePrice <= trade.price) {
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
                const session = await mongoose.startSession();
                let tradeWriteLease = null;
                try {
                    tradeWriteLease = await beginTradeWrite('db_limit_execution');
                    await session.withTransaction(async () => {
                        await tradeWriteLease.assertActive({ session });
                        // Idempotency: re-check status before executing
                        const freshTrade = await Trade.findById(trade._id).session(session);
                        if (!freshTrade || freshTrade.status !== 'pending') return;

                        // Calculate realised P&L using FIFO (matches /trade/report PDF logic)
                        let realisedPnl = 0;

                        // Fetch all previous completed trades chronologically for FIFO queue
                        const prevTrades = await Trade.find({
                            user_id: freshTrade.user_id,
                            instrument_token: freshTrade.instrument_token,
                            status: 'completed',
                            deleted_at: null
                        }).sort({ executed_at: 1 }).session(session);

                        // Build FIFO queue of open lots (supports both long and short)
                        const fifoQueue = [];
                        let netQtyFromPrev = 0; // positive = long, negative = short

                        // Wallet release basis (avgBuy/avgSell) needs to reset every time the
                        // position last returned to flat — same bug and same fix as
                        // priceQueueService.js's positionStateSinceLastFlat: an unbounded sum
                        // since last settlement blends in an already-closed prior round trip's
                        // prices into "today's" entry basis. Net qty itself (sinceFlat*Qty
                        // below) doesn't need this treatment — a full round trip's buys and
                        // sells cancel out in a plain qty sum regardless of order, so only the
                        // VALUE-weighted average is at risk, not the position size.
                        let sinceFlatBuyQty = 0, sinceFlatSellQty = 0, sinceFlatBuyValue = 0, sinceFlatSellValue = 0;

                        for (const pt of prevTrades) {
                            const isBuy = pt.transaction_type === 'BUY';
                            const qty = pt.executed_quantity;
                            const price = pt.executed_price;
                            const prevNet = netQtyFromPrev;

                            const isOpening = (isBuy && prevNet >= 0) || (!isBuy && prevNet <= 0);
                            const isClosing = (isBuy && prevNet < 0) || (!isBuy && prevNet > 0);

                            if (isOpening && !isClosing) {
                                fifoQueue.push({ qty, price, side: isBuy ? 'BUY' : 'SELL' });
                            } else if (isClosing) {
                                let remaining = Math.min(qty, Math.abs(prevNet));
                                while (remaining > 0 && fifoQueue.length > 0) {
                                    const front = fifoQueue[0];
                                    const matched = Math.min(remaining, front.qty);
                                    front.qty -= matched;
                                    remaining -= matched;
                                    if (front.qty <= 0) fifoQueue.shift();
                                }
                                const excess = qty - Math.abs(prevNet);
                                if (excess > 0) {
                                    fifoQueue.push({ qty: excess, price, side: isBuy ? 'BUY' : 'SELL' });
                                }
                            }

                            netQtyFromPrev += isBuy ? qty : -qty;

                            if (isBuy) {
                                sinceFlatBuyQty += qty;
                                sinceFlatBuyValue += qty * price;
                            } else {
                                sinceFlatSellQty += qty;
                                sinceFlatSellValue += qty * price;
                            }
                            if (netQtyFromPrev === 0) {
                                sinceFlatBuyQty = 0; sinceFlatSellQty = 0;
                                sinceFlatBuyValue = 0; sinceFlatSellValue = 0;
                            }
                        }

                        // Compute FIFO P&L for this closing trade
                        if (freshTrade.transaction_type === 'SELL' && netQtyFromPrev > 0) {
                            const closingQty = Math.min(freshTrade.quantity, netQtyFromPrev);
                            let remaining = closingQty;
                            while (remaining > 0 && fifoQueue.length > 0) {
                                const front = fifoQueue[0];
                                const matched = Math.min(remaining, front.qty);
                                realisedPnl += (freshTrade.price - front.price) * matched;
                                front.qty -= matched;
                                remaining -= matched;
                                if (front.qty <= 0) fifoQueue.shift();
                            }
                        } else if (freshTrade.transaction_type === 'BUY' && netQtyFromPrev < 0) {
                            const closingQty = Math.min(freshTrade.quantity, Math.abs(netQtyFromPrev));
                            let remaining = closingQty;
                            while (remaining > 0 && fifoQueue.length > 0) {
                                const front = fifoQueue[0];
                                const matched = Math.min(remaining, front.qty);
                                realisedPnl += (front.price - freshTrade.price) * matched;
                                front.qty -= matched;
                                remaining -= matched;
                                if (front.qty <= 0) fifoQueue.shift();
                            }
                        }
                        realisedPnl = Math.round(realisedPnl * 100) / 100;

                        // Net position and wallet-release basis both derive from prevTrades,
                        // already walked above — no second query needed. Net qty is the plain
                        // (unbounded-since-settlement) sum, which is correct as-is; the
                        // avgBuy/avgSell used for the wallet release basis below use the
                        // flat-reset totals instead, for the reason explained above.
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
                            .select('segment').session(session).lean();
                        const walletCategory = categoryForSegment(walletInstrument?.segment || freshTrade.exchange || '');

                        const { closingQty: walletClosingQty, openingQty: walletOpeningQty } =
                            computeWalletSplit(prevNetQtyCheck, freshTrade.transaction_type, freshTrade.quantity);
                        const walletAvgBuy = sinceFlatBuyQty > 0 ? sinceFlatBuyValue / sinceFlatBuyQty : 0;
                        const walletAvgSell = sinceFlatSellQty > 0 ? sinceFlatSellValue / sinceFlatSellQty : 0;
                        // Closed long lots release at avgBuy; closed short lots at avgSell.
                        const walletReleaseBasis = prevNetQtyCheck > 0 ? walletAvgBuy : walletAvgSell;
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

                        // Execute the trade
                        freshTrade.status = 'completed';
                        freshTrade.executed_at = new Date();
                        freshTrade.executed_price = freshTrade.price;
                        freshTrade.executed_quantity = freshTrade.quantity;
                        freshTrade.pnl = realisedPnl;
                        freshTrade.net_amount = realisedPnl;
                        await freshTrade.save({ session });

                        // Calculate margin impact and update balance
                        const prevNetQtyForMargin = prevNetQtyCheck;
                        const isBuy = freshTrade.transaction_type === 'BUY';
                        const newNetQty = prevNetQtyForMargin + (isBuy ? freshTrade.quantity : -freshTrade.quantity);
                        const marginPerUnit = await calculateMargin(freshTrade.exchange, 1, freshTrade.price);
                        const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
                        const newMargin = Math.abs(newNetQty) * marginPerUnit;
                        // NOTE: marginDelta is now notional — persisted equity interaction
                        // pending review (see Task 5 flag). calculateMargin returns |qty|×price
                        // after Task 3, so this still subtracts a notional-sized amount from the
                        // PERSISTED user.equity running balance. Kept byte-for-byte for parity
                        // with placeTrade / priceQueueService; flagged for user review.
                        const marginDelta = newMargin - prevMargin;
                        const balanceChange = realisedPnl - marginDelta;

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
                    console.log(`✅ [OrderExecution/Fallback] Executed ${trade.transaction_type} LIMIT for ${trade.tradingsymbol} @ ${trade.price} (live: ${livePrice})`);

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
                        console.error(`❌ [OrderExecution] Session error for trade ${trade._id}:`, sessionErr.message);
                    }
                }
            }
        }

        if (executedCount > 0) {
            console.log(`📊 [OrderExecution/Fallback] Executed ${executedCount} pending limit order(s) this cycle.`);
        }
    } catch (error) {
        console.error('[OrderExecution] Error processing pending orders:', error.message);
    }
};

module.exports = { processPendingOrders };
