const mongoose = require('mongoose');

const kiteMarketQuoteSchema = new mongoose.Schema({
  instrument_token: {
    type: String,
    required: true,
    unique: true
  },
  last_price: {
    type: Number,
    required: true
  },
  timestamp: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
kiteMarketQuoteSchema.set('toJSON', {
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
kiteMarketQuoteSchema.index({ instrument_token: 1 }, { unique: true });
kiteMarketQuoteSchema.index({ timestamp: -1 });

module.exports = mongoose.model('KiteMarketQuote', kiteMarketQuoteSchema);
