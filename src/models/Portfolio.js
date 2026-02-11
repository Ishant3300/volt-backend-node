const mongoose = require('mongoose');

const portfolioSchema = new mongoose.Schema({
  kite_instrument_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteInstrument',
    required: true
  },
  instrument_token: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
portfolioSchema.set('toJSON', {
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
portfolioSchema.index({ kite_instrument_id: 1 });

module.exports = mongoose.model('Portfolio', portfolioSchema);
