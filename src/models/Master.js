const mongoose = require('mongoose');

const masterSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  credits: {
    type: Number,
    required: true,
    default: 0
  },
  balance: {
    type: Number,
    required: true,
    default: 0
  },
  note: {
    type: String,
    required: true,
    default: ''
  },
  pnl_sharing: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    max: 100
  },
  brokerage_sharing: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    max: 100
  },
  exchanges_allowed: {
    type: [String],
    required: true,
    enum: ['NSE', 'MCX', 'SGX', 'CALLPUT', 'OTHERS', 'MCX-OPT'],
    default: []
  },
  intraday_squareoff: {
    type: [{
      exchange_name: {
        type: String,
        required: true,
        enum: ['NSE', 'MCX', 'SGX', 'CALLPUT', 'OTHERS', 'MCX-OPT']
      },
      enabled: {
        type: Boolean,
        required: true,
        default: false
      }
    }],
    default: []
  },
  margin_square_off_percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  trade_limit: {
    type: [String],
    required: true,
    enum: ['NSE', 'MCX', 'SGX', 'CALLPUT', 'OTHERS', 'MCX-OPT'],
    default: []
  },
  server_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Server',
    required: true
  },
  max_credit: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended'],
    default: 'active'
  },
  active_status: {
    type: Boolean,
    default: true
  },
  last_due_bill: {
    type: Date,
    default: null
  },
  last_login: {
    type: Date,
    default: null
  },
  ip_address: {
    type: String,
    default: null
  },
  exchanges: {
    type: [String],
    enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'],
    default: []
  },
  permissions: {
    account_summary: { type: Boolean, default: false },
    pnl_summary: { type: Boolean, default: false },
    client_summary: { type: Boolean, default: false },
    settlement_report: { type: Boolean, default: false },
    generate_pdf: { type: Boolean, default: false },
    weekly_admin: { type: Boolean, default: false },
    intraday_history: { type: Boolean, default: false },
    userwise_open_position: { type: Boolean, default: false },
    script_quantity: { type: Boolean, default: false },
    deleted_trade: { type: Boolean, default: false },
    trade_account: { type: Boolean, default: false },
    close_only: { type: Boolean, default: false },
    bet: { type: Boolean, default: false },
    margin_square: { type: Boolean, default: false },
    fresh_stoploss: { type: Boolean, default: false }
  },
  admin_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    default: null
  },
  add_master: {
    type: Boolean,
    default: false
  },
  change_pass_on_first_login: {
    type: Boolean,
    default: false
  },
  active_token: {
    type: String,
    default: null
  },
  deleted_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
masterSchema.set('toJSON', {
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
masterSchema.index({ username: 1 }, { unique: true });
masterSchema.index({ server_id: 1 });
masterSchema.index({ admin_id: 1 });
masterSchema.index({ master_id: 1 });
masterSchema.index({ status: 1 });

module.exports = mongoose.model('Master', masterSchema);
