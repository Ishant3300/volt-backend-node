const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
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
  totp_enabled: {
    type: Boolean,
    default: false
  },
  totp_secret: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
adminSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.totp_secret;
    ret.created_at = ret.createdAt;
    ret.updated_at = ret.updatedAt;
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  }
});

// Indexes
adminSchema.index({ username: 1 }, { unique: true });

module.exports = mongoose.model('Admin', adminSchema);
