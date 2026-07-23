/**
 * Revert: Restore trade.pnl back to FIFO values from the backup field '_pnl_fifo'.
 * Only affects trades that were modified by migrate_pnl_to_atp.js.
 *
 * Run: node scripts/revert_pnl_to_fifo.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // Find all trades that have the backup field
  const trades = await Trade.find({ _pnl_fifo: { $exists: true } }).select('_id pnl _pnl_fifo').lean();
  console.log(`Found ${trades.length} trades with FIFO backup.\n`);

  if (trades.length === 0) {
    console.log('Nothing to revert.');
    await mongoose.disconnect();
    return;
  }

  let reverted = 0;
  for (const t of trades) {
    await Trade.updateOne(
      { _id: t._id },
      { $set: { pnl: t._pnl_fifo }, $unset: { _pnl_fifo: 1 } }
    );
    reverted++;
  }

  console.log(`✅ Reverted ${reverted} trades back to FIFO P&L.`);
  console.log(`   '_pnl_fifo' backup field removed.`);

  await mongoose.disconnect();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
