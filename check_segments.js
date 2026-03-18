const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stocker')
  .then(async () => {
    console.log('Connected to MongoDB\n');
    
    const KiteInstrument = require('./src/models/KiteInstrument');
    
    // Get distinct segments
    console.log('=== Available Segments ===');
    const segments = await KiteInstrument.distinct('segment');
    console.log('Segments:', segments);
    console.log('');
    
    // Get distinct exchanges
    console.log('=== Available Exchanges ===');
    const exchanges = await KiteInstrument.distinct('exchange');
    console.log('Exchanges:', exchanges);
    console.log('');
    
    // Check for MCX instruments by exchange
    console.log('=== MCX Instruments (by exchange) ===');
    const mcxByExchange = await KiteInstrument.find({ 
      exchange: 'MCX'
    }).limit(5).lean();
    
    if (mcxByExchange.length === 0) {
      console.log('No MCX instruments found by exchange');
    } else {
      mcxByExchange.forEach(inst => {
        console.log(`Symbol: ${inst.tradingsymbol}`);
        console.log(`  instrument_token: ${inst.instrument_token}`);
        console.log(`  segment: ${inst.segment}`);
        console.log(`  exchange: ${inst.exchange}`);
        console.log(`  instrument_type: ${inst.instrument_type}`);
        console.log(`  lot_size: ${inst.lot_size}`);
        console.log('');
      });
    }
    
    // Check for instruments with COPPER in name
    console.log('\n=== Instruments with COPPER ===');
    const copper = await KiteInstrument.find({
      tradingsymbol: /COPPER/i
    }).limit(3).lean();
    
    copper.forEach(inst => {
      console.log(`Symbol: ${inst.tradingsymbol}`);
      console.log(`  instrument_token: ${inst.instrument_token}`);
      console.log(`  segment: ${inst.segment}`);
      console.log(`  exchange: ${inst.exchange}`);
      console.log(`  instrument_type: ${inst.instrument_type}`);
      console.log(`  lot_size: ${inst.lot_size}`);
      console.log('');
    });
    
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
