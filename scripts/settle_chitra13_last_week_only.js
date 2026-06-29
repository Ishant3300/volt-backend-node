/**
 * Settle ONLY chitra13's last-week trades (executed BEFORE Jun 29).
 * Jun 29 trades stay active (they're this week's live trades).
 * Run: node scripts/settle_chitra13_last_week_only.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const KiteInstrument = require('../src/models/KiteInstrument');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra13' }).lean();
  console.log(`chitra13: credits=${user.credits}, settled_pnl=${user.settled_pnl}\n`);

  // Only trades BEFORE Jun 29 (last week = Jun 22-28)
  const cutoff = new Date('2026-06-29T00:00:00.000Z'); // midnight Jun 29 UTC = 05:30 IST

  const lastWeek = await Trade.find({
    user_id: user._id, status: 'completed', deleted_at: null,
    trade_type: { $nin: ['carry_forward', 'margin_square_off'] },
    executed_at: { $lt: cutoff },
  }).sort({ executed_at: 1 }).lean();

  const thisWeek = await Trade.find({
    user_id: user._id, status: 'completed', deleted_at: null,
    trade_type: { $nin: ['carry_forward', 'margin_square_off'] },
    executed_at: { $gte: cutoff },
  }).lean();

  console.log(`Last week trades (before Jun 29): ${lastWeek.length}`);
  console.log(`This week trades (Jun 29+): ${thisWeek.length} — these STAY ACTIVE\n`);

  if (lastWeek.length === 0) {
    console.log('Nothing to settle from last week.');
    await mongoose.disconnect();
    return;
  }

  // Group last-week trades by instrument
  const groups = {};
  for (const t of lastWeek) {
    const key = t.instrument_token;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  const brkRules = await BrokerageSettings.find({ deleted_at: null }).lean();
  const tokens = Object.keys(groups);
  const kiDocs = await KiteInstrument.find({ instrument_token: { $in: tokens } })
    .select('instrument_token lot_size segment raw_name name expiry instrument_type strike').lean();
  const kiMap = {};
  kiDocs.forEach(ki => { kiMap[ki.instrument_token.toString()] = ki; });

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

  const settlementRunId = new mongoose.Types.ObjectId();
  const settlementDate = new Date('2026-06-29T02:14:36.000Z'); // match the real settlement time
  let totalNetPnl = 0;
  const snapshots = [];
  const tradeIdsToDelete = [];

  for (const [token, fills] of Object.entries(groups)) {
    let buyQty = 0, sellQty = 0;
    for (const f of fills) {
      if (f.transaction_type === 'BUY') buyQty += f.executed_quantity;
      else sellQty += f.executed_quantity;
    }
    const netQty = buyQty - sellQty;
    if (Math.abs(netQty) > 0.001) {
      console.log(`  ⚠️ SKIP ${fills[0].tradingsymbol} — not flat (net=${netQty}), needs settlement price`);
      continue;
    }

    const ki = kiMap[token];
    let realizedPnl = 0, brokerage = 0;
    const fillDocs = [];
    for (const f of fills) {
      const q = f.executed_quantity || 0, p = f.executed_price || 0;
      realizedPnl += (f.pnl || 0);
      const br = computeBrokerage(ki, q, p);
      brokerage += br;
      fillDocs.push({
        transaction_type: f.transaction_type, executed_quantity: q, executed_price: p,
        executed_at: f.executed_at, pnl: f.pnl || 0, brokerage: br,
        order_type: f.order_type || 'MARKET', placed_by: f.placed_by || 'USER', trade_type: f.trade_type || 'regular',
      });
      tradeIdsToDelete.push(f._id);
    }

    const netPnl = realizedPnl - brokerage;
    totalNetPnl += netPnl;

    const displayName = ki?.name
      ? (ki.instrument_type === 'FUT' ? `${ki.name} FUT` : `${ki.name} ${ki.strike||''} ${ki.instrument_type||''}`.trim())
      : fills[0].tradingsymbol;

    snapshots.push({
      settlement_run_id: settlementRunId, settlement_date: settlementDate,
      period_from: fills[0].executed_at, period_to: settlementDate,
      user_id: user._id, master_id: fills[0].master_id, admin_id: fills[0].admin_id || null,
      exchange: fills[0].exchange, tradingsymbol: fills[0].tradingsymbol, instrument_token: token,
      display_name: displayName,
      opening_qty: 0, opening_price: 0, opening_side: null, fills: fillDocs,
      total_buy_qty: buyQty, total_buy_value: fills.filter(f=>f.transaction_type==='BUY').reduce((s,f)=>s+(f.executed_quantity*f.executed_price),0),
      avg_buy_price: buyQty>0 ? fills.filter(f=>f.transaction_type==='BUY').reduce((s,f)=>s+(f.executed_quantity*f.executed_price),0)/buyQty : 0,
      total_sell_qty: sellQty, total_sell_value: fills.filter(f=>f.transaction_type==='SELL').reduce((s,f)=>s+(f.executed_quantity*f.executed_price),0),
      avg_sell_price: sellQty>0 ? fills.filter(f=>f.transaction_type==='SELL').reduce((s,f)=>s+(f.executed_quantity*f.executed_price),0)/sellQty : 0,
      closing_qty: 0, closing_side: null, settlement_price: 0, close_method: 'flat_position',
      realized_pnl: realizedPnl, settlement_pnl: 0, total_pnl: realizedPnl, brokerage, net_pnl: netPnl,
      carry_forward_qty: 0, carry_forward_price: 0, carry_forward_side: null,
    });

    console.log(`  ✅ ${fills[0].tradingsymbol.padEnd(28)} ${fills.length} trades → netPnl=${netPnl.toFixed(2)}`);
  }

  if (snapshots.length === 0) {
    console.log('\nNo flat last-week positions to settle.');
    await mongoose.disconnect();
    return;
  }

  // Write ledger
  await SettlementHistory.insertMany(snapshots, { ordered: true });
  console.log(`\n✅ Wrote ${snapshots.length} ledger snapshot(s).`);

  // Absorb P&L into settled_pnl
  const roundedPnl = Math.round(totalNetPnl * 100) / 100;
  await User.findByIdAndUpdate(user._id, { $inc: { settled_pnl: roundedPnl } });
  console.log(`✅ settled_pnl += ${roundedPnl}`);

  // Soft-delete ONLY last-week trades
  const delResult = await Trade.updateMany(
    { _id: { $in: tradeIdsToDelete } },
    { $set: { deleted_at: settlementDate, remarks: 'Settlement: week reset (flat position)' } }
  );
  console.log(`✅ Soft-deleted ${delResult.modifiedCount} last-week trade(s).`);

  // Verify
  const finalUser = await User.findById(user._id).lean();
  const remaining = await Trade.countDocuments({ user_id: user._id, status: 'completed', deleted_at: null });
  console.log(`\nFinal: credits=${finalUser.credits}, settled_pnl=${finalUser.settled_pnl}, active_trades=${remaining}`);
  console.log(`Expected: active_trades=4 (the 2 Jun-29 scripts × 2 fills each)`);

  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
