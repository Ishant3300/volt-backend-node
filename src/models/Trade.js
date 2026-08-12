const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true
  },
  admin_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  settlement_run_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SettlementRun',
    default: null
  },
  settlement_period_key: {
    type: String,
    default: null
  },
  instrument_token: {
    type: String,
    required: true
  },
  tradingsymbol: {
    type: String,
    required: true
  },
  exchange: {
    type: String,
    required: true,
    enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'NSEIX', 'GLOBAL', 'SGX', 'NCO', 'BCO', 'BCD']
  },
  transaction_type: {
    type: String,
    required: true,
    enum: ['BUY', 'SELL']
  },
  quantity: {
    type: Number,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  order_type: {
    type: String,
    required: true,
    enum: ['MARKET', 'LIMIT', 'SL', 'SL-M']
  },
  placed_by: {
    type: String,
    enum: ['USER', 'ADMIN', 'MASTER', 'SYSTEM'],
    default: 'USER'
  },
  // Trade type: 'regular' for normal trades, 'carry_forward' for ATP adjustment,
  // 'margin_square_off' for auto margin square-off trades
  // carry_forward and margin_square_off trades are hidden from orders/history page
  trade_type: {
    type: String,
    enum: ['regular', 'carry_forward', 'margin_square_off'],
    default: 'regular'
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'cancelled', 'rejected'],
    default: 'pending'
  },
  order_id: {
    type: String,
    default: null
  },
  executed_at: {
    type: Date,
    default: null
  },
  executed_price: {
    type: Number,
    default: null
  },
  executed_quantity: {
    type: Number,
    default: null
  },
  pnl: {
    type: Number,
    default: 0
  },
  brokerage: {
    type: Number,
    default: 0
  },
  taxes: {
    type: Number,
    default: 0
  },
  net_amount: {
    type: Number,
    default: 0
  },
  remarks: {
    type: String,
    default: ''
  },
  deleted_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
tradeSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    ret.created_at = ret.createdAt;
    ret.updated_at = ret.updatedAt;
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  }
});

// Indexes
tradeSchema.index({ user_id: 1, created_at: -1 });
tradeSchema.index({ master_id: 1, created_at: -1 });
tradeSchema.index({ admin_id: 1, created_at: -1 });
tradeSchema.index({ status: 1 });
tradeSchema.index({ instrument_token: 1 });
tradeSchema.index({ executed_at: -1 });
tradeSchema.index({ settlement_period_key: 1, status: 1, deleted_at: 1 });

module.exports = mongoose.model('Trade', tradeSchema);
