const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const TradeMargin = require('../models/TradeMargin');

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

        let totalRealisedPnl = 0;
        let totalPositionPnl = 0;
        let totalMarginUsed = 0;

        for (const position of trades) {
            const { total_buy_qty, total_sell_qty, total_buy_value, total_sell_value } = position;
            const instrumentToken = position._id.instrument_token;

            const netQty = total_buy_qty - total_sell_qty;
            const ltp = ltpMap.get(instrumentToken) || (total_buy_qty > 0 ? total_buy_value / total_buy_qty : 0); // fallback to avg buy or 0

            let realisedPnl = 0;
            let floatingPnl = 0;

            const avgBuyPrice = total_buy_qty > 0 ? total_buy_value / total_buy_qty : 0;
            const avgSellPrice = total_sell_qty > 0 ? total_sell_value / total_sell_qty : 0;

            if (netQty > 0) { // Net Long
                realisedPnl = total_sell_value - (total_sell_qty * avgBuyPrice);
                floatingPnl = (ltp - avgBuyPrice) * netQty;
            } else if (netQty < 0) { // Net Short
                realisedPnl = (total_buy_qty * avgSellPrice) - total_buy_value;
                floatingPnl = (avgSellPrice - ltp) * Math.abs(netQty);
            } else { // Flat
                realisedPnl = total_sell_value - total_buy_value;
                floatingPnl = 0;
            }

            totalRealisedPnl += realisedPnl;
            totalPositionPnl += floatingPnl;

            // Calculate Margin Used for open positions
            if (netQty !== 0) {
                // Find TradeMargin rules
                // Usually, exchange and script_name are used. 
                // For simplicity, let's look up TradeMargin by exchange
                const tradeMargin = await TradeMargin.findOne({ exchange_name: position._id.exchange });

                let positionMargin = 0;
                if (tradeMargin) {
                    if (tradeMargin.amount_type === 'percentage') {
                        // percentage of contract value
                        const contractValue = Math.abs(netQty) * ltp;
                        positionMargin = (contractValue * tradeMargin.trade_margin) / 100;
                    } else {
                        // flat amount per share/lot
                        positionMargin = Math.abs(netQty) * tradeMargin.trade_margin;
                    }
                }
                totalMarginUsed += positionMargin;
            }
        }

        const m2mPnl = totalRealisedPnl + totalPositionPnl;
        const equity = balance + m2mPnl;
        const freeMargin = equity - totalMarginUsed;

        return {
            credit,
            balance,
            realised_pnl: totalRealisedPnl,
            position_pnl: totalPositionPnl,
            m2m_pnl: m2mPnl,
            equity,
            margin_used: totalMarginUsed,
            free_margin: freeMargin,
            open_positions: trades.filter(t => (t.total_buy_qty - t.total_sell_qty) !== 0).length
        };
    }

}

module.exports = new TradeMetricsService();
