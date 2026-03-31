require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const kiteService = require('../src/services/kiteService');
const KiteInstrument = require('../src/models/KiteInstrument');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// Allowed exchanges for derivatives (FUT, CE, PE)
const ALLOWED_EXCHANGES = ['BFO', 'NFO', 'MCX'];

// ══════════════════════════════════════════════════════════════════════════════
// MCX LOT SIZES — from official MCX contract specifications table
// MT values converted to KG (1 MT = 1000 KG)
// Zerodha's CSV has lot_size=1 for all MCX instruments; we override here.
// ══════════════════════════════════════════════════════════════════════════════
const MCX_LOT_SIZES = {
  'GOLD':        100,
  'GOLDM':       10,
  'GOLDPETAL':   1,
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

function getMcxLotSize(name) {
  const upper = (name || '').toUpperCase().trim();
  if (MCX_LOT_SIZES[upper] !== undefined) return MCX_LOT_SIZES[upper];
  for (const [key, size] of Object.entries(MCX_LOT_SIZES)) {
    if (upper.startsWith(key)) return size;
  }
  return null;
}

// Allowed instrument types for derivatives
const ALLOWED_INSTRUMENT_TYPES = ['FUT', 'CE', 'PE'];

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
  'NIFTY NEXT 50': 'Nifty Next 50'
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if instrument passes the filter criteria
 * - Derivatives (FUT, CE, PE) from BFO, NFO, MCX
 * - Global indices from INDICES segment
 */
function shouldIncludeInstrument(instrument) {
  // Include global indices
  if (instrument.segment === 'INDICES' && instrument.exchange === 'NSE') {
    return true;
  }
  
  // Include derivatives from allowed exchanges
  if (
    ALLOWED_INSTRUMENT_TYPES.includes(instrument.instrument_type) &&
    ALLOWED_EXCHANGES.includes(instrument.exchange)
  ) {
    return true;
  }
  
  return false;
}

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
      // Options: include strike price
      const strike = instrument.strike || '';
      return `${baseName} ${strike} ${instrument.instrument_type} ${expiryStr}`.trim();
    }
  }
  
  return instrument.name || instrument.tradingsymbol;
}

/**
 * Parse CSV and apply filtering + mapping
 */
function parseAndFilterInstruments(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  
  console.log('📋 CSV Headers:', headers.slice(0, 12).join(', '));
  
  const instruments = [];
  const unmappedIndices = [];
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

    // Apply filter
    if (!shouldIncludeInstrument(instrument)) {
      stats.filtered++;
      continue;
    }

    // Store raw name before mapping
    instrument.raw_name = instrument.name;
    
    // Override lot_size for MCX instruments (Zerodha CSV has lot_size=1 for all MCX)
    if (instrument.exchange === 'MCX') {
      const correctLotSize = getMcxLotSize(instrument.name);
      if (correctLotSize !== null) {
        instrument.lot_size = correctLotSize;
      }
    }
    
    // Generate display name
    instrument.display_name = generateDisplayName(instrument);
    
    // Track unmapped indices
    if (instrument.segment === 'INDICES' && instrument.display_name === instrument.raw_name) {
      if (!GLOBAL_INDICES_MAP[instrument.name] && !GLOBAL_INDICES_MAP[instrument.tradingsymbol]) {
        unmappedIndices.push({ name: instrument.name, symbol: instrument.tradingsymbol });
      }
    }
    
    // Set is_active flag (all newly fetched instruments are active)
    instrument.is_active = true;
    instrument.updated_at = new Date();

    // Update stats
    if (instrument.segment === 'INDICES') {
      stats.indices++;
    } else if (ALLOWED_INSTRUMENT_TYPES.includes(instrument.instrument_type)) {
      stats.derivatives[instrument.instrument_type]++;
    }
    
    const exch = instrument.exchange;
    if (!stats.byExchange[exch]) {
      stats.byExchange[exch] = { FUT: 0, CE: 0, PE: 0, INDICES: 0, total: 0 };
    }
    stats.byExchange[exch].total++;
    if (instrument.segment === 'INDICES') {
      stats.byExchange[exch].INDICES++;
    } else {
      stats.byExchange[exch][instrument.instrument_type]++;
    }

    instruments.push(instrument);
  }

  // Log unmapped indices for manual review
  if (unmappedIndices.length > 0) {
    console.log('\n⚠️  Unmapped Global Indices (need to add to GLOBAL_INDICES_MAP):');
    unmappedIndices.forEach(idx => {
      console.log(`   - "${idx.name}": "${idx.name}", // ${idx.symbol}`);
    });
  }

  return { instruments, stats, unmappedIndices };
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

