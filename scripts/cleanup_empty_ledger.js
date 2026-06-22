/**
 * One-time cleanup: remove empty placeholder ledger snapshots created by the
 * best-effort backfill (docs with no fills and zero buy/sell qty). These carry
 * no real activity — the true history for those instruments lives in another
 * period's snapshot. Going forward the hardened backfill won't create them.
 *
 * Run: node scripts/cleanup_empty_ledger.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const SettlementHistory = require('../src/models/SettlementHistory');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const res = await SettlementHistory.deleteMany({
    $or: [
      { fills: { $size: 0 } },
      { fills: { $exists: false } },
    ],
    total_buy_qty: 0,
    total_sell_qty: 0,
  });
  console.log(`Deleted ${res.deletedCount} empty placeholder snapshot(s).`);
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
