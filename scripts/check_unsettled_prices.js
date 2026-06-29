/**
 * Check why chitra13's 62 CE/PE trades didn't get settled.
 * Looks up their instrument_tokens in KiteInstrument to see if last_price > 0.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const KiteInstrument = require('../src/models/KiteInstrument');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: 'chitra13' }).lean();

  const active = await Trade.find({
    user_id: user._id, status: 'completed', deleted_at: null,
    trade_type: { $nin: ['carry_forward', 'margin_square_off'] }
  }).lean();

  // Get unique instrument tokens
  const tokens = [...new Set(active.map(t => t.instrument_token))];
  console.log(`chitra13 active tokens: ${tokens.length}\n`);

  for (const token of tokens) {
    const ki = await KiteInstrument.findOne({ instrument_token: token }).select('tradingsymbol last_price is_active expiry segment deleted_at').lean();
    const trades = active.filter(t => t.instrument_token === token);
    const sym = trades[0]?.tradingsymbol || 'UNKNOWN';
    if (ki) {
      const expired = ki.expiry && new Date(ki.expiry) < new Date();
      console.log(`  ${sym.padEnd(28)} token=${token.padEnd(12)} last_price=${ki.last_price || 0}  is_active=${ki.is_active}  expired=${expired}  segment=${ki.segment}  trades=${trades.length}`);
    } else {
      console.log(`  ${sym.padEnd(28)} token=${token.padEnd(12)} ❌ NOT FOUND in KiteInstrument  trades=${trades.length}`);
    }
  }

  // Also check what the settlement service's Phase 1 would find
  console.log('\n--- Settlement Phase 1 check (is_active:true, last_price > 0, deleted_at: null) ---');
  for (const token of tokens) {
    const ki = await KiteInstrument.findOne({
      instrument_token: token,
      is_active: true,
      last_price: { $gt: 0 },
      deleted_at: null,
    }).lean();
    const sym = active.find(t => t.instrument_token === token)?.tradingsymbol || 'UNKNOWN';
    console.log(`  ${sym.padEnd(28)} → ${ki ? `✅ price=${ki.last_price}` : '❌ NOT FOUND (won\'t be settled)'}`);
  }

  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
