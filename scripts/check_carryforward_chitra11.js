/**
 * Diagnostic: verify all carry_forward positions for chitra11
 * and why only 1 shows in the Jun 15-20 PDF report.
 * Run: node scripts/check_carryforward_chitra11.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra11' }).lean();
  console.log(`User: ${user.username} | id: ${user._id}\n`);

  // ── 1. ALL carry_forward trades (any date, any status) ──
  const allCF = await Trade.find({
    user_id: user._id,
    trade_type: 'carry_forward',
  }).sort({ executed_at: 1 }).lean();

  console.log(`═══ ALL carry_forward trades (${allCF.length} total) ═══`);
  for (const t of allCF) {
    const ist = t.executed_at
      ? new Date(t.executed_at.getTime() + 5.5 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' IST'
      : 'NO DATE';
    const deleted = t.deleted_at ? `  ← DELETED at ${t.deleted_at.toISOString()}` : '';
    console.log(`  [${t.transaction_type.padEnd(4)}] ${t.tradingsymbol.padEnd(30)} qty=${t.executed_quantity} price=${t.executed_price} | status=${t.status} | at=${ist}${deleted}`);
    console.log(`         remarks: "${t.remarks}"  |  deleted_at: ${t.deleted_at || 'null'}`);
  }

  // ── 2. Active carry_forward trades only ──
  const activeCF = allCF.filter(t => !t.deleted_at && t.status === 'completed');
  console.log(`\n═══ ACTIVE (non-deleted, completed) carry_forward: ${activeCF.length} ═══`);
  for (const t of activeCF) {
    const ist = t.executed_at
      ? new Date(t.executed_at.getTime() + 5.5 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' IST'
      : 'NO DATE';
    console.log(`  [${t.transaction_type.padEnd(4)}] ${t.tradingsymbol.padEnd(30)} qty=${t.executed_quantity} price=${t.executed_price} | at=${ist}`);
    console.log(`         remarks: "${t.remarks}"`);
  }

  // ── 3. Simulate the report date range query (Jun 15-20) ──
  const fromDate = new Date('2026-06-15T00:00:00.000Z');
  const toDate = new Date('2026-06-20T23:59:59.999Z');

  console.log(`\n═══ Carry_forward trades within Jun 15-20 report range ═══`);
  const inRange = activeCF.filter(t =>
    t.executed_at && t.executed_at >= fromDate && t.executed_at <= toDate
  );
  if (inRange.length === 0) {
    console.log('  ⚠️  NONE found in range! All CF trades are outside Jun 15-20.');
  } else {
    for (const t of inRange) {
      const ist = new Date(t.executed_at.getTime() + 5.5 * 3600000).toISOString().slice(0, 19) + ' IST';
      console.log(`  [${t.transaction_type}] ${t.tradingsymbol} qty=${t.executed_quantity} @ ${t.executed_price} | ${ist}`);
    }
  }

  const outOfRange = activeCF.filter(t =>
    !t.executed_at || t.executed_at < fromDate || t.executed_at > toDate
  );
  if (outOfRange.length > 0) {
    console.log(`\n  Trades OUTSIDE range (${outOfRange.length}):`);
    for (const t of outOfRange) {
      const ist = t.executed_at
        ? new Date(t.executed_at.getTime() + 5.5 * 3600000).toISOString().slice(0, 19) + ' IST'
        : 'NO DATE';
      console.log(`  [${t.transaction_type}] ${t.tradingsymbol} qty=${t.executed_quantity} @ ${t.executed_price} | at=${ist}`);
    }
  }

  // ── 4. What the report query actually matches (mirrors backend logic) ──
  console.log(`\n═══ What the /trade/report query returns for Jun 15-20 (full $or match) ═══`);
  const reportMatch = await Trade.find({
    user_id: user._id,
    status: 'completed',
    executed_at: { $gte: fromDate, $lte: toDate },
    $or: [
      { deleted_at: null, trade_type: { $nin: ['carry_forward', 'margin_square_off'] } },
      { remarks: 'Settlement: week reset', trade_type: { $nin: ['carry_forward', 'margin_square_off'] } },
      { remarks: 'Settlement: position closed at settlement price' },
      { deleted_at: null, trade_type: 'carry_forward' },
    ],
  }).sort({ executed_at: 1 }).lean();

  const cf_in_report = reportMatch.filter(t => t.trade_type === 'carry_forward');
  const regular_in_report = reportMatch.filter(t => t.trade_type !== 'carry_forward');
  console.log(`  Total trades in report range: ${reportMatch.length}`);
  console.log(`  Regular trades: ${regular_in_report.length}`);
  console.log(`  Carry_forward trades: ${cf_in_report.length}`);
  if (cf_in_report.length > 0) {
    for (const t of cf_in_report) {
      const ist = new Date(t.executed_at.getTime() + 5.5 * 3600000).toISOString().slice(0, 19) + ' IST';
      console.log(`    [${t.transaction_type}] ${t.tradingsymbol} qty=${t.executed_quantity} @ ${t.executed_price} | ${ist} | remarks: "${t.remarks}"`);
    }
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
