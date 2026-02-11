const mongoose = require('mongoose');

const kiteAccessTokenSchema = new mongoose.Schema({
  access_token: {
    type: String,
    required: true,
    unique: true
  },
  expires_at: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

// Transform _id to id and timestamps to snake_case
kiteAccessTokenSchema.set('toJSON', {
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
kiteAccessTokenSchema.index({ access_token: 1 }, { unique: true });
kiteAccessTokenSchema.index({ expires_at: 1 });

module.exports = mongoose.model('KiteAccessToken', kiteAccessTokenSchema);
