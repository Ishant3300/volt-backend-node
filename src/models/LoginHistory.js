const mongoose = require('mongoose');

const loginHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'userModel'
  },
  userModel: {
    type: String,
    required: true,
    enum: ['User', 'Master', 'Admin']
  },
  username: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: null
  },
  ip_address: {
    type: String,
    default: null
  },
  user_agent: {
    type: String,
    default: null
  }
}, { timestamps: true });

loginHistorySchema.index({ userId: 1, createdAt: -1 });
loginHistorySchema.index({ userModel: 1, createdAt: -1 });
loginHistorySchema.index({ createdAt: -1 });

const LoginHistory = mongoose.model('LoginHistory', loginHistorySchema);

module.exports = LoginHistory;
