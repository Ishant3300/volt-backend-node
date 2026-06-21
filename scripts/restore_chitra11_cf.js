/**
 * Recovery: re-insert 5 lost carry-forward positions for chitra11.
 *
 * These were deleted by the Jun 14 settlement (Phase 4) but never
 * re-created (Phase 5 silently failed due to missing master_id on the
 * manually-inserted trades).
 *
 * Uses current KiteInstrument.last_price as the settlement price
 * (Jun 14 prices are no longer recoverable from the DB).
 *
 * Run: node scripts/restore_chitra11_cf.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');

const USER_ID   = '6a2631a783827435e0eba598';
const MASTER_ID = '6a02006d2afd266ab91b3ec4';
const ADMIN_ID  = '69dcc37cfb5426398f5b6a0a';

// Timestamp: just after the Jun 14 settlement ran (08:59 IST = 03:29 UTC)
const EXEC_AT = new Date('2026-06-14T03:31:00.000Z');

// Instruments confirmed from KiteInstrument lookup
const positions = [
  { tradingsymbol: 'BANKNIFTY26JUN54700CE', token: '19352066', exchange: 'NFO', qty: 30,  price: 3143    },
  { tradingsymbol: 'BANKNIFTY26JUN55200CE', token: '19354626', exchange: 'NFO', qty: 210, price: 2688.8  },
  { tradingsymbol: 'BANKNIFTY26JUN55300CE', token: '19355138', exchange: 'NFO', qty: 60,  price: 2573.85 },
  { tradingsymbol: 'FINNIFTY26JUNFUT',      token: '15955714', exchange: 'NFO', qty: 22,  price: 26469   },
  { tradingsymbol: 'NIFTY26JUNFUT',         token: '15956226', exchange: 'NFO', qty: 35,  price: 24056.9 },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // Safety check: make sure none of these already exist (avoid duplicates)
  for (const pos of positions) {
    const existing = await Trade.findOne({
      user_id:    USER_ID,
      tradingsymbol: pos.tradingsymbol,
      trade_type: 'carry_forward',
      remarks:    'Settlement: position carried forward at close price',
      deleted_at: null,
    }).lean();
    if (existing) {
      console.log(`⚠️  SKIP ${pos.tradingsymbol} — active CF already exists (id: ${existing._id})`);
      continue;
    }

    const doc = await Trade.create({
      user_id:            new mongoose.Types.ObjectId(USER_ID),
      master_id:          new mongoose.Types.ObjectId(MASTER_ID),
      admin_id:           new mongoose.Types.ObjectId(ADMIN_ID),
      instrument_token:   pos.token,
      tradingsymbol:      pos.tradingsymbol,
      exchange:           pos.exchange,
      transaction_type:   'BUY',
      quantity:           pos.qty,
      price:              pos.price,
      order_type:         'MARKET',
      placed_by:          'SYSTEM',
      trade_type:         'carry_forward',
      status:             'completed',
      executed_at:        EXEC_AT,
      executed_price:     pos.price,
      executed_quantity:  pos.qty,
      pnl:                0,
      remarks:            'Settlement: position carried forward at close price',
      deleted_at:         null,
    });

    console.log(`✅ Inserted ${pos.tradingsymbol.padEnd(30)} qty=${pos.qty} @ ${pos.price}  id=${doc._id}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
