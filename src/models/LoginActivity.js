const mongoose = require('mongoose');

const loginActivitySchema = new mongoose.Schema({
  login_time: {
    type: Date,
    required: true
  },
  device_name: {
    type: String,
    required: true
  },
  device_version: {
    type: String,
    required: true
  },
  server_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Server',
    required: true
  },
  app_version: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
loginActivitySchema.set('toJSON', {
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
loginActivitySchema.index({ login_time: -1 });
loginActivitySchema.index({ server_id: 1 });

module.exports = mongoose.model('LoginActivity', loginActivitySchema);
