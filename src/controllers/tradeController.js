const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const KiteInstrument = require('../models/KiteInstrument');
const BrokerageSettings = require('../models/BrokerageSettings');
const kiteService = require('../services/kiteService');
const ScriptQuantity = require('../models/ScriptQuantity');
const GroupedQuantity = require('../models/GroupedQuantity');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const orderBookService = require('../services/orderBookService');
const { calculateMargin } = require('../services/marginService');
const walletService = require('../services/walletService');
const { categoryForSegment } = require('../utils/walletCategory');
const { computeWalletSplit } = require('../utils/walletSplit');
const firebaseService = require('../services/firebaseService');
const { beginTradeWrite, withTradeWriteLease } = require('../services/tradeWriteFenceService');

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
 * `computeWalletSplit` (the pure open/close split that drives the category-wallet
 * release/block) now lives in `src/utils/walletSplit.js` so the pending-fill
 * services can import it without depending on this controller. It is re-exported
 * from here (see module.exports) for backwards compatibility with existing
 * callers/tests that import it from the controller.
 */

/**
 * Place a new trade order
 */
const placeTrade = async (req, res) => {
    const session = await mongoose.startSession();
    let tradeWriteLease = null;
    try {
        // #8 FIX: When admin/master places trade for a user, use req.body.user_id as the target, not the caller's own ID.
        const callerId = req.user?.id || req.master?.id || req.admin?.id;
        const isAdminOrMaster = !!(req.admin || req.master);
        const targetUserId = (req.body.user_id && isAdminOrMaster) ? req.body.user_id : (req.body.user_id || callerId);
        if (!targetUserId) {
            return res.status(401).json({ success: false, message: 'Unauthorized / User ID missing' });
        }
        // Admin/Master must always specify a user_id — they cannot trade for themselves
        if (isAdminOrMaster && !req.body.user_id) {
            return res.status(400).json({ success: false, message: 'Please select a user to place a trade on their behalf.' });
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
        tradeWriteLease = await beginTradeWrite('place_trade');

        await session.withTransaction(async () => {
            await tradeWriteLease.assertActive({ session });
            const user = await User.findById(targetUserId).populate('master_id').session(session);
            if (!user) {
                throw new Error('User not found');
            }

            // NOTE: The old live free-margin gate (metricsEngine equity/free_margin) is
            // replaced by the category-wallet gate applied at execution time below
            // (walletService.block). LIMIT orders no longer warn on free margin at
            // placement — they block at fill time (Task 6).

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

                        // VALIDATION 3 (old free-margin affordability check) removed for
                        // Task 5 — the category-wallet gate (walletService.block at execution)
                        // now enforces affordability per Requirement 4. Script-quantity limits
                        // (VALIDATION 1/2 above) still apply.
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

                        // VALIDATION 3 (old free-margin affordability check) removed for
                        // Task 5 — the category-wallet gate (walletService.block at execution)
                        // now enforces affordability per Requirement 4. Script-quantity limits
                        // (VALIDATION 1/2 above) still apply.
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

                if (fslLimit && user.fresh_stoploss === true) {
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
                // Admin placing with a custom price: use that price directly (no bid/ask override)
                if (req.admin && price && price > 0) {
                    executedPrice = price;
                } else {
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
                } // end else (non-admin MARKET order)
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
                // Aggregate all previous trades for average price and net position
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

                // Calculate P&L using Average Price method
                const agg = existingAgg.length > 0 ? existingAgg[0] : { total_buy_qty: 0, total_sell_qty: 0, total_buy_value: 0, total_sell_value: 0 };
                const netQtyFromPrev = agg.total_buy_qty - agg.total_sell_qty;
                const avgBuyPrice = agg.total_buy_qty > 0 ? agg.total_buy_value / agg.total_buy_qty : 0;
                const avgSellPrice = agg.total_sell_qty > 0 ? agg.total_sell_value / agg.total_sell_qty : 0;

                if (transaction_type === 'SELL' && netQtyFromPrev > 0) {
                    // Closing a long: P&L = (sell price - avg buy price) × closing qty
                    const closingQty = Math.min(quantity, netQtyFromPrev);
                    tradeRealisedPnl = (executedPrice - avgBuyPrice) * closingQty;
                } else if (transaction_type === 'BUY' && netQtyFromPrev < 0) {
                    // Closing a short: P&L = (avg sell price - buy price) × closing qty
                    const closingQty = Math.min(quantity, Math.abs(netQtyFromPrev));
                    tradeRealisedPnl = (avgSellPrice - executedPrice) * closingQty;
                }
                tradeRealisedPnl = Math.round(tradeRealisedPnl * 100) / 100;
            }

            // NOTE: The old Free-Margin + per-instrument margin validation block was
            // removed for Task 5. Affordability is now enforced by the category-wallet
            // gate (walletService.block at execution, below), and margin equals the full
            // traded notional (no per-instrument margin rule). Requirements 4.1–4.5.

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

                // ── Category trade-wallet: release the closed portion, then block the opened
                //    portion (Task 5 / Requirements 3.1–3.5, 4.1, 4.5, 1.4). Runs for EVERY
                //    executed trade regardless of who places it (user, master or admin) and
                //    operates on the TARGET user's wallet. Pending LIMIT orders do NOT block
                //    here — they block at fill time (Task 6). All mutations use this trade's
                //    `session`, so they roll back atomically with the trade write.
                {
                    // Category is derived from the RAW segment (NOT normalizedExchange, which
                    // maps GLOBAL→INDICES for the legacy ScriptQuantity lookups).
                    const walletCategory = categoryForSegment(segment || exchange || '');

                    const walletAgg = existingAgg && existingAgg.length > 0 ? existingAgg[0] : null;
                    const walletAvgBuy = walletAgg && walletAgg.total_buy_qty > 0
                        ? walletAgg.total_buy_value / walletAgg.total_buy_qty : 0;
                    const walletAvgSell = walletAgg && walletAgg.total_sell_qty > 0
                        ? walletAgg.total_sell_value / walletAgg.total_sell_qty : 0;

                    const { closingQty: walletClosingQty, openingQty: walletOpeningQty } =
                        computeWalletSplit(prevNetQtyForMargin, transaction_type, quantity);

                    // Closed long lots release at avgBuy; closed short lots at avgSell (entry basis).
                    const walletReleaseBasis = prevNetQtyForMargin > 0 ? walletAvgBuy : walletAvgSell;

                    // Release first — entry notional of the closed quantity, independent of the
                    // exit price / P&L (Requirement 3.2).
                    if (walletClosingQty > 0 && walletReleaseBasis > 0) {
                        await walletService.release('User', user._id, walletCategory, walletClosingQty * walletReleaseBasis, session);
                    }

                    // Then gate + block the opened/increased portion at the execution price
                    // (entry notional, Requirements 1.4 / 3.1). block() throws INSUFFICIENT_WALLET
                    // when the pool cannot cover it, aborting this transaction (the trade write
                    // rolls back) → clean category + shortfall rejection in the catch below.
                    if (walletOpeningQty > 0) {
                        await walletService.block('User', user._id, walletCategory, walletOpeningQty * executedPrice, session);
                    }
                }

                const normalizedExchange = ((segment || exchange || '').toUpperCase()) === 'GLOBAL' ? 'INDICES' : (segment || exchange || '').toUpperCase();
                // Calculate total margin for previous and new net positions directly
                // calculateMargin handles lot-based (per-lot) vs percentage internally
                const prevMargin = Math.abs(prevNetQtyForMargin) > 0
                    ? await calculateMargin(normalizedExchange, Math.abs(prevNetQtyForMargin), executedPrice, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol })
                    : 0;
                const newMargin = Math.abs(newNetQty) > 0
                    ? await calculateMargin(normalizedExchange, Math.abs(newNetQty), executedPrice, { rawName: instrumentRawName, instrumentToken: instrument_token, tradingsymbol })
                    : 0;
                // NOTE: marginDelta is now notional (see spec Task 5 flag) — persisted equity
                // interaction pending review. After Task 3, calculateMargin returns the full
                // |qty|×price notional, so this term now subtracts notional-sized amounts from
                // the PERSISTED user.equity running balance (design D2 describes persisted equity
                // as credit+realised only). Left unchanged per Task 5; flagged for user review.
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
                    const rawName = instrumentRawName || tradingsymbol.replace(/[0-9]+[A-Z]+$/, '').trim();
                    let seg = segment || kiteInst?.segment || exchange || '';
                    
                    // Try user-specific rules first, then global (user_id: null)
                    const userRules = await BrokerageSettings.find({ user_id: user._id, deleted_at: null }).lean();
                    const globalRules = userRules.length === 0 ? await BrokerageSettings.find({ user_id: null, deleted_at: null }).lean() : [];
                    const rules = userRules.length > 0 ? userRules : globalRules;
                    let brokerageRule = null;
                    if (rawName && seg) brokerageRule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
                    if (!brokerageRule && rawName) brokerageRule = rules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
                    if (!brokerageRule && seg) brokerageRule = rules.find(r => r.exchange_name === seg.toUpperCase() && (!r.script_name || r.script_name.trim() === ''));
                    if (!brokerageRule) brokerageRule = rules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && (!r.script_name || r.script_name.trim() === ''));

                    if (brokerageRule) {
                        if (brokerageRule.type === 'TURNOVER WISE') {
                            brokerage = (executedPrice * quantity) * (brokerageRule.brk_value / 10000);
                        } else if (brokerageRule.type === 'LOT WISE') {
                            const lots = lotSize > 1 ? quantity / lotSize : quantity;
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

            await tradeWriteLease.assertActive({ session });
            resultTrade = newTrade;
        });

        await session.endSession();

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

        // Register pending LIMIT orders before releasing the distributed write
        // lease. Settlement cannot cancel the Mongo row and clean Redis between
        // commit and registration. Mongo remains authoritative if Redis is down.
        if (resultTrade.status === 'pending' && resultTrade.order_type === 'LIMIT') {
            const stillPending = await Trade.exists({
                _id: resultTrade._id,
                status: 'pending',
                deleted_at: null,
            });
            if (stillPending) {
                try {
                    await orderBookService.addOrder(
                        resultTrade._id.toString(),
                        resultTrade.instrument_token,
                        resultTrade.price,
                        resultTrade.transaction_type
                    );
                } catch (redisError) {
                    console.error(`⚠️ [OrderBook] Pending order ${resultTrade._id} will be repaired from MongoDB: ${redisError.message}`);
                }

                const livePriceService = require('../services/livePriceService');
                livePriceService.addPendingToken(resultTrade.instrument_token);
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
        }

        await tradeWriteLease?.release();
        tradeWriteLease = null;

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
        await session.endSession().catch(() => {});
        await tradeWriteLease?.release();
        tradeWriteLease = null;

        // Map an insufficient category-wallet rejection (thrown by walletService.block as
        // the affordability gate) to a clear, user-facing message naming the category and
        // shortfall (Task 5, Requirements 4.1 / 4.2). The available-balance read runs
        // outside the aborted transaction and is best-effort.
        if (error.code === 'INSUFFICIENT_WALLET') {
            const walletCat = error.category;
            const requiredAmt = Number(error.requested) || 0;
            let availableAmt = null;
            try {
                const walletTargetId = (req.body.user_id && req.admin)
                    ? req.body.user_id
                    : (req.body.user_id || req.user?.id || req.master?.id || req.admin?.id);
                if (walletTargetId && walletCat) {
                    const bal = await walletService.getAvailable('User', walletTargetId);
                    availableAmt = Number(bal[walletCat]) || 0;
                }
            } catch (_) { /* best-effort — fall back to a required-only message */ }

            if (availableAmt != null) {
                const shortfall = Math.max(0, Math.round((requiredAmt - availableAmt) * 100) / 100);
                error.message = `Insufficient ${walletCat} wallet balance. Required ₹${requiredAmt.toFixed(2)}, available ₹${availableAmt.toFixed(2)} (short ₹${shortfall.toFixed(2)}).`;
            } else {
                error.message = `Insufficient ${walletCat} wallet balance. Required ₹${requiredAmt.toFixed(2)}.`;
            }
            error.status = 400;
        }

        // Save rejected trade to rejection log for margin/FSL failures
        const isRejectable = error.message.includes('free margin') ||
            error.message.includes('Trade margin is not configured') ||
            error.message.includes('Fresh Stop-Loss') ||
            error.message.includes('close-only mode') ||
            error.message.includes('Trading is currently disabled') ||
            error.message.includes('Insufficient balance') ||
            error.message.includes('Insufficient margin') ||
            error.message.includes('wallet balance') ||
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

        let statusCode = error.status || 500;
        if (error.message === 'User not found') statusCode = 404;
        else if (error.message.includes('Option selling is not allowed') || error.message.includes('would create a short position')) statusCode = 403;
        else if (error.message.includes('Trading is currently disabled')) statusCode = 403;
        else if (error.message.includes('close-only mode')) statusCode = 403;
        else if (error.message.includes('Insufficient balance') || error.message.includes('Insufficient margin') || error.message.includes('Insufficient free margin')) statusCode = 400;
        else if (error.code === 'INSUFFICIENT_WALLET' || error.message.includes('wallet balance')) statusCode = 400;
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
                    wallet: metrics.wallet || {},
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
                wallet: {},
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
                // Active regular trades and margin square-offs (completed)
                { status: 'completed', deleted_at: null, trade_type: { $nin: ['carry_forward'] } },
                // Active carry_forward trades (needed for position calculation, but marked so Flutter can hide from Trade tab)
                { status: 'completed', deleted_at: null, trade_type: 'carry_forward' },
                // Pending orders (limit orders waiting to be filled)
                { status: 'pending', deleted_at: null },
                // Cancelled orders (visible in history)
                { status: 'cancelled', deleted_at: null },
                // Include all period-qualified settlement rows. Remarks are
                // presentation text and must not be an API discriminator.
                { status: 'completed', settlement_period_key: { $type: 'string' } },
                // Backward-compatible legacy settlement remarks:
                { status: 'completed', remarks: 'Settlement: position closed at settlement price' },
                // 2. Flat positions fully closed during the week (buy = sell, just reset)
                { status: 'completed', remarks: 'Settlement: week reset (flat position)' },
                // 3. Regular trades from the settled week
                { status: 'completed', remarks: 'Settlement: week reset' },
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
        await withTradeWriteLease('cancel_order', () => trade.save());

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
        res.status(error.status || 500).json({
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

        // ── Wallet reversal for completed trades ──
        // Before soft-deleting, release/adjust the wallet to undo the margin impact
        if (trade.status === 'completed' && trade.executed_quantity > 0) {
            try {
                const walletCategory = categoryForSegment(trade.exchange || '');
                const userId = trade.user_id;

                // Aggregate current position INCLUDING the trade being deleted
                const currentAgg = await Trade.aggregate([
                    { $match: { user_id: userId, instrument_token: trade.instrument_token, status: 'completed', deleted_at: null } },
                    { $group: {
                        _id: null,
                        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                        total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                        total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                    }}
                ]);

                // Aggregate AFTER deletion (exclude this trade)
                const afterAgg = await Trade.aggregate([
                    { $match: { user_id: userId, instrument_token: trade.instrument_token, status: 'completed', deleted_at: null, _id: { $ne: trade._id } } },
                    { $group: {
                        _id: null,
                        total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                        total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                        total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                        total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                    }}
                ]);

                const cur = currentAgg.length > 0 ? currentAgg[0] : { total_buy_qty: 0, total_sell_qty: 0, total_buy_value: 0, total_sell_value: 0 };
                const aft = afterAgg.length > 0 ? afterAgg[0] : { total_buy_qty: 0, total_sell_qty: 0, total_buy_value: 0, total_sell_value: 0 };

                // Current blocked = |currentNetQty| × avgEntryPrice
                const curNetQty = cur.total_buy_qty - cur.total_sell_qty;
                const curAvgEntry = curNetQty > 0
                    ? (cur.total_buy_qty > 0 ? cur.total_buy_value / cur.total_buy_qty : 0)
                    : (cur.total_sell_qty > 0 ? cur.total_sell_value / cur.total_sell_qty : 0);
                const currentBlocked = Math.abs(curNetQty) * curAvgEntry;

                // After blocked = |afterNetQty| × avgEntryPrice (after removing this trade)
                const aftNetQty = aft.total_buy_qty - aft.total_sell_qty;
                const aftAvgEntry = aftNetQty > 0
                    ? (aft.total_buy_qty > 0 ? aft.total_buy_value / aft.total_buy_qty : 0)
                    : (aft.total_sell_qty > 0 ? aft.total_sell_value / aft.total_sell_qty : 0);
                const afterBlocked = Math.abs(aftNetQty) * aftAvgEntry;

                // Release the difference (if current > after, funds should be freed)
                const walletDelta = currentBlocked - afterBlocked;
                if (walletDelta > 0) {
                    await walletService.release('User', userId, walletCategory, walletDelta);
                    console.log(`🗑️  [DeleteTrade] Released ₹${walletDelta.toFixed(2)} from ${walletCategory} wallet for user ${userId}`);
                } else if (walletDelta < 0) {
                    // Position increased on delete (rare — e.g., deleting a closing trade re-opens position)
                    // Don't block — let metricsEngine handle it; blocking could fail if insufficient funds
                    console.log(`⚠️  [DeleteTrade] Position increased by ₹${Math.abs(walletDelta).toFixed(2)} after delete — wallet not re-blocked`);
                }
            } catch (walletErr) {
                console.error(`⚠️  [DeleteTrade] Wallet reversal failed (non-fatal):`, walletErr.message);
                // Continue with delete even if wallet reversal fails
            }
        }

        trade.deleted_at = new Date();
        await withTradeWriteLease('delete_trade', () => trade.save());

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

        const targetUserId = trade.user_id.toString();
        
        // Rebuild metrics cache so the deleted trade is removed from open positions instantly
        const metricsEngine = require('../services/metricsEngine');
        metricsEngine.onTradeExecuted(targetUserId).catch(() => {});

        // FCM notification to trade owner
        try {
            firebaseService.sendNotification(targetUserId, 'admin_order_deletion', {
                title: 'Trade Deleted by Admin',
                body: `${trade.transaction_type} ${trade.quantity} ${trade.tradingsymbol} has been deleted`,
                data: { trade_id: trade._id.toString(), tradingsymbol: trade.tradingsymbol },
            });
            
            const livePriceService = require('../services/livePriceService');
            livePriceService.broadcastToUser(targetUserId, {
                type: 'trade_deleted',
                trade_id: trade._id.toString(),
                instrument_token: trade.instrument_token,
            });
        } catch (fcmErr) {
            console.error('⚠️  [FCM] deleteTrade notification error:', fcmErr.message);
        }
    } catch (error) {
        res.status(error.status || 500).json({ success: false, message: error.message });
    }
};

/**
 * Get brokerage rules for frontend brokerage calculation
 */
const getBrokerageRules = async (req, res) => {
    try {
        const userId = req.user?._id || req.user?.id || null;
        // Try user-specific rules; if none exist, fall back to global
        let rules = userId ? await BrokerageSettings.find({ user_id: userId, deleted_at: null }) : [];
        if (rules.length === 0) {
            rules = await BrokerageSettings.find({ user_id: null, deleted_at: null });
        }
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
    let tradeWriteLease = null;
    try {
        const userId = req.user?.id || req.master?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { instrument_tokens } = req.body;
        if (!instrument_tokens || !Array.isArray(instrument_tokens) || instrument_tokens.length === 0) {
            return res.status(400).json({ success: false, message: 'instrument_tokens array required' });
        }

        // Acquire before user, position, instrument, and price snapshots.
        tradeWriteLease = await beginTradeWrite('legacy_carry_forward');
        const results = [];
        const errors = [];

        for (const rawToken of instrument_tokens) {
            const token = rawToken.toString();
            const session = await mongoose.startSession();
            let committed = null;
            try {
                await session.withTransaction(async () => {
                    committed = null;
                    await tradeWriteLease.assertActive({ session });
                    const user = await User.findById(userId).select('master_id admin_id').session(session).lean();
                    if (!user) throw new Error('User not found');

                    const posAgg = await Trade.aggregate([
                        { $match: { user_id: new mongoose.Types.ObjectId(userId), instrument_token: token, status: 'completed', deleted_at: null } },
                        { $group: {
                            _id: null,
                            total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                            total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                        }},
                    ]).session(session);
                    const netQty = posAgg.length > 0 ? posAgg[0].total_buy_qty - posAgg[0].total_sell_qty : 0;
                    if (netQty === 0) return;

                    const instrument = await KiteInstrument.findOne({ instrument_token: token }).session(session).lean();
                    if (!instrument) throw new Error('Instrument not found');
                    const closePrice = Number(instrument.settlement_price || instrument.last_price || 0);
                    if (closePrice <= 0) throw new Error('No settlement price available');

                    const absQty = Math.abs(netQty);
                    const closeSide = netQty > 0 ? 'SELL' : 'BUY';
                    const reopenSide = netQty > 0 ? 'BUY' : 'SELL';
                    const closingTrades = await Trade.find({
                        user_id: user._id,
                        instrument_token: token,
                        status: 'completed',
                        deleted_at: null,
                        transaction_type: netQty > 0 ? 'BUY' : 'SELL',
                    }).sort({ executed_at: 1 }).session(session).lean();

                    let remainingQty = absQty;
                    let totalCost = 0;
                    for (const trade of closingTrades) {
                        if (remainingQty <= 0) break;
                        const used = Math.min(Number(trade.executed_quantity || 0), remainingQty);
                        totalCost += used * Number(trade.executed_price || 0);
                        remainingQty -= used;
                    }
                    if (remainingQty > 0) throw new Error('Position fills cannot be reconciled for carry forward');
                    const avgEntryPrice = totalCost / absQty;
                    const closePnl = netQty > 0
                        ? (closePrice - avgEntryPrice) * absQty
                        : (avgEntryPrice - closePrice) * absQty;
                    const closeTime = new Date();

                    await Trade.create([{
                        user_id: user._id,
                        master_id: user.master_id,
                        admin_id: user.admin_id || null,
                        instrument_token: token,
                        tradingsymbol: instrument.tradingsymbol,
                        exchange: instrument.exchange,
                        transaction_type: closeSide,
                        quantity: absQty,
                        price: closePrice,
                        order_type: 'MARKET',
                        placed_by: 'SYSTEM',
                        trade_type: 'carry_forward',
                        status: 'completed',
                        executed_at: closeTime,
                        executed_price: closePrice,
                        executed_quantity: absQty,
                        pnl: Math.round(closePnl * 100) / 100,
                        brokerage: 0,
                        taxes: 0,
                        net_amount: Math.round(closePnl * 100) / 100,
                        remarks: 'Carry forward close — ATP adjustment',
                    }, {
                        user_id: user._id,
                        master_id: user.master_id,
                        admin_id: user.admin_id || null,
                        instrument_token: token,
                        tradingsymbol: instrument.tradingsymbol,
                        exchange: instrument.exchange,
                        transaction_type: reopenSide,
                        quantity: absQty,
                        price: closePrice,
                        order_type: 'MARKET',
                        placed_by: 'SYSTEM',
                        trade_type: 'carry_forward',
                        status: 'completed',
                        executed_at: new Date(closeTime.getTime() + 1),
                        executed_price: closePrice,
                        executed_quantity: absQty,
                        pnl: 0,
                        brokerage: 0,
                        taxes: 0,
                        net_amount: 0,
                        remarks: 'Carry forward reopen — ATP adjustment',
                    }], { session, ordered: true });
                    await tradeWriteLease.assertActive({ session });
                    committed = {
                        token,
                        tradingsymbol: instrument.tradingsymbol,
                        qty: absQty,
                        close_price: closePrice,
                        pnl: Math.round(closePnl * 100) / 100,
                    };
                });

                if (committed) {
                    const metricsEngine = require('../services/metricsEngine');
                    await metricsEngine.onTradeExecuted(userId);
                    results.push(committed);
                }
            } catch (error) {
                if (error.code === 'TRADE_WRITE_LEASE_LOST') throw error;
                errors.push({ token, message: error.message });
            } finally {
                await session.endSession();
            }
        }

        res.status(200).json({
            success: true,
            message: `Carry forward ${results.length} position(s)${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
            data: { carried_forward: results, errors },
        });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, message: error.message, data: null });
    } finally {
        await tradeWriteLease?.release();
    }
};

/**
 * GET /trade/instrument-info?token=X
 * Returns brokerage rule and instrument details for the info sheet.
 * (Per-instrument trade margin was removed — margin is now notional |qty| × price.)
 */
const getInstrumentInfo = async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ success: false, message: 'token is required' });

        const KiteInstrument = require('../models/KiteInstrument');
        const BrokerageSettings = require('../models/BrokerageSettings');

        const instrument = await KiteInstrument.findOne({ instrument_token: token }).lean();
        if (!instrument) return res.status(404).json({ success: false, message: 'Instrument not found' });

        const seg = instrument.segment || '';
        const rawName = instrument.raw_name || '';
        const exchange = seg.split('-')[0] || instrument.exchange || '';

        // Brokerage: 4-level fallback (raw_name+segment → raw_name → segment → exchange)
        // Try user-specific rules first, then global (user_id: null)
        const userId = req.user?._id || req.user?.id || null;
        let brkRule = null;

        async function findBrkRule(uid) {
            const uidFilter = { user_id: uid, deleted_at: null };
            let r = null;
            if (rawName && seg) r = await BrokerageSettings.findOne({ ...uidFilter, script_name: { $regex: new RegExp(`^${rawName}$`, 'i') }, exchange_name: seg.toUpperCase() }).lean();
            if (!r && rawName) r = await BrokerageSettings.findOne({ ...uidFilter, script_name: { $regex: new RegExp(`^${rawName}$`, 'i') } }).lean();
            if (!r && seg) r = await BrokerageSettings.findOne({ ...uidFilter, exchange_name: seg.toUpperCase(), script_name: { $in: [null, ''] } }).lean();
            if (!r) r = await BrokerageSettings.findOne({ ...uidFilter, exchange_name: exchange.toUpperCase(), script_name: { $in: [null, ''] } }).lean();
            return r;
        }

        if (userId) brkRule = await findBrkRule(userId);
        if (!brkRule) brkRule = await findBrkRule(null);

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
    computeWalletSplit,
    cancelTrade,
    deleteTrade,
    getAccountMetrics,
    saveClientMetrics,
    getPositions,
    getBrokerageRules,
    autoSquareOffExpired,
    getInstrumentInfo,
};
