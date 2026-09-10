const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const { escapeRegex } = require('../utils/escapeRegex');
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
const { computeWalletSplit, computeFlatResetState } = require('../utils/walletSplit');
const firebaseService = require('../services/firebaseService');
const { beginTradeWrite, withTradeWriteLease } = require('../services/tradeWriteFenceService');
const { sanitizeErrorMessage } = require('../utils/sanitizeError');
const { calculateBrokerage } = require('../services/brokerageService');

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
        // Fetch all completed trades once, chronologically, and derive each
        // instrument's average-cost state with a flat-reset walk
        // (computeFlatResetState) instead of a single unbounded aggregate —
        // an account that closed and reopened the same contract earlier in
        // the settlement week previously got a contaminated average for the
        // position that's open right now.
        const trades = await Trade.find({ user_id: userId, status: 'completed', deleted_at: null })
            .select('instrument_token transaction_type executed_quantity executed_price executed_at createdAt')
            .sort({ executed_at: 1, createdAt: 1 })
            .session(session)
            .lean();

        const byInstrument = new Map();
        for (const t of trades) {
            const token = t.instrument_token.toString();
            if (!byInstrument.has(token)) byInstrument.set(token, []);
            byInstrument.get(token).push(t);
        }

        const openPositions = [];
        for (const [token, instrumentTrades] of byInstrument) {
            const state = computeFlatResetState(instrumentTrades);
            if (state.netQty !== 0) openPositions.push({ _id: token, ...state });
        }
        if (openPositions.length === 0) return 0;

        // Fetch live prices for open position tokens
        const tokens = openPositions.map(p => parseInt(p._id));
        const ltpMap = await _getLivePricesFromKite(tokens);

        let totalFloating = 0;
        for (const pos of openPositions) {
            const netQty = pos.netQty;
            const avgBuy = pos.totalBuyQty > 0 ? pos.totalBuyValue / pos.totalBuyQty : 0;
            const avgSell = pos.totalSellQty > 0 ? pos.totalSellValue / pos.totalSellQty : 0;
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
 * Circuit-limit check for a LIMIT order's price. Shared between placeTrade
 * (a fresh order) and modifyTrade (a changed price on a pending order) — a
 * modified price is a new price the caller is choosing right now, so it
 * must pass the exact same check a fresh placement at that price would.
 */
async function _validateCircuitLimit(instrument_token, price, order_type) {
    if (order_type === 'LIMIT' && price) {
        const kiteInst = await KiteInstrument.findOne({ instrument_token });
        if (kiteInst) {
            const upper = kiteInst.upper_circuit_limit;
            const lower = kiteInst.lower_circuit_limit;
            if (upper && upper > 0 && price > upper) {
                throw new Error(`Limit price ₹${price} exceeds upper circuit limit ₹${upper}`);
            }
            if (lower && lower > 0 && price < lower) {
                throw new Error(`Limit price ₹${price} is below lower circuit limit ₹${lower}`);
            }
        }
    }
}

/**
 * Script-quantity break_qty/max_qty limit check (turnover-mode in raw
 * quantity, lot-mode in lots). Shared between placeTrade and modifyTrade —
 * a modified quantity must clear the same per-order and position-size caps
 * a fresh order at that quantity would. Returns instrumentRawName since
 * callers need it for the FSL/High-Low checks that follow.
 */
async function _validateScriptQuantityLimit(user, instrument_token, transaction_type, quantity, segment, exchange, tradingsymbol, session) {
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
    const instrumentRawName = kiteInst?.raw_name || kiteInst?.name || null;

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
        }
    }

    return { instrumentRawName };
}

/**
 * Fresh Stop-Loss price-offset restriction — applies to LIMIT and SL/SL-M
 * alike, gated behind a configured FreshStoplossLimit row AND the user's
 * fresh_stoploss toggle. Shared between placeTrade and modifyTrade (the
 * MARKET-only time restriction is NOT included here — modify never applies
 * to MARKET orders, so it stays inline in placeTrade only).
 */
