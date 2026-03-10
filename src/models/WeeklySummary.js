const mongoose = require('mongoose');

const weeklySummarySchema = new mongoose.Schema({
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
  username: { type: String, required: true },
  name: { type: String, default: null },
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', default: null },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  week_start: { type: Date, required: true }, // Monday 00:00
  week_end: { type: Date, required: true },   // Sunday 23:59:59
  pnl: { type: Number, default: 0 },
  brokerage: { type: Number, default: 0 },
  total_trades: { type: Number, default: 0 },
  buy_qty: { type: Number, default: 0 },
  sell_qty: { type: Number, default: 0 },
  turnover: { type: Number, default: 0 },
}, { timestamps: true });

weeklySummarySchema.index({ userId: 1, week_start: -1 });
weeklySummarySchema.index({ master_id: 1, week_start: -1 });
weeklySummarySchema.index({ admin_id: 1, week_start: -1 });
weeklySummarySchema.index({ week_start: -1 });
// Prevent duplicate entries
weeklySummarySchema.index({ userId: 1, week_start: 1 }, { unique: true });

module.exports = mongoose.model('WeeklySummary', weeklySummarySchema);
