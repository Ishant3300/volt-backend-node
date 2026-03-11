const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const tradeMetricsService = require('../services/tradeMetricsService');
const kiteService = require('../services/kiteService');
const TradeMargin = require('../models/TradeMargin');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const orderBookService = require('../services/orderBookService');
const { calculateMargin } = require('../services/marginService');
const firebaseService = require('../services/firebaseService');

const _getLivePricesFromKite = async (instrumentTokens) => {
    if (!instrumentTokens || instrumentTokens.length === 0) return new Map();
    try {
        const quotes = await kiteService.getLatestQuotes(instrumentTokens, 100);
        const ltpMap = new Map();
        quotes.forEach(q => {
            ltpMap.set(q.instrument_token, q.last_price);
        });
        return ltpMap;
    } catch (err) {
        console.error('Error fetching live quotes for metrics fallback:', err.message);
        return new Map();
    }
};

/**
 * Place a new trade order
 */
const placeTrade = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        const userId = req.user?.id || req.master?.id || req.admin?.id || req.body.user_id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized / User ID missing' });
        }

        const {
            instrument_token,
            tradingsymbol,
            exchange,
            transaction_type, // 'BUY' or 'SELL'
            quantity,
            price, // Usually 0 or market price for MARKET orders, specific price for LIMIT
            order_type, // 'MARKET', 'LIMIT'
        } = req.body;

        if (!['BUY', 'SELL'].includes(transaction_type)) {
            return res.status(400).json({ success: false, message: 'Invalid transaction_type' });
        }
        if (quantity <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid quantity' });
        }

        let resultTrade;

        await session.withTransaction(async () => {
            const user = await User.findById(userId).populate('master_id').session(session);
            if (!user) {
                throw new Error('User not found');
            }

            // 0. Options sell restriction: prevent naked short selling
            // Users can only SELL options they already own (to close a position)
            if (transaction_type === 'SELL') {
                const instrument = await require('../models/KiteInstrument').findOne({
                    instrument_token: instrument_token
                }).session(session);

                const isOption = instrument && ['CE', 'PE'].includes(instrument.instrument_type);

                if (isOption) {
                    // Calculate user's current net position for this exact instrument
                    const posAgg = await Trade.aggregate([
                        {
                            $match: {
                                user_id: user._id,
                                instrument_token: instrument_token,
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

                    const netQty = posAgg.length > 0
                        ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty
                        : 0;

                    if (netQty <= 0) {
                        throw new Error('Option selling is not allowed. You must own this option before you can sell it.');
                    }

                    if (quantity > netQty) {
                        throw new Error(`You can only sell up to ${netQty} units of this option (your current holding). Selling ${quantity} would create a short position.`);
                    }
                }
            }

            // 1. Determine execution price
            let executedPrice = price;
            let livePrice = null;

            // Fetch live price for comparison (needed for both MARKET fallback and LIMIT checks)
            const ltpMap = await _getLivePricesFromKite([parseInt(instrument_token)]);
            livePrice = ltpMap.get(parseInt(instrument_token)) || ltpMap.get(instrument_token.toString());

            if (order_type === 'MARKET') {
                // For MARKET orders, use the frontend-provided price; fall back to live price
                if (!executedPrice) {
                    executedPrice = livePrice;
                }
                if (!executedPrice) {
                    throw new Error('Could not determine price for MARKET order');
                }
            }

            // 2. For LIMIT orders, check if the condition is already met
            let shouldExecuteNow = false;
            if (order_type === 'MARKET') {
                shouldExecuteNow = true;
            } else if (order_type === 'LIMIT' && livePrice) {
                if (transaction_type === 'BUY' && livePrice <= executedPrice) {
                    shouldExecuteNow = true;
                } else if (transaction_type === 'SELL' && livePrice >= executedPrice) {
                    shouldExecuteNow = true;
                }
            }

            const tradeStatus = shouldExecuteNow ? 'completed' : 'pending';

            // 3. Calculate realised P&L if this trade closes (or partially closes) a position
            let realisedPnl = 0;
            let existingAgg = [];
            if (shouldExecuteNow) {
                // Aggregate existing completed trades for this instrument
                existingAgg = await Trade.aggregate([
                    {
                        $match: {
                            user_id: user._id,
                            instrument_token: instrument_token,
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
                            },
                            total_buy_value: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$transaction_type', 'BUY'] },
                                        { $multiply: ['$executed_quantity', '$executed_price'] },
                                        0
                                    ]
                                }
                            },
                            total_sell_value: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$transaction_type', 'SELL'] },
                                        { $multiply: ['$executed_quantity', '$executed_price'] },
                                        0
                                    ]
                                }
                            }
                        }
                    }
                ]).session(session);

                if (existingAgg.length > 0) {
                    const agg = existingAgg[0];
                    const prevNetQty = agg.total_buy_qty - agg.total_sell_qty;
                    const avgBuyPrice = agg.total_buy_qty > 0 ? agg.total_buy_value / agg.total_buy_qty : 0;
                    const avgSellPrice = agg.total_sell_qty > 0 ? agg.total_sell_value / agg.total_sell_qty : 0;

                    // Determine how many units this trade closes
                    if (transaction_type === 'SELL' && prevNetQty > 0) {
                        // Closing a long position (partially or fully)
                        const closingQty = Math.min(quantity, prevNetQty);
                        realisedPnl = (executedPrice - avgBuyPrice) * closingQty;
                    } else if (transaction_type === 'BUY' && prevNetQty < 0) {
                        // Closing a short position (partially or fully)
                        const closingQty = Math.min(quantity, Math.abs(prevNetQty));
                        realisedPnl = (avgSellPrice - executedPrice) * closingQty;
                    }
                }
            }

            const newTrade = new Trade({
                user_id: user._id,
                master_id: user.master_id._id,
                admin_id: user.server_id,
                instrument_token,
                tradingsymbol,
                exchange,
                transaction_type,
                quantity,
                price: executedPrice,
                order_type,
                status: tradeStatus,
                executed_at: shouldExecuteNow ? new Date() : null,
                executed_price: shouldExecuteNow ? executedPrice : null,
                executed_quantity: shouldExecuteNow ? quantity : 0,
                pnl: realisedPnl,
                brokerage: 0,
                taxes: 0,
                net_amount: realisedPnl
            });

            await newTrade.save({ session });

            // Calculate margin impact and update balance
            if (shouldExecuteNow) {
                // Determine previous net qty for this instrument
                let prevNetQtyForMargin = 0;
                if (existingAgg && existingAgg.length > 0) {
                    prevNetQtyForMargin = existingAgg[0].total_buy_qty - existingAgg[0].total_sell_qty;
                }
                const isBuy = transaction_type === 'BUY';
                const newNetQty = prevNetQtyForMargin + (isBuy ? quantity : -quantity);

                // Margin per unit at execution price
                const marginPerUnit = await calculateMargin(exchange, 1, executedPrice);

                const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
                const newMargin = Math.abs(newNetQty) * marginPerUnit;
                const marginDelta = newMargin - prevMargin; // +ve = more margin needed

                const balanceBefore = user.balance;
                const balanceChange = realisedPnl - marginDelta;

                // Block if insufficient balance for opening positions
                if (marginDelta > 0 && (user.balance + balanceChange) < 0) {
                    throw new Error(`Insufficient balance. Available: ₹${user.balance.toFixed(2)}, Required margin: ₹${marginDelta.toFixed(2)}`);
                }

                user.balance = user.balance + balanceChange;
                await user.save({ session });

                // Log transaction
                const tradeValue = executedPrice * quantity;
                const tx = new Transaction({
                    transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_T`,
                    userId: user._id,
                    userModel: 'User',
                    type: transaction_type,
                    status: 'SUCCESS',
                    amount: tradeValue,
                    referenceId: newTrade._id,
                    referenceModel: 'Trade',
                    balanceBefore,
                    balanceAfter: user.balance,
                    metadata: {
                        tradingsymbol,
                        quantity,
                        executedPrice,
                        order_type,
                        realisedPnl,
                        marginDelta,
                        balanceChange,
                        positionClosed: realisedPnl !== 0
                    }
                });
                await tx.save({ session });
            }

            resultTrade = newTrade;
        });

        session.endSession();

        // Register pending LIMIT orders in Redis order book (outside the DB transaction)
        if (resultTrade.status === 'pending' && resultTrade.order_type === 'LIMIT') {
            await orderBookService.addOrder(
                resultTrade._id.toString(),
                resultTrade.instrument_token,
                resultTrade.price,
                resultTrade.transaction_type
            );

            // Notify the user's Flutter client so Orders tab updates instantly
            const livePriceService = require('../services/livePriceService');
            livePriceService.broadcastToUser(userId.toString(), {
                type: 'trade_placed',
                trade_id: resultTrade._id.toString(),
                instrument_token: resultTrade.instrument_token,
                tradingsymbol: resultTrade.tradingsymbol,
                transaction_type: resultTrade.transaction_type,
                quantity: resultTrade.quantity,
                price: resultTrade.price,
                order_type: resultTrade.order_type,
                status: 'pending',
            });
        }

        const isPending = resultTrade.status === 'pending';
        const positionClosed = resultTrade.pnl !== 0;
        let message = isPending
            ? 'Limit order placed successfully (pending execution)'
            : 'Trade executed successfully';
        if (positionClosed) {
            message += ` | P&L: ${resultTrade.pnl >= 0 ? '+' : ''}${resultTrade.pnl.toFixed(2)}`;
        }

        res.status(201).json({
            success: true,
            message,
            data: resultTrade
        });

        // --- FCM Push Notifications (fire-and-forget, after response) ---
        try {
            const callerId = req.user?.id || req.master?.id || req.admin?.id;
            const targetUserId = resultTrade.user_id.toString();
            const callerIdStr = callerId?.toString();

            if (resultTrade.status === 'completed' && resultTrade.order_type === 'MARKET') {
                if (req.body.user_id && callerIdStr !== targetUserId) {
                    // Admin/Master placed trade on behalf of user
                    firebaseService.sendNotification(targetUserId, 'admin_order_execution', {
                        title: 'Trade Executed by Admin',
                        body: `${resultTrade.transaction_type} ${resultTrade.quantity} ${resultTrade.tradingsymbol} @ ₹${resultTrade.executed_price}`,
                        data: { trade_id: resultTrade._id.toString(), tradingsymbol: resultTrade.tradingsymbol },
                    });
                } else {
                    // User's own market order
                    firebaseService.sendNotification(targetUserId, 'market_order', {
                        title: `${resultTrade.transaction_type} Order Executed`,
                        body: `${resultTrade.quantity} ${resultTrade.tradingsymbol} @ ₹${resultTrade.executed_price}`,
                        data: { trade_id: resultTrade._id.toString(), tradingsymbol: resultTrade.tradingsymbol },
                    });
                }
            }
        } catch (fcmErr) {
            console.error('⚠️  [FCM] placeTrade notification error:', fcmErr.message);
        }
    } catch (error) {
        session.endSession();

        let statusCode = 500;
        if (error.message === 'User not found') statusCode = 404;
        else if (error.message.includes('Option selling is not allowed') || error.message.includes('would create a short position')) statusCode = 403;
        else if (error.message.includes('Insufficient balance')) statusCode = 400;
        else if (error.message.includes('Could not fetch') || error.message.includes('Invalid')) statusCode = 400;

        res.status(statusCode).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

/**
 * Get the current user's account metrics
 */
const getAccountMetrics = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id || req.admin?.id || req.body.user_id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // Usually, frontend has a WebSocket for live LTPs. Here we might fetch latest for all open positions.
        // So we first find all active instrument_tokens for this user.
        const trades = await Trade.find({ user_id: userId, status: 'completed' });
        const activeTokens = [...new Set(trades.map(t => t.instrument_token))];

        const ltpMap = await _getLivePricesFromKite(activeTokens.map(t => parseInt(t)));

        const metrics = await tradeMetricsService.getUserMetrics(userId, ltpMap);

        res.status(200).json({
            success: true,
            message: 'Metrics fetched successfully',
            data: metrics
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

/**
 * Get user's active and completed positions for local frontend metric calculation
 */
getPositions = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id || req.admin?.id || req.body.user_id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // For master/admin, optionally filter by user_id query param, otherwise show own trades
        let targetUserId = userId;
        if ((req.master || req.admin) && req.query.user_id) {
            targetUserId = req.query.user_id;
        }

        const trades = await Trade.find({ user_id: targetUserId, deleted_at: null }).sort({ executed_at: -1 });

        res.status(200).json({
            success: true,
            message: 'Positions fetched successfully',
            data: trades
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            data: null
        });
    }
}

/**
 * Get exchange margin rules for frontend calculation
 */
const getMargins = async (req, res) => {
    try {
        const margins = await TradeMargin.find({ deleted_at: null });

        res.status(200).json({
            success: true,
            message: 'Trade Margins fetched successfully',
            data: margins
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

/**
 * Cancel a pending limit order
 */
const cancelTrade = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id || req.admin?.id;
        const { tradeId } = req.params;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const trade = await Trade.findOne({ _id: tradeId, user_id: userId, deleted_at: null });

        if (!trade) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        if (trade.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel trade with status: ${trade.status}`
            });
        }

        // Update status in DB
        trade.status = 'cancelled';
        await trade.save();

        // Remove from Redis order book
        await orderBookService.removeOrder(
            trade._id.toString(),
            trade.instrument_token,
            trade.transaction_type
        );

        res.status(200).json({
            success: true,
            message: 'Order cancelled successfully',
            data: trade
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

/**
 * Soft-delete a trade (admin/master only)
 * Sends admin_order_deletion notification to the trade owner.
 */
const deleteTrade = async (req, res) => {
    try {
        const callerId = req.admin?.id || req.master?.id;
        const { tradeId } = req.params;

        if (!callerId) {
            return res.status(403).json({ success: false, message: 'Only admin/master can delete trades' });
        }

        const trade = await Trade.findById(tradeId);
        if (!trade || trade.deleted_at) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        trade.deleted_at = new Date();
        await trade.save();

        // If the trade was pending, also remove from Redis order book
        if (trade.status === 'pending') {
            try {
                await orderBookService.removeOrder(
                    trade._id.toString(),
                    trade.instrument_token,
                    trade.transaction_type
                );
            } catch (_) {}
        }

        res.status(200).json({ success: true, message: 'Trade deleted', data: trade });

        // FCM notification to trade owner
        try {
            const targetUserId = trade.user_id.toString();
            firebaseService.sendNotification(targetUserId, 'admin_order_deletion', {
                title: 'Trade Deleted by Admin',
                body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} has been deleted`,
                data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
            });
        } catch (fcmErr) {
            console.error('⚠️  [FCM] deleteTrade notification error:', fcmErr.message);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    placeTrade,
    cancelTrade,
    deleteTrade,
    getAccountMetrics,
    getPositions,
    getMargins
};