async function _validateFreshStoplossPriceOffset(isAdmin, user, instrument_token, order_type, transaction_type, price, segment, exchange, instrumentRawName) {
    if (isAdmin || !instrumentRawName) return;

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

    if (!(fslLimit && user.fresh_stoploss === true)) return;
    if (!((order_type === 'LIMIT' || order_type === 'SL' || order_type === 'SL-M') && fslLimit.price_offset > 0 && price > 0)) return;

    // Get live CMP from metricsEngine — use LTP (same basis as placement)
    const metricsEngFSL = require('../services/metricsEngine');
    const livePriceSvc = require('../services/livePriceService');
    const tokenStr = instrument_token.toString();
    const tokenInt = parseInt(instrument_token);
    const cmpFSL = metricsEngFSL._ltpMap?.get(tokenStr)
        || livePriceSvc.latestPrices?.get(tokenStr)
        || livePriceSvc.latestPrices?.get(tokenInt)
        || null;

    if (!(cmpFSL && cmpFSL > 0)) return;

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

/**
 * Fresh Stop-Loss: gate whether an SL/SL-M order may OPEN a fresh position.
 * Shared between placeTrade and modifyTrade — see the inline comment this
 * replaced for the full fresh_stoploss=true/false rule.
 */
async function _validateFreshStoplossOpenPosition(isAdmin, user, instrument_token, order_type, transaction_type, session) {
    if (!isAdmin && (order_type === 'SL' || order_type === 'SL-M') && user.fresh_stoploss !== true) {
        const prevTradesFreshSL = await Trade.find({
            user_id: user._id, instrument_token, status: 'completed', deleted_at: null
        })
            .select('transaction_type executed_quantity executed_price executed_at createdAt')
            .sort({ executed_at: 1, createdAt: 1 })
            .session(session)
            .lean();
        const stateFreshSL = computeFlatResetState(prevTradesFreshSL);
        const hasProtectiveLong = transaction_type === 'SELL' && stateFreshSL.netQty > 0;
        const hasProtectiveShort = transaction_type === 'BUY' && stateFreshSL.netQty < 0;
        if (!hasProtectiveLong && !hasProtectiveShort) {
            throw new Error('Fresh Stop-Loss is off for this account: a stoploss order can only be placed to protect an existing position, not to open a new one.');
        }
    }
}

/**
 * High-Low Trade Limit check — independent of the FSL limit above. Runs for
 * ALL LIMIT orders from non-admin users. Shared between placeTrade and
 * modifyTrade.
 */
async function _validateHighLowLimit(canCustomPrice, user, instrument_token, order_type, transaction_type, price, segment, exchange, instrumentRawName) {
    if (canCustomPrice || order_type !== 'LIMIT' || !(price > 0)) return;

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

    if (tradeLimitEnabled) return;

    // Button OFF: Buy limit must clear whichever is HIGHER of Day
    // High or (CMP + offset); Sell limit must clear whichever is
    // LOWER of Day Low or (CMP - offset). A limit order can never
    // fill at a price better than today's actual range — it can
    // only fill at a genuine breakout (buy) or breakdown (sell)
    // level, never at an artificially favourable price inside it.
    try {
        const kiteInstHL = await KiteInstrument.findOne({ instrument_token }).select('exchange tradingsymbol ohlc_high ohlc_low').lean();
        if (kiteInstHL) {
            const quoteKey = `${kiteInstHL.exchange}:${kiteInstHL.tradingsymbol}`;
            let dayHigh, dayLow;
            try {
                const ohlcData = await kiteService.getMarketQuotes([quoteKey], 'ohlc');
                const quote = ohlcData?.[quoteKey];
                dayHigh = quote?.ohlc?.high;
                dayLow = quote?.ohlc?.low;
            } catch (_) {
                // Kite has no record of non-Kite instruments (GLOBAL/COMEX,
                // fed by massiveFuturesFeedService.js) — falls through below.
            }
            // Kite quote lookup returns nothing for non-Kite instruments
            // (GLOBAL/COMEX Massive-fed contracts) — fall back to the
            // instrument's own ohlc_high/ohlc_low, tracked live by
            // massiveFuturesFeedService.js's per-tick $max/$min updates.
            if (!(dayHigh > 0) || !(dayLow > 0)) {
                dayHigh = kiteInstHL.ohlc_high;
                dayLow = kiteInstHL.ohlc_low;
            }

            // Get offset from FSL limit if available, otherwise 0
            const FreshStoplossLimitHL = require('../models/FreshStoplossLimit');
            const fslLimitHL = await FreshStoplossLimitHL.findOne({
                exchange_name: hlNormalizedSeg,
                raw_name: instrumentRawName,
                deleted_at: null
            });
            const hlOffset = fslLimitHL?.price_offset || 0;

            const metricsEngHL = require('../services/metricsEngine');
            const livePriceSvcHL = require('../services/livePriceService');
            const tokenStrHL = instrument_token.toString();
            const tokenIntHL = parseInt(instrument_token);
            const cmpHL = metricsEngHL._ltpMap?.get(tokenStrHL)
                || livePriceSvcHL.latestPrices?.get(tokenStrHL)
                || livePriceSvcHL.latestPrices?.get(tokenIntHL)
                || null;

            console.log(`📊 [HighLow] segment=${tradeLimitSegment}, enabled=${tradeLimitEnabled}, high=${dayHigh}, low=${dayLow}, cmp=${cmpHL}, offset=${hlOffset}, price=${price}, type=${transaction_type}`);

            if (dayHigh && dayLow && dayHigh > 0 && dayLow > 0 && cmpHL && cmpHL > 0) {
                if (transaction_type === 'BUY') {
                    const minBuyPrice = Math.max(dayHigh, cmpHL + hlOffset);
                    if (price <= minBuyPrice) {
                        throw new Error(`High-Low restriction: Buy limit must be above ₹${minBuyPrice.toFixed(2)} (Day High ₹${dayHigh.toFixed(2)} vs CMP ₹${cmpHL.toFixed(2)} + offset ₹${hlOffset}, whichever is higher).`);
                    }
                } else if (transaction_type === 'SELL') {
                    const maxSellPrice = Math.min(dayLow, cmpHL - hlOffset);
                    if (price >= maxSellPrice) {
                        throw new Error(`High-Low restriction: Sell limit must be below ₹${maxSellPrice.toFixed(2)} (Day Low ₹${dayLow.toFixed(2)} vs CMP ₹${cmpHL.toFixed(2)} - offset ₹${hlOffset}, whichever is lower).`);
                    }
                }
            }
        }
    } catch (hlErr) {
        if (hlErr.message.includes('High-Low restriction')) throw hlErr;
        console.warn(`⚠️ [HighLow] Could not fetch OHLC for trade limit check: ${hlErr.message}`);
    }
}

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
        // A plain user (req.user) is ALWAYS forced to their own id, full stop —
        // req.body.user_id must never be honoured for that role. Previously
        // `req.body.user_id || callerId` still picked the body value whenever
        // it was present, even for a plain user, since the `isAdminOrMaster`
        // check only gated which branch's RESULT got used, not whether the
        // body value was eligible in the first place. Any logged-in user
        // could place a real trade on any other account by supplying its id.
        const targetUserId = isAdminOrMaster ? (req.body.user_id || callerId) : callerId;
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
        try {
            await _validateCircuitLimit(instrument_token, price, order_type);
        } catch (circuitErr) {
            return res.status(400).json({ success: false, message: circuitErr.message });
        }

        let resultTrade;
        // Captured for the Trade Alert broadcast below (outside the
        // transaction closure) — reuses the `user` doc already fetched
        // here for every other check in this function, no extra query.
        let resultUserInfo = null;
        tradeWriteLease = await beginTradeWrite('place_trade');

        await session.withTransaction(async () => {
            await tradeWriteLease.assertActive({ session });
            const user = await User.findById(targetUserId).populate('master_id').session(session);
            if (!user) {
                throw new Error('User not found');
            }
            resultUserInfo = { name: user.name, username: user.username };

            // A master must only be able to place trades for users in their
            // own subtree (any depth — sub-masters' users included), never
            // an arbitrary user_id. Previously unchecked: any master could
            // pass any user_id and this would place a real trade against
            // that account. Admin remains unrestricted by design.
            if (req.master) {
                const { getAllSubMasterIds } = require('../services/masterHierarchyService');
                const allowedMasterIds = await getAllSubMasterIds(req.master.id);
                const userMasterId = (user.master_id?._id || user.master_id)?.toString();
                if (!userMasterId || !allowedMasterIds.includes(userMasterId)) {
                    throw new Error('Not authorized to place a trade for this user');
                }
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

            // ── Margin-call block (system-driven, separate from admin's manual
            //    bet/close_only toggles above) ──
            // Admin placing on behalf of user bypasses this check, same as every
            // other account-level gate here.
            if (!req.admin) {
                if (user.margin_call_blocked === true) {
                    throw new Error('Trading is blocked: a margin square-off already closed all your positions. Contact your master/admin to add credit and resume.');
                }

                // Toggle-OFF path: margin_square_off never auto-closes positions for
                // this account, so once live M2M loss reaches the full credit, block
                // any INCREASING trade (new or adding to a position) while still
                // allowing the user to close/reduce what they already have. This is
                // deliberately live/non-sticky (re-evaluated on every order) — unlike
                // margin_call_blocked above, nothing was force-closed here, so the
                // block should lift on its own the moment the market recovers.
                if (!user.margin_square_off && !(user.margin_square_off_percentage > 0)) {
                    const metricsEngForMarginCall = require('../services/metricsEngine');
                    const liveMetricsForMarginCall = metricsEngForMarginCall.getCachedMetrics(user._id.toString());
                    const creditForMarginCall = Number(user.credits || 0);
                    if (liveMetricsForMarginCall && Number(liveMetricsForMarginCall.m2m_pnl || 0) <= -creditForMarginCall) {
                        const posAggForMarginCall = await Trade.aggregate([
                            { $match: { user_id: user._id, instrument_token, status: 'completed', deleted_at: null } },
                            { $group: {
                                _id: null,
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } }
                            }}
                        ]).session(session);
                        const currentNetQtyForMarginCall = posAggForMarginCall.length > 0
                            ? posAggForMarginCall[0].total_buy_qty - posAggForMarginCall[0].total_sell_qty
                            : 0;
                        const isClosingForMarginCall = (transaction_type === 'SELL' && currentNetQtyForMarginCall > 0)
                            || (transaction_type === 'BUY' && currentNetQtyForMarginCall < 0);
                        if (!isClosingForMarginCall) {
                            throw new Error(`Trading is blocked: your live M2M loss (₹${Math.abs(liveMetricsForMarginCall.m2m_pnl).toFixed(2)}) has reached your full credit (₹${creditForMarginCall.toFixed(2)}). You can only close existing positions until your master/admin adds credit.`);
                        }
                    }
                }
            }

            // ── Expiry check: an expired contract has no real market/settlement
            // price and cannot legitimately be traded by ANYONE — unlike the
            // enabled/deleted_at checks below (deliberate admin business
            // toggles admin can override), this is a market fact, so there is
            // no admin bypass here. Confirmed live: a user placed real MARKET
            // orders on a NIFTY option the day AFTER its expiry (expiry
            // 2026-09-08, trades placed 2026-09-09) — nothing in this endpoint
            // ever checked expiry at all. Date-only comparison (matches
            // fetchInstruments.js's own "expired" boundary) so trading is
            // still allowed through the end of the expiry day itself.
            const instCheckExpiry = await KiteInstrument.findOne({ instrument_token }).select('enabled deleted_at expiry segment').lean().session(session);
            if (instCheckExpiry?.expiry) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const expiryDate = new Date(instCheckExpiry.expiry);
                if (expiryDate < today) {
                    throw new Error('This contract has expired and can no longer be traded.');
                }
            }

            // ── Options: MARKET only, no LIMIT/SL/SL-M at all (open, add, or
            //    close) — confirmed business rule. Uses the instrument's own
            //    segment from KiteInstrument (authoritative), not
            //    req.body.segment (client-supplied, sent for lookup
            //    convenience elsewhere but never trustworthy for a real
            //    restriction). Admin placing on behalf of a user bypasses
            //    this, same as every other account-level/instrument-level
            //    gate in this function.
            if (!req.admin && order_type !== 'MARKET') {
                const optionSegments = ['NFO-OPT', 'BFO-OPT', 'MCX-OPT'];
                if (optionSegments.includes((instCheckExpiry?.segment || '').toUpperCase())) {
                    throw new Error('Only MARKET orders are allowed for options — LIMIT and SL/SL-M are not permitted.');
                }
            }

            // ── Instrument enabled check: if instrument is disabled, only closing trades allowed ──
            // ── Instrument deleted check: if instrument is deleted, block ALL trades ──
            if (!req.admin) {
                const instCheck = instCheckExpiry;
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

            // ── Exchange permission check: the instrument's segment must be in the
            //    user's exchanges_allowed. Admin placing on behalf of a user bypasses
            //    this check (unrestricted by design, same as every other account-level
            //    gate above). Previously exchanges_allowed was read for turnover/lot
            //    MODE selection and brokerage/group lookups only — nothing anywhere
            //    actually rejected a trade for a segment the user was never granted,
            //    so the exchange-permission checkboxes on every create/edit account
            //    screen had no real effect on what a user could trade.
            //    GLOBAL/INDICES are treated as the same permission — both are valid
            //    enum values on exchanges_allowed for historical reasons (older
            //    records may say INDICES, current UI always writes GLOBAL), and the
            //    mobile client already normalizes the same way for display.
            if (!req.admin) {
                const rawSegmentForAllow = (segment || exchange || '').toUpperCase();
                const candidates = new Set([rawSegmentForAllow]);
                if (rawSegmentForAllow === 'GLOBAL') candidates.add('INDICES');
                if (rawSegmentForAllow === 'INDICES') candidates.add('GLOBAL');

                const hasAccess = (user.exchanges_allowed || []).some((ex) => {
                    const name = (ex.exchange_name || '').toUpperCase();
                    const normalized = name === 'INDICES' ? 'GLOBAL' : name;
                    return candidates.has(name) || candidates.has(normalized);
                });

                if (!hasAccess) {
                    throw new Error(`Your account is not permitted to trade ${segment || exchange || 'this instrument'}. Contact your master/admin.`);
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
            const { instrumentRawName } = await _validateScriptQuantityLimit(
                user, instrument_token, transaction_type, quantity, segment, exchange, tradingsymbol, session
            );

            // ── Fresh Stop-Loss: MARKET-order time restriction ──────────────
            // Stays inline (not extracted) — modify never applies to MARKET
            // orders, so this half has no shared caller. The price-offset
            // half (LIMIT/SL/SL-M) is extracted below into
            // _validateFreshStoplossPriceOffset, shared with modifyTrade.
            if (!req.admin && instrumentRawName && order_type === 'MARKET') {
                const FreshStoplossLimit = require('../models/FreshStoplossLimit');
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

                // Only restrict closing if the position is in PROFIT. Loss positions can close anytime.
                if (fslLimit && user.fresh_stoploss === true && fslLimit.time_minutes > 0) {
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

                    console.log(`🔒 [FSL] Checking time restriction: instrument=${instrumentRawName}, segment=${normalizedSeg}, time_minutes=${fslLimit.time_minutes}, cmp=${ltpFSL}`);
                    // Flat-reset average (computeFlatResetState) instead of a plain
                    // unbounded aggregate — this decides whether a real order gets
                    // BLOCKED or ALLOWED, so a stale average from an earlier, already-
                    // closed round trip this week could wrongly gate a live order, not
                    // just show a wrong number after the fact.
                    const prevTradesFSL = await Trade.find({ user_id: user._id, instrument_token, status: 'completed', deleted_at: null })
                        .select('transaction_type executed_quantity executed_price executed_at createdAt')
                        .sort({ executed_at: 1, createdAt: 1 })
                        .session(session)
                        .lean();
                    const stateFSL = computeFlatResetState(prevTradesFSL);

                    const currentNetQty = stateFSL.netQty;
                    const isClosing = (transaction_type === 'SELL' && currentNetQty > 0) ||
                                      (transaction_type === 'BUY' && currentNetQty < 0);

                    if (isClosing) {
                        // Check if position is in profit using bid/ask (same as orders page)
                        // BUY position: profit if bid > avg buy (exit = sell at bid)
                        // SELL position: profit if ask < avg sell (exit = buy at ask)
                        let positionInProfit = false;
                        const avgBuyFSL = stateFSL.totalBuyQty > 0 ? stateFSL.totalBuyValue / stateFSL.totalBuyQty : 0;
                        const avgSellFSL = stateFSL.totalSellQty > 0 ? stateFSL.totalSellValue / stateFSL.totalSellQty : 0;
                        if (currentNetQty > 0 && bidFSL && bidFSL > 0) {
                            positionInProfit = bidFSL > avgBuyFSL;
                        } else if (currentNetQty < 0 && askFSL && askFSL > 0) {
                            positionInProfit = askFSL < avgSellFSL;
                        }

                        console.log(`🔒 [FSL] netQty=${currentNetQty}, isClosing=${isClosing}, positionInProfit=${positionInProfit}, bid=${bidFSL}, ask=${askFSL}, ltp=${ltpFSL}, avgBuy=${avgBuyFSL}, avgSell=${avgSellFSL}`);
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

            // ── Fresh Stop-Loss: price-offset restriction (LIMIT/SL/SL-M) ──
            await _validateFreshStoplossPriceOffset(!!req.admin, user, instrument_token, order_type, transaction_type, price, segment, exchange, instrumentRawName);

            // ── Fresh Stop-Loss: gate whether an SL/SL-M order may OPEN a fresh position ──
            await _validateFreshStoplossOpenPosition(!!req.admin, user, instrument_token, order_type, transaction_type, session);

            // ── High-Low Trade Limit check (INDEPENDENT of FSL limit) ──────
            // The admin bypass here IS "custom-price order placement" from the
            // permissions plan — gated behind TRADE_CUSTOM for a regular Admin;
            // Super Admin and Master/User callers are unaffected (Master/User
            // never had req.admin set, so they always hit this check regardless).
            const adminCanCustomPrice = !!req.admin && (req.admin.isSuperAdmin || (req.admin.permissions || []).includes('TRADE_CUSTOM'));
            await _validateHighLowLimit(adminCanCustomPrice, user, instrument_token, order_type, transaction_type, price, segment, exchange, instrumentRawName);

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

            // For SL/SL-M only: decide the trigger direction ONCE here, from
            // where the trigger sits relative to the live price at this exact
            // moment — NOT from transaction_type. A SELL stop placed ABOVE the
            // live price (e.g. a fresh breakout-short entry) must fire on a
            // RISE to that level, not a FALL — the old hardcoded "SL SELL
            // always fires on fall" rule treated that as already-true and
            // instant-filled it. By construction this makes shouldExecuteNow
            // below false at placement in every normal case (the direction
            // chosen always points away from the current price); it only
            // resolves true on the exact-equal edge case, or later via
            // orderBookService's live-tick matching once price genuinely
            // reaches the trigger.
            let triggerDirection = null;
            if (order_type === 'SL' || order_type === 'SL-M') {
                if (livePrice != null && executedPrice > livePrice) triggerDirection = 'RISE';
                else if (livePrice != null && executedPrice < livePrice) triggerDirection = 'FALL';
                else triggerDirection = transaction_type === 'BUY' ? 'RISE' : 'FALL';
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
                if (triggerDirection === 'RISE' && livePrice >= executedPrice) {
                    shouldExecuteNow = true;
                } else if (triggerDirection === 'FALL' && livePrice <= executedPrice) {
                    shouldExecuteNow = true;
                }
            }

            const tradeStatus = shouldExecuteNow ? 'completed' : 'pending';

            // 3. Calculate realised P&L if this trade closes (or partially closes) a position
            let tradeRealisedPnl = 0;
            // Flat-reset average-cost state (computeFlatResetState) — shared below with the
            // margin/wallet block, since both need the same "position before this trade"
            // state and there's no trade mutation in between. Was previously a plain
            // unbounded aggregate with no reset when the position last returned to flat,
            // which blended an already-closed prior round trip into this trade's average —
            // confirmed against a real trade (BUY 30 @ 57562.60 -> SELL 30 @ 57810.00 showed
            // P&L +3171.00 instead of the correct 7422.00).
            let flatResetState = { netQty: 0, totalBuyQty: 0, totalSellQty: 0, totalBuyValue: 0, totalSellValue: 0 };
            if (shouldExecuteNow) {
                const prevTradesForFill = await Trade.find({
                    user_id: user._id,
                    instrument_token: instrument_token,
                    status: 'completed',
                    deleted_at: null
                })
                    .select('transaction_type executed_quantity executed_price executed_at createdAt')
                    .sort({ executed_at: 1, createdAt: 1 })
                    .session(session)
                    .lean();
                flatResetState = computeFlatResetState(prevTradesForFill);

                const netQtyFromPrev = flatResetState.netQty;
                const avgBuyPrice = flatResetState.totalBuyQty > 0 ? flatResetState.totalBuyValue / flatResetState.totalBuyQty : 0;
                const avgSellPrice = flatResetState.totalSellQty > 0 ? flatResetState.totalSellValue / flatResetState.totalSellQty : 0;

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
                trigger_direction: triggerDirection,
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
                // Same state computed above for the P&L calc — no second query needed.
                const prevNetQtyForMargin = flatResetState.netQty;
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

                    const walletAvgBuy = flatResetState.totalBuyQty > 0
                        ? flatResetState.totalBuyValue / flatResetState.totalBuyQty : 0;
                    const walletAvgSell = flatResetState.totalSellQty > 0
                        ? flatResetState.totalSellValue / flatResetState.totalSellQty : 0;

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
                // marginDelta is notional (calculateMargin returns full |qty|×price since
                // Task 3), computed here for the transaction metadata only. It is NOT
                // subtracted from persisted user.equity below — wallet.block/release
                // above already reserves/frees this exact notional from the
                // user's wallet balance, so subtracting it again here was double-
                // counting the same margin against two different balance fields
                // (design D2: persisted equity = credit + realised P&L only, same
                // as marginSquareOffService's square-off path, which computes no
                // marginDelta for the same reason).
                const marginDelta = newMargin - prevMargin; // +ve = more margin needed

                // #7 FIX: Block if free margin goes negative (balance - currentMargin - newMarginDelta < 0)
                // if (marginDelta > 0) {
                //     const freeMargin = user.equity - prevMargin;
                //     if (freeMargin < marginDelta) {
                //         throw new Error(`Insufficient free margin. Free: ₹${freeMargin.toFixed(2)}, Required: ₹${marginDelta.toFixed(2)}`);
                //     }
                // }

                // Brokerage: delegate to the shared calculateBrokerage (brokerageService.js) —
                // previously an inline copy of the same 4-level rule-matching logic duplicated
                // across this file, priceQueueService.js, and orderExecutionService.js, which is
                // exactly the kind of place a fix lands in one copy and not the others (already
                // happened once — see brokerageService.js's own header comment). newTrade is
                // already saved with instrument_token/tradingsymbol/exchange/price/quantity/user_id,
                // which is everything calculateBrokerage needs; it re-resolves segment/lot_size
                // itself from a fresh KiteInstrument lookup rather than trusting caller-local state.
                const brokerage = await calculateBrokerage(newTrade, session);

                const balanceBefore = user.equity;
                const balanceChange = tradeRealisedPnl - brokerage;

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

            // Trade Alert (web-only): live log for a master watching their
            // whole downstream tree, plus admin. Purely additive, own
            // try/catch so any failure here can never affect the trade
            // response already computed above.
            try {
                const metricsEngine = require('../services/metricsEngine');
                metricsEngine.broadcastTradeAlert(resultTrade.user_id.toString(), {
                    trade_id: resultTrade._id.toString(),
                    user_id: resultTrade.user_id.toString(),
                    client_name: resultUserInfo?.name || null,
                    client_username: resultUserInfo?.username || null,
                    instrument_token: resultTrade.instrument_token,
                    tradingsymbol: resultTrade.tradingsymbol,
                    transaction_type: resultTrade.transaction_type,
                    quantity: resultTrade.executed_quantity,
                    price: resultTrade.executed_price,
                    order_type: resultTrade.order_type,
                    status: 'completed',
                    executed_at: resultTrade.executed_at || new Date(),
                });
            } catch (alertErr) {
                console.error('⚠️ [TradeAlert] broadcast error:', alertErr.message);
            }
        }

        // Register pending LIMIT and SL/SL-M orders before releasing the
        // distributed write lease. Settlement cannot cancel the Mongo row and
        // clean Redis between commit and registration. Mongo remains
        // authoritative if Redis is down.
        //
        // SL/SL-M used to be excluded here entirely — a real bug: they were
        // accepted at placement (a valid order_type) but never registered
        // anywhere (Redis order book, DB-fallback query, boot-time sync all
        // filtered to 'LIMIT' only), so a stop-loss order sat pending with
        // zero actual protection until the end-of-day cleanup cancelled it.
        if (resultTrade.status === 'pending' && ['LIMIT', 'SL', 'SL-M'].includes(resultTrade.order_type)) {
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
                        resultTrade.transaction_type,
                        resultTrade.order_type,
                        resultTrade.trigger_direction
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

                // Trade Alert (web-only): a pending LIMIT/SL/SL-M order was
                // just placed, not yet filled — logged with status
                // 'pending' so the live log distinguishes it from an actual
                // execution. Own try/catch, purely additive.
                try {
                    const metricsEngine = require('../services/metricsEngine');
                    metricsEngine.broadcastTradeAlert(resultTrade.user_id.toString(), {
                        trade_id: resultTrade._id.toString(),
                        user_id: resultTrade.user_id.toString(),
                        client_name: resultUserInfo?.name || null,
                        client_username: resultUserInfo?.username || null,
                        instrument_token: resultTrade.instrument_token,
                        tradingsymbol: resultTrade.tradingsymbol,
                        transaction_type: resultTrade.transaction_type,
                        quantity: resultTrade.quantity,
                        price: resultTrade.price,
                        order_type: resultTrade.order_type,
                        status: 'pending',
                        executed_at: resultTrade.created_at || new Date(),
                    });
                } catch (alertErr) {
                    console.error('⚠️ [TradeAlert] broadcast error:', alertErr.message);
                }
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
        else if (error.message === 'Not authorized to place a trade for this user') statusCode = 403;
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
            message: sanitizeErrorMessage(error),
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
            message: sanitizeErrorMessage(error),
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
        res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
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

        // For master/admin, optionally filter by user_id query param, otherwise show own trades.
        // A master must only be able to read positions for users in their own
        // subtree — previously any master could pass any user_id and read a
        // completely unrelated user's full trade/position history. Admin
        // remains unrestricted by design.
        let targetUserId = userId;
        if (req.admin && req.query.user_id) {
            targetUserId = req.query.user_id;
        } else if (req.master && req.query.user_id) {
            const { getAllSubMasterIds } = require('../services/masterHierarchyService');
            const allowedMasterIds = await getAllSubMasterIds(req.master.id);
            const targetUser = await User.findById(req.query.user_id).select('master_id').lean();
            const targetMasterId = targetUser?.master_id?.toString();
            if (!targetUser || !targetMasterId || !allowedMasterIds.includes(targetMasterId)) {
                return res.status(403).json({ success: false, message: 'Not authorized to view this user\'s positions' });
            }
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
            message: sanitizeErrorMessage(error),
            data: null
        });
    }
}


/**
 * Cancel a pending limit order
 */
const cancelTrade = async (req, res) => {
    try {
        const { tradeId } = req.params;

        if (!req.user && !req.master && !req.admin) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const trade = await Trade.findOne({ _id: tradeId, deleted_at: null });

        if (!trade) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        // Ownership check. A trade's user_id is always the CLIENT it belongs
        // to, even when placed by a master/admin on that client's behalf —
        // req.user/master/admin.id can never equal it for those callers, so
        // this previously matched user_id against the CALLER's own id
        // unconditionally, meaning a master/admin could never cancel a
        // client's pending order at all. A User may only cancel their own
        // order; a Master may cancel any order belonging to a user anywhere
        // in their subtree (trade.master_id is that user's DIRECT master,
        // which may be several tiers below the caller); Admin may cancel any.
        if (req.user) {
            if (trade.user_id.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Not authorized to cancel this trade' });
            }
        } else if (req.master && !req.admin) {
            const { getAllSubMasterIds } = require('../services/masterHierarchyService');
            const allowedMasterIds = await getAllSubMasterIds(req.master.id);
            if (!trade.master_id || !allowedMasterIds.includes(trade.master_id.toString())) {
                return res.status(403).json({ success: false, message: 'Not authorized to cancel this trade' });
            }
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
            trade.transaction_type,
            trade.order_type,
            trade.trigger_direction
        );

        res.status(200).json({
            success: true,
            message: 'Order cancelled successfully',
            data: trade
        });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            message: sanitizeErrorMessage(error),
            data: null
        });
    }
};

/**
 * Modify a still-pending LIMIT or SL/SL-M order's price and/or quantity.
 * Same ownership rules as cancelTrade. Re-runs the same price/quantity-
 * specific validators a fresh placement at the new values would (circuit
 * limit, script-quantity limit, Fresh Stop-Loss price-offset, High-Low
 * limit, and — for SL/SL-M — the fresh_stoploss open-position gate), but
 * does NOT re-check account-level gates (bet/close_only/margin_call_blocked/
 * instrument enabled) since those are already re-verified at fill time
 * regardless of whether this order was just modified.
 *
 * True in-place update: same Trade _id, only price/quantity (and, for
 * SL/SL-M, trigger_direction) change — not a cancel-and-replace.
 */
const modifyTrade = async (req, res) => {
    try {
        const { tradeId } = req.params;
        const { price: newPriceRaw, quantity: newQuantityRaw } = req.body;

        if (!req.user && !req.master && !req.admin) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        if (newPriceRaw === undefined && newQuantityRaw === undefined) {
            return res.status(400).json({ success: false, message: 'Provide a new price and/or quantity to modify.' });
        }

        const trade = await Trade.findOne({ _id: tradeId, deleted_at: null });
        if (!trade) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        // Ownership check — identical to cancelTrade's (see its own comment
        // for the full reasoning: a trade's user_id is always the CLIENT,
        // never the caller, when placed by a master/admin on their behalf).
        if (req.user) {
            if (trade.user_id.toString() !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Not authorized to modify this trade' });
            }
        } else if (req.master && !req.admin) {
            const { getAllSubMasterIds } = require('../services/masterHierarchyService');
            const allowedMasterIds = await getAllSubMasterIds(req.master.id);
            if (!trade.master_id || !allowedMasterIds.includes(trade.master_id.toString())) {
                return res.status(403).json({ success: false, message: 'Not authorized to modify this trade' });
            }
        }

        if (trade.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Cannot modify trade with status: ${trade.status}` });
        }
        if (trade.order_type === 'MARKET') {
            return res.status(400).json({ success: false, message: 'MARKET orders execute immediately and cannot be modified.' });
        }

        const newPrice = newPriceRaw !== undefined ? Number(newPriceRaw) : trade.price;
        const newQuantity = newQuantityRaw !== undefined ? Number(newQuantityRaw) : trade.quantity;
        if (!Number.isFinite(newPrice) || newPrice <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid price' });
        }
        if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid quantity' });
        }

        const user = await User.findById(trade.user_id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const isAdmin = !!req.admin;

        // Re-run the same price/quantity-specific checks a fresh placement
        // at these new values would — see this function's own doc comment
        // for why account-level gates are deliberately NOT repeated here.
        try {
            await _validateCircuitLimit(trade.instrument_token, newPrice, trade.order_type);
            const { instrumentRawName } = await _validateScriptQuantityLimit(
                user, trade.instrument_token, trade.transaction_type, newQuantity, trade.segment, trade.exchange, trade.tradingsymbol, null
            );
            await _validateFreshStoplossPriceOffset(isAdmin, user, trade.instrument_token, trade.order_type, trade.transaction_type, newPrice, trade.segment, trade.exchange, instrumentRawName);
            await _validateFreshStoplossOpenPosition(isAdmin, user, trade.instrument_token, trade.order_type, trade.transaction_type, null);
            const adminCanCustomPrice = isAdmin && (req.admin.isSuperAdmin || (req.admin.permissions || []).includes('TRADE_CUSTOM'));
            await _validateHighLowLimit(adminCanCustomPrice, user, trade.instrument_token, trade.order_type, trade.transaction_type, newPrice, trade.segment, trade.exchange, instrumentRawName);
        } catch (validationErr) {
            return res.status(400).json({ success: false, message: validationErr.message });
        }

        // For SL/SL-M, the trigger direction must be recomputed fresh — a
        // new price at a new moment can have a different correct direction
        // than the order's original one (see tradeController.js's placeTrade
        // for the identical rule this mirrors).
        let newTriggerDirection = trade.trigger_direction;
        if (trade.order_type === 'SL' || trade.order_type === 'SL-M') {
            const metricsEngForModify = require('../services/metricsEngine');
            const livePriceSvcForModify = require('../services/livePriceService');
            const tokenStr = trade.instrument_token.toString();
            const tokenInt = parseInt(trade.instrument_token);
            let livePriceForModify = metricsEngForModify._ltpMap?.get(tokenStr)
                || livePriceSvcForModify.latestPrices?.get(tokenStr)
                || livePriceSvcForModify.latestPrices?.get(tokenInt)
                || null;
            // Same Kite API backstop placeTrade uses when both in-memory tick
            // caches are cold (process just restarted, pre-market, or a
            // Massive-fed GLOBAL/COMEX contract) — without this, modify
            // silently fell back to the old hardcoded BUY=rise/SELL=fall
            // rule this feature exists to eliminate.
            if (livePriceForModify == null) {
                const ltpMapForModify = await _getLivePricesFromKite([tokenInt]);
                livePriceForModify = ltpMapForModify.get(tokenInt) || ltpMapForModify.get(tokenStr) || null;
            }
            if (livePriceForModify != null && newPrice > livePriceForModify) newTriggerDirection = 'RISE';
            else if (livePriceForModify != null && newPrice < livePriceForModify) newTriggerDirection = 'FALL';
            else newTriggerDirection = trade.transaction_type === 'BUY' ? 'RISE' : 'FALL';
        }

        // Remove the OLD order-book entry (old price/direction) before
        // updating the Trade document, so a tick arriving mid-update can
        // never match against stale data under either key. If the save
        // below throws, re-add the order under its ORIGINAL values before
        // re-throwing — otherwise a failed save would leave the order
        // completely de-registered from Redis while still 'pending' in
        // Mongo, silently un-triggerable until the next consistency-audit
        // sweep or server restart.
        const oldPrice = trade.price;
        const oldTransactionType = trade.transaction_type;
        const oldOrderType = trade.order_type;
        const oldTriggerDirection = trade.trigger_direction;
        await orderBookService.removeOrder(
            trade._id.toString(),
            trade.instrument_token,
            oldTransactionType,
            oldOrderType,
            oldTriggerDirection
        );

        try {
            trade.price = newPrice;
            trade.quantity = newQuantity;
            trade.trigger_direction = newTriggerDirection;
            await withTradeWriteLease('modify_order', () => trade.save());
        } catch (saveErr) {
            await orderBookService.addOrder(
                trade._id.toString(),
                trade.instrument_token,
                oldPrice,
                oldTransactionType,
                oldOrderType,
                oldTriggerDirection
            );
            throw saveErr;
        }

        await orderBookService.addOrder(
            trade._id.toString(),
            trade.instrument_token,
            trade.price,
            trade.transaction_type,
            trade.order_type,
            trade.trigger_direction
        );

        res.status(200).json({
            success: true,
            message: 'Order modified successfully',
            data: trade
        });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            message: sanitizeErrorMessage(error),
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
        // Admin-only. Masters were previously allowed here too, but they have
        // no ownership/hierarchy check against the trade's user — any master
        // could delete any user's trade system-wide. The web portal already
        // hides this action for masters (AccountPanels.tsx's canDelete=false
        // on MasterClientDetail); this closes the same door on the API itself.
        const callerId = req.admin?.id;
        const { tradeId } = req.params;

        if (!callerId) {
            return res.status(403).json({ success: false, message: 'Only admin can delete trades' });
        }

        const trade = await Trade.findById(tradeId);
        if (!trade || trade.deleted_at) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        // ── Wallet reversal for completed trades ──
        // Before soft-deleting, release/adjust the wallet to undo the margin impact
        if (trade.status === 'completed' && trade.executed_quantity > 0) {
            try {
                // trade.exchange holds the coarse exchange (NFO/MCX), not the
                // segment (NFO-FUT/NFO-OPT) — categoryForSegment needs the
                // segment or every derivative here resolves to GLOBAL instead
                // of NSE/MCX, releasing this trade's margin into the wrong
                // wallet pool. Same trap already documented and avoided in
                // priceQueueService.js; resolve segment from the instrument here too.
                const deletedInstrument = await KiteInstrument.findOne({ instrument_token: trade.instrument_token }).select('segment').lean();
                const walletCategory = categoryForSegment(deletedInstrument?.segment || trade.exchange || '');
                const userId = trade.user_id;

                // Fetch every completed trade for this (user, instrument) once,
                // chronologically, and derive both "current" (including the trade
                // being deleted) and "after" (excluding it) states with the same
                // flat-reset walk used everywhere else P&L/wallet basis is
                // computed — a plain unbounded aggregate here had the same
                // contamination risk as everywhere else: an already-closed prior
                // round trip blending into the average for whatever's open now.
                const allInstrumentTrades = await Trade.find({
                    user_id: userId, instrument_token: trade.instrument_token, status: 'completed', deleted_at: null
                })
                    .select('_id transaction_type executed_quantity executed_price executed_at createdAt')
                    .sort({ executed_at: 1, createdAt: 1 })
                    .lean();

                const deletedTradeId = trade._id.toString();
                const cur = computeFlatResetState(allInstrumentTrades);
                const aft = computeFlatResetState(allInstrumentTrades.filter(t => t._id.toString() !== deletedTradeId));

                // Current blocked = |currentNetQty| × avgEntryPrice
                const curNetQty = cur.netQty;
                const curAvgEntry = curNetQty > 0
                    ? (cur.totalBuyQty > 0 ? cur.totalBuyValue / cur.totalBuyQty : 0)
                    : (cur.totalSellQty > 0 ? cur.totalSellValue / cur.totalSellQty : 0);
                const currentBlocked = Math.abs(curNetQty) * curAvgEntry;

                // After blocked = |afterNetQty| × avgEntryPrice (after removing this trade)
                const aftNetQty = aft.netQty;
                const aftAvgEntry = aftNetQty > 0
                    ? (aft.totalBuyQty > 0 ? aft.totalBuyValue / aft.totalBuyQty : 0)
                    : (aft.totalSellQty > 0 ? aft.totalSellValue / aft.totalSellQty : 0);
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
                    trade.transaction_type,
                    trade.order_type,
                    trade.trigger_direction
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
        res.status(error.status || 500).json({ success: false, message: sanitizeErrorMessage(error) });
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
            message: sanitizeErrorMessage(error),
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
                errors.push({ token, message: sanitizeErrorMessage(error) });
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
        res.status(error.status || 500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
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
            if (rawName && seg) r = await BrokerageSettings.findOne({ ...uidFilter, script_name: { $regex: new RegExp(`^${escapeRegex(rawName)}$`, 'i') }, exchange_name: seg.toUpperCase() }).lean();
            if (!r && rawName) r = await BrokerageSettings.findOne({ ...uidFilter, script_name: { $regex: new RegExp(`^${escapeRegex(rawName)}$`, 'i') } }).lean();
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
        res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
    }
};

/**
 * POST /trade/rollover
 * Square off selected open position(s) and immediately reopen the same
 * qty/direction on the next-expiry contract in the same series — two real
 * trades (brokerage charged on both), not a free ATP carry-forward like
 * autoSquareOffExpired. Mirrors placeTrade's own authorization model (a
 * Master must specify a user_id within their subtree; Admin is unrestricted)
 * since this reuses the exact same close/open validation a normal trade
 * would go through.
 */
const rolloverPositions = async (req, res) => {
    let tradeWriteLease = null;
    try {
        const callerId = req.user?.id || req.master?.id || req.admin?.id;
        const isAdminOrMaster = !!(req.admin || req.master);
        const targetUserId = isAdminOrMaster ? (req.body.user_id || callerId) : callerId;
        if (!targetUserId) {
            return res.status(401).json({ success: false, message: 'Unauthorized / User ID missing' });
        }
        if (isAdminOrMaster && !req.body.user_id) {
            return res.status(400).json({ success: false, message: 'Please select a user to roll over a position on their behalf.' });
        }

        const { instrument_tokens } = req.body;
        if (!instrument_tokens || !Array.isArray(instrument_tokens) || instrument_tokens.length === 0) {
            return res.status(400).json({ success: false, message: 'instrument_tokens array required' });
        }

        const { resolveNextExpiryInstrument } = require('../services/rolloverInstrumentService');
        const metricsEngine = require('../services/metricsEngine');
        const livePriceService = require('../services/livePriceService');

        tradeWriteLease = await beginTradeWrite('rollover');
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

                    const user = await User.findById(targetUserId).populate('master_id').session(session);
                    if (!user) throw new Error('User not found');

                    if (req.master) {
                        const { getAllSubMasterIds } = require('../services/masterHierarchyService');
                        const allowedMasterIds = await getAllSubMasterIds(req.master.id);
                        const userMasterId = (user.master_id?._id || user.master_id)?.toString();
                        if (!userMasterId || !allowedMasterIds.includes(userMasterId)) {
                            throw new Error('Not authorized to roll over a position for this user');
                        }
                    }

                    const oldInstrument = await KiteInstrument.findOne({ instrument_token: token }).session(session).lean();
                    if (!oldInstrument) throw new Error('Instrument not found');

                    const prevTrades = await Trade.find({
                        user_id: user._id,
                        instrument_token: token,
                        status: 'completed',
                        deleted_at: null,
                    }).select('transaction_type executed_quantity executed_price executed_at createdAt')
                      .sort({ executed_at: 1, createdAt: 1 })
                      .session(session)
                      .lean();
                    const state = computeFlatResetState(prevTrades);
                    const netQty = state.netQty;
                    if (netQty === 0) throw new Error(`No open position on ${oldInstrument.tradingsymbol}.`);

                    const newInstrument = await resolveNextExpiryInstrument(oldInstrument, session);
                    if (!newInstrument) throw new Error(`No further expiry available to roll ${oldInstrument.tradingsymbol} into.`);

                    const absQty = Math.abs(netQty);
                    const originalSide = netQty > 0 ? 'BUY' : 'SELL'; // direction of the existing position
                    const closeSide = originalSide === 'BUY' ? 'SELL' : 'BUY';
                    const openSide = originalSide; // rollover keeps the same direction

                    // ── New-instrument gates — same rules a fresh trade on this instrument
                    //    would go through, since the reopen leg genuinely IS a fresh trade.
                    if (newInstrument.deleted_at) {
                        throw new Error('Admin has deactivated the next-expiry script. Rollover is not allowed.');
                    }
                    if (newInstrument.enabled === false) {
                        throw new Error('The next-expiry script has been disabled by admin. Rollover is not allowed.');
                    }
                    if (!req.admin && user.bet === false) {
                        throw new Error('Trading is currently disabled for your account.');
                    }
                    if (!req.admin && user.close_only === true) {
                        throw new Error('Your account is in close-only mode. You can only close existing positions.');
                    }
                    // Rollover's reopen leg is always fresh exposure on the new
                    // contract (never a close), so both margin-call gates block it
                    // unconditionally — same reasoning as close_only just above.
                    if (!req.admin && user.margin_call_blocked === true) {
                        throw new Error('Trading is blocked: a margin square-off already closed all your positions. Contact your master/admin to add credit and resume.');
                    }
                    if (!req.admin && !user.margin_square_off && !(user.margin_square_off_percentage > 0)) {
                        const metricsEngForRolloverMarginCall = require('../services/metricsEngine');
                        const liveMetricsForRolloverMarginCall = metricsEngForRolloverMarginCall.getCachedMetrics(user._id.toString());
                        const creditForRolloverMarginCall = Number(user.credits || 0);
                        if (liveMetricsForRolloverMarginCall && Number(liveMetricsForRolloverMarginCall.m2m_pnl || 0) <= -creditForRolloverMarginCall) {
                            throw new Error(`Trading is blocked: your live M2M loss (₹${Math.abs(liveMetricsForRolloverMarginCall.m2m_pnl).toFixed(2)}) has reached your full credit (₹${creditForRolloverMarginCall.toFixed(2)}). You can only close existing positions until your master/admin adds credit.`);
                        }
                    }
                    if (!req.admin) {
                        const rawSegmentForAllow = (newInstrument.segment || newInstrument.exchange || '').toUpperCase();
                        const allowCandidates = new Set([rawSegmentForAllow]);
                        if (rawSegmentForAllow === 'GLOBAL') allowCandidates.add('INDICES');
                        if (rawSegmentForAllow === 'INDICES') allowCandidates.add('GLOBAL');
                        const hasAccess = (user.exchanges_allowed || []).some((ex) => {
                            const name = (ex.exchange_name || '').toUpperCase();
                            const normalized = name === 'INDICES' ? 'GLOBAL' : name;
                            return allowCandidates.has(name) || allowCandidates.has(normalized);
                        });
                        if (!hasAccess) {
                            throw new Error(`Your account is not permitted to trade ${rawSegmentForAllow || 'this instrument'}. Contact your master/admin.`);
                        }
                    }
                    // Naked-option-short rule: the reopen leg is always a FRESH position
                    // on the new contract (net qty 0 going in), so a SELL open on a CE/PE
                    // is never allowed here — same rule as placing any other fresh option
                    // sell. In practice this means only long option positions roll over;
                    // a short must be squared off and reopened manually.
                    if (['CE', 'PE'].includes(newInstrument.instrument_type) && openSide === 'SELL') {
                        throw new Error('Option selling is not allowed. You must own this option before you can sell it — a short option position cannot be rolled over.');
                    }

                    // Script-quantity max_qty gate. Unlike a normal trade (which only
                    // blocks the INCREMENTAL increase beyond the limit — closing/reducing
                    // is always allowed regardless of a lowered limit, so an already-open
                    // position that now exceeds a since-lowered max_qty is grandfathered
                    // in place), the reopen leg here is a genuinely FRESH position on the
                    // new contract with zero prior qty — so the entire absQty counts as
                    // new exposure. A position that grew under an old, higher limit and
                    // now exceeds a since-lowered one cannot roll over automatically; it
                    // must be squared off (or partially reduced) manually first. This is
                    // deliberately all-or-nothing per position — other selected positions
                    // in the same rollover batch are unaffected (each runs in its own
                    // transaction, see the per-token loop below).
                    {
                        const rawSegment = (newInstrument.segment || newInstrument.exchange || '').toUpperCase();
                        const normalizedExchangeForQty = rawSegment === 'GLOBAL' ? 'INDICES' : rawSegment;
                        const userExchangeCfg = user.exchanges_allowed?.find(
                            ex => ex.exchange_name.toUpperCase() === normalizedExchangeForQty
                        );
                        const isTurnover = userExchangeCfg?.turnover === true;
                        const isLotMode = userExchangeCfg?.lot === true;

                        if (isTurnover || isLotMode) {
                            const newRawName = newInstrument.raw_name || newInstrument.name || null;
                            let scriptQty = newRawName
                                ? await ScriptQuantity.findOne({
                                    owner_id: user._id,
                                    exchange_name: normalizedExchangeForQty,
                                    script_name: newRawName,
                                    deleted_at: null,
                                }).session(session)
                                : null;
                            if (!scriptQty) {
                                scriptQty = await ScriptQuantity.findOne({
                                    owner_id: user._id,
                                    exchange_name: normalizedExchangeForQty,
                                    script_name: newInstrument.tradingsymbol,
                                    deleted_at: null,
                                }).session(session);
                            }

                            const limitValue = scriptQty?.max_qty ?? null;
                            if (limitValue !== null && limitValue > 0) {
                                const qtyLotSize = scriptQty?.lot_size || newInstrument.lot_size || 1;
                                const requested = isLotMode ? Math.ceil(absQty / qtyLotSize) : absQty;
                                if (requested > limitValue) {
                                    const unit = isLotMode ? 'lot(s)' : 'qty';
                                    throw new Error(
                                        `Rollover exceeds the current maximum position limit for ${newInstrument.tradingsymbol}. Max: ${limitValue} ${unit}, Requested: ${requested} ${unit}. Square off the excess manually before rolling over.`
                                    );
                                }
                            }
                        }
                    }

                    const ltpOld = metricsEngine._ltpMap?.get(token);
                    const closePrice = closeSide === 'SELL'
                        ? (metricsEngine._bidMap?.get(token) || ltpOld)
                        : (metricsEngine._askMap?.get(token) || ltpOld);
                    if (!closePrice || closePrice <= 0) throw new Error(`No live price available for ${oldInstrument.tradingsymbol}.`);

                    const newToken = newInstrument.instrument_token;
                    const ltpNew = metricsEngine._ltpMap?.get(newToken);
                    const openPrice = openSide === 'BUY'
                        ? (metricsEngine._askMap?.get(newToken) || ltpNew)
                        : (metricsEngine._bidMap?.get(newToken) || ltpNew);
                    if (!openPrice || openPrice <= 0) throw new Error(`No live price available for ${newInstrument.tradingsymbol}.`);

                    const rolloverGroupId = new mongoose.Types.ObjectId();
                    const closeTime = new Date();
                    const balanceBefore = user.equity;

                    // ── Close leg — realise P&L, release the full closing notional, charge brokerage.
                    const avgBuy = state.totalBuyQty > 0 ? state.totalBuyValue / state.totalBuyQty : 0;
                    const avgSell = state.totalSellQty > 0 ? state.totalSellValue / state.totalSellQty : 0;
                    const closePnl = Math.round((originalSide === 'BUY'
                        ? (closePrice - avgBuy) * absQty
                        : (avgSell - closePrice) * absQty) * 100) / 100;

                    const closeTrade = new Trade({
                        user_id: user._id,
                        master_id: user.master_id._id,
                        admin_id: user.admin_id || null,
                        instrument_token: token,
                        tradingsymbol: oldInstrument.tradingsymbol,
                        exchange: oldInstrument.exchange,
                        transaction_type: closeSide,
                        quantity: absQty,
                        price: closePrice,
                        order_type: 'MARKET',
                        placed_by: req.admin ? 'ADMIN' : (req.master ? 'MASTER' : 'USER'),
                        status: 'completed',
                        executed_at: closeTime,
                        executed_price: closePrice,
                        executed_quantity: absQty,
                        rollover_group_id: rolloverGroupId,
                        remarks: `Rollover close — reopening on ${newInstrument.tradingsymbol}`,
                    });
                    const closeBrokerage = await calculateBrokerage(closeTrade, session);
                    closeTrade.pnl = closePnl;
                    closeTrade.brokerage = closeBrokerage;
                    closeTrade.net_amount = Math.round((closePnl - closeBrokerage) * 100) / 100;
                    await closeTrade.save({ session });

                    const closeCategory = categoryForSegment(oldInstrument.segment || oldInstrument.exchange || '');
                    const closeReleaseBasis = originalSide === 'BUY' ? avgBuy : avgSell;
                    if (closeReleaseBasis > 0) {
                        await walletService.release('User', user._id, closeCategory, absQty * closeReleaseBasis, session);
                    }

                    // ── Reopen leg — brand-new position, block the full opening notional, charge brokerage.
                    const openTrade = new Trade({
                        user_id: user._id,
                        master_id: user.master_id._id,
                        admin_id: user.admin_id || null,
                        instrument_token: newToken,
                        tradingsymbol: newInstrument.tradingsymbol,
                        exchange: newInstrument.exchange,
                        transaction_type: openSide,
                        quantity: absQty,
                        price: openPrice,
                        order_type: 'MARKET',
                        placed_by: req.admin ? 'ADMIN' : (req.master ? 'MASTER' : 'USER'),
                        status: 'completed',
                        executed_at: new Date(closeTime.getTime() + 1),
                        executed_price: openPrice,
                        executed_quantity: absQty,
                        rollover_group_id: rolloverGroupId,
                        remarks: `Rollover reopen — closed out of ${oldInstrument.tradingsymbol}`,
                    });
                    const openBrokerage = await calculateBrokerage(openTrade, session);
                    openTrade.pnl = 0;
                    openTrade.brokerage = openBrokerage;
                    openTrade.net_amount = Math.round(-openBrokerage * 100) / 100;
                    await openTrade.save({ session });

                    const openCategory = categoryForSegment(newInstrument.segment || newInstrument.exchange || '');
                    // block() throws INSUFFICIENT_WALLET when the pool can't cover it,
                    // aborting this whole transaction — the close leg above rolls back too,
                    // so a rollover never leaves the user flat with no reopened position.
                    await walletService.block('User', user._id, openCategory, absQty * openPrice, session);

                    user.equity = user.equity + (closePnl - closeBrokerage) - openBrokerage;
                    await user.save({ session });

                    await Transaction.create([{
                        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_RC`,
                        userId: user._id,
                        userModel: 'User',
                        type: closeSide,
                        status: 'SUCCESS',
                        amount: closePrice * absQty,
                        referenceId: closeTrade._id,
                        referenceModel: 'Trade',
                        balanceBefore,
                        balanceAfter: balanceBefore + (closePnl - closeBrokerage),
                        metadata: {
                            tradingsymbol: oldInstrument.tradingsymbol,
                            quantity: absQty,
                            executedPrice: closePrice,
                            realisedPnl: closePnl,
                            brokerage: closeBrokerage,
                            rollover_group_id: rolloverGroupId.toString(),
                            rollover_leg: 'close',
                        },
                    }, {
                        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_RO`,
                        userId: user._id,
                        userModel: 'User',
                        type: openSide,
                        status: 'SUCCESS',
                        amount: openPrice * absQty,
                        referenceId: openTrade._id,
                        referenceModel: 'Trade',
                        balanceBefore: balanceBefore + (closePnl - closeBrokerage),
                        balanceAfter: user.equity,
                        metadata: {
                            tradingsymbol: newInstrument.tradingsymbol,
                            quantity: absQty,
                            executedPrice: openPrice,
                            realisedPnl: 0,
                            brokerage: openBrokerage,
                            rollover_group_id: rolloverGroupId.toString(),
                            rollover_leg: 'open',
                        },
                    }], { session, ordered: true });

                    await tradeWriteLease.assertActive({ session });
                    committed = {
                        rollover_group_id: rolloverGroupId.toString(),
                        old: { token, tradingsymbol: oldInstrument.tradingsymbol, price: closePrice, brokerage: closeBrokerage, pnl: closePnl },
                        new: { token: newToken, tradingsymbol: newInstrument.tradingsymbol, price: openPrice, brokerage: openBrokerage },
                        qty: absQty,
                    };
                });

                if (committed) {
                    const metricsEngineNotify = require('../services/metricsEngine');
                    await metricsEngineNotify.onTradeExecuted(targetUserId);
                    livePriceService.broadcastToUser(targetUserId.toString(), {
                        type: 'rollover_executed',
                        rollover_group_id: committed.rollover_group_id,
                        old_instrument_token: committed.old.token,
                        new_instrument_token: committed.new.token,
                        new_tradingsymbol: committed.new.tradingsymbol,
                        quantity: committed.qty,
                    });
                    results.push(committed);
                }
            } catch (error) {
                if (error.code === 'TRADE_WRITE_LEASE_LOST') throw error;
                errors.push({ token, message: sanitizeErrorMessage(error) });
            } finally {
                await session.endSession();
            }
        }

        res.status(200).json({
            success: true,
            message: `Rolled over ${results.length} position(s)${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
            data: { rolled_over: results, errors },
        });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
    } finally {
        await tradeWriteLease?.release();
    }
};

module.exports = {
    placeTrade,
    computeWalletSplit,
    cancelTrade,
    modifyTrade,
    deleteTrade,
    getAccountMetrics,
    saveClientMetrics,
    getPositions,
    getBrokerageRules,
    autoSquareOffExpired,
    getInstrumentInfo,
    rolloverPositions,
};
