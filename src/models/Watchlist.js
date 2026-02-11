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
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true
  },
  admin_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
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
watchlistSchema.index({ user_id: 1 });
watchlistSchema.index({ master_id: 1 });
watchlistSchema.index({ admin_id: 1 });
watchlistSchema.index({ kite_instrument_id: 1 });
watchlistSchema.index({ user_id: 1, order: 1 });

module.exports = mongoose.model('Watchlist', watchlistSchema);
