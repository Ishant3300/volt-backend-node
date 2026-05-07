const mongoose = require('mongoose');

const scriptQuantitySchema = new mongoose.Schema({
  owner_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  owner_type: {
    type: String,
    enum: ['Master', 'User'],
    required: true
  },
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
  lot_size: {
    type: Number,
    required: true,
    min: 0
  },
  max_qty: {
    type: Number,
    required: true,
    min: 0
  },
  brk_qty: {
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
scriptQuantitySchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

// Index for faster queries
scriptQuantitySchema.index({ deleted_at: 1 });
scriptQuantitySchema.index({ exchange_name: 1 });
scriptQuantitySchema.index({ script_name: 1 });
scriptQuantitySchema.index({ owner_id: 1, exchange_name: 1 });
scriptQuantitySchema.index({ owner_id: 1, exchange_name: 1, script_name: 1 });

const ScriptQuantity = mongoose.model('ScriptQuantity', scriptQuantitySchema);

module.exports = ScriptQuantity;
