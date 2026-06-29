/**
 * Fix: revert the erroneous credit increase for chitra13,
 * and instead add the settled P&L to the new settled_pnl field.
 * Result: credit stays at 200,000, equity = 200,000 + settled_pnl + m2mPnl.
 * Run: node scripts/fix_chitra13_settled_pnl.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra13' }).lean();
  console.log(`Before: credits=${user.credits}, settled_pnl=${user.settled_pnl || 0}`);

  const snap = await SettlementHistory.findOne({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
  }).sort({ settlement_date: -1 }).lean();

  const netPnl = Math.round((snap.net_pnl || 4923.92) * 100) / 100;
  console.log(`Settlement net_pnl to move: ${netPnl}`);

  // Revert the credits back (subtract what was added), add to settled_pnl instead
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { credits: -netPnl, settled_pnl: netPnl } },
    { new: true }
  ).lean();

  console.log(`After: credits=${updated.credits}, settled_pnl=${updated.settled_pnl}`);
  console.log(`Expected equity = credits(${updated.credits}) + settled_pnl(${updated.settled_pnl}) + m2mPnl(current week) = ${updated.credits + updated.settled_pnl} + m2mPnl`);
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
