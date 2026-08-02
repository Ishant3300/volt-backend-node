const mongoose = require('mongoose');

// Singleton exclusive fence used while weekly settlement snapshots and commits.
const settlementFenceSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  lock_owner: { type: String, required: true },
  locked_until: { type: Date, required: true },
}, { timestamps: true });

settlementFenceSchema.index({ locked_until: 1 });

module.exports = mongoose.model('SettlementFence', settlementFenceSchema);
