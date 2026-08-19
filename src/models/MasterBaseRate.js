const mongoose = require('mongoose');

/**
 * A master's own per-segment "base rate" — the wholesale brokerage rate this
 * master account is themselves charged, used purely as a reference/starting
 * point when configuring what they in turn charge downstream. Distinct from
 * BrokerageSettings (which stores what a leaf USER is actually charged and
 * drives real per-trade brokerage calculation) — this collection has no
 * effect on any brokerage calculation. It exists solely for the hierarchy
 * creation UI: when creating a sub-master, the form autofills this field
 * from the parent master's own base rate (editable before save).
 */
const masterBaseRateSchema = new mongoose.Schema({
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true,
  },
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
  // Blank = segment-wide default for this master, matching the existing
  // BrokerageSettings wildcard convention (empty script_name).
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

masterBaseRateSchema.index({ master_id: 1, deleted_at: 1 });
masterBaseRateSchema.index({ master_id: 1, exchange_name: 1, script_name: 1, deleted_at: 1 });

module.exports = mongoose.model('MasterBaseRate', masterBaseRateSchema);
