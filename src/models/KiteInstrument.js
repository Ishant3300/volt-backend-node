const mongoose = require('mongoose');

const kiteInstrumentSchema = new mongoose.Schema({
  instrument_token: {
    type: String,
    required: true,
    unique: true
  },
  exchange_token: {
    type: String,
    required: true
  },
  tradingsymbol: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  last_price: {
    type: Number,
    default: 0
  },
  expiry: {
    type: Date,
    default: null
  },
  strike: {
    type: Number,
    default: 0
  },
  tick_size: {
    type: Number,
    default: 0
  },
  lot_size: {
    type: Number,
    default: 1
  },
  instrument_type: {
    type: String,
    required: true
  },
  segment: {
    type: String,
    required: true
  },
  exchange: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
kiteInstrumentSchema.set('toJSON', {
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
kiteInstrumentSchema.index({ instrument_token: 1 }, { unique: true });
kiteInstrumentSchema.index({ exchange_token: 1 });
kiteInstrumentSchema.index({ tradingsymbol: 1 });
kiteInstrumentSchema.index({ name: 1 });
kiteInstrumentSchema.index({ exchange: 1 });
kiteInstrumentSchema.index({ segment: 1 });
kiteInstrumentSchema.index({ instrument_type: 1 });

module.exports = mongoose.model('KiteInstrument', kiteInstrumentSchema);
