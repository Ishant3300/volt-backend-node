const BrokerageSettings = require('../models/BrokerageSettings');
const KiteInstrument = require('../models/KiteInstrument');
const ScriptQuantity = require('../models/ScriptQuantity');

async function calculateBrokerage(trade, session) {
  try {
    const instrument = await KiteInstrument.findOne({ instrument_token: trade.instrument_token }).session(session).lean();
    const rawName = instrument?.raw_name || instrument?.name || null;
    let rule = null;
    if (rawName) {
      rule = await BrokerageSettings.findOne({
        exchange_name: trade.exchange,
        script_name: rawName,
        deleted_at: null,
      }).session(session).lean();
    }
    if (!rule) {
      rule = await BrokerageSettings.findOne({
        exchange_name: trade.exchange,
        script_name: trade.tradingsymbol,
        deleted_at: null,
      }).session(session).lean();
    }
    if (!rule) return 0;
    
    if (rule.type === 'TURNOVER WISE') {
        return (trade.price * trade.quantity) * (rule.brk_value / 100);
    }
    if (rule.type !== 'LOT WISE') return 0;

    let lotSize = Number(instrument?.lot_size || 0);
    if (lotSize <= 0) {
      const lot = await ScriptQuantity.findOne({
        exchange_name: trade.exchange,
        script_name: trade.tradingsymbol,
        deleted_at: null,
      }).session(session).lean();
      lotSize = lot?.quantity || 1;
    }
    
    const lots = lotSize > 0 ? trade.quantity / lotSize : trade.quantity;
    return lots * rule.brk_value;
  } catch (err) {
    console.error('Error calculating brokerage:', err);
    return 0;
  }
}

module.exports = { calculateBrokerage };
