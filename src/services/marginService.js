const TradeMargin = require('../models/TradeMargin');
const KiteInstrument = require('../models/KiteInstrument');
const { LOG_MARGIN_CALC } = require('../config/logFlags');

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
  let normalizedExchange = exchange.toUpperCase() === 'GLOBAL' ? 'INDICES' : exchange.toUpperCase();

  // Resolve raw_name, segment, and lot_size from KiteInstrument
  let rawName = opts.rawName || null;
  let lotSize = opts.lotSize || 1;
  let segment = null;
  if (opts.instrumentToken) {
    const kiteInst = await KiteInstrument.findOne({ instrument_token: opts.instrumentToken }).lean();
    if (kiteInst) {
      if (!rawName) rawName = kiteInst.raw_name || kiteInst.name;
      // Use instrument's segment (e.g. 'MCX-FUT') instead of base exchange ('MCX')
      // because TradeMargin records store exchange_name as segment names.
      if (kiteInst.segment) {
        segment = kiteInst.segment.toUpperCase();
        normalizedExchange = segment;
      }
      if (kiteInst.lot_size > 1) lotSize = kiteInst.lot_size;
    }
  }

  // Lot-based segments: MCX-FUT, MCX-OPT, NFO-OPT
  // For these, TradeMargin.trade_margin is a flat amount PER LOT.
  // margin = numberOfLots * trade_margin
  const isLotBased = segment === 'MCX-FUT' || segment === 'MCX-OPT' || segment === 'NFO-OPT';

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

  if (LOG_MARGIN_CALC) console.log(`💰 [Margin] exchange=${normalizedExchange}, rawName=${rawName || 'N/A'}, isLotBased=${isLotBased}, lotSize=${lotSize}, rule=${rule ? JSON.stringify({ amount_type: rule.amount_type, trade_margin: rule.trade_margin, script_name: rule.script_name }) : 'NOT FOUND'}`);
  if (!rule) return 0;

  if (isLotBased && rule.amount_type === 'amount') {
    // Lot-based: trade_margin is a flat amount — just use it directly (NOT multiplied by lots or qty)
    const margin = rule.trade_margin;
    if (LOG_MARGIN_CALC) console.log(`💰 [Margin] lot-based calc: qty=${quantity}, lotSize=${lotSize}, flatMargin=${rule.trade_margin}, result=${margin}`);
    return margin;
  }

  if (rule.amount_type === 'percentage') {
    // Percentage-based: margin = quantity * price * (trade_margin / 100)
    const margin = Math.abs(quantity) * price * (rule.trade_margin / 100);
    if (LOG_MARGIN_CALC) console.log(`💰 [Margin] percentage calc: qty=${quantity}, price=${price}, margin%=${rule.trade_margin}, result=${margin}`);
    return margin;
  }

  // Flat amount fallback (non-lot-based segments with amount type)
  const margin = Math.abs(quantity) * rule.trade_margin;
  if (LOG_MARGIN_CALC) console.log(`💰 [Margin] flat calc: qty=${quantity}, flat=${rule.trade_margin}, result=${margin}`);
  return margin;
};

module.exports = { calculateMargin };
