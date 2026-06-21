/**
 * Diagnostic: show chitra11's current open positions (net qty per instrument).
 * Run: node scripts/check_open_positions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  // Find chitra11
  const user = await User.findOne({ username: 'chitra11' }).lean();
  if (!user) {
    console.log('User chitra11 not found');
    process.exit(1);
  }
  console.log(`\nUser: ${user.username} (${user.name}) — id: ${user._id}\n`);

  // Get all active completed trades (non-deleted)
  const trades = await Trade.find({
    user_id: user._id,
    status: 'completed',
    deleted_at: null,
  }).sort({ executed_at: 1 }).lean();

  console.log(`Total active completed trades: ${trades.length}\n`);

  // Compute net position per instrument
  const positions = {};
  for (const t of trades) {
    const key = `${t.exchange}::${t.tradingsymbol}`;
    if (!positions[key]) {
      positions[key] = {
        exchange: t.exchange,
        symbol: t.tradingsymbol,
        netQty: 0,
        totalBuyQty: 0,
        totalSellQty: 0,
        trades: [],
      };
    }
    const qty = t.executed_quantity || 0;
    if (t.transaction_type === 'BUY') {
      positions[key].netQty += qty;
      positions[key].totalBuyQty += qty;
    } else {
      positions[key].netQty -= qty;
      positions[key].totalSellQty += qty;
    }
    positions[key].trades.push({
      type: t.transaction_type,
      qty,
      price: t.executed_price,
      trade_type: t.trade_type,
      executed_at: t.executed_at,
      remarks: t.remarks,
    });
  }

  console.log('=== OPEN POSITIONS (netQty != 0) ===\n');
  let hasOpen = false;
  for (const [key, pos] of Object.entries(positions)) {
    if (Math.abs(pos.netQty) > 0.001) {
      hasOpen = true;
      const direction = pos.netQty > 0 ? 'LONG (BUY)' : 'SHORT (SELL)';
      console.log(`${pos.exchange} ${pos.symbol}`);
      console.log(`  Direction : ${direction}`);
      console.log(`  Net Qty   : ${pos.netQty}`);
      console.log(`  Total Buy : ${pos.totalBuyQty}`);
      console.log(`  Total Sell: ${pos.totalSellQty}`);
      console.log(`  Trades    :`);
      for (const t of pos.trades) {
        console.log(`    [${t.type.padEnd(4)}] qty=${t.qty}, price=${t.price}, type=${t.trade_type}, at=${t.executed_at ? new Date(t.executed_at).toISOString() : 'N/A'}, remarks="${t.remarks || ''}"`);
      }
      console.log('');
    }
  }
  if (!hasOpen) console.log('No open positions found.\n');

  console.log('=== ALL CLOSED POSITIONS ===\n');
  for (const [key, pos] of Object.entries(positions)) {
    if (Math.abs(pos.netQty) <= 0.001 && pos.trades.length > 0) {
      console.log(`${pos.exchange} ${pos.symbol} — CLOSED (buy=${pos.totalBuyQty}, sell=${pos.totalSellQty})`);
    }
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
