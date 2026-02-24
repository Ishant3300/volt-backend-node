const mongoose = require('mongoose');

const creditTransactionSchema = new mongoose.Schema({
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
  transaction_type: {
    type: String,
    required: true,
    enum: ['CREDIT', 'DEBIT']
  },
  amount: {
    type: Number,
    required: true
  },
  previous_balance: {
    type: Number,
    required: true
  },
  new_balance: {
    type: Number,
    required: true
  },
  note: {
    type: String,
    default: ''
  },
  reference_id: {
    type: String,
    default: null
  },
  deleted_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
creditTransactionSchema.set('toJSON', {
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
creditTransactionSchema.index({ master_id: 1, created_at: -1 });
creditTransactionSchema.index({ admin_id: 1, created_at: -1 });
creditTransactionSchema.index({ transaction_type: 1 });

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);
