const mongoose = require('mongoose');

const watchlistSchema = new mongoose.Schema({
  kite_instrument_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteInstrument',
    required: true
  },
  instrument_token: {
    type: String,
    required: true
  },
  order: {
    type: Number,
    required: true
  },
  owner_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    // Can reference User, Admin, or Master
    refPath: 'owner_type'
  },
  owner_type: {
    type: String,
    required: true,
    enum: ['User', 'Admin', 'Master']
  },
  deleted_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
watchlistSchema.set('toJSON', {
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
watchlistSchema.index({ kite_instrument_id: 1 });

// ─── NEW: Covers watchlist listing with soft-delete + sort by order ───
watchlistSchema.index({ owner_id: 1, owner_type: 1, deleted_at: 1, order: 1 });

// ─── NEW: Duplicate check when adding to watchlist ───
watchlistSchema.index({ owner_id: 1, owner_type: 1, instrument_token: 1, deleted_at: 1 });

// ─── NEW: livePriceService distinct('instrument_token', { deleted_at: null }) ───
watchlistSchema.index({ deleted_at: 1 });

module.exports = mongoose.model('Watchlist', watchlistSchema);
