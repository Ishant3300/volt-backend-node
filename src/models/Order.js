const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  kite_instrument_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteInstrument',
    required: true
  },
  instrument_token: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  market_price: {
    type: Number,
    required: true
  },
  stop_loss: {
    type: Number,
    default: 0
  },
  trigger_price: {
    type: Number,
    default: 0
  },
  limit_price: {
    type: Number,
    default: 0
  },
  side: {
    type: String,
    enum: ['buy', 'sell'],
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
orderSchema.set('toJSON', {
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
orderSchema.index({ kite_instrument_id: 1 });
orderSchema.index({ side: 1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
