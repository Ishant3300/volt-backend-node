const mongoose = require('mongoose');

const quantityValueSchema = new mongoose.Schema({
  value: {
    type: Number,
    required: true
  },
  order: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
quantityValueSchema.set('toJSON', {
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
quantityValueSchema.index({ order: 1 });

module.exports = mongoose.model('QuantityValue', quantityValueSchema);
