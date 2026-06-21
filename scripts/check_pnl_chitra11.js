/**
 * Diagnostic: verify chitra11's BANKNIFTY FUT P&L claim.
 * Shows avg sell price vs close (buy) prices, and FIFO P&L per trade.
 * Run: node scripts/check_pnl_chitra11.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra11' }).lean();
  console.log(`User: ${user.username} | id: ${user._id}\n`);

  const trades = await Trade.find({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    status: 'completed',
    deleted_at: null,
  }).sort({ executed_at: 1 }).lean();

  console.log(`Total active BANKNIFTY26JUNFUT trades: ${trades.length}\n`);

  // Compute weighted average sell price
  let totalSellQty = 0, totalSellValue = 0;
  let totalBuyQty = 0, totalBuyValue = 0;

  for (const t of trades) {
    const qty = t.executed_quantity;
    const price = t.executed_price;
    const ist = new Date(t.executed_at.getTime() + 5.5 * 3600000);
    const label = ist.toISOString().replace('T', ' ').slice(0, 19) + ' IST';

    if (t.transaction_type === 'SELL') {
      totalSellQty += qty;
      totalSellValue += qty * price;
      console.log(`  SELL  ${qty.toString().padStart(3)} @ ${price.toFixed(2).padStart(10)}   ${label}`);
    } else {
      totalBuyQty += qty;
      totalBuyValue += qty * price;
      const pnl = t.pnl || 0;
      const marker = pnl < 0 ? '  ← LOSS' : '  ← PROFIT';
      console.log(`  BUY   ${qty.toString().padStart(3)} @ ${price.toFixed(2).padStart(10)}   ${label}   stored P&L: ${pnl.toFixed(2)}${marker}`);
    }
  }

  const avgSell = totalSellQty > 0 ? totalSellValue / totalSellQty : 0;
  const avgBuy  = totalBuyQty  > 0 ? totalBuyValue  / totalBuyQty  : 0;

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`Total SELL qty : ${totalSellQty}  |  Avg SELL price : ${avgSell.toFixed(4)}`);
  console.log(`Total BUY  qty : ${totalBuyQty}  |  Avg BUY  price : ${avgBuy.toFixed(4)}`);
  console.log(`Net open qty   : ${totalBuyQty - totalSellQty}  (negative = SHORT)`);
  console.log(`═══════════════════════════════════════════════════`);

  // For each BUY trade, compare its price vs avg sell
  console.log('\n── BUY trades vs avg sell price ──');
  for (const t of trades) {
    if (t.transaction_type !== 'BUY') continue;
    const price = t.executed_price;
    const diff = price - avgSell;
    const ist = new Date(t.executed_at.getTime() + 5.5 * 3600000);
    const label = ist.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
    const verdict = diff > 0
      ? `ABOVE avg sell by ${diff.toFixed(2)} → LOSS for short close`
      : `BELOW avg sell by ${Math.abs(diff).toFixed(2)} → PROFIT for short close`;
    console.log(`  BUY ${t.executed_quantity} @ ${price} on ${label}`);
    console.log(`    vs avg sell ${avgSell.toFixed(2)} → ${verdict}`);
    console.log(`    stored pnl: ${(t.pnl || 0).toFixed(2)}\n`);
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
