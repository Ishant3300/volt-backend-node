const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const { calculateMargin } = require('./marginService');
const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * Service to dynamically calculate the 7 required account metrics for a user or master.
 */
class TradeMetricsService {

    /**
     * Get dynamic account metrics for a user
     * @param {string} userId - User ID
     * @param {Map} ltpMap - Map of instrument_token => current LTP
     */
    async getUserMetrics(userId, ltpMap = new Map()) {
        const user = await User.findById(userId);
        if (!user) throw new Error('User not found');

        const credit = user.credits || 0;
        const balance = user.balance || 0;

        // Aggregate trades per instrument
        const trades = await Trade.aggregate([
            { $match: { user_id: user._id, status: 'completed', deleted_at: null } },
            {
                $group: {
                    _id: { instrument_token: '$instrument_token', exchange: '$exchange', tradingsymbol: '$tradingsymbol' },
                    total_buy_qty: {
                        $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] }
                    },
                    total_sell_qty: {
                        $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] }
                    },
                    total_buy_value: {
                        $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] }
                    },
                    total_sell_value: {
                        $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] }
                    }
                }
            }
        ]);

        let totalPositionPnl = 0;
        let totalMarginUsed = 0;

        // Recalculate brokerage from BrokerageSettings (stored trade.brokerage is unreliable)
        const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();

        const rawTrades = await Trade.find({
            user_id: user._id, status: 'completed', deleted_at: null
        }).select('instrument_token transaction_type executed_quantity executed_price pnl').lean();

        const allTokens = [...new Set(rawTrades.map(t => t.instrument_token))];
        const kiteInstruments = await KiteInstrument.find(
            { instrument_token: { $in: allTokens } },
            'instrument_token lot_size segment raw_name'
        ).lean();
        const kiteMap = {};
        kiteInstruments.forEach(ki => { kiteMap[ki.instrument_token] = ki; });

        let totalFifoPnl = 0;
        let totalBrokerage = 0;
        for (const t of rawTrades) {
            totalFifoPnl += (t.pnl || 0);

            const ki = kiteMap[t.instrument_token];
            const seg = ki?.segment || '';
            const rawName = ki?.raw_name || '';
            const lotSize = ki?.lot_size || 1;

            let brkRule = null;
            if (rawName && seg) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
            if (!brkRule && rawName) brkRule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
            if (!brkRule && seg) brkRule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
            if (!brkRule) brkRule = brkRules.find(r => r.exchange_name === (seg.split('-')[0] || '').toUpperCase() && !r.script_name);

            if (brkRule) {
                if (brkRule.type === 'TURNOVER WISE') {
                    totalBrokerage += t.executed_price * t.executed_quantity * (brkRule.brk_value / 10000);
                } else if (brkRule.type === 'LOT WISE') {
                    totalBrokerage += (lotSize > 1 ? t.executed_quantity / lotSize : t.executed_quantity) * brkRule.brk_value;
                }
            }
        }

        // Realised P&L = sum(trade.pnl) - recalculated brokerage
        let totalRealisedPnl = totalFifoPnl - totalBrokerage;

        for (const position of trades) {
            const { total_buy_qty, total_sell_qty, total_buy_value, total_sell_value } = position;
            const instrumentToken = position._id.instrument_token;

            const netQty = total_buy_qty - total_sell_qty;
            const ltp = ltpMap.get(instrumentToken) || (total_buy_qty > 0 ? total_buy_value / total_buy_qty : 0);

            let floatingPnl = 0;

            const avgBuyPrice = total_buy_qty > 0 ? total_buy_value / total_buy_qty : 0;
            const avgSellPrice = total_sell_qty > 0 ? total_sell_value / total_sell_qty : 0;

            if (netQty > 0) {
                floatingPnl = (ltp - avgBuyPrice) * netQty;
            } else if (netQty < 0) {
                floatingPnl = (avgSellPrice - ltp) * Math.abs(netQty);
            }

            totalPositionPnl += floatingPnl;

            // Calculate Margin Used for open positions
            // Uses marginService.calculateMargin for proper exchange→segment resolution
            // Pass full quantity so lot-based segments can compute lots correctly
            if (netQty !== 0) {
                const positionMargin = await calculateMargin(position._id.exchange, Math.abs(netQty), ltp, {
                    instrumentToken: instrumentToken,
                    tradingsymbol: position._id.tradingsymbol,
                });
                totalMarginUsed += positionMargin;
            }
        }

        const m2mPnl = totalRealisedPnl + totalPositionPnl;
        // Equity = Credit + M2M P&L
        const equity = credit + m2mPnl;
        const freeMargin = equity - totalMarginUsed;

        // Map aggregated positions for return — reuse kiteMap from brokerage calculation
        const instrMap = {};
        kiteInstruments.forEach(inst => {
            instrMap[inst.instrument_token] = {
                lot_size: inst.lot_size || 1,
                segment: inst.segment || ''
            };
        });

        const enrichedPositions = trades
            .filter(t => (t.total_buy_qty - t.total_sell_qty) !== 0)
            .map(p => {
                const netQty = p.total_buy_qty - p.total_sell_qty;
                const avgBuyPrice = p.total_buy_qty > 0 ? p.total_buy_value / p.total_buy_qty : 0;
                const avgSellPrice = p.total_sell_qty > 0 ? p.total_sell_value / p.total_sell_qty : 0;
                const info = instrMap[p._id.instrument_token] || { lot_size: 1, segment: '' };
                return {
                    instrument_token: p._id.instrument_token,
                    tradingsymbol: p._id.tradingsymbol,
                    exchange: p._id.exchange,
                    segment: info.segment,
                    lot_size: info.lot_size,
                    net_qty: netQty,
                    avg_buy_price: Math.round(avgBuyPrice * 100) / 100,
                    avg_sell_price: Math.round(avgSellPrice * 100) / 100,
                    total_buy_qty: p.total_buy_qty,
                    total_sell_qty: p.total_sell_qty,
                    total_buy_value: Math.round(p.total_buy_value * 100) / 100,
                    total_sell_value: Math.round(p.total_sell_value * 100) / 100
                };
            });

        return {
            user_id: userId,
            name: user.name,
            username: user.username,
            credit,
            balance,
            realised_pnl: Math.round(totalRealisedPnl * 100) / 100,
            position_pnl: Math.round(totalPositionPnl * 100) / 100,
            m2m_pnl: Math.round(m2mPnl * 100) / 100,
            equity: Math.round(equity * 100) / 100,
            margin_used: Math.round(totalMarginUsed * 100) / 100,
            free_margin: Math.round(freeMargin * 100) / 100,
            open_positions_count: enrichedPositions.length,
            positions: enrichedPositions
        };
    }

}

module.exports = new TradeMetricsService();
