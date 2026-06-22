/**
 * chitra11 — Full trade history summary (all BANKNIFTY FUT trades + CF positions)
 * Run: node scripts/chitra11_history.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User  = require('../src/models/User');

function toIST(d) {
  if (!d) return 'N/A';
  return new Date(d.getTime() + 5.5 * 3600000)
    .toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}
function fmt(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pad(s, n) { return String(s).padEnd(n); }

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra11' }).lean();

  // ── BANKNIFTY FUT: all regular trades (includes settled/soft-deleted) ──
  const bnfTrades = await Trade.find({
    user_id:    user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    status:     'completed',
    trade_type: { $ne: 'carry_forward' },
  }).sort({ executed_at: 1 }).lean();

  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log('  BANKNIFTY 30 Jun FUT — Trade History (' + bnfTrades.length + ' trades)');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log(pad('Timestamp (IST)',22) + pad('Side',5) + pad('Qty',5) + pad('Price',12) + pad('PnL (stored)',15) + 'Note');
  console.log('─'.repeat(80));

  let totalPnl = 0;
  for (const t of bnfTrades) {
    const pnl = t.pnl || 0;
    totalPnl += pnl;
    const note = t.deleted_at ? '[settled ' + toIST(t.deleted_at) + ']' : '';
    console.log(
      pad(toIST(t.executed_at), 22) +
      pad(t.transaction_type, 5) +
      pad(t.executed_quantity, 5) +
      pad(fmt(t.executed_price), 12) +
      pad((pnl > 0 ? '+' : '') + fmt(pnl), 15) +
      note
    );
  }
  console.log('─'.repeat(80));
  console.log('Total realised PnL (stored): ₹' + fmt(totalPnl));

  // Settlement close trade
  const sc = await Trade.findOne({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    trade_type: 'carry_forward',
    remarks: 'Settlement: position closed at settlement price',
  }).lean();
  if (sc) {
    console.log('\nSettlement close @ ' + toIST(sc.executed_at));
    console.log('  Side=' + sc.transaction_type + '  qty=' + sc.executed_quantity +
                '  settlement price=₹' + fmt(sc.executed_price) +
                '  settlement PnL=₹' + fmt(sc.pnl || 0));
  }

  // Carry-forward re-open
  const cf = await Trade.findOne({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    trade_type: 'carry_forward',
    remarks: 'Settlement: position carried forward at close price',
    deleted_at: null,
  }).lean();
  if (cf) {
    console.log('\nCarry-forward re-open @ ' + toIST(cf.executed_at));
    console.log('  Side=' + cf.transaction_type + '  qty=' + cf.executed_quantity +
                '  ATP=₹' + fmt(cf.executed_price) + '  (open for new week)');
  }

  // ── Historical CE/FUT carry-forwards from Jun 14 settlement ──
  console.log('\n\n══════════════════════════════════════════════════════════════════════════');
  console.log('  CE / FINNIFTY / NIFTY — Historical Carry-Forwards (Jun 14 Settlement)');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log(pad('Script', 30) + pad('Side', 5) + pad('Qty', 5) + pad('ATP', 12) + pad('Opened (IST)', 22) + 'Settled (IST)');
  console.log('─'.repeat(100));

  const histCF = await Trade.find({
    user_id: user._id,
    trade_type: 'carry_forward',
    remarks: 'Settlement: position carried forward at close price',
    deleted_at: { $ne: null },
  }).sort({ executed_at: 1 }).lean();

  for (const t of histCF) {
    console.log(
      pad(t.tradingsymbol, 30) +
      pad(t.transaction_type, 5) +
      pad(t.executed_quantity, 5) +
      pad(fmt(t.executed_price), 12) +
      pad(toIST(t.executed_at), 22) +
      toIST(t.deleted_at)
    );
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
