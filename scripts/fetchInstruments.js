require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
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
    
    // Define the exchanges to fetch
    // NSE: National Stock Exchange (equity and indices)
    // MCX: Multi Commodity Exchange
    // NFO: NSE Futures & Options (includes CE/PE options)
    const exchanges = ['NSE', 'MCX', 'NFO'];
    
    console.log('\n📊 Fetching instruments from Kite API...');
    console.log(`   Exchanges: ${exchanges.join(', ')}`);
    console.log('This may take a few minutes...\n');
    
    // Drop the collection once at the beginning
    console.log('🗑️  Clearing existing instruments...');
    await KiteInstrument.collection.drop().catch(() => {
      console.log('   Collection does not exist, creating new one');
    });
    
    let allInstruments = [];
    const exchangeBreakdown = {};
    
    // Fetch instruments for each exchange
    for (const exchange of exchanges) {
      console.log(`\n📡 Fetching ${exchange} instruments...`);
      
      try {
        const csvData = await kiteService.fetchInstrumentsFromKite(exchange);
        const instruments = kiteService.parseInstrumentsCsv(csvData);
        
        console.log(`✅ ${exchange} parsed: ${instruments.length} instruments`);
        
        // Calculate breakdown for this exchange
        exchangeBreakdown[exchange] = {
          FUT: instruments.filter(i => i.instrument_type === 'FUT').length,
          CE: instruments.filter(i => i.instrument_type === 'CE').length,
          PE: instruments.filter(i => i.instrument_type === 'PE').length,
          EQ: instruments.filter(i => i.instrument_type === 'EQ').length,
          total: instruments.length
        };
        
        allInstruments = allInstruments.concat(instruments);
      } catch (error) {
        console.error(`❌ Error fetching ${exchange}:`, error.message);
        // Continue with next exchange even if one fails
      }
    }
    
    console.log(`\n� Storing ${allInstruments.length} total instruments...`);
    
    // Bulk insert all instruments at once
    const result = await KiteInstrument.insertMany(allInstruments, {
      ordered: false
    });
    
    const insertedCount = Array.isArray(result) ? result.length : (result.insertedCount || 0);
    
    console.log('\n✅ All exchanges fetched and stored successfully!');
    console.log(`   Total instruments: ${allInstruments.length}`);
    console.log(`   Total inserted: ${insertedCount}`);
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
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
}

fetchInstruments();
