const mongoose = require('mongoose');

/**
 * Durable coordinator for weekly settlement.
 * `period_key` is the official trading date (YYYY-MM-DD) and is globally unique,
 * so only one process can mutate a settlement period even with multiple workers.
 */
const settlementRunSchema = new mongoose.Schema({
  period_key: { type: String, required: true, unique: true, immutable: true },
  trading_date: { type: Date, required: true, immutable: true },
  // Absolute end of the logical settlement period in IST. Recovery must never
  // absorb trades created after this boundary.
  trade_cutoff_at: { type: Date, required: true, immutable: true },
  // NSE and MCX can have different full-day holidays. Each price is validated
  // against its exchange-specific official source date.
  price_dates: {
    nse: { type: Date, required: true },
    mcx: { type: Date, required: true },
  },
  // False only when calendar resolution failed before source dates could be
  // certified. Such a run remains durable/failed and fences every writer.
  price_dates_resolved: { type: Boolean, default: true },
  status: {
    type: String,
    enum: ['running', 'committed', 'finalizing', 'completed', 'failed', 'blocked'],
    required: true,
    default: 'running',
  },
  trigger: {
    type: String,
    enum: ['cron', 'manual', 'recovery'],
    default: 'manual',
  },
  lock_owner: { type: String, default: null },
  lease_expires_at: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  started_at: { type: Date, default: null },
  committed_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  failed_at: { type: Date, default: null },
  error: { type: String, default: null },
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  verification: { type: mongoose.Schema.Types.Mixed, default: {} },
  adopted_legacy_history: { type: Boolean, default: false },
  // Legacy ledgers used their own generated run identifier before durable
  // SettlementRun records existed. Keep that immutable history identity rather
  // than rewriting ledger rows during one-time adoption.
  history_run_id: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

settlementRunSchema.index({ status: 1, lease_expires_at: 1 });
settlementRunSchema.index({ trading_date: -1 });

module.exports = mongoose.model('SettlementRun', settlementRunSchema);
