const mongoose = require('mongoose');

// Category trade wallet — the available (spendable) balance per category pool
// (NSE, MCX, GLOBAL). `min: 0` is a schema-level guard; the atomic `$gte` guard
// in walletService is the real never-negative enforcement (see design §D1).
const walletSchema = new mongoose.Schema({
  NSE:    { type: Number, default: 0, min: 0 },
  MCX:    { type: Number, default: 0, min: 0 },
  GLOBAL: { type: Number, default: 0, min: 0 }
}, { _id: false });

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
  equity: {
    type: Number,
    required: true,
    default: 0
  },
  note: {
    type: String,
    required: false,
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
    enum: ['NSE', 'NFO', 'MCX', 'SGX', 'OTHERS', 'NFO-FUT', 'NFO-OPT', 'MCX-FUT', 'MCX-OPT', 'BFO-FUT', 'BFO-OPT', 'INDICES', 'GLOBAL'],
    default: []
  },
  intraday_squareoff: {
    type: [{
      exchange_name: {
        type: String,
        required: true,
        enum: ['NSE', 'NFO', 'MCX', 'SGX', 'OTHERS', 'NFO-FUT', 'NFO-OPT', 'MCX-FUT', 'MCX-OPT', 'BFO-FUT', 'BFO-OPT', 'INDICES', 'GLOBAL']
      },
      enabled: {
        type: Boolean,
        required: true,
        default: false
      }
    }],
    default: []
  },
  // First-class M2M auto square-off toggle, mirroring User.margin_square_off.
  // Used by shouldSquareOff (design §8); kept in parity with permissions.margin_square.
  margin_square_off: {
    type: Boolean,
    default: false
  },
  margin_square_off_percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  // Per-category trade wallet (available balances). Funded via the assignment
  // flow; blocked on open / released on close by walletService.
  wallet: {
    type: walletSchema,
    default: () => ({ NSE: 0, MCX: 0, GLOBAL: 0 })
  },
  trade_limit: {
    type: [String],
    required: true,
    enum: ['NSE', 'NFO', 'MCX', 'SGX', 'OTHERS', 'NFO-FUT', 'NFO-OPT', 'MCX-FUT', 'MCX-OPT', 'BFO-FUT', 'BFO-OPT', 'INDICES', 'GLOBAL'],
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
    enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'NCO', 'BCO', 'BCD'],
    default: []
  },
  permissions: {
    account_summary: { type: Boolean, default: true },
    pnl_summary: { type: Boolean, default: true },
    client_summary: { type: Boolean, default: true },
    settlement_report: { type: Boolean, default: true },
    generate_pdf: { type: Boolean, default: true },
    weekly_admin: { type: Boolean, default: true },
    intraday_history: { type: Boolean, default: true },
    userwise_open_position: { type: Boolean, default: true },
    script_quantity: { type: Boolean, default: true },
    deleted_trade: { type: Boolean, default: true },
    trade_account: { type: Boolean, default: true },
    close_only: { type: Boolean, default: false },
    bet: { type: Boolean, default: true },
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
  },
  notification_settings: {
    market_order: { type: Boolean, default: false },
    pending_order: { type: Boolean, default: true },
    admin_order_execution: { type: Boolean, default: false },
    admin_order_deletion: { type: Boolean, default: true },
    trading_sound: { type: Boolean, default: false }
  },
  fcm_tokens: {
    type: [String],
    default: []
  },
  account_limit: {
    enabled: { type: Boolean, default: false },
    max_masters: { type: Number, default: 0 },
    max_users: { type: Number, default: 0 }
  },
  // ── Live Trading Metrics (aggregated from all users under this master) ──
  realised_pnl: {
    type: Number,
    default: 0
  },
  position_pnl: {
    type: Number,
    default: 0
  },
  m2m_pnl: {
    type: Number,
    default: 0
  },
  margin_used: {
    type: Number,
    default: 0
  },
  equity: {
    type: Number,
    default: 0
  },
  free_margin: {
    type: Number,
    default: 0
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
