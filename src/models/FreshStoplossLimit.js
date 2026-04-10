const mongoose = require('mongoose');

const freshStoplossLimitSchema = new mongoose.Schema({
  exchange_name: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  raw_name: {
    type: String,
    required: true,
    trim: true
  },
  // Time restriction in minutes — applies to Market Execution trades
  // e.g. 30 means user cannot close a market trade within 30 minutes
  time_minutes: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  // Price restriction — applies to Limit and Stop-Loss trades
  // e.g. 100 means BUY limit max = CMP - 100, SELL limit min = CMP + 100
  price_offset: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  deleted_at: {
    type: Date,
    default: null
  }
});

freshStoplossLimitSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

freshStoplossLimitSchema.index({ deleted_at: 1 });
freshStoplossLimitSchema.index({ exchange_name: 1, raw_name: 1, deleted_at: 1 }, { unique: true, partialFilterExpression: { deleted_at: null } });

module.exports = mongoose.model('FreshStoplossLimit', freshStoplossLimitSchema);
