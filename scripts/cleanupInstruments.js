/**
 * Cleanup KiteInstrument collection
 *
 * 1. Loads allowed raw_name values from active_instruments (UPDATED).csv
 * 2. Fetches fresh instruments from Kite API
 * 3. Filters by allowed names + nearest expiry (same logic as fetchInstruments.js)
 * 4. Deletes DB documents that don't match our logic
 * 5. Upserts new/updated instruments — preserving existing _id for matching tokens
 *
 * Safe: never touches instruments that already follow the logic.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const kiteService = require('../src/services/kiteService');
const KiteInstrument = require('../src/models/KiteInstrument');

const ACTIVE_INSTRUMENTS_CSV = path.join(__dirname, 'required_scripts', 'active_instruments (UPDATED).csv');

// ── MCX Lot Sizes ───────────────────────────────────────────────────────────
const MCX_LOT_SIZES = {
  'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDTEN': 10,
  'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
  'COPPER': 2500, 'COPPERM': 250,
  'CRUDEOIL': 100, 'CRUDEOILM': 10,
  'NATURALGAS': 1250, 'NATGASMINI': 250,
  'ALUMINIUM': 5000, 'ALUMINI': 1000,
  'ZINC': 5000, 'ZINCMINI': 1000,
  'LEAD': 5000, 'LEADMINI': 1000,
  'NICKEL': 1500, 'NICKELM': 100,
};

function getMcxLotSize(name) {
  const upper = (name || '').toUpperCase().trim();
  if (MCX_LOT_SIZES[upper] !== undefined) return MCX_LOT_SIZES[upper];
  for (const [key, size] of Object.entries(MCX_LOT_SIZES)) {
    if (upper.startsWith(key)) return size;
  }
  return null;
}

// ── Load allowed names from CSV ─────────────────────────────────────────────
function loadAllowedRawNames() {
  const csvText = fs.readFileSync(ACTIVE_INSTRUMENTS_CSV, 'utf8');
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rawNameIdx = headers.indexOf('raw_name');
  const allowedNames = new Set();
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const rawName = (values[rawNameIdx] || '').trim();
    if (rawName) allowedNames.add(rawName.toUpperCase());
  }
  return allowedNames;
}

// ── Parse Kite CSV and filter ───────────────────────────────────────────────
function parseAndFilter(csvText, allowedNames) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const instruments = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const instrument = {};
    headers.forEach((key, index) => {
      let value = values[index]?.trim() || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (['instrument_token', 'exchange_token'].includes(key)) instrument[key] = value;
      else if (['last_price', 'strike', 'tick_size'].includes(key)) instrument[key] = parseFloat(value) || 0;
      else if (key === 'lot_size') instrument[key] = parseInt(value, 10) || 1;
      else if (key === 'expiry' && value) instrument[key] = new Date(value);
      else instrument[key] = value;
    });

    const instName = (instrument.name || '').toUpperCase().trim();
    if (!allowedNames.has(instName)) continue;

    instrument.raw_name = instrument.name;
    if (instrument.exchange === 'MCX') {
      const correctLot = getMcxLotSize(instrument.name);
      if (correctLot !== null) instrument.lot_size = correctLot;
    }
    instrument.is_active = true;
    instruments.push(instrument);
  }
  return instruments;
}

// ── Nearest expiry filter ───────────────────────────────────────────────────
function filterNearestExpiry(instruments) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nearestMap = new Map();

  for (const inst of instruments) {
    if (!inst.expiry || inst.segment === 'INDICES') {
      nearestMap.set(inst.instrument_token, inst);
      continue;
    }
    const expiryDate = new Date(inst.expiry);
    if (expiryDate < today) continue;

    const rawName = (inst.raw_name || inst.name || '').toUpperCase();
    const type = (inst.instrument_type || '').toUpperCase();
    const exchange = (inst.exchange || '').toUpperCase();
    const strikeKey = (type === 'CE' || type === 'PE') ? `|${inst.strike}` : '';
    const key = `${rawName}|${exchange}|${type}${strikeKey}`;

    const existing = nearestMap.get(key);
    if (!existing) {
      nearestMap.set(key, inst);
    } else {
      if (expiryDate.getTime() < new Date(existing.expiry).getTime()) {
        nearestMap.set(key, inst);
      }
    }
  }
  return [...nearestMap.values()];
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  KITE INSTRUMENT CLEANUP');
  console.log('  Removes instruments that don\'t match our filtering logic.');
  console.log('  Preserves _id for instruments that already exist.');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allowedNames = loadAllowedRawNames();
  console.log(`📋 Loaded ${allowedNames.size} allowed instrument names.\n`);

  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected.\n');

  // ── Step 1: Fetch fresh instruments from Kite ─────────────────────────
  console.log('📊 Fetching instruments from Kite API...');
  const csvData = await kiteService.fetchInstrumentsFromKite();
  const allParsed = parseAndFilter(csvData, allowedNames);
  console.log(`   Parsed ${allParsed.length} instruments matching allowed names.`);

  const validInstruments = filterNearestExpiry(allParsed);
  console.log(`   After nearest-expiry filter: ${validInstruments.length} instruments.\n`);

  // Build a set of valid tokens (these should stay in DB)
  const validTokenSet = new Set(validInstruments.map(i => i.instrument_token));

  // Also preserve synthetic tokens (9999xxx) and GLOBAL/SGX instruments
  const preservedDocs = await KiteInstrument.find({
    $or: [
      { instrument_token: /^9999/ },
      { exchange: { $in: ['GLOBAL', 'SGX'] } },
    ]
  }).select('instrument_token').lean();
  for (const doc of preservedDocs) {
    validTokenSet.add(doc.instrument_token);
  }

  console.log(`   Total valid tokens (incl. synthetic/global): ${validTokenSet.size}\n`);

  // ── Step 2: Count what's currently in DB ──────────────────────────────
  const dbCount = await KiteInstrument.countDocuments();
  console.log(`📦 Current DB count: ${dbCount} instruments.`);

  // ── Step 3: Delete instruments NOT in valid set ───────────────────────
  console.log('\n🗑️  Deleting instruments that don\'t match our logic...');
  const deleteResult = await KiteInstrument.deleteMany({
    instrument_token: { $nin: [...validTokenSet] }
  });
  console.log(`   Deleted: ${deleteResult.deletedCount} instruments.`);

  // ── Step 4: Upsert valid instruments (preserve existing _id) ──────────
  console.log(`\n💾 Upserting ${validInstruments.length} valid instruments...`);

  const BATCH_SIZE = 500;
  let upserted = 0;
  let modified = 0;

  for (let i = 0; i < validInstruments.length; i += BATCH_SIZE) {
    const batch = validInstruments.slice(i, i + BATCH_SIZE);
    const ops = batch.map(inst => {
      const { instrument_token, lot_size, ...rest } = inst;
      const setFields = { ...rest };

      if (lot_size > 1) {
        setFields.lot_size = lot_size;
        return {
          updateOne: {
            filter: { instrument_token },
            update: { $set: setFields, $setOnInsert: { instrument_token } },
            upsert: true
          }
        };
      } else {
        return {
          updateOne: {
            filter: { instrument_token },
            update: { $set: setFields, $setOnInsert: { instrument_token, lot_size: 1 } },
            upsert: true
          }
        };
      }
    });

    const res = await KiteInstrument.bulkWrite(ops, { ordered: false });
    upserted += res.upsertedCount || 0;
    modified += res.modifiedCount || 0;

    if ((i / BATCH_SIZE) % 5 === 0 && i > 0) {
      process.stdout.write(`   Progress: ${Math.min(i + BATCH_SIZE, validInstruments.length)}/${validInstruments.length}\r`);
    }
  }

  const finalCount = await KiteInstrument.countDocuments();

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  ✅ CLEANUP COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Before: ${dbCount} instruments`);
  console.log(`   Deleted: ${deleteResult.deletedCount}`);
  console.log(`   Upserted (new): ${upserted}`);
  console.log(`   Updated (existing): ${modified}`);
  console.log(`   After: ${finalCount} instruments`);

  await mongoose.connection.close();
  console.log('\n🔌 Disconnected from MongoDB.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  mongoose.connection.close().catch(() => {});
  process.exit(1);
});
