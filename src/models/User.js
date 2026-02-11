const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  server_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Server',
    required: true
  },
  credit: {
    type: Number,
    default: 0
  },
  current_credit: {
    type: Number,
    default: 0
  },
  balance: {
    type: Number,
    default: 0
  },
  exchanges_support: {
    type: [String],
    enum: ['BSE-FUT', 'BSE-CALL', 'BSE-PUT', 'NSE-FUT', 'NSE-CALL', 'NSE-PUT', 'MCX-FUT', 'MCX-CALL', 'MCX-PUT'],
    default: []
  },
  master_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Master',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended'],
    default: 'active'
  },
  active_token: {
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
userSchema.set('toJSON', {
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
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ server_id: 1 });
userSchema.index({ master_id: 1 });
userSchema.index({ status: 1 });

module.exports = mongoose.model('User', userSchema);
