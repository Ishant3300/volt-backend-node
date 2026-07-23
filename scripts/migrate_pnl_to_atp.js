/**
 * Migration: Recalculate all trade.pnl from FIFO to ATP (Average Trade Price).
 *
 * ATP P&L logic:
 * - Long close (SELL when net > 0): pnl = (sellPrice - avgBuyPrice) × closingQty
 * - Short close (BUY when net < 0): pnl = (avgSellPrice - buyPrice) × closingQty
 * - Opening trades: pnl = 0
 *
 * Saves old pnl in a backup field `_pnl_fifo` for revert capability.
 * Processes per user, per instrument, chronologically.
 *
 * Run: node scripts/migrate_pnl_to_atp.js
 * Revert: node scripts/revert_pnl_to_fifo.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // Get all users with completed trades
  const userIds = await Trade.distinct('user_id', { status: 'completed' });
  console.log(`Processing ${userIds.length} users...\n`);

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const userId of userIds) {
    // Get all completed trades for this user (including soft-deleted — for full history)
    const trades = await Trade.find({
      user_id: userId,
      status: 'completed',
    }).sort({ executed_at: 1 }).lean();

    if (trades.length === 0) continue;

    // Group by instrument
    const byInstrument = {};
    for (const t of trades) {
      const key = t.instrument_token;
      if (!byInstrument[key]) byInstrument[key] = [];
      byInstrument[key].push(t);
    }

    // Process each instrument chronologically
    for (const [token, instrTrades] of Object.entries(byInstrument)) {
      let totalBuyQty = 0;
      let totalBuyValue = 0;
      let totalSellQty = 0;
      let totalSellValue = 0;

      for (const t of instrTrades) {
        const qty = t.executed_quantity || 0;
        const price = t.executed_price || 0;
        const isBuy = t.transaction_type === 'BUY';

        // Current net position BEFORE this trade
        const netQtyBefore = totalBuyQty - totalSellQty;

        let newPnl = 0;

        if (isBuy) {
          if (netQtyBefore < 0) {
            // Closing a short position — use avg sell price
            const avgSellPrice = totalSellQty > 0 ? totalSellValue / totalSellQty : 0;
            const closingQty = Math.min(qty, Math.abs(netQtyBefore));
            newPnl = (avgSellPrice - price) * closingQty;
          }
          // else: opening or adding to long — pnl = 0
          totalBuyQty += qty;
          totalBuyValue += qty * price;
        } else {
          // SELL
          if (netQtyBefore > 0) {
            // Closing a long position — use avg buy price
            const avgBuyPrice = totalBuyQty > 0 ? totalBuyValue / totalBuyQty : 0;
            const closingQty = Math.min(qty, netQtyBefore);
            newPnl = (price - avgBuyPrice) * closingQty;
          }
          // else: opening or adding to short — pnl = 0
          totalSellQty += qty;
          totalSellValue += qty * price;
        }

        // Round to 2 decimal places
        newPnl = Math.round(newPnl * 100) / 100;

        // Only update if the value actually changed
        const oldPnl = Math.round((t.pnl || 0) * 100) / 100;
        if (oldPnl !== newPnl) {
          await Trade.updateOne(
            { _id: t._id },
            { $set: { pnl: newPnl, _pnl_fifo: oldPnl } }
          );
          totalUpdated++;
        } else {
          totalSkipped++;
        }
      }
    }
  }

  console.log(`\n✅ Migration complete.`);
  console.log(`   Updated: ${totalUpdated} trades (pnl changed)`);
  console.log(`   Skipped: ${totalSkipped} trades (pnl unchanged)`);
  console.log(`   Old FIFO values backed up in '_pnl_fifo' field.`);

  await mongoose.disconnect();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
