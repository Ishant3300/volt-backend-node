require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const kiteService = require('../src/services/kiteService');
const KiteInstrument = require('../src/models/KiteInstrument');

async function fetchInstruments() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    console.log('   URI:', process.env.MONGO_URI ? 'Found' : 'NOT FOUND');

    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI not found in environment variables');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
      console.log('📁 Created downloads directory');
    }

    console.log('\n📊 Fetching ALL instruments from Kite API...');
    console.log('This may take a few minutes...\n');
    console.log('This may take a few minutes...\n');

    // Drop the collection once at the beginning
    console.log('🗑️  Clearing existing instruments...');
    await KiteInstrument.collection.drop().catch(() => {
      console.log('   Collection does not exist, creating new one');
    });

    let allInstruments = [];
    let allCsvData = [];
    let csvHeader = '';
    const exchangeBreakdown = {};

    // Fetch all instruments at once without specifying an exchange
    console.log(`\n📡 Fetching ALL instruments...`);

    try {
      const csvData = await kiteService.fetchInstrumentsFromKite(); // No exchange passed

      // Store raw CSV data
      allCsvData = csvData.trim().split('\n');
      if (allCsvData.length > 0) {
        csvHeader = allCsvData[0];
        allCsvData = allCsvData.slice(1); // Remove header for processing
      }

      const instruments = kiteService.parseInstrumentsCsv(csvData);

      console.log(`✅ Parsed: ${instruments.length} instruments total`);

      // Calculate breakdown by exchange instead of by type since we have all now
      instruments.forEach(inst => {
        const exch = inst.exchange || 'UNKNOWN';
        if (!exchangeBreakdown[exch]) {
          exchangeBreakdown[exch] = { FUT: 0, CE: 0, PE: 0, EQ: 0, total: 0 };
        }

        exchangeBreakdown[exch].total++;
        if (inst.instrument_type === 'FUT') exchangeBreakdown[exch].FUT++;
        else if (inst.instrument_type === 'CE') exchangeBreakdown[exch].CE++;
        else if (inst.instrument_type === 'PE') exchangeBreakdown[exch].PE++;
        else if (inst.instrument_type === 'EQ') exchangeBreakdown[exch].EQ++;
      });

      allInstruments = instruments;
    } catch (error) {
      console.error(`❌ Error fetching instruments:`, error.message);
      throw error;
    }

    // Save combined CSV file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const filename = `all_instruments_${timestamp}.csv`;
    const filepath = path.join(downloadsDir, filename);

    const combinedCsv = [csvHeader, ...allCsvData].join('\n');
    fs.writeFileSync(filepath, combinedCsv, 'utf8');
    console.log(`\n💾 Saved comprehensive CSV: ${filename}`);
    console.log(`   Total rows: ${allCsvData.length}`);

    console.log(`\n💾 Storing ${allInstruments.length} total instruments...`);

    // Bulk insert all instruments at once
    const result = await KiteInstrument.insertMany(allInstruments, {
      ordered: false
    });

    const insertedCount = Array.isArray(result) ? result.length : (result.insertedCount || 0);

    console.log('\n✅ All instruments fetched and stored successfully!');
    console.log(`   Total instruments: ${allInstruments.length}`);
    console.log(`   Total inserted: ${insertedCount}`);
    console.log(`   CSV file saved: ${filepath}`);
    console.log('\n📊 Exchange Breakdown:');
    for (const [exchange, breakdown] of Object.entries(exchangeBreakdown)) {
      console.log(`   ${exchange}:`);
      console.log(`      Total: ${breakdown.total}`);
      console.log(`      FUT: ${breakdown.FUT}, CE: ${breakdown.CE}, PE: ${breakdown.PE}, EQ: ${breakdown.EQ}`);
    }

    await mongoose.connection.close();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    await mongoose.connection.close().catch(() => { });
    process.exit(1);
  }
}

fetchInstruments();
