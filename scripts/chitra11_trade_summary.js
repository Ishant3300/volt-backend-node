/**
 * Trade summary for chitra11's carry-forward positions.
 * Shows ATP, current close price, PnL, timestamps — like the trade history UI.
 * Run: node scripts/chitra11_trade_summary.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const KiteInstrument = require('../src/models/KiteInstrument');
const User = require('../src/models/User');

function toIST(date) {
  if (!date) return 'N/A';
  return new Date(date.getTime() + 5.5 * 3600000)
    .toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

function fmt(n) {
  return n != null ? Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A';
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra11' }).lean();

  // Get active carry-forward positions
  const cfTrades = await Trade.find({
    user_id: user._id,
    trade_type: 'carry_forward',
    remarks: 'Settlement: position carried forward at close price',
    deleted_at: null,
    status: 'completed',
  }).sort({ executed_at: 1 }).lean();

  // Also get soft-deleted historical ones (Jun 14)
  const histCfTrades = await Trade.find({
    user_id: user._id,
    trade_type: 'carry_forward',
    remarks: 'Settlement: position carried forward at close price',
    deleted_at: { $ne: null },
    status: 'completed',
  }).sort({ executed_at: 1 }).lean();

  const allCF = [...cfTrades, ...histCfTrades];

  // Get current prices from KiteInstrument
  const tokens = allCF.map(t => t.instrument_token);
  const instruments = await KiteInstrument.find({ instrument_token: { $in: tokens } }).lean();
  const kiMap = {};
  instruments.forEach(i => { kiMap[i.instrument_token] = i; });

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  chitra11 — Carry-Forward Trade Summary');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  for (const t of allCF) {
    const ki = kiMap[t.instrument_token] || {};
    const atp = t.executed_price;
    const cmp = ki.last_price || 0;
    const qty = t.executed_quantity;
    const isLong = t.transaction_type === 'BUY';
    const pnl = isLong ? (cmp - atp) * qty : (atp - cmp) * qty;
    const status = t.deleted_at ? `CLOSED (deleted ${toIST(t.deleted_at)})` : 'OPEN';

    console.log(`  Script      : ${t.tradingsymbol}`);
    console.log(`  Type        : ${t.transaction_type} ${qty} lots`);
    console.log(`  ATP (Entry) : ₹${fmt(atp)}`);
    console.log(`  Close Price : ₹${fmt(cmp)}  (KiteInstrument last_price)`);
    console.log(`  PnL         : ₹${fmt(pnl)}  ${pnl >= 0 ? '✅ Profit' : '🔴 Loss'}`);
    console.log(`  Placed At   : ${toIST(t.executed_at)}`);
    console.log(`  Status      : ${status}`);
    console.log('  ─────────────────────────────────────────────────────────────');
  }

  // Also show the BANKNIFTY FUT regular trades summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  BANKNIFTY26JUNFUT — Regular Trades Summary');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const bnfTrades = await Trade.find({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    trade_type: 'regular',
    status: 'completed',
    deleted_at: null,
  }).sort({ executed_at: 1 }).lean();

  const bnfKi = await KiteInstrument.findOne({ tradingsymbol: 'BANKNIFTY26JUNFUT', deleted_at: null }).lean();
  const bnfCmp = bnfKi?.last_price || 0;

  let totalBuyQty = 0, totalBuyVal = 0;
  let totalSellQty = 0, totalSellVal = 0;

  for (const t of bnfTrades) {
    const qty = t.executed_quantity;
    const price = t.executed_price;
    if (t.transaction_type === 'BUY') { totalBuyQty += qty; totalBuyVal += qty * price; }
    else { totalSellQty += qty; totalSellVal += qty * price; }

    console.log(`  [${t.transaction_type.padEnd(4)}] ${qty.toString().padStart(3)} qty @ ₹${fmt(price)}  |  pnl=₹${fmt(t.pnl)}  |  ${toIST(t.executed_at)}`);
  }

  const netQty = totalBuyQty - totalSellQty;
  const avgSell = totalSellQty > 0 ? totalSellVal / totalSellQty : 0;
  const avgBuy  = totalBuyQty  > 0 ? totalBuyVal  / totalBuyQty  : 0;
  const unrealPnl = netQty < 0
    ? (avgSell - bnfCmp) * Math.abs(netQty)
    : (bnfCmp - avgBuy)  * netQty;

  console.log(`\n  Total BUY  : ${totalBuyQty} qty @ avg ₹${fmt(avgBuy)}`);
  console.log(`  Total SELL : ${totalSellQty} qty @ avg ₹${fmt(avgSell)}`);
  console.log(`  Net Open   : ${netQty} (${netQty < 0 ? 'SHORT' : 'LONG'})`);
  console.log(`  CMP        : ₹${fmt(bnfCmp)}`);
  console.log(`  Unrealised : ₹${fmt(unrealPnl)}  ${unrealPnl >= 0 ? '✅' : '🔴'}`);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
