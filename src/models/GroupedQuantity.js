const mongoose = require('mongoose');

const groupedQuantitySchema = new mongoose.Schema({
  exchange_name: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  lot_name: {
    type: String,
    required: true,
    trim: true
  },
  instrument_id: {
    type: String,
    required: true,
    trim: true
  },
  instrument_symbol: {
    type: String,
    required: true,
    trim: true
  },
  max_qty: {
    type: Number,
    required: true,
    min: 0
  },
  break_qty: {
    type: Number,
    required: true,
    min: 0
  },
  lot_size: {
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
groupedQuantitySchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

// Index for faster queries
groupedQuantitySchema.index({ deleted_at: 1 });
groupedQuantitySchema.index({ exchange_name: 1 });
groupedQuantitySchema.index({ lot_name: 1 });
groupedQuantitySchema.index({ instrument_id: 1 });

const GroupedQuantity = mongoose.model('GroupedQuantity', groupedQuantitySchema);

module.exports = GroupedQuantity;
