const mongoose = require('mongoose');

// Access Token Schema - stores Kite access tokens with expiry
const accessTokenSchema = new mongoose.Schema({
  access_token: {
    type: String,
    required: true,
    unique: true
  },
  created_at: {
    type: Date,
    required: true,
    default: Date.now
  },
  expires_at: {
    type: Date,
    required: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient queries
accessTokenSchema.index({ expires_at: 1 });
accessTokenSchema.index({ created_at: -1 });

const AccessToken = mongoose.model('AccessToken', accessTokenSchema);

module.exports = { AccessToken };
