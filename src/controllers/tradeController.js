const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const KiteInstrument = require('../models/KiteInstrument');
const BrokerageSettings = require('../models/BrokerageSettings');
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
 * Compute floating P&L for a user's open positions using live LTP.
 * Returns the total unrealised P&L across all open instruments.
 */
const _computeUserFloatingPnl = async (userId, session) => {
    try {
        const trades = await Trade.aggregate([
            { $match: { user_id: userId, status: 'completed', deleted_at: null } },
            { $group: {
                _id: '$instrument_token',
                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
            }}
        ]).session(session);

        // Filter to open positions only
        const openPositions = trades.filter(t => (t.total_buy_qty - t.total_sell_qty) !== 0);
        if (openPositions.length === 0) return 0;

        // Fetch live prices for open position tokens
        const tokens = openPositions.map(p => parseInt(p._id));
        const ltpMap = await _getLivePricesFromKite(tokens);

        let totalFloating = 0;
        for (const pos of openPositions) {
            const netQty = pos.total_buy_qty - pos.total_sell_qty;
            const avgBuy = pos.total_buy_qty > 0 ? pos.total_buy_value / pos.total_buy_qty : 0;
            const avgSell = pos.total_sell_qty > 0 ? pos.total_sell_value / pos.total_sell_qty : 0;
            const ltp = ltpMap.get(parseInt(pos._id)) || ltpMap.get(pos._id.toString()) || (netQty > 0 ? avgBuy : avgSell);

            if (netQty > 0) totalFloating += (ltp - avgBuy) * netQty;
            else if (netQty < 0) totalFloating += (avgSell - ltp) * Math.abs(netQty);
        }
        return Math.round(totalFloating * 100) / 100;
    } catch (err) {
        console.error('Error computing floating P&L:', err.message);
        return 0; // Fallback: assume 0 floating if computation fails
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

            // Compute live equity and free margin for margin check.
            // ALWAYS use metricsEngine (single source of truth — same as orders page UI).
            // equity = credit + m2mPnl
            // freeMargin = equity - marginUsed
            let liveEquity;
            let liveFreeMargin;
            const metricsEngine = require('../services/metricsEngine');
            const freshMetrics = await metricsEngine.getFreshMetrics(user._id.toString());
            if (freshMetrics) {
                liveEquity = freshMetrics.equity;
                liveFreeMargin = freshMetrics.free_margin;
            } else {
                // User has no trades at all — equity = freeMargin = credits
                liveEquity = user.credits || 0;
                liveFreeMargin = user.credits || 0;
            }

            // ── Early free margin warning for LIMIT orders ──
            // Inform user gracefully before any other validation
            if (!req.admin && order_type === 'LIMIT' && liveFreeMargin < 0) {
                throw new Error(`Your free margin is negative (₹${liveFreeMargin.toFixed(2)}). Please close existing positions or add funds before placing limit orders.`);
            }

            // ── BET check: if bet is OFF, user cannot trade at all (BUY or SELL) ──
            // Admin placing on behalf of user bypasses this check
            if (!req.admin && user.bet === false) {
                throw new Error('Trading is currently disabled for your account.');
            }

            // ── Instrument enabled check: if instrument is disabled, only closing trades allowed ──
            // ── Instrument deleted check: if instrument is deleted, block ALL trades ──
            if (!req.admin) {
                const instCheck = await KiteInstrument.findOne({ instrument_token }).select('enabled deleted_at').lean().session(session);
                if (instCheck && instCheck.deleted_at) {
                    throw new Error('Admin has deactivated this script. Trading is not allowed.');
                }
                if (instCheck && instCheck.enabled === false) {
                    // Check if this trade is closing an existing position
                    const posAggEnabled = await Trade.aggregate([
                        { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                        { $group: {
                            _id: null,
                            total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                            total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                        }}
                    ]).session(session);

                    const currentNetQtyEnabled = posAggEnabled.length > 0
                        ? posAggEnabled[0].total_buy_qty - posAggEnabled[0].total_sell_qty
                        : 0;

                    const isClosingEnabled = (transaction_type === 'SELL' && currentNetQtyEnabled > 0) ||
                                             (transaction_type === 'BUY' && currentNetQtyEnabled < 0);

                    // Allow closing up to the net position qty, block anything beyond
                    if (!isClosingEnabled) {
                        throw new Error('This instrument has been disabled by admin. You cannot open new positions on this script.');
                    }

                    // If closing, check that quantity doesn't exceed net position (no new position beyond close)
                    const absNetQtyEnabled = Math.abs(currentNetQtyEnabled);
                    if (quantity > absNetQtyEnabled) {
                        throw new Error(`This instrument is disabled. You can only close your existing ${absNetQtyEnabled} qty position. Cannot open new positions on this script.`);
                    }
                }
            }

            // ── Close Only check: if close_only is ON, user can only close existing positions (not open new ones) ──
            // Admin placing on behalf of user bypasses this check
            if (!req.admin && user.close_only === true) {
                // Determine if this trade is closing an existing position
                const posAggForCloseOnly = await Trade.aggregate([
                    { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                    { $group: {
                        _id: null,
                        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                    }}
                ]).session(session);

                const currentNetQty = posAggForCloseOnly.length > 0
                    ? posAggForCloseOnly[0].total_buy_qty - posAggForCloseOnly[0].total_sell_qty
                    : 0;

                const isClosing = (transaction_type === 'SELL' && currentNetQty > 0) ||
                                  (transaction_type === 'BUY' && currentNetQty < 0);

                if (!isClosing) {
                    throw new Error('Your account is in close-only mode. You can only close existing positions.');
                }
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
            let instrumentRawName = null; // resolved inside block, used later for margin calc
            {
                // Use segment if provided (e.g. NFO-FUT) — more specific than exchange (NFO).
                // This is critical: exchanges_allowed stores NFO-FUT not NFO.
                const rawSegment = (segment || exchange || '').toUpperCase();
                const normalizedExchange = rawSegment === 'GLOBAL' ? 'INDICES' : rawSegment;
                const userExchange = user.exchanges_allowed?.find(ex => ex.exchange_name.toUpperCase() === normalizedExchange);

                // Determine mode from user's exchange config
                const isTurnover = userExchange?.turnover === true;
                const isLotMode  = userExchange?.lot === true;

                let limitValue = null; // max_qty from DB (qty or lots depending on mode)
                let breakValue = 0;   // break_qty from DB (qty or lots depending on mode)
                let lotSize = 1;

                const kiteInst = await KiteInstrument.findOne({ instrument_token });
                if (kiteInst?.lot_size) lotSize = kiteInst.lot_size;
                instrumentRawName = kiteInst?.raw_name || kiteInst?.name || null;

                // Lookup from ScriptQuantity with user's owner_id (always exists — created with user)
                {
                    let scriptQty = null;
                    if (instrumentRawName) {
                        scriptQty = await ScriptQuantity.findOne({
                            owner_id: user._id,
                            exchange_name: normalizedExchange,
                            script_name: instrumentRawName,
                            deleted_at: null
                        }).session(session);
                    }
                    if (!scriptQty) {
                        scriptQty = await ScriptQuantity.findOne({
                            owner_id: user._id,
                            exchange_name: normalizedExchange,
                            script_name: tradingsymbol,
                            deleted_at: null
                        }).session(session);
                    }
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

                    // Determine if this is a closing trade (square-off) — closing trades bypass breakup limit
                    let isClosingForBreakup = false;
                    {
                        const posAggBrk = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: { _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);
                        const netQtyBrk = posAggBrk.length > 0 ? posAggBrk[0].total_buy_qty - posAggBrk[0].total_sell_qty : 0;
                        isClosingForBreakup = (transaction_type === 'SELL' && netQtyBrk > 0) || (transaction_type === 'BUY' && netQtyBrk < 0);
                    }

                    // VALIDATION 1: break_qty per single order (skip for closing/square-off trades)
                    if (!isClosingForBreakup && breakValue > 0 && quantity > breakValue) {
                        throw new Error(
                            `Order size exceeds breakup limit. Max qty per order: ${breakValue}, Requested: ${quantity}. Please split your order.`
                        );
                    }

                    if (limitValue !== null && limitValue > 0) {
                        const posAgg = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: {
                                _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);

                        const currentNetQty = posAgg.length > 0 ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty : 0;
                        // Calculate what net position would be after this trade
                        const afterNetQty = transaction_type === 'BUY' ? currentNetQty + quantity : currentNetQty - quantity;
                        const absAfter = Math.abs(afterNetQty);
                        const absCurrent = Math.abs(currentNetQty);

                        // Only block if the trade is INCREASING the position size beyond the limit
                        // Closing/reducing trades are always allowed
                        if (absAfter > absCurrent && absAfter > limitValue) {
                            const remainingQty = Math.max(0, limitValue - absCurrent);
                            throw new Error(
                                `Order exceeds maximum position limit. Max: ${limitValue} qty, Current: ${absCurrent} qty, Remaining: ${remainingQty} qty, Requested: ${quantity} qty.`
                            );
                        }

                        // VALIDATION 3: balance / margin check (only for opening trades)
                        if (absAfter > absCurrent) {
                            const remainingQty = Math.max(0, limitValue - absCurrent);
                            let priceForMargin = price;
                            if (!priceForMargin || priceForMargin <= 0) {
                                const ltpMapForMargin = await _getLivePricesFromKite([parseInt(instrument_token)]);
                                priceForMargin = ltpMapForMargin.get(parseInt(instrument_token)) || ltpMapForMargin.get(instrument_token.toString());
                            }
                            if (!priceForMargin || priceForMargin <= 0) {
                                throw new Error('Could not determine price for margin calculation');
                            }

                            const marginPerUnit = await calculateMargin(normalizedExchange, 1, priceForMargin, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol });
                            const availableBalance = liveFreeMargin;
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
                    }

                } else if (isLotMode) {
                    // ── LOT MODE: all limits are in lots ──────────────────────────────
                    const requestedLots = Math.ceil(quantity / lotSize);

                    // Determine if this is a closing trade (square-off) — closing trades bypass breakup limit
                    let isClosingForBreakupLot = false;
                    {
                        const posAggBrkLot = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: { _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);
                        const netQtyBrkLot = posAggBrkLot.length > 0 ? posAggBrkLot[0].total_buy_qty - posAggBrkLot[0].total_sell_qty : 0;
                        isClosingForBreakupLot = (transaction_type === 'SELL' && netQtyBrkLot > 0) || (transaction_type === 'BUY' && netQtyBrkLot < 0);
                    }

                    // VALIDATION 1: break_qty per single order in lots (skip for closing/square-off trades)
                    if (!isClosingForBreakupLot && breakValue > 0 && requestedLots > breakValue) {
                        throw new Error(
                            `Order size exceeds breakup limit. Max lots per order: ${breakValue}, Requested: ${requestedLots} lot(s). Please split your order.`
                        );
                    }

                    if (limitValue !== null && limitValue > 0) {
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
                        // Calculate what net position would be after this trade
                        const afterNetQty = transaction_type === 'BUY' ? currentNetQty + quantity : currentNetQty - quantity;
                        const afterLots = Math.ceil(Math.abs(afterNetQty) / lotSize);

                        // Only block if the trade is INCREASING the position size beyond the limit
                        // Closing/reducing trades are always allowed
                        if (afterLots > currentLots && afterLots > limitValue) {
                            const remainingLots = Math.max(0, limitValue - currentLots);
                            throw new Error(
                                `Order exceeds maximum position limit. Max: ${limitValue} lot(s), Current: ${currentLots} lot(s), Remaining: ${remainingLots} lot(s), Requested: ${requestedLots} lot(s).`
                            );
                        }

                        // VALIDATION 3: balance / margin check (only for opening trades)
                        if (Math.abs(afterNetQty) > Math.abs(currentNetQty)) {
                            const remainingLots = Math.max(0, limitValue - currentLots);
                            let priceForMargin = price;
                            if (!priceForMargin || priceForMargin <= 0) {
                                const ltpMapForMargin = await _getLivePricesFromKite([parseInt(instrument_token)]);
                                priceForMargin = ltpMapForMargin.get(parseInt(instrument_token)) || ltpMapForMargin.get(instrument_token.toString());
                            }
                            if (!priceForMargin || priceForMargin <= 0) {
                                throw new Error('Could not determine price for margin calculation');
                            }

                            const marginPerLot = await calculateMargin(normalizedExchange, lotSize, priceForMargin, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol });
                            const availableBalance = liveFreeMargin;
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
            }

            // ── Fresh Stop-Loss & Limit Price Restrictions ─────────────────
            // Price offset restrictions apply to ALL LIMIT/SL orders (independent of fresh_stoploss toggle).
            // Fresh stoploss toggle controls whether user can place closing orders on open positions.
            if (!req.admin && instrumentRawName) {
                const FreshStoplossLimit = require('../models/FreshStoplossLimit');
                // Resolve segment: use provided segment, or look up from KiteInstrument
                let fslSegment = (segment || '').toUpperCase();
                if (!fslSegment || fslSegment === exchange?.toUpperCase()) {
                    const kiteInstFSL = await KiteInstrument.findOne({ instrument_token }).select('segment').lean();
                    if (kiteInstFSL?.segment) fslSegment = kiteInstFSL.segment.toUpperCase();
                }
                const normalizedSeg = fslSegment === 'GLOBAL' ? 'INDICES' : (fslSegment || exchange || '').toUpperCase();

                const fslLimit = await FreshStoplossLimit.findOne({
                    exchange_name: normalizedSeg,
                    raw_name: instrumentRawName,
                    deleted_at: null
                });

                if (fslLimit) {
                    // Get live CMP from metricsEngine — use bid/ask (same as orders page P&L)
                    // BUY position exits at bid, SELL position exits at ask
                    const metricsEngFSL = require('../services/metricsEngine');
                    const livePriceSvc = require('../services/livePriceService');
                    const tokenStr = instrument_token.toString();
                    const tokenInt = parseInt(instrument_token);
                    const ltpFSL = metricsEngFSL._ltpMap?.get(tokenStr)
                        || livePriceSvc.latestPrices?.get(tokenStr)
                        || livePriceSvc.latestPrices?.get(tokenInt)
                        || null;
                    const bidFSL = metricsEngFSL._bidMap?.get(tokenStr) || ltpFSL;
                    const askFSL = metricsEngFSL._askMap?.get(tokenStr) || ltpFSL;
                    // cmpFSL for price offset checks (uses LTP)
                    const cmpFSL = ltpFSL;

                    // ── 1. MARKET orders: time restriction (always applies when FSL limit has time_minutes) ──
                    // Only restrict closing if the position is in PROFIT. Loss positions can close anytime.
                    if (order_type === 'MARKET') {
                        console.log(`🔒 [FSL] Checking time restriction: instrument=${instrumentRawName}, segment=${normalizedSeg}, time_minutes=${fslLimit.time_minutes}, cmp=${cmpFSL}`);
                        if (fslLimit.time_minutes > 0) {
                            const posAggFSL = await Trade.aggregate([
                                { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                                { $group: {
                                    _id: null,
                                    total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                    total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                                    total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_price', '$executed_quantity'] }, 0] } },
                                    total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_price', '$executed_quantity'] }, 0] } }
                                }}
                            ]).session(session);

                            const currentNetQty = posAggFSL.length > 0 ? posAggFSL[0].total_buy_qty - posAggFSL[0].total_sell_qty : 0;
                            const isClosing = (transaction_type === 'SELL' && currentNetQty > 0) ||
                                              (transaction_type === 'BUY' && currentNetQty < 0);

                            if (isClosing) {
                                // Check if position is in profit using bid/ask (same as orders page)
                                // BUY position: profit if bid > avg buy (exit = sell at bid)
                                // SELL position: profit if ask < avg sell (exit = buy at ask)
                                let positionInProfit = false;
                                if (posAggFSL.length > 0) {
                                    const avgBuy = posAggFSL[0].total_buy_qty > 0 ? posAggFSL[0].total_buy_value / posAggFSL[0].total_buy_qty : 0;
                                    const avgSell = posAggFSL[0].total_sell_qty > 0 ? posAggFSL[0].total_sell_value / posAggFSL[0].total_sell_qty : 0;
                                    if (currentNetQty > 0 && bidFSL && bidFSL > 0) {
                                        // Long position: profit if bid > avg buy
                                        positionInProfit = bidFSL > avgBuy;
                                    } else if (currentNetQty < 0 && askFSL && askFSL > 0) {
                                        // Short position: profit if ask < avg sell
                                        positionInProfit = askFSL < avgSell;
                                    }
                                }

                                // Only apply time restriction if position is in profit
                                console.log(`🔒 [FSL] netQty=${currentNetQty}, isClosing=${isClosing}, positionInProfit=${positionInProfit}, bid=${bidFSL}, ask=${askFSL}, ltp=${ltpFSL}, avgBuy=${posAggFSL[0]?.total_buy_qty > 0 ? posAggFSL[0].total_buy_value / posAggFSL[0].total_buy_qty : 0}, avgSell=${posAggFSL[0]?.total_sell_qty > 0 ? posAggFSL[0].total_sell_value / posAggFSL[0].total_sell_qty : 0}`);
                                if (positionInProfit) {
                                    const oppositeType = transaction_type === 'SELL' ? 'BUY' : 'SELL';
                                    const lastOpeningTrade = await Trade.findOne({
                                        user_id: user._id, instrument_token,
                                        transaction_type: oppositeType, order_type: 'MARKET',
                                        status: 'completed', deleted_at: null
                                    }).sort({ executed_at: -1 }).session(session);

                                    if (lastOpeningTrade && lastOpeningTrade.executed_at) {
                                        const elapsedMs = Date.now() - lastOpeningTrade.executed_at.getTime();
                                        const requiredMs = fslLimit.time_minutes * 60 * 1000;
                                        if (elapsedMs < requiredMs) {
                                            const remainingMins = Math.ceil((requiredMs - elapsedMs) / 60000);
                                            throw new Error(`Fresh Stop-Loss: Cannot close this position for ${remainingMins} more minute(s). Time restriction: ${fslLimit.time_minutes} minutes.`);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // ── 2. LIMIT/SL orders: price offset restriction (always applies) ──
                    if ((order_type === 'LIMIT' || order_type === 'SL' || order_type === 'SL-M') && fslLimit.price_offset > 0 && price > 0 && cmpFSL && cmpFSL > 0) {
                        if (order_type === 'LIMIT') {
                            // Standard offset check (applies regardless of High-Low setting)
                            // LIMIT: BUY below CMP, SELL above CMP
                            if (transaction_type === 'BUY') {
                                const maxBuyPrice = cmpFSL - fslLimit.price_offset;
                                if (price > maxBuyPrice) {
                                    throw new Error(`Price restriction: Buy limit must be at or below ₹${maxBuyPrice.toFixed(2)} (CMP ₹${cmpFSL.toFixed(2)} - ₹${fslLimit.price_offset}).`);
                                }
                            } else if (transaction_type === 'SELL') {
                                const minSellPrice = cmpFSL + fslLimit.price_offset;
                                if (price < minSellPrice) {
                                    throw new Error(`Price restriction: Sell limit must be at or above ₹${minSellPrice.toFixed(2)} (CMP ₹${cmpFSL.toFixed(2)} + ₹${fslLimit.price_offset}).`);
                                }
                            }
                        } else {
                            // SL/SL-M: BUY above CMP, SELL below CMP (opposite of LIMIT)
                            if (transaction_type === 'BUY') {
                                const minBuyPrice = cmpFSL + fslLimit.price_offset;
                                if (price < minBuyPrice) {
                                    throw new Error(`Price restriction: Buy stoploss must be at or above ₹${minBuyPrice.toFixed(2)} (CMP ₹${cmpFSL.toFixed(2)} + ₹${fslLimit.price_offset}).`);
                                }
                            } else if (transaction_type === 'SELL') {
                                const maxSellPrice = cmpFSL - fslLimit.price_offset;
                                if (price > maxSellPrice) {
                                    throw new Error(`Price restriction: Sell stoploss must be at or below ₹${maxSellPrice.toFixed(2)} (CMP ₹${cmpFSL.toFixed(2)} - ₹${fslLimit.price_offset}).`);
                                }
                            }
                        }
                    }

                    // Note: Time restriction only applies to MARKET closing orders (section 1 above).
                    // SL/LIMIT closing orders are always allowed — user should be able to
                    // place a stoploss to protect their position at any time.
                }
            }

            // ── High-Low Trade Limit check (INDEPENDENT of FSL limit) ──────
            // Runs for ALL LIMIT orders from non-admin users, regardless of whether an FSL limit exists.
            // If the user's trade_limit does NOT include this segment (button OFF),
            // Buy Limit must be below Day Low - offset, Sell Limit must be above Day High + offset.
            if (!req.admin && order_type === 'LIMIT' && price > 0) {
                // Resolve segment independently
                let hlSegment = (segment || '').toUpperCase();
                if (!hlSegment || hlSegment === exchange?.toUpperCase()) {
                    const kiteInstHL = await KiteInstrument.findOne({ instrument_token }).select('segment').lean();
                    if (kiteInstHL?.segment) hlSegment = kiteInstHL.segment.toUpperCase();
                }
                const hlNormalizedSeg = hlSegment === 'GLOBAL' ? 'INDICES' : (hlSegment || exchange || '').toUpperCase();

                const tradeLimitSegment = (hlSegment || hlNormalizedSeg || '').toUpperCase();
                const tradeLimitEnabled = user.trade_limit && user.trade_limit.some(
                    tl => tl.toUpperCase() === tradeLimitSegment || 
                          tl.toUpperCase() === (tradeLimitSegment === 'INDICES' ? 'GLOBAL' : tradeLimitSegment) ||
                          (tradeLimitSegment === 'GLOBAL' && tl.toUpperCase() === 'INDICES')
                );

                if (!tradeLimitEnabled) {
                    // Button OFF: orders must go beyond High/Low
                    try {
                        const kiteInstHL = await KiteInstrument.findOne({ instrument_token }).select('exchange tradingsymbol').lean();
                        if (kiteInstHL) {
                            const quoteKey = `${kiteInstHL.exchange}:${kiteInstHL.tradingsymbol}`;
                            const ohlcData = await kiteService.getMarketQuotes([quoteKey], 'ohlc');
                            const quote = ohlcData?.[quoteKey];
                            const dayHigh = quote?.ohlc?.high;
                            const dayLow = quote?.ohlc?.low;

                            // Get offset from FSL limit if available, otherwise 0
                            const FreshStoplossLimitHL = require('../models/FreshStoplossLimit');
                            const fslLimitHL = await FreshStoplossLimitHL.findOne({
                                exchange_name: hlNormalizedSeg,
                                raw_name: instrumentRawName,
                                deleted_at: null
                            });
                            const hlOffset = fslLimitHL?.price_offset || 0;

                            console.log(`📊 [HighLow] segment=${tradeLimitSegment}, enabled=${tradeLimitEnabled}, high=${dayHigh}, low=${dayLow}, offset=${hlOffset}, price=${price}, type=${transaction_type}`);

                            if (dayHigh && dayLow && dayHigh > 0 && dayLow > 0) {
                                if (transaction_type === 'BUY') {
                                    const maxBuyPrice = dayLow - hlOffset;
                                    if (price > maxBuyPrice) {
                                        throw new Error(`High-Low restriction: Buy limit must be at or below ₹${maxBuyPrice.toFixed(2)} (Day Low ₹${dayLow.toFixed(2)} - offset ₹${hlOffset}). Orders within High-Low range not allowed.`);
                                    }
                                } else if (transaction_type === 'SELL') {
                                    const minSellPrice = dayHigh + hlOffset;
                                    if (price < minSellPrice) {
                                        throw new Error(`High-Low restriction: Sell limit must be at or above ₹${minSellPrice.toFixed(2)} (Day High ₹${dayHigh.toFixed(2)} + offset ₹${hlOffset}). Orders within High-Low range not allowed.`);
                                    }
                                }
                            }
                        }
                    } catch (hlErr) {
                        if (hlErr.message.includes('High-Low restriction')) throw hlErr;
                        console.warn(`⚠️ [HighLow] Could not fetch OHLC for trade limit check: ${hlErr.message}`);
                    }
                }
            }

            // 1. Determine execution price
            let executedPrice = price;
            let livePrice = null;

            // Fetch live price for comparison (needed for both MARKET fallback and LIMIT checks)
            // Prefer live tick price from metricsEngine/livePriceService over DB (which may have stale settlement prices)
            const metricsEngForLtp = require('../services/metricsEngine');
            const livePriceSvcForLtp = require('../services/livePriceService');
            const tokenStrForLtp = instrument_token.toString();
            const tokenIntForLtp = parseInt(instrument_token);
            livePrice = metricsEngForLtp._ltpMap?.get(tokenStrForLtp)
                || livePriceSvcForLtp.latestPrices?.get(tokenStrForLtp)
                || livePriceSvcForLtp.latestPrices?.get(tokenIntForLtp)
                || null;

            // Fallback to Kite API only if no live tick available
            if (!livePrice) {
                const ltpMap = await _getLivePricesFromKite([parseInt(instrument_token)]);
                livePrice = ltpMap.get(parseInt(instrument_token)) || ltpMap.get(instrument_token.toString());
            }

            if (order_type === 'MARKET') {
                // For MARKET orders closing a position, use bid/ask (matching orders page CMP)
                // BUY to close short → use ask price; SELL to close long → use bid price
                // This ensures the execution price matches what the user sees on the orders page.
                // For opening trades, use the frontend-provided price (LTP).
                const tokenStrBidAsk = instrument_token.toString();
                const livePriceSvcBA = require('../services/livePriceService');

                // Fetch fresh bid/ask from Kite full quote API (not from cache)
                let freshBid = null;
                let freshAsk = null;
                try {
                    const kiteInstBA = await KiteInstrument.findOne({ instrument_token }).select('exchange tradingsymbol').lean();
                    if (kiteInstBA) {
                        const quoteKeyBA = `${kiteInstBA.exchange}:${kiteInstBA.tradingsymbol}`;
                        const fullQuote = await kiteService.getMarketQuotes([quoteKeyBA], 'full');
                        const q = fullQuote?.[quoteKeyBA];
                        if (q) {
                            // Kite full quote has depth.buy[0].price (best bid) and depth.sell[0].price (best ask)
                            freshBid = q.depth?.buy?.[0]?.price || q.last_price;
                            freshAsk = q.depth?.sell?.[0]?.price || q.last_price;
                            // Update livePriceService maps so subsequent reads are fresh too
                            if (freshBid > 0) livePriceSvcBA.latestPrices.set(tokenStrBidAsk, q.last_price || freshBid);
                        }
                    }
                } catch (_) {}

                // Fall back to metricsEngine bid/ask if Kite API call failed
                if (!freshBid || freshBid <= 0) {
                    const meBA = require('../services/metricsEngine');
                    freshBid = meBA._bidMap?.get(tokenStrBidAsk) || null;
                    freshAsk = meBA._askMap?.get(tokenStrBidAsk) || null;
                }

                // Determine if this is a closing trade
                const posAggForPrice = await Trade.aggregate([
                    { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                    { $group: {
                        _id: null,
                        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                    }}
                ]).session(session);
                const netQtyForPrice = posAggForPrice.length > 0 ? posAggForPrice[0].total_buy_qty - posAggForPrice[0].total_sell_qty : 0;
                const isClosingForPrice = (transaction_type === 'SELL' && netQtyForPrice > 0) ||
                                          (transaction_type === 'BUY' && netQtyForPrice < 0);

                if (isClosingForPrice) {
                    // Closing: SELL uses bid, BUY uses ask (same as orders page CMP)
                    if (transaction_type === 'SELL' && freshBid && freshBid > 0) {
                        executedPrice = freshBid;
                    } else if (transaction_type === 'BUY' && freshAsk && freshAsk > 0) {
                        executedPrice = freshAsk;
                    }
                } else {
                    // Opening: BUY uses ask, SELL uses bid (user enters at the worse side of spread)
                    if (transaction_type === 'BUY' && freshAsk && freshAsk > 0) {
                        executedPrice = freshAsk;
                    } else if (transaction_type === 'SELL' && freshBid && freshBid > 0) {
                        executedPrice = freshBid;
                    }
                }

                // Final fallback — only if bid/ask completely unavailable
                if (!executedPrice || executedPrice <= 0) {
                    executedPrice = livePrice;
                }
                if (!executedPrice) {
                    throw new Error('Could not determine price for MARKET order');
                }
            }

            // 2. For LIMIT/SL orders, check if the condition is already met
            let shouldExecuteNow = false;
            if (order_type === 'MARKET') {
                shouldExecuteNow = true;
            } else if (order_type === 'LIMIT' && livePrice) {
                if (transaction_type === 'BUY' && livePrice <= executedPrice) {
                    shouldExecuteNow = true;
                } else if (transaction_type === 'SELL' && livePrice >= executedPrice) {
                    shouldExecuteNow = true;
                }
            } else if ((order_type === 'SL' || order_type === 'SL-M') && livePrice) {
                // Stop-Loss: triggers when price moves AGAINST the position
                // SL BUY triggers when price >= trigger price (short covering)
                // SL SELL triggers when price <= trigger price (long stop-loss)
                if (transaction_type === 'BUY' && livePrice >= executedPrice) {
                    shouldExecuteNow = true;
                } else if (transaction_type === 'SELL' && livePrice <= executedPrice) {
                    shouldExecuteNow = true;
                }
            }

            const tradeStatus = shouldExecuteNow ? 'completed' : 'pending';

            // 3. Calculate realised P&L if this trade closes (or partially closes) a position
            let tradeRealisedPnl = 0;
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
                        tradeRealisedPnl += (executedPrice - front.price) * matched;
                        front.qty -= matched;
                        remaining -= matched;
                        if (front.qty === 0) tempQueue.shift();
                    }
                } else if (transaction_type === 'BUY' && netQtyFromPrev < 0) {
                    // Closing a short position: use avg sell price from aggregate
                    const agg = existingAgg.length > 0 ? existingAgg[0] : null;
                    const avgSellPrice = agg && agg.total_sell_qty > 0 ? agg.total_sell_value / agg.total_sell_qty : 0;
                    const closingQty = Math.min(quantity, Math.abs(netQtyFromPrev));
                    tradeRealisedPnl = (avgSellPrice - executedPrice) * closingQty;
                }
            }

            // ── Free Margin & Trade Margin validation (opening trades only) ──
            // Checks for MARKET and SL orders (execute immediately).
            // LIMIT orders skip this — margin is checked when the pending order triggers.
            if (shouldExecuteNow && !req.admin) {
                // Determine if this is an opening trade
                const aggDataFM = existingAgg.length > 0 ? existingAgg[0] : null;
                const currentNetQtyFM = aggDataFM ? aggDataFM.total_buy_qty - aggDataFM.total_sell_qty : 0;
                const afterNetQtyFM = transaction_type === 'BUY' ? currentNetQtyFM + quantity : currentNetQtyFM - quantity;
                const isOpeningFM = Math.abs(afterNetQtyFM) > Math.abs(currentNetQtyFM);

                if (isOpeningFM) {
                    // Check 1: Free margin must not be negative (use fresh metrics, not cached)
                    const metricsEngine = require('../services/metricsEngine');
                    const freshMetricsFM = await metricsEngine.getFreshMetrics(user._id.toString());
                    if (freshMetricsFM && freshMetricsFM.free_margin < 0) {
                        throw new Error('Insufficient free margin. Your free margin is negative. Please close existing positions or add funds.');
                    }

                    // Check 2: Verify trade margin is configured for this instrument
                    const TradeMargin = require('../models/TradeMargin');
                    const rawSeg = (segment || exchange || '').toUpperCase();
                    // GLOBAL and INDICES are the same segment — normalize to check both
                    const normalizedSegment = (rawSeg === 'GLOBAL' || rawSeg === 'INDICES') ? 'GLOBAL' : rawSeg;
                    
                    let marginRule = null;
                    if (instrumentRawName) {
                        marginRule = await TradeMargin.findOne({ script_name: { $regex: new RegExp('^' + instrumentRawName + '$', 'i') }, exchange_name: normalizedSegment, deleted_at: null }).session(session);
                    }
                    if (!marginRule && instrumentRawName) {
                        // Try the alternate name (GLOBAL↔INDICES)
                        const altSegment = normalizedSegment === 'GLOBAL' ? 'INDICES' : (normalizedSegment === 'INDICES' ? 'GLOBAL' : null);
                        if (altSegment) {
                            marginRule = await TradeMargin.findOne({ script_name: { $regex: new RegExp('^' + instrumentRawName + '$', 'i') }, exchange_name: altSegment, deleted_at: null }).session(session);
                        }
                    }
                    if (!marginRule) {
                        marginRule = await TradeMargin.findOne({ exchange_name: normalizedSegment, script_name: { $in: [null, ''] }, deleted_at: null }).session(session);
                    }
                    if (!marginRule && (normalizedSegment === 'GLOBAL' || normalizedSegment === 'INDICES')) {
                        const altSegment = normalizedSegment === 'GLOBAL' ? 'INDICES' : 'GLOBAL';
                        marginRule = await TradeMargin.findOne({ exchange_name: altSegment, script_name: { $in: [null, ''] }, deleted_at: null }).session(session);
                    }
                    if (!marginRule && normalizedSegment.includes('-')) {
                        const baseExchange = normalizedSegment.split('-')[0];
                        marginRule = await TradeMargin.findOne({ exchange_name: baseExchange, script_name: { $in: [null, ''] }, deleted_at: null }).session(session);
                    }

                    if (!marginRule || marginRule.trade_margin <= 0) {
                        throw new Error(`Trade margin is not configured for ${instrumentRawName || tradingsymbol} (${normalizedSegment}). Please contact your admin.`);
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
                placed_by: req.admin ? 'ADMIN' : (req.master ? 'MASTER' : 'USER'),
                status: tradeStatus,
                executed_at: shouldExecuteNow ? new Date() : null,
                executed_price: shouldExecuteNow ? executedPrice : null,
                executed_quantity: shouldExecuteNow ? quantity : 0,
                pnl: tradeRealisedPnl,
                brokerage: 0,
                taxes: 0,
                net_amount: tradeRealisedPnl
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

                const normalizedExchange = ((segment || exchange || '').toUpperCase()) === 'GLOBAL' ? 'INDICES' : (segment || exchange || '').toUpperCase();
                // Calculate total margin for previous and new net positions directly
                // calculateMargin handles lot-based (per-lot) vs percentage internally
                const prevMargin = Math.abs(prevNetQtyForMargin) > 0
                    ? await calculateMargin(normalizedExchange, Math.abs(prevNetQtyForMargin), executedPrice, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol })
                    : 0;
                const newMargin = Math.abs(newNetQty) > 0
                    ? await calculateMargin(normalizedExchange, Math.abs(newNetQty), executedPrice, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol })
                    : 0;
                const marginDelta = newMargin - prevMargin; // +ve = more margin needed

                // #7 FIX: Block if free margin goes negative (balance - currentMargin - newMarginDelta < 0)
                // if (marginDelta > 0) {
                //     const freeMargin = user.equity - prevMargin;
                //     if (freeMargin < marginDelta) {
                //         throw new Error(`Insufficient free margin. Free: ₹${freeMargin.toFixed(2)}, Required: ₹${marginDelta.toFixed(2)}`);
                //     }
                // }

                // #5 FIX: Calculate brokerage using BrokerageSettings
                let brokerage = 0;
                try {
                    // Try by raw_name first, then fallback to tradingsymbol
                    let brokerageRule = null;
                    if (instrumentRawName) {
                        brokerageRule = await BrokerageSettings.findOne({
                            exchange_name: normalizedExchange,
                            script_name: instrumentRawName,
                            deleted_at: null
                        });
                    }
                    if (!brokerageRule) {
                        brokerageRule = await BrokerageSettings.findOne({
                            exchange_name: normalizedExchange,
                            script_name: tradingsymbol,
                            deleted_at: null
                        });
                    }
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

                const balanceBefore = user.equity;
                const balanceChange = tradeRealisedPnl - marginDelta - brokerage;

                user.equity = user.equity + balanceChange;
                newTrade.brokerage = brokerage;
                newTrade.net_amount = tradeRealisedPnl - brokerage;
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
                    balanceAfter: user.equity,
                    metadata: {
                        tradingsymbol,
                        quantity,
                        executedPrice,
                        order_type,
                        realisedPnl: tradeRealisedPnl,
                        brokerage,
                        marginDelta,
                        balanceChange,
                        positionClosed: tradeRealisedPnl !== 0
                    }
                });
                await tx.save({ session });
            }

            resultTrade = newTrade;
        });

        session.endSession();

        // Notify Flutter client so the orders tab refreshes trades
        if (resultTrade.status === 'completed') {
            const livePriceService = require('../services/livePriceService');
            livePriceService.broadcastToUser(resultTrade.user_id.toString(), {
                type: 'trade_executed',
                trade_id: resultTrade._id.toString(),
                instrument_token: resultTrade.instrument_token,
                tradingsymbol: resultTrade.tradingsymbol,
                transaction_type: resultTrade.transaction_type,
                quantity: resultTrade.executed_quantity,
                price: resultTrade.executed_price,
                pnl: resultTrade.pnl,
                brokerage: resultTrade.brokerage,
            });
        }

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
            livePriceService.broadcastToUser(resultTrade.user_id.toString(), {
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

        // Notify metrics engine to rebuild user's cache and broadcast updated metrics
        try {
            const metricsEngine = require('../services/metricsEngine');
            metricsEngine.onTradeExecuted(resultTrade.user_id.toString());
        } catch (_) {}
    } catch (error) {
        session.endSession();

        // Save rejected trade to rejection log for margin/FSL failures
        const isRejectable = error.message.includes('free margin') ||
            error.message.includes('Trade margin is not configured') ||
            error.message.includes('Fresh Stop-Loss') ||
            error.message.includes('close-only mode') ||
            error.message.includes('Trading is currently disabled') ||
            error.message.includes('Insufficient balance') ||
            error.message.includes('Insufficient margin') ||
            error.message.includes('exceeds') ||
            error.message.includes('Option selling is not allowed');

        if (isRejectable && req.user) {
            try {
                const User = require('../models/User');
                const rejUser = await User.findById(req.user.id).select('master_id server_id').lean();
                await Trade.create({
                    user_id: req.user.id,
                    master_id: rejUser?.master_id || null,
                    admin_id: rejUser?.server_id || rejUser?.master_id || req.user.id,
                    instrument_token: req.body.instrument_token,
                    tradingsymbol: req.body.tradingsymbol,
                    exchange: req.body.exchange,
                    transaction_type: req.body.transaction_type,
                    order_type: req.body.order_type || 'MARKET',
                    quantity: req.body.quantity || 0,
                    price: req.body.price || 0,
                    executed_quantity: 0,
                    executed_price: 0,
                    status: 'rejected',
                    remarks: error.message,
                });
                console.log(`📝 [RejectionLog] Saved rejected trade for user ${req.user.id}: ${error.message.substring(0, 80)}`);
            } catch (rejErr) {
                console.error('⚠️  [RejectionLog] Failed to save rejected trade:', rejErr.message);
            }
        }

        let statusCode = 500;
        if (error.message === 'User not found') statusCode = 404;
        else if (error.message.includes('Option selling is not allowed') || error.message.includes('would create a short position')) statusCode = 403;
        else if (error.message.includes('Trading is currently disabled')) statusCode = 403;
        else if (error.message.includes('close-only mode')) statusCode = 403;
        else if (error.message.includes('Insufficient balance') || error.message.includes('Insufficient margin') || error.message.includes('Insufficient free margin')) statusCode = 400;
        else if (error.message.includes('Could not fetch') || error.message.includes('Invalid')) statusCode = 400;
        else if (error.message.includes('exceeds')) statusCode = 400;
        else if (error.message.includes('Trade margin is not configured')) statusCode = 400;
        else if (error.message.includes('Fresh Stop-Loss')) statusCode = 400;

        res.status(statusCode).json({
            success: false,
            message: error.message,
            data: null
        });
    }
};

/**
 * Get the current user's base account metrics (credit, equity, free_margin).
 * These are the DB-stored snapshot values. The client computes realised_pnl,
 * position_pnl, m2m_pnl, margin_used locally from trades + live ticks.
 */
const getAccountMetrics = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id || req.admin?.id || req.body.user_id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // ALWAYS use metricsEngine (single source of truth)
        const metricsEngine = require('../services/metricsEngine');
        const metrics = await metricsEngine.getFreshMetrics(userId.toString());

        if (metrics) {
            const user = await User.findById(userId, 'name username').lean();
            return res.status(200).json({
                success: true,
                message: 'Metrics fetched successfully',
                data: {
                    user_id: userId,
                    name: user?.name,
                    username: user?.username,
                    credit: metrics.credit,
                    equity: metrics.equity,
                    free_margin: metrics.free_margin,
                    realised_pnl: metrics.realised_pnl,
                    position_pnl: metrics.position_pnl,
                    m2m_pnl: metrics.m2m_pnl,
                    margin_used: metrics.margin_used,
                    positions: metrics.positions || [],
                }
            });
        }

        // User has no trades — return credits as equity
        const user = await User.findById(userId, 'credits name username').lean();
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Metrics fetched successfully',
            data: {
                user_id: userId,
                name: user.name,
                username: user.username,
                credit: user.credits || 0,
                equity: user.credits || 0,
                free_margin: user.credits || 0,
                realised_pnl: 0,
                position_pnl: 0,
                m2m_pnl: 0,
                margin_used: 0,
            }
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
 * Save client-computed metrics to DB.
 * Called by Flutter periodically (and on app background/close) to cache
 * the latest computed values. Also used by the 12:01 AM flush.
 *
 * Body: { realised_pnl, position_pnl, m2m_pnl, margin_used, equity, free_margin }
 */
const saveClientMetrics = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { realised_pnl, position_pnl, m2m_pnl, margin_used, equity, free_margin } = req.body;

        await User.updateOne(
            { _id: userId },
            { $set: {
                realised_pnl: Math.round((realised_pnl || 0) * 100) / 100,
                position_pnl: Math.round((position_pnl || 0) * 100) / 100,
                m2m_pnl: Math.round((m2m_pnl || 0) * 100) / 100,
                margin_used: Math.round((margin_used || 0) * 100) / 100,
                equity: Math.round((equity || 0) * 100) / 100,
                free_margin: Math.round((free_margin || 0) * 100) / 100,
            }}
        );

        res.status(200).json({ success: true, message: 'Metrics saved' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
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

        const trades = await Trade.find({
            user_id: targetUserId,
            $or: [
                { deleted_at: null },
                // Include settlement closing trades (soft-deleted but should show in history)
                { remarks: 'Settlement: position closed at settlement price' },
            ],
        }).sort({ executed_at: -1 });

        // Enrich trades with lot_size from KiteInstrument so Flutter can display lots vs qty
        const KiteInstrument = require('../models/KiteInstrument');
        const uniqueTokens = [...new Set(trades.map(t => t.instrument_token))];
        const instruments = await KiteInstrument.find({ instrument_token: { $in: uniqueTokens } }, 'instrument_token lot_size segment raw_name name');
        const lotSizeMap = {};
        instruments.forEach(inst => {
            lotSizeMap[inst.instrument_token] = { lot_size: inst.lot_size || 1, segment: inst.segment || '', raw_name: inst.raw_name || inst.name || '' };
        });

        const enrichedTrades = trades.map(t => {
            const plain = t.toJSON();
            const info = lotSizeMap[t.instrument_token] || { lot_size: 1, segment: '', raw_name: '' };
            plain.lot_size = info.lot_size || 1;
            plain.segment = info.segment;
            plain.raw_name = info.raw_name;
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

/**
 * Get brokerage rules for frontend brokerage calculation
 */
const getBrokerageRules = async (req, res) => {
    try {
        const rules = await BrokerageSettings.find({ deleted_at: null });
        res.status(200).json({
            success: true,
            message: 'Brokerage rules fetched successfully',
            data: rules
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
 * Auto square-off expired positions.
 * Called by Flutter when it detects open positions on expired instruments.
 * Body: { instrument_tokens: ['token1', 'token2', ...] }
 */
const autoSquareOffExpired = async (req, res) => {
    try {
        const userId = req.user?.id || req.master?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { instrument_tokens } = req.body;
        if (!instrument_tokens || !Array.isArray(instrument_tokens) || instrument_tokens.length === 0) {
            return res.status(400).json({ success: false, message: 'instrument_tokens array required' });
        }

        const user = await User.findById(userId).populate('master_id');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const results = [];
        const errors = [];

        for (const token of instrument_tokens) {
            try {
                // Get current net position
                const posAgg = await Trade.aggregate([
                    { $match: { user_id: new mongoose.Types.ObjectId(userId), instrument_token: token.toString(), status: 'completed', deleted_at: null } },
                    { $group: {
                        _id: null,
                        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                    }}
                ]);

                const netQty = posAgg.length > 0 ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty : 0;
                if (netQty === 0) continue;

                const inst = await KiteInstrument.findOne({ instrument_token: token.toString() }).lean();
                if (!inst) { errors.push({ token, message: 'Instrument not found' }); continue; }

                // Use settlement/close price from DB (updated by refreshSettlementPrices)
                const closePrice = inst.last_price;
                if (!closePrice || closePrice <= 0) {
                    errors.push({ token, tradingsymbol: inst.tradingsymbol, message: 'No settlement price available' });
                    continue;
                }

                const absQty = Math.abs(netQty);
                const closeSide = netQty > 0 ? 'SELL' : 'BUY';
                const reopenSide = netQty > 0 ? 'BUY' : 'SELL';
                const now = new Date();

                // Compute P&L for the closing trade (FIFO-based, same as placeTrade)
                const closingTrades = await Trade.find({
                    user_id: user._id,
                    instrument_token: token.toString(),
                    status: 'completed',
                    deleted_at: null,
                    transaction_type: netQty > 0 ? 'BUY' : 'SELL',
                }).sort({ executed_at: 1 }).session(null);

                let remainingQty = absQty;
                let totalCost = 0;
                for (const t of closingTrades) {
                    if (remainingQty <= 0) break;
                    const available = t.executed_quantity - (t._usedQty || 0);
                    const used = Math.min(available, remainingQty);
                    totalCost += used * t.executed_price;
                    remainingQty -= used;
                }
                const avgEntryPrice = totalCost / absQty;
                const closePnl = netQty > 0
                    ? (closePrice - avgEntryPrice) * absQty
                    : (avgEntryPrice - closePrice) * absQty;

                // 1. CLOSE trade — settles the position at close price
                const closeTrade = await Trade.create({
                    user_id: user._id,
                    master_id: user.master_id?._id || user.master_id,
                    admin_id: user.admin_id,
                    instrument_token: token.toString(),
                    tradingsymbol: inst.tradingsymbol,
                    exchange: inst.exchange,
                    transaction_type: closeSide,
                    quantity: absQty,
                    price: closePrice,
                    order_type: 'MARKET',
                    placed_by: 'SYSTEM',
                    trade_type: 'carry_forward',
                    status: 'completed',
                    executed_at: now,
                    executed_price: closePrice,
                    executed_quantity: absQty,
                    pnl: Math.round(closePnl * 100) / 100,
                    brokerage: 0,
                    taxes: 0,
                    net_amount: Math.round(closePnl * 100) / 100,
                    remarks: 'Carry forward close — ATP adjustment',
                });

                // 2. REOPEN trade — reopens position at close price (new ATP = close price)
                const reopenTrade = await Trade.create({
                    user_id: user._id,
                    master_id: user.master_id?._id || user.master_id,
                    admin_id: user.admin_id,
                    instrument_token: token.toString(),
                    tradingsymbol: inst.tradingsymbol,
                    exchange: inst.exchange,
                    transaction_type: reopenSide,
                    quantity: absQty,
                    price: closePrice,
                    order_type: 'MARKET',
                    placed_by: 'SYSTEM',
                    trade_type: 'carry_forward',
                    status: 'completed',
                    executed_at: now,
                    executed_price: closePrice,
                    executed_quantity: absQty,
                    pnl: 0,
                    brokerage: 0,
                    taxes: 0,
                    net_amount: 0,
                    remarks: 'Carry forward reopen — ATP adjustment',
                });

                // Refresh metricsEngine for this user
                const metricsEngine = require('../services/metricsEngine');
                await metricsEngine.onTradeExecuted(userId);

                results.push({
                    token,
                    tradingsymbol: inst.tradingsymbol,
                    qty: absQty,
                    close_price: closePrice,
                    pnl: Math.round(closePnl * 100) / 100,
                });
            } catch (e) {
                errors.push({ token, message: e.message });
            }
        }

        res.status(200).json({
            success: true,
            message: `Carry forward ${results.length} position(s)${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
            data: { carried_forward: results, errors },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, data: null });
    }
};

/**
 * GET /trade/instrument-info?token=X
 * Returns trade margin, brokerage rule, and instrument details for the info sheet.
 */
const getInstrumentInfo = async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ success: false, message: 'token is required' });

        const KiteInstrument = require('../models/KiteInstrument');
        const TradeMargin = require('../models/TradeMargin');
        const BrokerageSettings = require('../models/BrokerageSettings');

        const instrument = await KiteInstrument.findOne({ instrument_token: token }).lean();
        if (!instrument) return res.status(404).json({ success: false, message: 'Instrument not found' });

        const seg = instrument.segment || '';
        const rawName = instrument.raw_name || '';
        const exchange = seg.split('-')[0] || instrument.exchange || '';

        // Trade margin: 4-level fallback (raw_name+segment → raw_name → segment → exchange)
        let marginRule = null;
        if (rawName && seg) marginRule = await TradeMargin.findOne({ script_name: { $regex: new RegExp(`^${rawName}$`, 'i') }, exchange_name: seg.toUpperCase(), deleted_at: null }).lean();
        if (!marginRule && rawName) marginRule = await TradeMargin.findOne({ script_name: { $regex: new RegExp(`^${rawName}$`, 'i') }, deleted_at: null }).lean();
        if (!marginRule && seg) marginRule = await TradeMargin.findOne({ exchange_name: seg.toUpperCase(), script_name: { $in: [null, ''] }, deleted_at: null }).lean();
        if (!marginRule) marginRule = await TradeMargin.findOne({ exchange_name: exchange.toUpperCase(), script_name: { $in: [null, ''] }, deleted_at: null }).lean();

        // Brokerage: same 4-level fallback
        let brkRule = null;
        if (rawName && seg) brkRule = await BrokerageSettings.findOne({ script_name: { $regex: new RegExp(`^${rawName}$`, 'i') }, exchange_name: seg.toUpperCase(), deleted_at: null }).lean();
        if (!brkRule && rawName) brkRule = await BrokerageSettings.findOne({ script_name: { $regex: new RegExp(`^${rawName}$`, 'i') }, deleted_at: null }).lean();
        if (!brkRule && seg) brkRule = await BrokerageSettings.findOne({ exchange_name: seg.toUpperCase(), script_name: { $in: [null, ''] }, deleted_at: null }).lean();
        if (!brkRule) brkRule = await BrokerageSettings.findOne({ exchange_name: exchange.toUpperCase(), script_name: { $in: [null, ''] }, deleted_at: null }).lean();

        res.status(200).json({
            success: true,
            data: {
                script: rawName || instrument.name || instrument.tradingsymbol,
                segment: seg,
                exchange: instrument.exchange,
                expiry: instrument.expiry,
                lot_size: instrument.lot_size || 1,
                tick_size: instrument.tick_size,
                instrument_type: instrument.instrument_type,
                trade_margin: marginRule ? {
                    value: marginRule.trade_margin,
                    type: marginRule.amount_type,
                } : null,
                brokerage: brkRule ? {
                    value: brkRule.brk_value,
                    type: brkRule.type,
                } : null,
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    placeTrade,
    cancelTrade,
    deleteTrade,
    getAccountMetrics,
    saveClientMetrics,
    getPositions,
    getMargins,
    getBrokerageRules,
    autoSquareOffExpired,
    getInstrumentInfo,
};
