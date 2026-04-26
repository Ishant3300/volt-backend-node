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
  // Original name from CSV
  name: {
    type: String,
    required: true
  },
  // Raw name preserved for reference (same as name from CSV)
  raw_name: {
    type: String,
    default: function() { return this.name; }
  },
  // User-friendly display name (mapped for indices, generated for derivatives)
  display_name: {
    type: String,
    default: function() { return this.name; }
  },
  last_price: {
    type: Number,
    default: 0
  },
  // OHLC from last trading day (populated by weekend carry forward / settlement cron)
  ohlc_open: { type: Number, default: 0 },
  ohlc_high: { type: Number, default: 0 },
  ohlc_low: { type: Number, default: 0 },
  ohlc_close: { type: Number, default: 0 },
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
  },
  // Flag to indicate if instrument is active (for filtering expired contracts in search)
  is_active: {
    type: Boolean,
    default: true
  },
  // Admin can disable an instrument to prevent new positions (existing positions unaffected)
  enabled: {
    type: Boolean,
    default: true
  },
  // Soft delete timestamp (admin can soft-delete instruments)
  deleted_at: {
    type: Date,
    default: null
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

// ══════════════════════════════════════════════════════════════════════════════
// INDEXES
// ══════════════════════════════════════════════════════════════════════════════

// Primary lookup indexes
kiteInstrumentSchema.index({ exchange_token: 1 });
kiteInstrumentSchema.index({ tradingsymbol: 1 });
kiteInstrumentSchema.index({ name: 1 });
kiteInstrumentSchema.index({ display_name: 1 });

// Filter indexes
kiteInstrumentSchema.index({ exchange: 1 });
kiteInstrumentSchema.index({ segment: 1 });
kiteInstrumentSchema.index({ instrument_type: 1 });
kiteInstrumentSchema.index({ expiry: 1 });
kiteInstrumentSchema.index({ is_active: 1 });

// Compound indexes for smart search cache loading query
kiteInstrumentSchema.index({ instrument_type: 1, segment: 1, exchange: 1 });
kiteInstrumentSchema.index({ tradingsymbol: 1, instrument_type: 1 });
kiteInstrumentSchema.index({ name: 1, instrument_type: 1 });

// Compound index for nearest expiry queries
// Covers: WHERE instrument_type IN (...) AND exchange IN (...) AND expiry >= today ORDER BY expiry
kiteInstrumentSchema.index({ instrument_type: 1, exchange: 1, expiry: 1 });

// Compound index for symbol + expiry lookups (for getting all expiries of a symbol)
kiteInstrumentSchema.index({ name: 1, instrument_type: 1, expiry: 1 });
kiteInstrumentSchema.index({ tradingsymbol: 1, expiry: 1 });

// Index for options chain queries (symbol + strike + expiry)
kiteInstrumentSchema.index({ name: 1, strike: 1, expiry: 1, instrument_type: 1 });

// Compound index for direct DB search (no cache)
kiteInstrumentSchema.index({ is_active: 1, name: 1, expiry: 1, instrument_type: 1 });
kiteInstrumentSchema.index({ is_active: 1, raw_name: 1, expiry: 1, instrument_type: 1 });

module.exports = mongoose.model('KiteInstrument', kiteInstrumentSchema);
