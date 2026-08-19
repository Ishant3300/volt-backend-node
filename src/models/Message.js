const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'sender_type'
  },
  sender_type: {
    type: String,
    required: true,
    enum: ['Admin', 'Master']
  },
  recipient_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'recipient_type'
  },
  recipient_type: {
    type: String,
    required: true,
    enum: ['Admin', 'Master', 'User']
  },
  subject: {
    type: String,
    default: ''
  },
  message: {
    type: String,
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  read_at: {
    type: Date,
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
messageSchema.set('toJSON', {
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
messageSchema.index({ sender_id: 1 });

// ─── NEW: Replaces { recipient_id: 1, read: 1 } and broken { created_at: -1 } ───
// Covers inbox listing: find({ recipient_id, recipient_type, deleted_at: null }).sort({ createdAt: -1 })
messageSchema.index({ recipient_id: 1, recipient_type: 1, deleted_at: 1, createdAt: -1 });

// ─── NEW: Unread count: countDocuments({ recipient_id, recipient_type, read: false, deleted_at: null }) ───
messageSchema.index({ recipient_id: 1, recipient_type: 1, read: 1, deleted_at: 1 });

module.exports = mongoose.model('Message', messageSchema);
