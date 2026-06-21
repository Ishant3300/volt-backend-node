/**
 * Restore chitra11's carry-forward trades correctly:
 *
 * 1. 5 × CE/FUT positions (Jun 14 settlement):
 *    - Inserted as soft-deleted (deleted_at = Jun 21 settlement time)
 *    - Show in last-week PDF carry-forward section (secondary CF query now
 *      includes deleted_at > fromDate), but NOT in current open positions
 *
 * 2. BANKNIFTY FUT SELL 30 @ 57,861.6 (Jun 21 / today's settlement):
 *    - Inserted as ACTIVE (deleted_at: null)
 *    - Shows in open positions AND in current-week carry-forward
 *
 * Run: node scripts/restore_chitra11_cf_v2.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');

const USER_ID   = '6a2631a783827435e0eba598';
const MASTER_ID = '6a02006d2afd266ab91b3ec4';
const ADMIN_ID  = '69dcc37cfb5426398f5b6a0a';

// Jun 14 settlement executed_at (just after settlement ran at 08:59 IST = 03:29 UTC)
const JUN14_EXEC   = new Date('2026-06-14T03:31:00.000Z');
// Jun 21 settlement time (when it was settled/deleted by today's settlement)
const JUN21_SETTLE = new Date('2026-06-21T04:11:07.139Z');
// Jun 21 settlement re-open time (from the DB we saw 09:41:07/08 IST = 04:11:07/08 UTC)
const JUN21_EXEC   = new Date('2026-06-21T04:11:08.000Z');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // ── Part 1: 5 × historical CF positions (soft-deleted) ──────────────────
  // These show in last-week reports but not as currently open positions.
  const historicalPositions = [
    { tradingsymbol: 'BANKNIFTY26JUN54700CE', token: '19352066', exchange: 'NFO', qty: 30,  price: 3143,    type: 'BUY' },
    { tradingsymbol: 'BANKNIFTY26JUN55200CE', token: '19354626', exchange: 'NFO', qty: 210, price: 2688.8,  type: 'BUY' },
    { tradingsymbol: 'BANKNIFTY26JUN55300CE', token: '19355138', exchange: 'NFO', qty: 60,  price: 2573.85, type: 'BUY' },
    { tradingsymbol: 'FINNIFTY26JUNFUT',      token: '15955714', exchange: 'NFO', qty: 22,  price: 26469,   type: 'BUY' },
    { tradingsymbol: 'NIFTY26JUNFUT',         token: '15956226', exchange: 'NFO', qty: 35,  price: 24056.9, type: 'BUY' },
  ];

  console.log('── Part 1: Historical CF positions (soft-deleted, Jun 14) ──');
  for (const pos of historicalPositions) {
    const existing = await Trade.findOne({
      user_id:      USER_ID,
      tradingsymbol: pos.tradingsymbol,
      trade_type:   'carry_forward',
      executed_at:  JUN14_EXEC,
    }).lean();
    if (existing) {
      console.log(`  ⚠️  SKIP ${pos.tradingsymbol} — already exists`);
      continue;
    }
    const doc = await Trade.create({
      user_id:           new mongoose.Types.ObjectId(USER_ID),
      master_id:         new mongoose.Types.ObjectId(MASTER_ID),
      admin_id:          new mongoose.Types.ObjectId(ADMIN_ID),
      instrument_token:  pos.token,
      tradingsymbol:     pos.tradingsymbol,
      exchange:          pos.exchange,
      transaction_type:  pos.type,
      quantity:          pos.qty,
      price:             pos.price,
      order_type:        'MARKET',
      placed_by:         'SYSTEM',
      trade_type:        'carry_forward',
      status:            'completed',
      executed_at:       JUN14_EXEC,
      executed_price:    pos.price,
      executed_quantity: pos.qty,
      pnl:               0,
      remarks:           'Settlement: position carried forward at close price',
      // Soft-deleted at today's settlement time → shows in last-week reports
      // but not in current open positions
      deleted_at:        JUN21_SETTLE,
    });
    console.log(`  ✅ ${pos.tradingsymbol.padEnd(30)} qty=${pos.qty} @ ${pos.price}  [soft-deleted]  id=${doc._id}`);
  }

  // ── Part 2: BANKNIFTY FUT SELL 30 (active, today's settlement) ──────────
  console.log('\n── Part 2: BANKNIFTY FUT carry-forward (active, Jun 21) ──');
  const bnfExisting = await Trade.findOne({
    user_id:      USER_ID,
    tradingsymbol: 'BANKNIFTY26JUNFUT',
    trade_type:   'carry_forward',
    remarks:      'Settlement: position carried forward at close price',
    deleted_at:   null,
  }).lean();
  if (bnfExisting) {
    console.log(`  ⚠️  SKIP BANKNIFTY26JUNFUT — active CF already exists (id: ${bnfExisting._id})`);
  } else {
    const doc = await Trade.create({
      user_id:           new mongoose.Types.ObjectId(USER_ID),
      master_id:         new mongoose.Types.ObjectId(MASTER_ID),
      admin_id:          new mongoose.Types.ObjectId(ADMIN_ID),
      instrument_token:  '15955458',    // BANKNIFTY26JUNFUT token
      tradingsymbol:     'BANKNIFTY26JUNFUT',
      exchange:          'NFO',
      transaction_type:  'SELL',
      quantity:          30,
      price:             57861.6,
      order_type:        'MARKET',
      placed_by:         'SYSTEM',
      trade_type:        'carry_forward',
      status:            'completed',
      executed_at:       JUN21_EXEC,
      executed_price:    57861.6,
      executed_quantity: 30,
      pnl:               0,
      remarks:           'Settlement: position carried forward at close price',
      deleted_at:        null,   // ACTIVE — shows as current open position
    });
    console.log(`  ✅ BANKNIFTY26JUNFUT SELL 30 @ 57861.6  [active]  id=${doc._id}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
