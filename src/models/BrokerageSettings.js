const mongoose = require('mongoose');

const brokerageSettingsSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['TURNOVER WISE', 'LOT WISE'],
    uppercase: true
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
  brk_value: {
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
brokerageSettingsSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

// Index for faster queries
brokerageSettingsSchema.index({ deleted_at: 1 });

const BrokerageSettings = mongoose.model('BrokerageSettings', brokerageSettingsSchema);

module.exports = BrokerageSettings;
