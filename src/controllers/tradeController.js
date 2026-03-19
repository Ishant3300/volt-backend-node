const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const KiteInstrument = require('../models/KiteInstrument');
const BrokerageSettings = require('../models/BrokerageSettings');
const tradeMetricsService = require('../services/tradeMetricsService');
const kiteService = require('../services/kiteService');
const TradeMargin = require('../models/TradeMargin');
const ScriptQuantity = require('../models/ScriptQuantity');
const GroupedQuantity = require('../models/GroupedQuantity');
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
        // #8 FIX: When admin places trade for a user, use req.body.user_id as the target, not the admin's own ID.
        const callerId = req.user?.id || req.master?.id || req.admin?.id;
        const targetUserId = (req.body.user_id && req.admin) ? req.body.user_id : (req.body.user_id || callerId);
        if (!targetUserId) {
            return res.status(401).json({ success: false, message: 'Unauthorized / User ID missing' });
        }
        // Admin must always specify a user_id — admin is not a User and cannot trade for themselves
        if (req.admin && !req.body.user_id) {
            return res.status(400).json({ success: false, message: 'Admin must select a user to place a trade on their behalf. Please search and select a user first.' });
        }

        const {
            instrument_token,
            tradingsymbol,
            exchange,
            transaction_type, // 'BUY' or 'SELL'
            quantity,
            price, // Usually 0 or market price for MARKET orders, specific price for LIMIT
            order_type, // 'MARKET', 'LIMIT'
            segment,   // e.g. NFO-FUT, MCX-FUT — sent by Flutter for accurate limit lookup
        } = req.body;

        if (!['BUY', 'SELL'].includes(transaction_type)) {
            return res.status(400).json({ success: false, message: 'Invalid transaction_type' });
        }
        if (quantity <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid quantity' });
        }

        // #1 FIX: Circuit limit check for LIMIT orders (before DB transaction to fail fast)
        if (order_type === 'LIMIT' && price) {
            const kiteInst = await KiteInstrument.findOne({ instrument_token });
            if (kiteInst) {
                const upper = kiteInst.upper_circuit_limit;
                const lower = kiteInst.lower_circuit_limit;
                if (upper && upper > 0 && price > upper) {
                    return res.status(400).json({ success: false, message: `Limit price ₹${price} exceeds upper circuit limit ₹${upper}` });
                }
                if (lower && lower > 0 && price < lower) {
                    return res.status(400).json({ success: false, message: `Limit price ₹${price} is below lower circuit limit ₹${lower}` });
                }
            }
        }

        let resultTrade;

        await session.withTransaction(async () => {
            const user = await User.findById(targetUserId).populate('master_id').session(session);
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

            // 1.5 Limit validation — break_qty applies to BUY & SELL; max_qty + balance only for BUY
            // turnover:true  → max_qty/break_qty are in raw QUANTITY, compare directly
            // lot:true       → max_qty/break_qty are in LOTS, convert quantity→lots first
            {
                // Use segment if provided (e.g. NFO-FUT) — more specific than exchange (NFO).
                // This is critical: exchanges_allowed stores NFO-FUT not NFO.
                const rawSegment = (segment || exchange || '').toUpperCase();
                const normalizedExchange = rawSegment === 'GLOBAL' ? 'INDICES' : rawSegment;
                const userExchange = user.exchanges_allowed?.find(ex => ex.exchange_name.toUpperCase() === normalizedExchange);
                const groupName = userExchange?.group_name;

                // Determine mode from user's exchange config
                const isTurnover = userExchange?.turnover === true;
                const isLotMode  = userExchange?.lot === true;

                let limitValue = null; // max_qty from DB (qty or lots depending on mode)
                let breakValue = 0;   // break_qty from DB (qty or lots depending on mode)
                let lotSize = 1;

                const kiteInst = await KiteInstrument.findOne({ instrument_token });
                if (kiteInst?.lot_size) lotSize = kiteInst.lot_size;

                if (groupName) {
                    let groupQty = await GroupedQuantity.findOne({
                        exchange_name: normalizedExchange,
                        lot_name: groupName,
                        instrument_symbol: tradingsymbol,
                        deleted_at: null
                    }).session(session);

                    if (!groupQty) {
                        groupQty = await GroupedQuantity.findOne({
                            exchange_name: normalizedExchange,
                            lot_name: groupName,
                            instrument_id: instrument_token,
                            deleted_at: null
                        }).session(session);
                    }

                    if (groupQty) {
                        limitValue = groupQty.max_qty;
                        breakValue = groupQty.break_qty || 0;
                        if (groupQty.lot_size) {
                            lotSize = groupQty.lot_size;
                        }
                    }
                }

                if (limitValue === null) {
                    const scriptQty = await ScriptQuantity.findOne({
                        exchange_name: normalizedExchange,
                        script_name: tradingsymbol,
                        deleted_at: null
                    }).session(session);
                    if (scriptQty) {
                        limitValue = scriptQty.max_qty;
                        breakValue = scriptQty.brk_qty || 0;
                        if (scriptQty.lot_size) {
                            lotSize = scriptQty.lot_size;
                        }
                    }
                }

                if (isTurnover) {
                    // ── TURNOVER MODE: all limits are in raw quantity ──────────────────
                    // VALIDATION 1: break_qty per single order
                    if (breakValue > 0 && quantity > breakValue) {
                        throw new Error(
                            `Order size exceeds breakup limit. Max qty per order: ${breakValue}, Requested: ${quantity}. Please split your order.`
                        );
                    }

                    if (transaction_type === 'BUY' && limitValue !== null && limitValue > 0) {
                        const posAgg = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: {
                                _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);

                        const currentNetQty = posAgg.length > 0 ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty : 0;
                        const remainingQty = Math.max(0, limitValue - currentNetQty);

                        // VALIDATION 2: max position check
                        if (quantity > remainingQty) {
                            throw new Error(
                                `Order exceeds maximum position limit. Max: ${limitValue} qty, Current: ${currentNetQty} qty, Remaining: ${remainingQty} qty, Requested: ${quantity} qty.`
                            );
                        }

                        // VALIDATION 3: balance / margin check
                        let priceForMargin = price;
                        if (!priceForMargin || priceForMargin <= 0) {
                            const ltpMapForMargin = await _getLivePricesFromKite([parseInt(instrument_token)]);
                            priceForMargin = ltpMapForMargin.get(parseInt(instrument_token)) || ltpMapForMargin.get(instrument_token.toString());
                        }
                        if (!priceForMargin || priceForMargin <= 0) {
                            throw new Error('Could not determine price for margin calculation');
                        }

                        const marginPerUnit = await calculateMargin(normalizedExchange, 1, priceForMargin);
                        const availableBalance = user.balance || 0;
                        const maxAffordableQty = marginPerUnit > 0 ? Math.floor(availableBalance / marginPerUnit) : remainingQty;
                        const effectiveMaxQty = Math.min(remainingQty, maxAffordableQty);

                        if (quantity > effectiveMaxQty) {
                            const requiredMargin = quantity * marginPerUnit;
                            if (maxAffordableQty === 0) {
                                throw new Error(`Insufficient margin to place even 1 unit. Available: ₹${availableBalance.toFixed(2)}, Required per unit: ₹${marginPerUnit.toFixed(2)}.`);
                            } else {
                                throw new Error(
                                    `Insufficient balance for ${quantity} qty. Available: ₹${availableBalance.toFixed(2)}, Required: ₹${requiredMargin.toFixed(2)}. Max affordable: ${maxAffordableQty} qty.`
                                );
                            }
                        }
                    }

                } else if (isLotMode) {
                    // ── LOT MODE: all limits are in lots ──────────────────────────────
                    const requestedLots = Math.ceil(quantity / lotSize);

                    // VALIDATION 1: break_qty per single order (in lots)
                    if (breakValue > 0 && requestedLots > breakValue) {
                        throw new Error(
                            `Order size exceeds breakup limit. Max lots per order: ${breakValue}, Requested: ${requestedLots} lot(s). Please split your order.`
                        );
                    }

                    if (transaction_type === 'BUY' && limitValue !== null && limitValue > 0) {
                        const posAgg = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: {
                                _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);

                        const currentNetQty = posAgg.length > 0 ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty : 0;
                        const currentLots = Math.floor(Math.abs(currentNetQty) / lotSize);
                        const remainingLots = Math.max(0, limitValue - currentLots);

                        // VALIDATION 2: max position check (in lots)
                        if (requestedLots > remainingLots) {
                            throw new Error(
                                `Order exceeds maximum position limit. Max: ${limitValue} lot(s), Current: ${currentLots} lot(s), Remaining: ${remainingLots} lot(s), Requested: ${requestedLots} lot(s).`
                            );
                        }

                        // VALIDATION 3: balance / margin check
                        let priceForMargin = price;
                        if (!priceForMargin || priceForMargin <= 0) {
                            const ltpMapForMargin = await _getLivePricesFromKite([parseInt(instrument_token)]);
                            priceForMargin = ltpMapForMargin.get(parseInt(instrument_token)) || ltpMapForMargin.get(instrument_token.toString());
                        }
                        if (!priceForMargin || priceForMargin <= 0) {
                            throw new Error('Could not determine price for margin calculation');
                        }

                        const marginPerLot = await calculateMargin(normalizedExchange, lotSize, priceForMargin);
                        const availableBalance = user.balance || 0;
                        const maxAffordableLots = marginPerLot > 0 ? Math.floor(availableBalance / marginPerLot) : remainingLots;
                        const effectiveMaxLots = Math.min(remainingLots, maxAffordableLots);

                        if (requestedLots > effectiveMaxLots) {
                            const requiredMargin = requestedLots * marginPerLot;
                            if (maxAffordableLots === 0) {
                                throw new Error(`Insufficient margin to place even 1 lot. Available: ₹${availableBalance.toFixed(2)}, Required per lot: ₹${marginPerLot.toFixed(2)}.`);
                            } else {
                                throw new Error(
                                    `Insufficient balance for ${requestedLots} lot(s). Available: ₹${availableBalance.toFixed(2)}, Required: ₹${requiredMargin.toFixed(2)}. Max affordable: ${maxAffordableLots} lot(s).`
                                );
                            }
                        }
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
                // Fetch all previous completed trades for this instrument in chronological order (FIFO)
                const prevTrades = await Trade.find({
                    user_id: user._id,
                    instrument_token: instrument_token,
                    status: 'completed',
                    deleted_at: null
                }).sort({ executed_at: 1 }).session(session);

                // Build FIFO queue of open lots
                // Each entry: { qty, price }
                const fifoQueue = [];
                let netQtyFromPrev = 0;

                for (const pt of prevTrades) {
                    if (pt.transaction_type === 'BUY') {
                        fifoQueue.push({ qty: pt.executed_quantity, price: pt.executed_price });
                        netQtyFromPrev += pt.executed_quantity;
                    } else {
                        // SELL: consume from FIFO queue
                        let remaining = pt.executed_quantity;
                        while (remaining > 0 && fifoQueue.length > 0) {
                            const front = fifoQueue[0];
                            if (front.qty <= remaining) {
                                remaining -= front.qty;
                                fifoQueue.shift();
                            } else {
                                front.qty -= remaining;
                                remaining = 0;
                            }
                        }
                        netQtyFromPrev -= pt.executed_quantity;
                    }
                }

                // Also build aggregate for margin calculation (still needed)
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

                // Calculate P&L using FIFO
                if (transaction_type === 'SELL' && netQtyFromPrev > 0) {
                    // Closing a long position: match against FIFO buy queue
                    let closingQty = Math.min(quantity, netQtyFromPrev);
                    let remaining = closingQty;
                    const tempQueue = fifoQueue.map(e => ({ ...e })); // clone
                    while (remaining > 0 && tempQueue.length > 0) {
                        const front = tempQueue[0];
                        const matched = Math.min(front.qty, remaining);
                        realisedPnl += (executedPrice - front.price) * matched;
                        front.qty -= matched;
                        remaining -= matched;
                        if (front.qty === 0) tempQueue.shift();
                    }
                } else if (transaction_type === 'BUY' && netQtyFromPrev < 0) {
                    // Closing a short position: use avg sell price from aggregate
                    const agg = existingAgg.length > 0 ? existingAgg[0] : null;
                    const avgSellPrice = agg && agg.total_sell_qty > 0 ? agg.total_sell_value / agg.total_sell_qty : 0;
                    const closingQty = Math.min(quantity, Math.abs(netQtyFromPrev));
                    realisedPnl = (avgSellPrice - executedPrice) * closingQty;
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

                const normalizedExchange = exchange.toUpperCase() === 'GLOBAL' ? 'INDICES' : exchange.toUpperCase();
                // Margin per unit at execution price
                const marginPerUnit = await calculateMargin(normalizedExchange, 1, executedPrice);

                const prevMargin = Math.abs(prevNetQtyForMargin) * marginPerUnit;
                const newMargin = Math.abs(newNetQty) * marginPerUnit;
                const marginDelta = newMargin - prevMargin; // +ve = more margin needed

                // #7 FIX: Block if free margin goes negative (balance - currentMargin - newMarginDelta < 0)
                if (marginDelta > 0) {
                    const freeMargin = user.balance - prevMargin;
                    if (freeMargin < marginDelta) {
                        throw new Error(`Insufficient free margin. Free: ₹${freeMargin.toFixed(2)}, Required: ₹${marginDelta.toFixed(2)}`);
                    }
                }

                // #5 FIX: Calculate brokerage using BrokerageSettings
                let brokerage = 0;
                try {
                    const brokerageRule = await BrokerageSettings.findOne({
                        exchange_name: normalizedExchange,
                        script_name: tradingsymbol,
                        deleted_at: null
                    });
                    if (brokerageRule) {
                        if (brokerageRule.type === 'TURNOVER WISE') {
                            brokerage = (executedPrice * quantity) * (brokerageRule.brk_value / 100);
                        } else if (brokerageRule.type === 'LOT WISE') {
                            let lotSizeForBrokerage = 1;
                            const kiteInstForBrk = await KiteInstrument.findOne({ instrument_token });
                            if (kiteInstForBrk && kiteInstForBrk.lot_size) {
                                lotSizeForBrokerage = kiteInstForBrk.lot_size;
                            } else {
                                const lotSizeDoc = await ScriptQuantity.findOne({ exchange_name: normalizedExchange, script_name: tradingsymbol, deleted_at: null });
                                lotSizeForBrokerage = lotSizeDoc?.lot_size || 1;
                            }
                            const lots = quantity / lotSizeForBrokerage;
                            brokerage = lots * brokerageRule.brk_value;
                        }
                    }
                } catch (brErr) {
                    console.warn('[Brokerage] Could not calculate brokerage:', brErr.message);
                }

                const balanceBefore = user.balance;
                const balanceChange = realisedPnl - marginDelta - brokerage;

                user.balance = user.balance + balanceChange;
                newTrade.brokerage = brokerage;
                newTrade.net_amount = realisedPnl - brokerage;
                await newTrade.save({ session });
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
                        brokerage,
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

        // Enrich trades with lot_size from KiteInstrument so Flutter can display lots vs qty
        const KiteInstrument = require('../models/KiteInstrument');
        const uniqueTokens = [...new Set(trades.map(t => t.instrument_token))];
        const instruments = await KiteInstrument.find({ instrument_token: { $in: uniqueTokens } }, 'instrument_token lot_size segment');
        const lotSizeMap = {};
        instruments.forEach(inst => {
            lotSizeMap[inst.instrument_token] = { lot_size: inst.lot_size || 1, segment: inst.segment || '' };
        });

        const enrichedTrades = trades.map(t => {
            const plain = t.toJSON();
            const info = lotSizeMap[t.instrument_token] || { lot_size: 1, segment: '' };
            plain.lot_size = info.lot_size || 1;
            plain.segment = info.segment;
            return plain;
        });

        res.status(200).json({
            success: true,
            message: 'Positions fetched successfully',
            data: enrichedTrades
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
            } catch (_) { }
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
