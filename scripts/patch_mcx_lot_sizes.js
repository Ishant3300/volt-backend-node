/**
 * patch_mcx_lot_sizes.js
 *
 * One-time script to update MCX instrument lot sizes in the DB.
 * Zerodha's CSV has lot_size=1 for all MCX instruments — this patches
 * them to the correct exchange-published values.
 *
 * Run: node scripts/patch_mcx_lot_sizes.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const KiteInstrument = require('../src/models/KiteInstrument');

// MCX lot sizes — official exchange-published contract sizes
const MCX_LOT_SIZES = {
  'GOLD':        100,
  'GOLDM':       10,
  'GOLDPETAL':   1,
  'SILVER':      30000,
  'SILVERM':     5000,
  'SILVERMIC':   1000,
  'COPPER':      2500,
  'COPPERM':     250,
  'CRUDE':       100,
  'CRUDEOIL':    100,
  'CRUDEOILM':   10,
  'NATURALGAS':  1250,
  'NATGAS':      1250,
  'ALUMINIUM':   5000,
  'ALUMINIUMM':  1000,
  'ZINC':        5000,
  'ZINCM':       1000,
  'LEAD':        5000,
  'LEADM':       1000,
  'NICKEL':      1500,
  'NICKELM':     100,
  'COTTON':      25,
  'MENTHAOIL':   360,
  'CASTORSEED':  10000,
  'CARDAMOM':    100,
  'PEPPER':      1000,
  'TURMERIC':    1000,
  'JEERA':       3000,
  'DHANIYA':     1000,
};

/**
 * Get lot size for an MCX instrument by its name field.
 * Tries exact match first, then prefix match (e.g. GOLDGUINEA → GOLD).
 */
function getMcxLotSize(name) {
  const upper = (name || '').toUpperCase().trim();
  if (MCX_LOT_SIZES[upper] !== undefined) return MCX_LOT_SIZES[upper];
  // Prefix match — e.g. GOLDGUINEA matches GOLD
  for (const [key, size] of Object.entries(MCX_LOT_SIZES)) {
    if (upper.startsWith(key)) return size;
  }
  return null; // unknown — leave as-is
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const mcxInstruments = await KiteInstrument.find({
    exchange: 'MCX',
    instrument_type: { $in: ['FUT', 'CE', 'PE'] }
  }, 'instrument_token name tradingsymbol lot_size segment').lean();

  console.log(`Found ${mcxInstruments.length} MCX instruments\n`);

  const updates = [];
  const unknown = new Set();

  for (const inst of mcxInstruments) {
    const correctSize = getMcxLotSize(inst.name);
    if (correctSize === null) {
      unknown.add(inst.name);
      continue;
    }
    if (inst.lot_size !== correctSize) {
      updates.push({
        token: inst.instrument_token,
        name: inst.name,
        tradingsymbol: inst.tradingsymbol,
        old: inst.lot_size,
        new: correctSize
      });
    }
  }

  if (updates.length === 0) {
    console.log('✅ All MCX lot sizes are already correct.');
  } else {
    console.log(`Updating ${updates.length} instruments in bulk...\n`);

    // Use bulkWrite for speed
    const ops = updates.map(u => ({
      updateOne: {
        filter: { instrument_token: u.token },
        update: { $set: { lot_size: u.new } }
      }
    }));

    const result = await KiteInstrument.bulkWrite(ops, { ordered: false });
    console.log(`✅ Updated ${result.modifiedCount} instruments.`);

    // Print summary by instrument name
    const byName = {};
    updates.forEach(u => {
      if (!byName[u.name]) byName[u.name] = { old: u.old, new: u.new, count: 0 };
      byName[u.name].count++;
    });
    console.log('\nSummary:');
    Object.entries(byName).sort().forEach(([name, info]) => {
      console.log(`  ${name.padEnd(15)} ${info.old} → ${info.new}  (${info.count} instruments)`);
    });
  }

  if (unknown.size > 0) {
    console.log(`\n⚠️  Unknown MCX instrument names (not in map, lot_size unchanged):`);
    [...unknown].sort().forEach(n => console.log(`   - ${n}`));
  }

  await mongoose.disconnect();
  console.log('\n🔌 Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