// ══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ══════════════════════════════════════════════════════════════════════════════

async function fetchInstruments() {
  try {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  INSTRUMENT FETCH & SYNC');
    console.log('  Filtering: FUT, CE, PE from BFO, NFO, MCX + Global Indices');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('🔌 Connecting to MongoDB...');
    console.log('   URI:', process.env.MONGO_URI ? 'Found' : 'NOT FOUND');

    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI not found in environment variables');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
      console.log('📁 Created downloads directory');
    }

    console.log('📊 Fetching ALL instruments from Kite API...');
    console.log('   This may take a few minutes...\n');

    // Fetch all instruments
    const csvData = await kiteService.fetchInstrumentsFromKite();
    
    // Save raw CSV for reference
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const rawFilename = `raw_instruments_${timestamp}.csv`;
    const rawFilepath = path.join(downloadsDir, rawFilename);
    fs.writeFileSync(rawFilepath, csvData, 'utf8');
    console.log(`💾 Saved raw CSV: ${rawFilename}`);

    // Parse and filter instruments
    console.log('\n🔍 Parsing and filtering instruments...');
    const { instruments, stats, unmappedIndices } = parseAndFilterInstruments(csvData);
    
    // Deduplicate by token
    const uniqueInstruments = deduplicateByToken(instruments);
    
    console.log('\n📊 Filter Results:');
    console.log(`   Total in CSV: ${stats.total}`);
    console.log(`   Filtered out: ${stats.filtered}`);
    console.log(`   Kept: ${uniqueInstruments.length}`);
    console.log(`   - Derivatives: FUT=${stats.derivatives.FUT}, CE=${stats.derivatives.CE}, PE=${stats.derivatives.PE}`);
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

    // Upsert instruments — preserve existing _id for known tokens, insert new ones
    // This ensures instrument_token stays the stable key and _id never changes.
    console.log(`\n💾 Upserting ${uniqueInstruments.length} instruments (preserving existing IDs)...`);

    const BATCH_SIZE = 500;
    let upserted = 0;
    let modified = 0;

    for (let i = 0; i < uniqueInstruments.length; i += BATCH_SIZE) {
      const batch = uniqueInstruments.slice(i, i + BATCH_SIZE);
      const ops = batch.map(inst => {
        const { instrument_token, lot_size, ...rest } = inst;
        const setFields = { ...rest };

        // For new inserts: always set instrument_token + lot_size via $setOnInsert
        // For existing docs: only overwrite lot_size if incoming value > 1
        //   (preserves patched MCX lot sizes when Zerodha sends 1)
        if (lot_size > 1) {
          // Real lot size — put in $set so it updates existing docs too
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
          // Default lot_size=1 from Zerodha — only set on new inserts, don't overwrite existing
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
    // Exclude synthetic tokens (9999xxx) and GLOBAL exchange instruments (manually seeded)
    const activeTokens = uniqueInstruments.map(i => i.instrument_token);
    const deactivated = await KiteInstrument.updateMany(
      { instrument_token: { $nin: activeTokens, $not: /^9999/ }, exchange: { $ne: 'GLOBAL' }, is_active: true },
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
      if (breakdown.INDICES > 0) {
        console.log(`      Indices: ${breakdown.INDICES}`);
      }
      if (breakdown.FUT > 0 || breakdown.CE > 0 || breakdown.PE > 0) {
        console.log(`      FUT: ${breakdown.FUT}, CE: ${breakdown.CE}, PE: ${breakdown.PE}`);
      }
    }

    if (unmappedIndices.length > 0) {
      console.log(`\n⚠️  ${unmappedIndices.length} unmapped indices need manual mapping`);
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
