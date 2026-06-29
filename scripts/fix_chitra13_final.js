/**
 * Final fix: credit=200000 (admin-allocated, untouched), settled_pnl=4923.92
 * equity = credit + settled_pnl + m2mPnl = 200000 + 4923.92 + current_week
 * Run: node scripts/fix_chitra13_final.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra13' }).lean();
  console.log(`Before: credits=${user.credits}, settled_pnl=${user.settled_pnl || 0}`);

  // Reset to correct values
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { credits: 200000, settled_pnl: 4923.92 } },
    { new: true }
  ).lean();

  console.log(`After: credits=${updated.credits}, settled_pnl=${updated.settled_pnl}`);
  console.log(`Expected after deploy:`);
  console.log(`  Credit: 200,000 (untouched)`);
  console.log(`  Equity: 200,000 + 4,923.92 + m2mPnl`);
  console.log(`  Realised P&L: current week active trades only (~16,988 since 62 CE/PE trades not settled yet)`);
  console.log(`  NOTE: Realised shows 16,988 because those 62 trades were NOT settled (no bhavcopy prices).`);
  console.log(`        Once they are settled too, realised will go to 0 and settled_pnl will absorb them.`);
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
