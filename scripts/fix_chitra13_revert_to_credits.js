/**
 * Revert: move settled_pnl back to credits for chitra13.
 * After this: credits = 200000 + 4923.92 = 204923.92, settled_pnl = 0
 * Run: node scripts/fix_chitra13_revert_to_credits.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra13' }).lean();
  console.log(`Before: credits=${user.credits}, settled_pnl=${user.settled_pnl || 0}`);

  const delta = user.settled_pnl || 0;
  if (Math.abs(delta) < 0.01) {
    console.log('Nothing to move — settled_pnl is already 0.');
    await mongoose.disconnect();
    return;
  }

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { credits: delta }, $set: { settled_pnl: 0 } },
    { new: true }
  ).lean();

  console.log(`After: credits=${updated.credits}, settled_pnl=${updated.settled_pnl}`);
  console.log(`Post-settlement expected: credit=${updated.credits}, realised_pnl=0(new week starts at 0 after all positions settled)`);
  console.log(`But current week has unsettled trades showing ~16988 realised_pnl (correct — those weren't settled)`);
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
