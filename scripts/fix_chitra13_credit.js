/**
 * Retroactive fix: credit chitra13 with the settled P&L from the
 * Jun 29 settlement of BANKNIFTY26JUNFUT flat position.
 * net_pnl = realPnl(4976.00) - brokerage(52.08) = 4923.92
 * Run: node scripts/fix_chitra13_credit.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra13' }).lean();
  if (!user) { console.log('chitra13 not found'); process.exit(1); }

  console.log(`chitra13 current credits: ${user.credits}`);

  // Verify the ledger entry to use the exact net_pnl value
  const snap = await SettlementHistory.findOne({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
  }).sort({ settlement_date: -1 }).lean();

  if (!snap) {
    console.log('No settlement ledger entry found for chitra13 BANKNIFTY26JUNFUT');
    process.exit(1);
  }

  console.log(`Ledger entry: realPnl=${snap.realized_pnl}, settlePnl=${snap.settlement_pnl}, br=${snap.brokerage}, net_pnl=${snap.net_pnl}`);
  console.log(`Settlement date: ${snap.settlement_date}`);

  const delta = Math.round(snap.net_pnl * 100) / 100;
  console.log(`\nWill add ${delta} to chitra13.credits`);

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { credits: delta } },
    { new: true }
  ).lean();

  console.log(`\nDone.`);
  console.log(`New credits: ${updated.credits}`);
  console.log(`Expected equity after server rebuild: credits(${updated.credits}) + current_week_m2mPnl(14691.01) = ${(updated.credits + 14691.01).toFixed(2)}`);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
