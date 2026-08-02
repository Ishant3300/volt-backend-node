const mongoose = require('mongoose');

// One short-lived document per in-flight trade write. Settlement first closes
// the global fence and then drains these leases before taking its DB snapshot.
const tradeWriteLeaseSchema = new mongoose.Schema({
  owner: { type: String, required: true, unique: true },
  label: { type: String, default: 'trade_write' },
  expires_at: { type: Date, required: true },
  // Settlement claims this same per-writer document after closing the global
  // fence. A writer transaction that touched the lease must commit/abort before
  // the claim can complete; a claimed lease can no longer prove a write.
  claimed_by: { type: String, default: null },
  claimed_at: { type: Date, default: null },
}, { timestamps: true });

tradeWriteLeaseSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TradeWriteLease', tradeWriteLeaseSchema);
