const mongoose = require('mongoose');

// Immutable, append-only settlement ledger.
// One document per user-per-instrument captured at each settlement, BEFORE any
// live-table mutation. This is the durable source of truth for historical bills/PDFs.
// Documents are NEVER updated or deleted.

const fillSchema = new mongoose.Schema({
  source_trade_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  transaction_type: { type: String, enum: ['BUY', 'SELL'] },
  executed_quantity: { type: Number, default: 0 },
  executed_price: { type: Number, default: 0 },
  executed_at: { type: Date },
  pnl: { type: Number, default: 0 },
  brokerage: { type: Number, default: 0 },
  order_type: { type: String, default: 'MARKET' },
  placed_by: { type: String, default: 'USER' },
  trade_type: { type: String, default: 'regular' },
}, { _id: false });

const settlementHistorySchema = new mongoose.Schema({
  settlement_run_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  settlement_period_key: { type: String, default: null },
  settlement_trading_date: { type: Date, default: null },
  // Exact source date and provenance for this instrument's official price.
  settlement_price_date: { type: Date, default: null },
  settlement_price_source: { type: String, default: null },
  settlement_date: { type: Date, required: true },
  period_from: { type: Date, default: null },
  period_to: { type: Date, required: true },

  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', default: null },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

  exchange: { type: String },
  tradingsymbol: { type: String },
  instrument_token: { type: String },
  display_name: { type: String },

  // Position carried INTO this period (previous settlement's carry-forward)
  opening_qty: { type: Number, default: 0 },
  opening_price: { type: Number, default: 0 },
  opening_side: { type: String, default: null },

  // Full immutable copy of every fill during the period
  fills: { type: [fillSchema], default: [] },

  total_buy_qty: { type: Number, default: 0 },
  total_buy_value: { type: Number, default: 0 },
  avg_buy_price: { type: Number, default: 0 },
  total_sell_qty: { type: Number, default: 0 },
  total_sell_value: { type: Number, default: 0 },
  avg_sell_price: { type: Number, default: 0 },

  // Net open position closed at settlement
  closing_qty: { type: Number, default: 0 },
  closing_side: { type: String, default: null },
  settlement_price: { type: Number, default: 0 },
  close_method: { type: String, default: 'settlement' },

  realized_pnl: { type: Number, default: 0 },
  settlement_pnl: { type: Number, default: 0 },
  total_pnl: { type: Number, default: 0 },
  brokerage: { type: Number, default: 0 },
  net_pnl: { type: Number, default: 0 },

  // Position carried forward into the NEXT period (= net closed at settlement price)
  carry_forward_qty: { type: Number, default: 0 },
  carry_forward_price: { type: Number, default: 0 },
  carry_forward_side: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

settlementHistorySchema.index({ user_id: 1, period_to: -1 });
settlementHistorySchema.index({ settlement_run_id: 1 });
settlementHistorySchema.index(
  { settlement_period_key: 1, user_id: 1, instrument_token: 1 },
  { unique: true, partialFilterExpression: { settlement_period_key: { $type: 'string' } } }
);
settlementHistorySchema.index({ user_id: 1, instrument_token: 1, period_to: -1 });
settlementHistorySchema.index({ master_id: 1, period_to: -1 });

module.exports = mongoose.model('SettlementHistory', settlementHistorySchema);
