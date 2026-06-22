/**
 * Outputs chitra11's BANKNIFTY FUT data in Live M2M Report table format.
 * Run: node scripts/chitra11_live_m2m_table.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');

function toIST(d) {
  if (!d) return 'N/A';
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const day = String(ist.getUTCDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = months[ist.getUTCMonth()];
  let h = ist.getUTCHours();
  const min = String(ist.getUTCMinutes()).padStart(2,'0');
  const sec = String(ist.getUTCSeconds()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${day}-${mon} ${String(h).padStart(2,'0')}:${min}:${sec} ${ampm}`;
}
function fmt(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function col(s, w, right=false) {
  s = String(s == null ? '' : s);
  if (s.length > w) s = s.slice(0, w);
  return right ? s.padStart(w) : s.padEnd(w);
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra11' }).lean();

  const from = new Date('2026-06-15T00:00:00.000Z');
  const to   = new Date('2026-06-20T23:59:59.999Z');

  const trades = await Trade.find({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    status: 'completed',
    trade_type: { $ne: 'carry_forward' },
    executed_at: { $gte: from, $lte: to },
  }).sort({ executed_at: 1 }).lean();

  const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();
  const ki = await KiteInstrument.findOne({ tradingsymbol: 'BANKNIFTY26JUNFUT', deleted_at: null }).lean();
  const seg = ki?.segment || 'NFO-FUT';
  const rawName = ki?.raw_name || 'BANKNIFTY';
  const lotSize = ki?.lot_size || 1;

  function getBrokerage(qty, price) {
    let rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!rule) rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!rule) rule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
    if (!rule) rule = brkRules.find(r => r.exchange_name === (seg.split('-')[0]||'').toUpperCase() && !r.script_name);
    if (!rule) return 0;
    if (rule.type === 'TURNOVER WISE') return Math.round(price * qty * (rule.brk_value / 10000) * 100) / 100;
    if (rule.type === 'LOT WISE') return Math.round((lotSize > 1 ? qty / lotSize : qty) * rule.brk_value * 100) / 100;
    return 0;
  }

  const cfTrade = await Trade.findOne({
    user_id: user._id,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    trade_type: 'carry_forward',
    remarks: 'Settlement: position carried forward at close price',
    deleted_at: null,
  }).lean();

  const W = { date:19, type:6, bqty:9, sqty:9, rate:12, br:8, pnl:12 };
  const SEP = '─'.repeat(W.date+W.type+W.bqty+W.sqty+W.rate+W.br+W.pnl);

  console.log('\n' + ' '.repeat(22) + 'Live M2M Report');
  console.log('chitra11' + ' '.repeat(40) + 'From 15 Jun 2026 To 20 Jun 2026');
  console.log('\n' + ' '.repeat(18) + 'NFO  BANKNIFTY 30 Jun FUT\n');
  console.log(col('Date',W.date)+col('Type',W.type)+col('B Qty',W.bqty,true)+col('S Qty',W.sqty,true)+col('Rate',W.rate,true)+col('Br',W.br,true)+col('PnL',W.pnl,true));
  console.log(SEP);

  let totalBQty=0, totalSQty=0, totalBr=0, totalPnl=0;

  for (const t of trades) {
    const isBuy = t.transaction_type === 'BUY';
    const bqty = isBuy ? fmt(t.executed_quantity) : '';
    const sqty = !isBuy ? fmt(t.executed_quantity) : '';
    const br = getBrokerage(t.executed_quantity, t.executed_price);
    const pnl = t.pnl || 0;
    if (isBuy) totalBQty += t.executed_quantity; else totalSQty += t.executed_quantity;
    totalBr += br; totalPnl += pnl;
    console.log(col(toIST(t.executed_at),W.date)+col(isBuy?'Buy':'Sell',W.type)+col(bqty,W.bqty,true)+col(sqty,W.sqty,true)+col(fmt(t.executed_price),W.rate,true)+col(fmt(br),W.br,true)+col(pnl!==0?fmt(pnl):'0.00',W.pnl,true));
  }

  if (cfTrade) {
    const isLiveSell = cfTrade.transaction_type === 'SELL';
    const lq = cfTrade.executed_quantity;
    if (isLiveSell) totalSQty += lq; else totalBQty += lq;
    console.log(col(toIST(cfTrade.executed_at),W.date)+col('LIVE',W.type)+col(!isLiveSell?fmt(lq):'',W.bqty,true)+col(isLiveSell?fmt(lq):'',W.sqty,true)+col(fmt(cfTrade.executed_price),W.rate,true)+col('-',W.br,true)+col('0.00',W.pnl,true));
  }

  console.log(SEP);
  console.log(col('Script wise total :',W.date+W.type)+col(fmt(totalBQty),W.bqty,true)+col(fmt(totalSQty),W.sqty,true)+col('',W.rate,true)+col(fmt(totalBr),W.br,true)+col(fmt(totalPnl),W.pnl,true));
  const netPnl = totalPnl - totalBr;
  console.log(col('',W.date+W.type+W.bqty+W.sqty)+col('Total:',W.rate,true)+col('',W.br,true)+col(fmt(netPnl),W.pnl,true));
  console.log(SEP);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
