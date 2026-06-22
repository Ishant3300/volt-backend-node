/**
 * Best-effort backfill of the SettlementHistory ledger from existing
 * soft-deleted settlement trades. Groups soft-deleted settlement-related
 * trades by (user, instrument, settlement-day) and reconstructs a snapshot.
 *
 * Idempotent: skips a (user, instrument, settlement-day) that already has a
 * ledger doc. Safe to re-run.
 *
 * Run: node scripts/backfill_settlement_history.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const KiteInstrument = require('../src/models/KiteInstrument');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const SettlementHistory = require('../src/models/SettlementHistory');

const SETTLEMENT_REMARKS = [
  'Settlement: week reset',
  'Settlement: week reset (flat position)',
  'Settlement: position closed at settlement price',
  'Settlement: position carried forward at close price',
];

function dayKey(d) {
  const x = new Date(d.getTime() + 5.5 * 3600000); // IST day bucket
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,'0')}-${String(x.getUTCDate()).padStart(2,'0')}`;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();
  const computeBrokerage = (ki, qty, price) => {
    if (!ki) return 0;
    const seg = ki.segment || ''; const rawName = ki.raw_name || ''; const lotSize = ki.lot_size || 1;
    let rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase() && r.exchange_name === seg.toUpperCase());
    if (!rule && rawName) rule = brkRules.find(r => r.script_name?.toUpperCase() === rawName.toUpperCase());
    if (!rule && seg) rule = brkRules.find(r => r.exchange_name === seg.toUpperCase() && !r.script_name);
    if (!rule) rule = brkRules.find(r => r.exchange_name === (seg.split('-')[0]||'').toUpperCase() && !r.script_name);
    if (!rule) return 0;
    if (rule.type === 'TURNOVER WISE') return Math.round(price*qty*(rule.brk_value/10000)*100)/100;
    if (rule.type === 'LOT WISE') return Math.round((lotSize>1?qty/lotSize:qty)*rule.brk_value*100)/100;
    return 0;
  };
  const buildDisplayName = (ki, fallback) => {
    if (!ki || !ki.name) return fallback;
    if (!ki.expiry) return ki.name;
    const exp = new Date(ki.expiry);
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d=exp.getDate(), m=months[exp.getMonth()];
    if (ki.instrument_type==='FUT') return `${ki.name} ${d} ${m} FUT`;
    if (ki.instrument_type==='CE'||ki.instrument_type==='PE') return `${ki.name} ${ki.strike||''} ${ki.instrument_type} ${d} ${m}`;
    return `${ki.name} ${d} ${m}`;
  };

  // All soft-deleted settlement-related trades
  const trades = await Trade.find({
    status: 'completed',
    deleted_at: { $ne: null },
    remarks: { $in: SETTLEMENT_REMARKS },
  }).sort({ executed_at: 1 }).lean();

  console.log(`Found ${trades.length} soft-deleted settlement trades.\n`);

  // Group by user :: instrument :: settlement-day (from deleted_at)
  const groups = {};
  for (const t of trades) {
    const sKey = dayKey(t.deleted_at);
    const key = `${t.user_id}::${t.instrument_token}::${sKey}`;
    if (!groups[key]) groups[key] = { sKey, settlementDate: t.deleted_at, trades: [] };
    groups[key].trades.push(t);
  }

  const tokenSet = [...new Set(trades.map(t => t.instrument_token))];
  const instr = await KiteInstrument.find({ instrument_token: { $in: tokenSet } })
    .select('instrument_token lot_size segment raw_name name expiry instrument_type strike display_name').lean();
  const instMap = {};
  instr.forEach(ki => { instMap[ki.instrument_token.toString()] = ki; });

  let created = 0, skipped = 0;
  const runIdByDay = {};

  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const fills = g.trades;
    const first = fills[0];
    const ts = first.instrument_token.toString();
    const ki = instMap[ts];

    // period_to = settlement day end (the deleted_at)
    const periodTo = g.settlementDate;

    // Idempotency: skip if a snapshot already exists for this user+instrument+day
    const dayStart = new Date(periodTo); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(periodTo); dayEnd.setHours(23,59,59,999);
    const exists = await SettlementHistory.findOne({
      user_id: first.user_id,
      instrument_token: ts,
      period_to: { $gte: dayStart, $lte: dayEnd },
    }).lean();
    if (exists) { skipped++; continue; }

    // Settlement price from any carry_forward marker in the group
    const cfMarker = fills.find(f => f.trade_type === 'carry_forward');
    const settlementPrice = cfMarker ? (cfMarker.executed_price || 0) : 0;

    // Regular fills = non-carry_forward (the actual trades during the period)
    const regularFills = fills.filter(f => f.trade_type !== 'carry_forward');
    const openingFill = fills.find(f => f.trade_type === 'carry_forward' && f.transaction_type && /carried forward/.test(f.remarks || ''));

    // Skip groups with no real trades (pure carry_forward markers carry no period activity —
    // their actual history lives in the period where the position was traded).
    if (regularFills.length === 0) { skipped++; continue; }

    let tbq=0,tbv=0,tsq=0,tsv=0, realizedPnl=0, brokerage=0;
    const fillDocs = [];
    for (const f of regularFills) {
      const q=f.executed_quantity||0, p=f.executed_price||0;
      if (f.transaction_type==='BUY'){tbq+=q;tbv+=q*p;} else {tsq+=q;tsv+=q*p;}
      realizedPnl += (f.pnl||0);
      const br = computeBrokerage(ki, q, p);
      brokerage += br;
      fillDocs.push({ transaction_type:f.transaction_type, executed_quantity:q, executed_price:p, executed_at:f.executed_at, pnl:f.pnl||0, brokerage:br, order_type:f.order_type||'MARKET', placed_by:f.placed_by||'USER', trade_type:f.trade_type||'regular' });
    }

    const avgBuy = tbq>0?tbv/tbq:0, avgSell=tsq>0?tsv/tsq:0;
    const net = tbq - tsq; const isLong = net>0; const absNet = Math.abs(net);
    const avgEntry = isLong?avgBuy:avgSell;
    const settlementPnl = (absNet>0 && settlementPrice>0) ? (isLong ? (settlementPrice-avgEntry)*absNet : (avgEntry-settlementPrice)*absNet) : 0;

    if (!runIdByDay[g.sKey]) runIdByDay[g.sKey] = new mongoose.Types.ObjectId();

    await SettlementHistory.create({
      settlement_run_id: runIdByDay[g.sKey],
      settlement_date: periodTo,
      period_from: first.executed_at,
      period_to: periodTo,
      user_id: first.user_id,
      master_id: first.master_id,
      admin_id: first.admin_id || null,
      exchange: first.exchange,
      tradingsymbol: first.tradingsymbol,
      instrument_token: ts,
      display_name: buildDisplayName(ki, first.tradingsymbol),
      opening_qty: openingFill ? (openingFill.executed_quantity||0) : 0,
      opening_price: openingFill ? (openingFill.executed_price||0) : 0,
      opening_side: openingFill ? openingFill.transaction_type : null,
      fills: fillDocs,
      total_buy_qty: tbq, total_buy_value: tbv, avg_buy_price: avgBuy,
      total_sell_qty: tsq, total_sell_value: tsv, avg_sell_price: avgSell,
      closing_qty: absNet,
      closing_side: absNet>0 ? (isLong?'SELL':'BUY') : null,
      settlement_price: settlementPrice,
      close_method: 'settlement',
      realized_pnl: realizedPnl, settlement_pnl: settlementPnl,
      total_pnl: realizedPnl+settlementPnl, brokerage,
      net_pnl: (realizedPnl+settlementPnl)-brokerage,
      carry_forward_qty: absNet,
      carry_forward_price: absNet>0?settlementPrice:0,
      carry_forward_side: absNet>0 ? (isLong?'BUY':'SELL') : null,
    });
    created++;
  }

  console.log(`\nBackfill complete: created ${created} snapshot(s), skipped ${skipped} existing.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
