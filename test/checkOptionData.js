/**
 * Quick script to check option chain data in database
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function checkData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const KiteInstrument = require('../src/models/KiteInstrument');

    // Check NIFTY options
    console.log('\n📊 Checking NIFTY options...');
    const niftyOptions = await KiteInstrument.find({
      tradingsymbol: /^NIFTY/,
      instrument_type: { $in: ['CE', 'PE'] },
      segment: 'NFO-OPT'
    })
    .limit(10)
    .lean();

    console.log(`Found ${niftyOptions.length} NIFTY options`);
    
    if (niftyOptions.length > 0) {
      console.log('\nSample option:');
      const sample = niftyOptions[0];
      console.log(`  Symbol: ${sample.tradingsymbol}`);
      console.log(`  Strike: ${sample.strike}`);
      console.log(`  Type: ${sample.instrument_type}`);
      console.log(`  Last Price: ${sample.last_price}`);
      console.log(`  Token: ${sample.instrument_token}`);
    }

    // Check if last_price is 0 for all
    const withPrice = niftyOptions.filter(o => o.last_price > 0);
    console.log(`\nOptions with price > 0: ${withPrice.length}/${niftyOptions.length}`);

    // Check BANKNIFTY
    console.log('\n📊 Checking BANKNIFTY options...');
    const bankNiftyOptions = await KiteInstrument.find({
      tradingsymbol: /^BANKNIFTY/,
      instrument_type: { $in: ['CE', 'PE'] },
      segment: 'NFO-OPT'
    })
    .limit(5)
    .lean();

    console.log(`Found ${bankNiftyOptions.length} BANKNIFTY options`);
    
    if (bankNiftyOptions.length > 0) {
      console.log('\nSample option:');
      const sample = bankNiftyOptions[0];
      console.log(`  Symbol: ${sample.tradingsymbol}`);
      console.log(`  Strike: ${sample.strike}`);
      console.log(`  Type: ${sample.instrument_type}`);
      console.log(`  Last Price: ${sample.last_price}`);
    }

    mongoose.disconnect();
    console.log('\n✅ Done');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkData();
