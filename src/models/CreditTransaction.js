const mongoose = require('mongoose');

const creditTransactionSchema = new mongoose.Schema({
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true
  },
  // The actor who performed this credit/debit — an Admin OR a Master
  // (a master crediting/debiting their own direct child/user). `ref: 'Admin'`
  // was hardcoded here while several call sites actually stored a Master's
  // id in this field, making `.populate('admin_id')` resolve against the
  // wrong collection. `refPath` lets each document declare its own actor
  // type via `actor_model`.
  admin_id: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'actor_model',
    required: true
  },
  actor_model: {
    type: String,
    enum: ['Admin', 'Master'],
    default: 'Admin'
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

// Indexes — Fixed: was `created_at` which doesn't exist (Mongoose timestamps = `createdAt`)
creditTransactionSchema.index({ master_id: 1, createdAt: -1 });
creditTransactionSchema.index({ admin_id: 1, createdAt: -1 });
creditTransactionSchema.index({ transaction_type: 1 });

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);
