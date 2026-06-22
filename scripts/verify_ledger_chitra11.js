require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');
async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra11' }).lean();
  const docs = await SettlementHistory.find({ user_id: user._id }).sort({ period_to: 1, tradingsymbol: 1 }).lean();
  console.log(`chitra11 ledger snapshots: ${docs.length}\n`);
  for (const d of docs) {
    const ist = new Date(d.period_to.getTime()+5.5*3600000).toISOString().slice(0,10);
    console.log(`[${ist}] ${d.display_name} | fills=${d.fills.length} | buy=${d.total_buy_qty} sell=${d.total_sell_qty} | settle=${d.settlement_price} | realPnl=${d.realized_pnl.toFixed(2)} setPnl=${d.settlement_pnl.toFixed(2)} br=${d.brokerage.toFixed(2)} net=${d.net_pnl.toFixed(2)} | CF: ${d.carry_forward_side||'-'} ${d.carry_forward_qty}@${d.carry_forward_price}`);
  }
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
