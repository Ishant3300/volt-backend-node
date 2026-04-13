const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
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
    type: [{
      exchange_name: {
        type: String,
        required: true,
        enum: ['NSE', 'NFO', 'MCX', 'SGX', 'OTHERS', 'NFO-FUT', 'NFO-OPT', 'MCX-FUT', 'MCX-OPT', 'BFO-FUT', 'BFO-OPT', 'INDICES', 'GLOBAL']
      },
      turnover: {
        type: Boolean,
        required: true,
        default: false
      },
      lot: {
        type: Boolean,
        required: true,
        default: false
      },
      group_name: {
        type: String,
        required: true,
        default: ''
      }
    }],
    required: true,
    default: []
  },
  trade_limit: {
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
  close_only: {
    type: Boolean,
    default: false
  },
  bet: {
    type: Boolean,
    default: true
  },
  fresh_stoploss: {
    type: Boolean,
    default: true
  },
  change_pass_on_first_login: {
    type: Boolean,
    default: false
  },
  server_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Server',
    required: true
  },
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true
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
  active_token: {
    type: String,
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
  // ── Live Trading Metrics (updated on every tick & trade execution) ──
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
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    ret.created_at = ret.createdAt;
    ret.updated_at = ret.updatedAt;
    ret.credit = ret.credits; // Aliasing for older API endpoints expecting credit
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  }
});

// Indexes
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ server_id: 1 });
userSchema.index({ master_id: 1 });
userSchema.index({ status: 1 });

module.exports = mongoose.model('User', userSchema);
