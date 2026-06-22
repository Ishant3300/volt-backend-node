/**
 * chitra11 General PDF Report — Jun 15 to Jun 20, 2026
 * Regular trades in instrument tables, carry-forwards in a separate section.
 * Run: node scripts/chitra11_all_scripts.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User  = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');

function toIST(d) {
  if (!d) return 'N/A';
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const day = String(ist.getUTCDate()).padStart(2,'0');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = ist.getUTCHours();
  const min = String(ist.getUTCMinutes()).padStart(2,'0');
  const sec = String(ist.getUTCSeconds()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${day}-${months[ist.getUTCMonth()]} ${String(h).padStart(2,'0')}:${min}:${sec} ${ampm}`;
}
function fmt(n) { return Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function col(s,w,r=false){ s=String(s==null?'':s); if(s.length>w)s=s.slice(0,w); return r?s.padStart(w):s.padEnd(w); }

function displayName(ki, sym) {
  if (!ki?.name || !ki?.expiry) return sym;
  const exp = new Date(ki.expiry);
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = exp.getDate(), m = months[exp.getMonth()];
  if (ki.instrument_type === 'FUT') return `${ki.name} ${d} ${m} FUT`;
  if (ki.instrument_type === 'CE' || ki.instrument_type === 'PE') return `${ki.name} ${ki.strike} ${ki.instrument_type} ${d} ${m}`;
  return sym;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra11' }).lean();
  const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();

  const from = new Date('2026-06-15T00:00:00.000Z');
  const to   = new Date('2026-06-20T23:59:59.999Z');

  function getBrokerage(ki, qty, price) {
    const seg = ki?.segment || '';
    const rawName = ki?.raw_name || '';
    const lotSize = ki?.lot_size || 1;
    let r = brkRules.find(x => x.script_name?.toUpperCase()===rawName.toUpperCase() && x.exchange_name===seg.toUpperCase());
    if (!r) r = brkRules.find(x => x.script_name?.toUpperCase()===rawName.toUpperCase());
    if (!r) r = brkRules.find(x => x.exchange_name===seg.toUpperCase() && !x.script_name);
    if (!r) r = brkRules.find(x => x.exchange_name===(seg.split('-')[0]||'').toUpperCase() && !x.script_name);
    if (!r) return 0;
    if (r.type==='TURNOVER WISE') return Math.round(price*qty*(r.brk_value/10000)*100)/100;
    if (r.type==='LOT WISE') return Math.round((lotSize>1?qty/lotSize:qty)*r.brk_value*100)/100;
    return 0;
  }

  // ── Header ──────────────────────────────────────────────────────────────
  console.log('\n' + ' '.repeat(30) + 'General Summary Report');
  console.log('chitra11' + ' '.repeat(42) + 'From 15 Jun 2026 To 20 Jun 2026\n');

  const W = { date:19, type:6, bqty:9, sqty:9, rate:12, br:8, pnl:12 };
  const SEP = '─'.repeat(W.date+W.type+W.bqty+W.sqty+W.rate+W.br+W.pnl);
  const HDR = col('Date',W.date)+col('Type',W.type)+col('B Qty',W.bqty,true)+col('S Qty',W.sqty,true)+col('Rate',W.rate,true)+col('Br',W.br,true)+col('PnL',W.pnl,true);

  let grandPnl=0, grandBr=0;
  const carryForwards = [];

  // Scripts that have regular trades in Jun 15-20 range
  const allSyms = ['BANKNIFTY26JUNFUT','BANKNIFTY26JUN54700CE','BANKNIFTY26JUN55200CE','BANKNIFTY26JUN55300CE','FINNIFTY26JUNFUT','NIFTY26JUNFUT'];

  for (const sym of allSyms) {
    const ki = await KiteInstrument.findOne({ tradingsymbol: sym, deleted_at: null }).lean();
    const exchange = ki?.exchange || 'NFO';
    const dname = displayName(ki, sym);

    // Regular trades in Jun 15-20
    const trades = await Trade.find({
      user_id: user._id,
      tradingsymbol: sym,
      status: 'completed',
      trade_type: { $ne: 'carry_forward' },
      executed_at: { $gte: from, $lte: to },
    }).sort({ executed_at: 1 }).lean();

    // Active carry-forward (open position going into next week)
    const cfActive = await Trade.findOne({
      user_id: user._id,
      tradingsymbol: sym,
      trade_type: 'carry_forward',
      remarks: 'Settlement: position carried forward at close price',
      deleted_at: null,
    }).lean();

    // Soft-deleted CF from Jun 14 (open at start of this week)
    const cfOpen = await Trade.findOne({
      user_id: user._id,
      tradingsymbol: sym,
      trade_type: 'carry_forward',
      remarks: 'Settlement: position carried forward at close price',
      deleted_at: { $ne: null },
    }).lean();

    // Collect carry-forward entries for the CF section
    // 1. Positions open at END of period (unmatched qty from regular trades or cfActive)
    if (trades.length > 0) {
      let bq=0, bv=0, sq=0, sv=0;
      for (const t of trades) {
        if (t.transaction_type==='BUY') { bq+=t.executed_quantity; bv+=t.executed_quantity*t.executed_price; }
        else { sq+=t.executed_quantity; sv+=t.executed_quantity*t.executed_price; }
      }
      const diff = bq - sq;
      if (Math.abs(diff) > 0.001) {
        const isLong = diff > 0;
        const avgP = isLong ? (bv/bq) : (sv/sq);
        carryForwards.push({ exchange, display: dname, type: isLong?'Buy':'Sell', qty: Math.abs(diff), price: avgP, source: 'trades' });
      }
    } else if (cfOpen) {
      // Position open at start of week (CF from Jun 14), no trades during week = still open
      const isBuy = cfOpen.transaction_type === 'BUY';
      carryForwards.push({ exchange, display: dname, type: isBuy?'Buy':'Sell', qty: cfOpen.executed_quantity, price: cfOpen.executed_price, source: 'cf_open' });
    }

    // Only print instrument table if there are regular trades in range
    if (trades.length === 0) continue;

    console.log(`${exchange}  ${dname}\n`);
    console.log(HDR);
    console.log(SEP);

    let bqT=0, sqT=0, brT=0, pnlT=0;
    for (const t of trades) {
      const isBuy = t.transaction_type==='BUY';
      const br = getBrokerage(ki, t.executed_quantity, t.executed_price);
      const pnl = t.pnl || 0;
      if (isBuy) bqT+=t.executed_quantity; else sqT+=t.executed_quantity;
      brT+=br; pnlT+=pnl;
      console.log(col(toIST(t.executed_at),W.date)+col(isBuy?'Buy':'Sell',W.type)+col(isBuy?fmt(t.executed_quantity):'',W.bqty,true)+col(!isBuy?fmt(t.executed_quantity):'',W.sqty,true)+col(fmt(t.executed_price),W.rate,true)+col(fmt(br),W.br,true)+col(pnl!==0?fmt(pnl):'0.00',W.pnl,true));
    }
    console.log(SEP);
    console.log(col('Script wise total :',W.date+W.type)+col(fmt(bqT),W.bqty,true)+col(fmt(sqT),W.sqty,true)+col('',W.rate,true)+col(fmt(brT),W.br,true)+col(fmt(pnlT),W.pnl,true));
    const net = pnlT - brT;
    console.log(col('',W.date+W.type+W.bqty+W.sqty)+col('Total:',W.rate,true)+col('',W.br,true)+col(fmt(net),W.pnl,true));
    console.log(SEP+'\n');

    grandPnl+=pnlT; grandBr+=brT;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const summSEP = '─'.repeat(20+20+12+10+14);
  console.log('Summary\n');
  console.log(col('Exchange',12)+col('Script',24)+col('Total',12,true)+col('Br',10,true)+col('Net',14,true));
  console.log(summSEP);
  // Only showing BANKNIFTY FUT for summary (only script with trades)
  // Recalculate for summary row
  const bnfTrades = await Trade.find({
    user_id: user._id, tradingsymbol:'BANKNIFTY26JUNFUT', status:'completed',
    trade_type:{$ne:'carry_forward'}, executed_at:{$gte:from,$lte:to}
  }).lean();
  const bnfKi = await KiteInstrument.findOne({ tradingsymbol:'BANKNIFTY26JUNFUT', deleted_at:null }).lean();
  let sPnl=0, sBr=0;
  for (const t of bnfTrades) {
    sPnl += (t.pnl||0);
    sBr  += getBrokerage(bnfKi, t.executed_quantity, t.executed_price);
  }
  console.log(col('NFO',12)+col('BANKNIFTY 30 Jun FUT',24)+col(fmt(sPnl),12,true)+col(fmt(sBr),10,true)+col(fmt(sPnl-sBr),14,true));
  console.log(summSEP);
  console.log(col('Total',12)+col('',24)+col(fmt(sPnl),12,true)+col(fmt(sBr),10,true)+col(fmt(sPnl-sBr),14,true));
  console.log(summSEP+'\n');

  // ── Carry Forward Section ─────────────────────────────────────────────────
  if (carryForwards.length > 0) {
    const cfSEP = '─'.repeat(15+28+10+12+14);
    console.log('Carry Forward\n');
    console.log(col('Exchange',15)+col('Script',28)+col('Type',10)+col('Quantity',12,true)+col('Price',14,true));
    console.log(cfSEP);
    for (const cf of carryForwards) {
      console.log(col(cf.exchange,15)+col(cf.display,28)+col(cf.type,10)+col(fmt(cf.qty),12,true)+col(fmt(cf.price),14,true));
    }
    console.log(cfSEP);
  }

  await mongoose.disconnect();
}
run().catch(err => { console.error(err.message); process.exit(1); });
