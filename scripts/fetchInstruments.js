require('dotenv').config();
const mongoose = require('mongoose');
const kiteService = require('../src/services/kiteService');

async function fetchInstruments() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    console.log('   URI:', process.env.MONGO_URI ? 'Found' : 'NOT FOUND');
    
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI not found in environment variables');
    }
    
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    
    console.log('\n📊 Fetching instruments from Kite API...');
    console.log('This may take a few minutes...\n');
    
    const result = await kiteService.fetchAndStoreAllInstruments();
    
    console.log('\n✅ Success!');
    console.log(`   Total instruments: ${result.total || 'N/A'}`);
    if (result.new !== undefined) console.log(`   New: ${result.new}`);
    if (result.updated !== undefined) console.log(`   Updated: ${result.updated}`);
    if (result.exchanges && Array.isArray(result.exchanges)) {
      console.log(`   Exchanges: ${result.exchanges.join(', ')}`);
    }
    
    console.log('\nResult object:', JSON.stringify(result, null, 2));
    
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
