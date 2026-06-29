/**
 * Diagnostic: trace chitra13 P&L before/after settlement.
 * Run: node scripts/check_pnl_chitra13.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');

function toIST(d) {
  if (!d) return 'N/A';
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().replace('T',' ').slice(0,19) + ' IST';
}
function fmt(n) { return Number(n).toFixed(2); }

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra13' }).lean();
  if (!user) { console.log('chitra13 NOT FOUND'); process.exit(1); }
  console.log(`User: ${user.username} | id: ${user._id}`);
  console.log(`Credit: ${user.credits || user.credit || 0}\n`);

  // ── 1. All completed trades (active + soft-deleted) ──
  const allTrades = await Trade.find({
    user_id: user._id,
    status: 'completed',
  }).sort({ executed_at: 1 }).lean();

  console.log(`Total completed trades (any state): ${allTrades.length}`);

  // Separate: active vs deleted
  const activeTrades = allTrades.filter(t => !t.deleted_at);
  const deletedTrades = allTrades.filter(t => t.deleted_at);
  console.log(`  Active (not deleted): ${activeTrades.length}`);
  console.log(`  Soft-deleted:         ${deletedTrades.length}\n`);

  // ── 2. P&L from ALL trades (what client had before settlement) ──
  const totalPnlAll = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalBrAll  = allTrades.reduce((s, t) => s + (t.brokerage || 0), 0);
  console.log(`P&L from ALL trades (pre-settlement view):`);
  console.log(`  Sum of pnl field:       ${fmt(totalPnlAll)}`);
  console.log(`  Sum of brokerage field: ${fmt(totalBrAll)}`);
  console.log(`  Net (pnl - brokerage):  ${fmt(totalPnlAll - totalBrAll)}\n`);

  // ── 3. P&L from ACTIVE trades only (post-settlement view) ──
  const totalPnlActive = activeTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalBrActive  = activeTrades.reduce((s, t) => s + (t.brokerage || 0), 0);
  console.log(`P&L from ACTIVE trades only (post-settlement view):`);
  console.log(`  Sum of pnl field:       ${fmt(totalPnlActive)}`);
  console.log(`  Sum of brokerage field: ${fmt(totalBrActive)}`);
  console.log(`  Net (pnl - brokerage):  ${fmt(totalPnlActive - totalBrActive)}\n`);

  // ── 4. Settlement closing trades (the P&L booked at settlement) ──
  const settleClose = allTrades.filter(t =>
    t.remarks === 'Settlement: position closed at settlement price'
  );
  console.log(`Settlement closing trades: ${settleClose.length}`);
  let settlePnlSum = 0;
  for (const t of settleClose) {
    console.log(`  [${t.transaction_type}] ${t.tradingsymbol.padEnd(28)} qty=${t.executed_quantity} @ ${t.executed_price} | pnl=${fmt(t.pnl||0)} | at=${toIST(t.executed_at)} | deleted=${toIST(t.deleted_at)}`);
    settlePnlSum += (t.pnl || 0);
  }
  console.log(`  Total settlement P&L: ${fmt(settlePnlSum)}\n`);

  // ── 5. Carry-forward re-opening trades ──
  const cfTrades = allTrades.filter(t =>
    t.remarks === 'Settlement: position carried forward at close price'
  );
  console.log(`Carry-forward re-opening trades: ${cfTrades.length}`);
  for (const t of cfTrades) {
    console.log(`  [${t.transaction_type}] ${t.tradingsymbol.padEnd(28)} qty=${t.executed_quantity} @ ${t.executed_price} | deleted=${t.deleted_at ? toIST(t.deleted_at) : 'ACTIVE'}`);
  }
  console.log('');

  // ── 6. Regular trades still active (the "week-reset" ones should be deleted) ──
  const activeRegular = activeTrades.filter(t =>
    t.trade_type !== 'carry_forward' && t.trade_type !== 'margin_square_off'
  );
  const activeCF = activeTrades.filter(t => t.trade_type === 'carry_forward');
  console.log(`Active regular trades: ${activeRegular.length}`);
  console.log(`Active carry_forward:  ${activeCF.length}\n`);

  // ── 7. What P&L metricsEngine would see (active trades only) ──
  // metricsEngine uses active trades for FIFO pnl
  let metricsEstimate = 0;
  for (const t of activeTrades) {
    metricsEstimate += (t.pnl || 0);
  }
  console.log(`Estimated realised P&L (active trades pnl sum): ${fmt(metricsEstimate)}`);
  console.log(`Screen shows realised P&L: 14691.01`);
  console.log(`Client says before settlement it was: ~19000\n`);

  // ── 8. Difference analysis ──
  const diff = 19000 - metricsEstimate;
  console.log(`Gap (19k - current): ~${fmt(diff)}`);
  console.log(`Settlement closing P&L sum: ${fmt(settlePnlSum)}`);
  console.log(`If settlement P&L was NOT added: expected = active_regular_pnl + settlement_pnl = ${fmt(totalPnlActive + settlePnlSum)}\n`);

  // ── 9. SettlementHistory ledger ──
  const ledger = await SettlementHistory.find({ user_id: user._id }).sort({ period_to: 1 }).lean();
  console.log(`Settlement ledger snapshots: ${ledger.length}`);
  for (const s of ledger) {
    console.log(`  [${toIST(s.period_to)}] ${s.display_name.padEnd(30)} realPnl=${fmt(s.realized_pnl)} settlePnl=${fmt(s.settlement_pnl)} br=${fmt(s.brokerage)} net=${fmt(s.net_pnl)}`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
