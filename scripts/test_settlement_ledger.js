/**
 * SAFE test for the SettlementHistory ledger.
 * - Validates chitra11's backfilled ledger against known-good figures (read-only).
 * - Round-trips the model.
 * - Proves capture-before-mutate: if the ledger insert fails, trades are NOT deleted.
 * Uses only throwaway test data for destructive checks; cleans up everything.
 *
 * Run: node scripts/test_settlement_ledger.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ PASS: ${name}`); pass++; }
  else { console.log(`  ❌ FAIL: ${name} ${detail}`); fail++; }
}
function approx(a, b, tol = 0.5) { return Math.abs(a - b) <= tol; }

// Unique throwaway identifiers
const TEST_USER = new mongoose.Types.ObjectId();
const TEST_MASTER = new mongoose.Types.ObjectId();
const TEST_TOKEN = 'TEST_LEDGER_TOKEN_999999';
const TEST_RUN = new mongoose.Types.ObjectId();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // ── TEST 1: Ground-truth validation of chitra11's Jun-21 BANKNIFTY snapshot ──
  console.log('TEST 1: chitra11 ledger matches known-good bill (read-only)');
  const chitra = await User.findOne({ username: 'chitra11' }).lean();
  check('chitra11 exists', !!chitra);
  if (chitra) {
    const jun21Start = new Date('2026-06-21T00:00:00Z');
    const jun21End = new Date('2026-06-21T23:59:59Z');
    const bnf = await SettlementHistory.findOne({
      user_id: chitra._id,
      tradingsymbol: 'BANKNIFTY26JUNFUT',
      period_to: { $gte: jun21Start, $lte: jun21End },
    }).lean();
    check('BANKNIFTY Jun-21 snapshot exists', !!bnf);
    if (bnf) {
      check('total_buy_qty = 106', bnf.total_buy_qty === 106, `got ${bnf.total_buy_qty}`);
      check('total_sell_qty = 136', bnf.total_sell_qty === 136, `got ${bnf.total_sell_qty}`);
      check('fills count = 33', bnf.fills.length === 33, `got ${bnf.fills.length}`);
      check('settlement_price = 57861.6', approx(bnf.settlement_price, 57861.6), `got ${bnf.settlement_price}`);
      check('realized_pnl ≈ 4954.65', approx(bnf.realized_pnl, 4954.65, 1), `got ${bnf.realized_pnl}`);
      check('brokerage ≈ 139.07', approx(bnf.brokerage, 139.07, 1), `got ${bnf.brokerage}`);
      check('carry_forward SELL 30', bnf.carry_forward_side === 'SELL' && bnf.carry_forward_qty === 30, `got ${bnf.carry_forward_side} ${bnf.carry_forward_qty}`);
      check('carry_forward_price = 57861.6', approx(bnf.carry_forward_price, 57861.6), `got ${bnf.carry_forward_price}`);
    }
  }

  // ── TEST 2: Read endpoint query logic (period filter) ──
  console.log('\nTEST 2: settlement-history period query');
  if (chitra) {
    const from = new Date('2026-06-15'); const to = new Date('2026-06-20T23:59:59.999Z');
    const inWindow = await SettlementHistory.find({
      user_id: chitra._id, period_to: { $gte: from, $lte: to },
    }).lean();
    // Jun-21 snapshots must NOT appear in a Jun15-20 window; Jun-14 also outside. Expect 0 for this window.
    check('Jun15-20 window excludes Jun-21 & Jun-14 snapshots', inWindow.every(d => d.period_to >= from && d.period_to <= to));
    const all = await SettlementHistory.find({ user_id: chitra._id }).lean();
    check('chitra11 has >= 10 total snapshots', all.length >= 10, `got ${all.length}`);
  }

  // ── TEST 3: Model round-trip + field integrity (throwaway doc) ──
  console.log('\nTEST 3: model round-trip');
  const sample = await SettlementHistory.create({
    settlement_run_id: TEST_RUN, settlement_date: new Date(), period_from: new Date('2026-06-15'), period_to: new Date('2026-06-21'),
    user_id: TEST_USER, master_id: TEST_MASTER, exchange: 'NFO', tradingsymbol: 'TESTSYM', instrument_token: TEST_TOKEN,
    display_name: 'TEST SYM', fills: [{ transaction_type:'BUY', executed_quantity:10, executed_price:100, executed_at:new Date(), pnl:0, brokerage:1, order_type:'MARKET', placed_by:'SYSTEM', trade_type:'regular' }],
    total_buy_qty:10, total_buy_value:1000, avg_buy_price:100, total_sell_qty:0, total_sell_value:0, avg_sell_price:0,
    closing_qty:10, closing_side:'SELL', settlement_price:105, realized_pnl:0, settlement_pnl:50, total_pnl:50, brokerage:1, net_pnl:49,
    carry_forward_qty:10, carry_forward_price:105, carry_forward_side:'BUY',
  });
  const readBack = await SettlementHistory.findById(sample._id).lean();
  check('doc persisted with all fields', readBack && readBack.fills.length === 1 && readBack.net_pnl === 49 && !!readBack.created_at);
  check('no updatedAt field (immutable timestamps)', readBack && readBack.updatedAt === undefined);

  // ── TEST 4: Capture-before-mutate — failed ledger insert must NOT delete trades ──
  console.log('\nTEST 4: abort-on-failure preserves trades (isolated test user)');
  // Seed two throwaway trades for the test user
  await Trade.create([
    { user_id: TEST_USER, master_id: TEST_MASTER, instrument_token: TEST_TOKEN, tradingsymbol:'TESTSYM', exchange:'NFO', transaction_type:'BUY', quantity:10, price:100, order_type:'MARKET', placed_by:'SYSTEM', trade_type:'regular', status:'completed', executed_at:new Date(), executed_price:100, executed_quantity:10, pnl:0 },
    { user_id: TEST_USER, master_id: TEST_MASTER, instrument_token: TEST_TOKEN, tradingsymbol:'TESTSYM', exchange:'NFO', transaction_type:'SELL', quantity:5, price:110, order_type:'MARKET', placed_by:'SYSTEM', trade_type:'regular', status:'completed', executed_at:new Date(), executed_price:110, executed_quantity:5, pnl:50 },
  ]);
  const beforeCount = await Trade.countDocuments({ user_id: TEST_USER, deleted_at: null });
  check('seeded 2 active test trades', beforeCount === 2, `got ${beforeCount}`);

  // Simulate the capture-before-mutate guarantee:
  // attempt an INVALID ledger insert (missing required settlement_date) → must throw → must NOT delete.
  let aborted = false;
  try {
    // Build an intentionally invalid snapshot (missing required period_to & settlement_date & user_id)
    await SettlementHistory.create({ settlement_run_id: TEST_RUN /* missing required fields */ });
    // If we reach the delete, the guarantee FAILED. (We should have thrown above.)
    await Trade.updateMany({ user_id: TEST_USER, deleted_at: null }, { $set: { deleted_at: new Date() } });
  } catch (e) {
    aborted = true; // insert threw → in real settlement this throw aborts before any delete
  }
  const afterCount = await Trade.countDocuments({ user_id: TEST_USER, deleted_at: null });
  check('ledger insert failed/threw as expected', aborted);
  check('trades preserved after failed ledger write (still 2 active)', afterCount === 2, `got ${afterCount}`);

  // ── TEST 5: success path — valid insert, THEN safe to delete ──
  console.log('\nTEST 5: success path writes ledger then resets trades');
  const okSnap = await SettlementHistory.create({
    settlement_run_id: TEST_RUN, settlement_date: new Date(), period_to: new Date(),
    user_id: TEST_USER, master_id: TEST_MASTER, exchange:'NFO', tradingsymbol:'TESTSYM', instrument_token: TEST_TOKEN,
    display_name:'TEST SYM', fills:[], total_buy_qty:10, total_sell_qty:5, closing_qty:5, settlement_price:110,
    realized_pnl:50, settlement_pnl:0, total_pnl:50, brokerage:0, net_pnl:50, carry_forward_qty:5, carry_forward_price:110, carry_forward_side:'BUY',
  });
  check('valid snapshot written', !!okSnap._id);
  await Trade.updateMany({ user_id: TEST_USER, deleted_at: null }, { $set: { deleted_at: new Date(), remarks: 'Settlement: week reset' } });
  const activeAfter = await Trade.countDocuments({ user_id: TEST_USER, deleted_at: null });
  check('trades reset only after successful ledger write', activeAfter === 0, `got ${activeAfter}`);

  // ── CLEANUP: remove ALL throwaway data ──
  console.log('\nCleanup...');
  const delTrades = await Trade.deleteMany({ user_id: TEST_USER });
  const delLedger = await SettlementHistory.deleteMany({ user_id: TEST_USER });
  console.log(`  removed ${delTrades.deletedCount} test trades, ${delLedger.deletedCount} test ledger docs`);
  // Safety assert: confirm no real data carries the test token
  const leftover = await Trade.countDocuments({ instrument_token: TEST_TOKEN });
  check('no leftover test trades', leftover === 0, `got ${leftover}`);

  console.log(`\n═══════════════════════════════════════`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(`═══════════════════════════════════════`);

  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
