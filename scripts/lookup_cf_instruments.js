/**
 * Step 1: Look up instrument tokens, current settlement prices (last_price),
 * and chitra11's master_id / admin_id needed for re-insertion.
 * Run: node scripts/lookup_cf_instruments.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade    = require('../src/models/Trade');
const User     = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra11' }).lean();
  console.log(`User: ${user.username} | _id: ${user._id}\n`);

  // Pull master_id / admin_id from any existing trade for this user
  const sampleTrade = await Trade.findOne({ user_id: user._id, status: 'completed' }).lean();
  if (!sampleTrade) { console.log('No trades found for chitra11'); process.exit(1); }
  console.log(`master_id : ${sampleTrade.master_id}`);
  console.log(`admin_id  : ${sampleTrade.admin_id}\n`);

  // Symbols we need to re-insert
  const symbols = [
    'BANKNIFTY26JUN54700CE',
    'BANKNIFTY26JUN55200CE',
    'BANKNIFTY26JUN55300CE',
    'FINNIFTY26JUNFUT',
    'NIFTY26JUNFUT',
  ];

  console.log('=== KiteInstrument lookup ===');
  for (const sym of symbols) {
    const ki = await KiteInstrument.findOne({ tradingsymbol: sym, deleted_at: null }).lean();
    if (!ki) {
      console.log(`  ❌ ${sym.padEnd(30)} NOT FOUND in KiteInstrument`);
    } else {
      console.log(`  ✅ ${sym.padEnd(30)} token=${ki.instrument_token.toString().padEnd(12)} exchange=${ki.exchange.padEnd(6)} last_price=${ki.last_price}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
