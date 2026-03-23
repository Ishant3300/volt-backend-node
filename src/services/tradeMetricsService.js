const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const { calculateMargin } = require('./marginService');

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

        // Aggregate trades
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

        // Realised P&L = sum of (pnl − brokerage) across all completed trades.
        // Captures booked profit/loss minus brokerage charges.
        const realisedPnlAgg = await Trade.aggregate([
            { $match: { user_id: user._id, status: 'completed', deleted_at: null } },
            { $group: { _id: null, total: { $sum: { $subtract: ['$pnl', '$brokerage'] } } } }
        ]);
        let totalRealisedPnl = realisedPnlAgg.length > 0 ? realisedPnlAgg[0].total : 0;

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

        // Map aggregated positions for return
        const enrichedPositions = trades
            .filter(t => (t.total_buy_qty - t.total_sell_qty) !== 0)
            .map(p => {
                const netQty = p.total_buy_qty - p.total_sell_qty;
                const avgBuyPrice = p.total_buy_qty > 0 ? p.total_buy_value / p.total_buy_qty : 0;
                const avgSellPrice = p.total_sell_qty > 0 ? p.total_sell_value / p.total_sell_qty : 0;
                return {
                    instrument_token: p._id.instrument_token,
                    tradingsymbol: p._id.tradingsymbol,
                    exchange: p._id.exchange,
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
