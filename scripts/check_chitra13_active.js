require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');

function toIST(d) {
  if (!d) return 'N/A';
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().replace('T',' ').slice(0,19) + ' IST';
}
function fmt(n) { return Number(n).toFixed(2); }

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra13' }).lean();

  const active = await Trade.find({
    user_id: user._id, status: 'completed', deleted_at: null,
    trade_type: { $nin: ['carry_forward', 'margin_square_off'] }
  }).sort({ executed_at: 1 }).lean();

  console.log(`Active regular trades: ${active.length}\n`);

  // Group by instrument
  const byInstr = {};
  for (const t of active) {
    const k = `${t.exchange}::${t.tradingsymbol}`;
    if (!byInstr[k]) byInstr[k] = { buyQty:0, sellQty:0, pnlSum:0, brSum:0, trades:[] };
    const g = byInstr[k];
    if (t.transaction_type === 'BUY') g.buyQty += t.executed_quantity;
    else g.sellQty += t.executed_quantity;
    g.pnlSum += (t.pnl || 0);
    g.brSum  += (t.brokerage || 0);
    g.trades.push(t);
  }

  console.log('INSTRUMENT BREAKDOWN:');
  for (const [k, g] of Object.entries(byInstr)) {
    const netQty = g.buyQty - g.sellQty;
    const earliest = toIST(g.trades[0].executed_at);
    const latest   = toIST(g.trades[g.trades.length-1].executed_at);
    console.log(`  ${k}`);
    console.log(`    trades=${g.trades.length}  buy=${g.buyQty}  sell=${g.sellQty}  net=${netQty}  pnl=${fmt(g.pnlSum)}  br=${fmt(g.brSum)}`);
    console.log(`    from ${earliest}  to ${latest}`);
  }

  // Also show the 9 deleted trades
  const deleted = await Trade.find({
    user_id: user._id, status: 'completed', deleted_at: { $ne: null }
  }).sort({ executed_at: 1 }).lean();

  console.log(`\nDELETED TRADES (${deleted.length}):`);
  for (const t of deleted) {
    console.log(`  [${t.transaction_type}] ${t.tradingsymbol.padEnd(24)} qty=${t.executed_quantity} @ ${t.executed_price} | pnl=${fmt(t.pnl||0)} | at=${toIST(t.executed_at)} | deleted=${toIST(t.deleted_at)} | remarks: ${t.remarks}`);
  }

  await mongoose.disconnect();
}
run().catch(err => { console.error(err.message); process.exit(1); });
