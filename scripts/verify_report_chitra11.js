/**
 * Read-only verification: exercises the real getTradeReport handler (mock req/res)
 * for chitra11 Jun 15-20 and prints the resulting tables/summary/carry-forward.
 * Run: node scripts/verify_report_chitra11.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { getTradeReport } = require('../src/controllers/tradeReportController');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findOne({ username: 'chitra11' }).lean();

  const req = {
    query: { from: '2026-06-15', to: '2026-06-20', user_id: String(u._id) },
    admin: { id: String(new mongoose.Types.ObjectId()) }, // act as admin querying a user
  };
  let captured = null;
  const res = { status() { return res; }, json(obj) { captured = obj; return res; } };

  await getTradeReport(req, res);

  if (!captured || !captured.success) {
    console.log('REPORT FAILED:', captured && captured.message);
    await mongoose.disconnect();
    process.exit(1);
  }
  const d = captured.data;
  console.log(`\nReport for ${d.user_name}  (${new Date(d.from).toISOString().slice(0,10)} → ${new Date(d.to).toISOString().slice(0,10)})\n`);
  console.log('INSTRUMENT TABLES:');
  for (const i of d.instruments) {
    console.log(`  ${i.exchange} ${i.display_name}: buyQty=${i.total_buy_qty} sellQty=${i.total_sell_qty} fills=${i.all_trades.length} pnl=${Number(i.pnl).toFixed(2)} br=${Number(i.brokerage).toFixed(2)} net=${Number(i.net_pnl).toFixed(2)}`);
  }
  console.log('\nSUMMARY:', JSON.stringify(d.summary));
  console.log('\nCARRY FORWARD:');
  for (const c of d.carry_forward) {
    console.log(`  ${c.exchange} ${c.display_name} ${c.type} ${c.quantity} @ ${Number(c.price).toFixed(2)}`);
  }
  console.log('');
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
