const mongoose = require('mongoose');

/**
 * The platform's single, fixed clearing/cost rate per instrument — e.g. NSE
 * Futures 1.5 paisa (0.015% turnover) or MCX Gold ₹120/lot/side. Distinct
 * from MasterBaseRate (a per-master, self-reported reference value with no
 * calculation effect) and from BrokerageSettings (what a client/master is
 * actually billed) — this is the one true floor cost used by
 * weeklyAdminController.js's _cascadeBrokerageOwedUpwardBatched to compute
 * how much of the spread above true cost gets shared back down the chain.
 * Not scoped to any master or user — one rate per instrument, platform-wide.
 */
const platformBaseRateSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['TURNOVER WISE', 'LOT WISE'],
    uppercase: true,
  },
  exchange_name: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
  },
  // Blank = segment-wide default, matching BrokerageSettings' convention.
  script_name: {
    type: String,
    trim: true,
    default: '',
  },
  brk_value: {
    type: Number,
    required: true,
    min: 0,
  },
  effective_from: {
    type: Date,
    default: Date.now,
  },
  deleted_at: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  toJSON: {
    transform: function (doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
});

platformBaseRateSchema.index({ deleted_at: 1 });
platformBaseRateSchema.index({ exchange_name: 1, script_name: 1, deleted_at: 1 });

module.exports = mongoose.model('PlatformBaseRate', platformBaseRateSchema);
