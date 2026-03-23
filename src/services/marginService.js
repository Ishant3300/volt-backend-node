const TradeMargin = require('../models/TradeMargin');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * Calculate the margin required for a trade.
 * Uses TradeMargin rules: either flat amount per unit or percentage of contract value.
 * Looks up by exchange_name + raw_name (script_name) for per-instrument margins.
 *
 * @param {string} exchange    - Exchange/segment name (NFO-FUT, MCX-FUT, INDICES, etc.)
 * @param {number} quantity    - Number of units
 * @param {number} price       - Execution price per unit
 * @param {object} [opts]      - Optional params
 * @param {string} [opts.rawName]          - Instrument raw_name for per-instrument lookup
 * @param {string} [opts.instrumentToken]  - Instrument token to resolve raw_name if not provided
 * @param {string} [opts.tradingsymbol]    - Trading symbol fallback
 * @returns {Promise<number>} margin amount
 */
const calculateMargin = async (exchange, quantity, price, opts = {}) => {
  const normalizedExchange = exchange.toUpperCase() === 'GLOBAL' ? 'INDICES' : exchange.toUpperCase();

  // Resolve raw_name for per-instrument lookup
  let rawName = opts.rawName || null;
  if (!rawName && opts.instrumentToken) {
    const kiteInst = await KiteInstrument.findOne({ instrument_token: opts.instrumentToken }).lean();
    if (kiteInst) rawName = kiteInst.raw_name || kiteInst.name;
  }

  // 1. Try per-instrument rule (exchange + script_name)
  let rule = null;
  if (rawName) {
    rule = await TradeMargin.findOne({
      exchange_name: normalizedExchange,
      script_name: rawName,
      deleted_at: null
    });
  }

  // 2. Fallback: try by tradingsymbol
  if (!rule && opts.tradingsymbol) {
    rule = await TradeMargin.findOne({
      exchange_name: normalizedExchange,
      script_name: opts.tradingsymbol,
      deleted_at: null
    });
  }

  // 3. Fallback: any rule for this exchange (legacy behavior)
  if (!rule) {
    rule = await TradeMargin.findOne({
      exchange_name: normalizedExchange,
      deleted_at: null
    });
  }

  console.log(`💰 [Margin] exchange=${normalizedExchange}, rawName=${rawName || 'N/A'}, rule=${rule ? JSON.stringify({ amount_type: rule.amount_type, trade_margin: rule.trade_margin, script_name: rule.script_name }) : 'NOT FOUND'}`);
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
