const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/stocker')
  .then(async () => {
    console.log('Connected to MongoDB\n');
    
    const KiteInstrument = require('./src/models/KiteInstrument');
    
    // Count total instruments
    const total = await KiteInstrument.countDocuments();
    console.log(`Total instruments in collection: ${total}\n`);
    
    // Check for MCX instruments by exchange
    console.log('=== MCX Instruments (exchange = MCX) ===');
    const mcxCount = await KiteInstrument.countDocuments({ exchange: 'MCX' });
    console.log(`Total MCX instruments: ${mcxCount}\n`);
    
    if (mcxCount > 0) {
      // Get a few MCX instruments
      const mcxInstruments = await KiteInstrument.find({ 
        exchange: 'MCX'
      }).limit(5).lean();
      
      mcxInstruments.forEach(inst => {
        console.log(`Symbol: ${inst.tradingsymbol}`);
        console.log(`  instrument_token: ${inst.instrument_token}`);
        console.log(`  segment: ${inst.segment}`);
        console.log(`  exchange: ${inst.exchange}`);
        console.log(`  instrument_type: ${inst.instrument_type}`);
        console.log(`  lot_size: ${inst.lot_size}`);
        console.log('');
      });
      
      // Check for COPPER specifically
      console.log('\n=== COPPER Instruments ===');
      const copper = await KiteInstrument.find({
        exchange: 'MCX',
        tradingsymbol: /COPPER/i
      }).limit(3).lean();
      
      if (copper.length > 0) {
        copper.forEach(inst => {
          console.log(`Symbol: ${inst.tradingsymbol}`);
          console.log(`  instrument_token: ${inst.instrument_token}`);
          console.log(`  segment: ${inst.segment}`);
          console.log(`  instrument_type: ${inst.instrument_type}`);
          console.log(`  lot_size: ${inst.lot_size}`);
          console.log('');
        });
      } else {
        console.log('No COPPER instruments found');
      }
    }
    
    // Check distinct segments
    console.log('\n=== Distinct Segments ===');
    const segments = await KiteInstrument.distinct('segment');
    console.log('Segments:', segments);
    
    // Check distinct exchanges
    console.log('\n=== Distinct Exchanges ===');
    const exchanges = await KiteInstrument.distinct('exchange');
    console.log('Exchanges:', exchanges);
    
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
