/**
 * Fix user equity values corrupted by the old margin deduction bug.
 * Recalculates: equity = credits + sum(trade.pnl) - sum(trade.brokerage)
 * 
 * Run: node scripts/fixUserEquity.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Trade = require('../src/models/Trade');

async function fix() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const users = await User.find({ deleted_at: null });
  console.log(`Found ${users.length} users\n`);

  for (const user of users) {
    const trades = await Trade.find({
      user_id: user._id,
      status: 'completed',
      deleted_at: null,
    });

    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalBrokerage = trades.reduce((sum, t) => sum + (t.brokerage || 0), 0);
    const correctEquity = (user.credits || 0) + totalPnl - totalBrokerage;
    const oldEquity = user.equity || 0;

    if (Math.abs(correctEquity - oldEquity) > 0.01) {
      console.log(`${user.username}: ${oldEquity.toFixed(2)} → ${correctEquity.toFixed(2)} (credits=${user.credits}, pnl=${totalPnl.toFixed(2)}, brk=${totalBrokerage.toFixed(2)})`);
      user.equity = correctEquity;
      await user.save();
    } else {
      console.log(`${user.username}: OK (${oldEquity.toFixed(2)})`);
    }
  }

  console.log('\nDone');
  await mongoose.disconnect();
  process.exit(0);
}

fix().catch(err => { console.error(err); process.exit(1); });
