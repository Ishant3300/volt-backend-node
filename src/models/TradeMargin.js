const mongoose = require('mongoose');

const tradeMarginSchema = new mongoose.Schema({
  exchange_name: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  script_name: {
    type: String,
    required: true,
    trim: true
  },
  amount_type: {
    type: String,
    required: true,
    enum: ['amount', 'percentage'],
    lowercase: true
  },
  trade_margin: {
    type: Number,
    required: true,
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
}, {
  timestamps: false,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// Update the updated_at timestamp before saving
tradeMarginSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

// Index for faster queries
tradeMarginSchema.index({ deleted_at: 1 });
tradeMarginSchema.index({ exchange_name: 1 });
tradeMarginSchema.index({ script_name: 1 });

const TradeMargin = mongoose.model('TradeMargin', tradeMarginSchema);

module.exports = TradeMargin;
