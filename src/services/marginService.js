const TradeMargin = require('../models/TradeMargin');

/**
 * Calculate the margin required for a trade.
 * Uses TradeMargin rules: either flat amount per unit or percentage of contract value.
 *
 * @param {string} exchange - Exchange name (NSE, MCX, etc.)
 * @param {number} quantity - Number of units
 * @param {number} price    - Execution price per unit
 * @returns {Promise<number>} margin amount
 */
const calculateMargin = async (exchange, quantity, price) => {
  const normalizedExchange = exchange.toUpperCase() === 'GLOBAL' ? 'INDICES' : exchange.toUpperCase();
  const rule = await TradeMargin.findOne({ exchange_name: normalizedExchange, deleted_at: null });
  console.log(`💰 [Margin] exchange=${exchange}, rule=${rule ? JSON.stringify({ amount_type: rule.amount_type, trade_margin: rule.trade_margin, script_name: rule.script_name }) : 'NOT FOUND'}`);
  if (!rule) return 0;

  if (rule.amount_type === 'percentage') {
    const margin = (Math.abs(quantity) * price * rule.trade_margin) / 100;
    console.log(`💰 [Margin] percentage calc: qty=${quantity}, price=${price}, margin%=${rule.trade_margin}, result=${margin}`);
    return margin;
  }
  // flat amount per unit
  const margin = Math.abs(quantity) * rule.trade_margin;
  console.log(`💰 [Margin] flat calc: qty=${quantity}, flat=${rule.trade_margin}, result=${margin}`);
  return margin;
};

module.exports = { calculateMargin };
