require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const kiteService = require('../src/services/kiteService');
const KiteInstrument = require('../src/models/KiteInstrument');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// Path to the master list of allowed instruments
const ACTIVE_INSTRUMENTS_CSV = path.join(__dirname, 'required_scripts', 'active_instruments (UPDATED).csv');

// ══════════════════════════════════════════════════════════════════════════════
// MCX LOT SIZES — from official MCX contract specifications table
// MT values converted to KG (1 MT = 1000 KG)
// Zerodha's CSV has lot_size=1 for all MCX instruments; we override here.
// ══════════════════════════════════════════════════════════════════════════════
const MCX_LOT_SIZES = {
  'GOLD':        100,
  'GOLDM':       10,
  'GOLDPETAL':   1,
  'GOLDTEN':     10,
  'SILVER':      30,
  'SILVERM':     5,
  'SILVERMIC':   1,
  'COPPER':      2500,
  'COPPERM':     250,
  'CRUDE':       100,
  'CRUDEOIL':    100,
  'CRUDEOILM':   10,
  'NATURALGAS':  1250,
  'NATGAS':      1250,
  'NATGASMINI':  250,
  'ALUMINIUM':   5000,
  'ALUMINIUMM':  1000,
  'ALUMINI':     1000,
  'ZINC':        5000,
  'ZINCM':       1000,
  'ZINCMINI':    1000,
  'LEAD':        5000,
  'LEADM':       1000,
  'LEADMINI':    1000,
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

function getMcxLotSize(name) {
  const upper = (name || '').toUpperCase().trim();
  if (MCX_LOT_SIZES[upper] !== undefined) return MCX_LOT_SIZES[upper];
  for (const [key, size] of Object.entries(MCX_LOT_SIZES)) {
    if (upper.startsWith(key)) return size;
  }
  return null;
}

// Global indices name mapping for user-friendly display
const GLOBAL_INDICES_MAP = {
  'US 100': 'Nasdaq 100',
  'US 500': 'S&P 500',
  'US 30': 'Dow Jones 30',
  'UK 100': 'FTSE 100',
  'DE 40': 'DAX 40',
  'EU 50': 'Euro Stoxx 50',
  'JP 225': 'Nikkei 225',
  'HK 50': 'Hang Seng 50',
  'AU 200': 'ASX 200',
  'FR 40': 'CAC 40',
  'SG 30': 'SGX Nifty',
  'CN 50': 'FTSE China 50',
  'INDIA VIX': 'India VIX',
  'NIFTY 50': 'Nifty 50',
  'NIFTY BANK': 'Bank Nifty',
  'NIFTY FIN SERVICE': 'Nifty Financial Services',
  'NIFTY MIDCAP 50': 'Nifty Midcap 50',
  'NIFTY IT': 'Nifty IT',
  'NIFTY NEXT 50': 'Nifty Next 50',
  'GIFT NIFTY': 'Gift Nifty',
};

// ══════════════════════════════════════════════════════════════════════════════
// LOAD ALLOWED INSTRUMENTS FROM CSV
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Load the set of allowed raw_name values from the active instruments CSV.
 * Only instruments whose `name` matches one of these will be kept.
 */
function loadAllowedRawNames() {
  if (!fs.existsSync(ACTIVE_INSTRUMENTS_CSV)) {
    console.error(`❌ Active instruments CSV not found: ${ACTIVE_INSTRUMENTS_CSV}`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(ACTIVE_INSTRUMENTS_CSV, 'utf8');
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rawNameIdx = headers.indexOf('raw_name');

  if (rawNameIdx === -1) {
    console.error('❌ CSV missing "raw_name" column');
    process.exit(1);
  }

  const allowedNames = new Set();
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const rawName = (values[rawNameIdx] || '').trim();
    if (rawName) allowedNames.add(rawName.toUpperCase());
  }

  console.log(`📋 Loaded ${allowedNames.size} allowed instrument names from CSV.`);
  return allowedNames;
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Generate display name for an instrument
 */
function generateDisplayName(instrument) {
  // For global indices, use mapped name
  if (instrument.segment === 'INDICES') {
    const mappedName = GLOBAL_INDICES_MAP[instrument.name] || GLOBAL_INDICES_MAP[instrument.tradingsymbol];
    if (!mappedName) {
      console.warn(`⚠️  Unmapped global index: ${instrument.name} (${instrument.tradingsymbol})`);
    }
    return mappedName || instrument.name;
  }
  
  // For derivatives, create descriptive name
  if (['FUT', 'CE', 'PE'].includes(instrument.instrument_type)) {
    const baseName = instrument.name || instrument.tradingsymbol.split(/\d/)[0];
    const expiryStr = instrument.expiry 
      ? new Date(instrument.expiry).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      : '';
    
    if (instrument.instrument_type === 'FUT') {
      return `${baseName} FUT ${expiryStr}`.trim();
    } else {
      const strike = instrument.strike || '';
      return `${baseName} ${strike} ${instrument.instrument_type} ${expiryStr}`.trim();
    }
  }
  
  return instrument.name || instrument.tradingsymbol;
}

/**
 * Parse CSV and filter instruments based on the allowed raw_name set.
 */
function parseAndFilterInstruments(csvText, allowedNames) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  
  console.log('📋 CSV Headers:', headers.slice(0, 12).join(', '));
  
  const instruments = [];
  const stats = {
    total: 0,
    filtered: 0,
    derivatives: { FUT: 0, CE: 0, PE: 0 },
    indices: 0,
    byExchange: {}
  };

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const instrument = {};

    headers.forEach((key, index) => {
      let value = values[index]?.trim() || '';

      // Remove quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      // Type casting
      if (['instrument_token', 'exchange_token'].includes(key)) {
        instrument[key] = value;
      } else if (['last_price', 'strike', 'tick_size'].includes(key)) {
        instrument[key] = parseFloat(value) || 0;
      } else if (['lot_size'].includes(key)) {
        instrument[key] = parseInt(value, 10) || 1;
      } else if (key === 'expiry' && value) {
        instrument[key] = new Date(value);
      } else {
        instrument[key] = value;
      }
    });

    stats.total++;

    // Filter: only keep instruments whose name matches the allowed list
    const instName = (instrument.name || '').toUpperCase().trim();
    if (!allowedNames.has(instName)) {
      stats.filtered++;
      continue;
    }

    // Store raw name before mapping
    instrument.raw_name = instrument.name;
    
    // Override lot_size for MCX instruments
    if (instrument.exchange === 'MCX') {
      const correctLotSize = getMcxLotSize(instrument.name);
      if (correctLotSize !== null) {
        instrument.lot_size = correctLotSize;
      }
    }
    
    // Generate display name
    instrument.display_name = generateDisplayName(instrument);
    
    // Set is_active flag
    instrument.is_active = true;
    instrument.updated_at = new Date();

    // Update stats
    if (instrument.segment === 'INDICES') {
      stats.indices++;
    } else if (['FUT', 'CE', 'PE'].includes(instrument.instrument_type)) {
      stats.derivatives[instrument.instrument_type] = (stats.derivatives[instrument.instrument_type] || 0) + 1;
    }
    
    const exch = instrument.exchange;
    if (!stats.byExchange[exch]) {
      stats.byExchange[exch] = { FUT: 0, CE: 0, PE: 0, INDICES: 0, OTHER: 0, total: 0 };
    }
    stats.byExchange[exch].total++;
    if (instrument.segment === 'INDICES') {
      stats.byExchange[exch].INDICES++;
    } else if (stats.byExchange[exch][instrument.instrument_type] !== undefined) {
      stats.byExchange[exch][instrument.instrument_type]++;
    } else {
      stats.byExchange[exch].OTHER++;
    }

    instruments.push(instrument);
  }

  return { instruments, stats };
}

/**
 * Deduplicate instruments by token
 */
function deduplicateByToken(instruments) {
  const seen = new Map();
  const duplicates = [];
  
  for (const inst of instruments) {
    if (seen.has(inst.instrument_token)) {
      duplicates.push(inst.instrument_token);
    } else {
      seen.set(inst.instrument_token, inst);
    }
  }
  
  if (duplicates.length > 0) {
    console.log(`⚠️  Found ${duplicates.length} duplicate tokens, keeping first occurrence`);
  }
  
  return Array.from(seen.values());
}

/**
 * Keep instruments with expiry within the next 3 months for each instrument group.
 * For FUT: key = raw_name|exchange|FUT → keep all expiries within 3 months
 * For CE/PE: key = raw_name|exchange|CE|strike → keep all expiries within 3 months
 * INDICES / no expiry: always included
 *
 * Expired instruments (expiry < today) are excluded entirely.
 */
function filterNearestExpiry(instruments) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 3 months from today
  const threeMonthsLater = new Date(today);
  threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);

  const result = [];

  for (const inst of instruments) {
    // Non-expiring instruments (indices, etc.) — always include
    if (!inst.expiry || inst.segment === 'INDICES') {
      result.push(inst);
      continue;
    }

    // Skip expired instruments
    const expiryDate = new Date(inst.expiry);
    if (expiryDate < today) continue;

    // Keep if expiry is within 3 months
    if (expiryDate <= threeMonthsLater) {
      result.push(inst);
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ══════════════════════════════════════════════════════════════════════════════

async function fetchInstruments() {
  try {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  INSTRUMENT FETCH & SYNC');
    console.log('  Filtering based on: active_instruments (UPDATED).csv');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Load allowed instrument names from CSV
    const allowedNames = loadAllowedRawNames();

    console.log('🔌 Connecting to MongoDB...');
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI not found in environment variables');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    console.log('📊 Fetching ALL instruments from Kite API...');
    console.log('   This may take a few minutes...\n');

    const csvData = await kiteService.fetchInstrumentsFromKite();
    
    // Save raw CSV for reference
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const rawFilename = `raw_instruments_${timestamp}.csv`;
    const rawFilepath = path.join(downloadsDir, rawFilename);
    fs.writeFileSync(rawFilepath, csvData, 'utf8');
    console.log(`💾 Saved raw CSV: ${rawFilename}`);

    // Parse and filter instruments using the allowed names list
    console.log('\n🔍 Parsing and filtering instruments...');
    const { instruments, stats } = parseAndFilterInstruments(csvData, allowedNames);
    
    // Keep instruments with expiry within next 3 months (same window as manage instruments)
    console.log('\n📅 Filtering to next 3 months expiry...');
    const nearestExpiry = filterNearestExpiry(instruments);
    console.log(`   Before: ${instruments.length} → After: ${nearestExpiry.length} (3-month window)`);

    // Deduplicate by token
    const uniqueInstruments = deduplicateByToken(nearestExpiry);
    
    console.log('\n📊 Filter Results:');
    console.log(`   Total in CSV: ${stats.total}`);
    console.log(`   Filtered out: ${stats.filtered}`);
    console.log(`   Kept: ${uniqueInstruments.length}`);
    console.log(`   - Derivatives: FUT=${stats.derivatives.FUT || 0}, CE=${stats.derivatives.CE || 0}, PE=${stats.derivatives.PE || 0}`);
    console.log(`   - Indices: ${stats.indices}`);

    // Save filtered CSV
    const filteredFilename = `filtered_instruments_${timestamp}.csv`;
    const filteredFilepath = path.join(downloadsDir, filteredFilename);
    const filteredHeaders = Object.keys(uniqueInstruments[0] || {}).join(',');
    const filteredRows = uniqueInstruments.map(inst => 
      Object.values(inst).map(v => 
        typeof v === 'string' && v.includes(',') ? `"${v}"` : v
      ).join(',')
    );
    fs.writeFileSync(filteredFilepath, [filteredHeaders, ...filteredRows].join('\n'), 'utf8');
    console.log(`💾 Saved filtered CSV: ${filteredFilename}`);

    // Upsert instruments
    console.log(`\n💾 Upserting ${uniqueInstruments.length} instruments (preserving existing IDs)...`);

    const BATCH_SIZE = 500;
    let upserted = 0;
    let modified = 0;

    for (let i = 0; i < uniqueInstruments.length; i += BATCH_SIZE) {
      const batch = uniqueInstruments.slice(i, i + BATCH_SIZE);
      const ops = batch.map(inst => {
        const { instrument_token, lot_size, ...rest } = inst;
        const setFields = { ...rest };

        if (lot_size > 1) {
          setFields.lot_size = lot_size;
          return {
            updateOne: {
              filter: { instrument_token },
              update: {
                $set: setFields,
                $setOnInsert: { instrument_token }
              },
              upsert: true
            }
          };
        } else {
          return {
            updateOne: {
              filter: { instrument_token },
              update: {
                $set: setFields,
                $setOnInsert: { instrument_token, lot_size: 1 }
              },
              upsert: true
            }
          };
        }
      });

      const res = await KiteInstrument.bulkWrite(ops, { ordered: false });
      upserted += res.upsertedCount || 0;
      modified += res.modifiedCount || 0;

      if ((i / BATCH_SIZE) % 10 === 0) {
        process.stdout.write(`   Progress: ${Math.min(i + BATCH_SIZE, uniqueInstruments.length)}/${uniqueInstruments.length}\r`);
      }
    }

    // Mark instruments no longer in Kite's feed as inactive
    // Exclude synthetic tokens (9999xxx) and GLOBAL/SGX exchange instruments (manually seeded)
    const activeTokens = uniqueInstruments.map(i => i.instrument_token);
    const deactivated = await KiteInstrument.updateMany(
      { instrument_token: { $nin: activeTokens, $not: /^9999/ }, exchange: { $nin: ['GLOBAL', 'SGX'] }, is_active: true },
      { $set: { is_active: false } }
    );

    // Print summary
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('  ✅ SYNC COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   New instruments inserted: ${upserted}`);
    console.log(`   Existing instruments updated: ${modified}`);
    console.log(`   Instruments marked inactive: ${deactivated.modifiedCount}`);
    console.log(`   Raw CSV: ${rawFilepath}`);
    console.log(`   Filtered CSV: ${filteredFilepath}`);
    
    console.log('\n📊 Exchange Breakdown:');
    for (const [exchange, breakdown] of Object.entries(stats.byExchange)) {
      console.log(`   ${exchange}:`);
      console.log(`      Total: ${breakdown.total}`);
      if (breakdown.INDICES > 0) console.log(`      Indices: ${breakdown.INDICES}`);
      if (breakdown.FUT > 0 || breakdown.CE > 0 || breakdown.PE > 0) {
        console.log(`      FUT: ${breakdown.FUT}, CE: ${breakdown.CE}, PE: ${breakdown.PE}`);
      }
    }

    await mongoose.connection.close();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
}

fetchInstruments();
