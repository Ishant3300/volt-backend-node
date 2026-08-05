const Trade = require('../models/Trade');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const mongoose = require('mongoose');
const kiteService = require('./kiteService');
const orderBookService = require('./orderBookService');
const redisService = require('./redisService');
const { calculateMargin } = require('./marginService');
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

                        // Aggregate still needed for margin calculation and free margin check
                        const existingAgg = await Trade.aggregate([
                            {
                                $match: {
                                    user_id: freshTrade.user_id,
                                    instrument_token: freshTrade.instrument_token,
                                    status: 'completed',
                                    deleted_at: null
                                }
                            },
                            {
                                $group: {
                                    _id: null,
                                    total_buy_qty: {
                                        $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
                                    },
                                    total_sell_qty: {
                                        $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
                                    }
                                }
                            }
                        ]).session(session);

                        // ── Free margin check for opening LIMIT orders ──
                        const prevNetQtyCheck = existingAgg.length > 0 ? existingAgg[0].total_buy_qty - existingAgg[0].total_sell_qty : 0;
                        const afterNetQtyCheck = freshTrade.transaction_type === 'BUY' ? prevNetQtyCheck + freshTrade.quantity : prevNetQtyCheck - freshTrade.quantity;
                        const isOpeningLimitTrade = Math.abs(afterNetQtyCheck) > Math.abs(prevNetQtyCheck);

                        if (isOpeningLimitTrade) {
                            const metricsEngine = require('./metricsEngine');
                            const freshMetrics = await metricsEngine.getFreshMetrics(freshTrade.user_id.toString());
                            if (freshMetrics && freshMetrics.free_margin < 0) {
                                freshTrade.status = 'cancelled';
                                freshTrade.remarks = 'Insufficient free margin when limit order triggered';
                                await freshTrade.save({ session });

                                // Save rejection log
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
                                        remarks: `Insufficient free margin (₹${freshMetrics.free_margin.toFixed(2)}). Limit order cancelled.`,
                                    }], { session });
                                } catch (_) {}

                                console.log(`⚠️ [OrderExecution] Cancelled ${freshTrade.tradingsymbol} LIMIT — insufficient free margin (₹${freshMetrics.free_margin.toFixed(2)})`);
                                return;
                            }
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
                        let prevNetQtyForMargin = 0;
                        if (existingAgg.length > 0) {
                            prevNetQtyForMargin = existingAgg[0].total_buy_qty - existingAgg[0].total_sell_qty;
                        }
                        const isBuy = freshTrade.transaction_type === 'BUY';
                        const newNetQty = prevNetQtyForMargin + (isBuy ? freshTrade.quantity : -freshTrade.quantity);
                        const marginPerUnit = await calculateMargin(freshTrade.exchange, 1, freshTrade.price);
                        const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
                        const newMargin = Math.abs(newNetQty) * marginPerUnit;
                        const marginDelta = newMargin - prevMargin;
                        const balanceChange = realisedPnl - marginDelta;

                        const user = await User.findById(freshTrade.user_id).session(session);
                        if (user) {
                            // Skip trade if insufficient balance for opening positions
                            if (marginDelta > 0 && (user.equity + balanceChange) < 0) {
                                // Revert trade status
                                freshTrade.status = 'rejected';
                                freshTrade.pnl = 0;
                                freshTrade.net_amount = 0;
                                await freshTrade.save({ session });
                                console.log(`⚠️ [OrderExecution] Rejected ${freshTrade.tradingsymbol} - insufficient balance (need ₹${marginDelta.toFixed(2)}, have ₹${user.equity.toFixed(2)})`);
                                return;
                            }

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
