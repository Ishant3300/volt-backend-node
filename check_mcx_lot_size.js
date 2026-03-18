const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stocker')
  .then(async () => {
    console.log('Connected to MongoDB\n');
    
    const KiteInstrument = require('./src/models/KiteInstrument');
    const GroupedQuantity = require('./src/models/GroupedQuantity');
    
    // Find a few MCX-OPT and MCX-FUT instruments
    console.log('=== MCX-OPT Instruments (from KiteInstrument) ===');
    const mcxOpt = await KiteInstrument.find({ 
      segment: 'MCX-OPT',
      tradingsymbol: /COPPER.*CE/i
    }).limit(3).lean();
    
    mcxOpt.forEach(inst => {
      console.log(`Symbol: ${inst.tradingsymbol}`);
      console.log(`  instrument_token: ${inst.instrument_token}`);
      console.log(`  segment: ${inst.segment}`);
      console.log(`  exchange: ${inst.exchange}`);
      console.log(`  lot_size: ${inst.lot_size}`);
      console.log('');
    });
    
    console.log('\n=== MCX-FUT Instruments (from KiteInstrument) ===');
    const mcxFut = await KiteInstrument.find({ 
      segment: 'MCX-FUT',
      tradingsymbol: /GOLD/i
    }).limit(3).lean();
    
    mcxFut.forEach(inst => {
      console.log(`Symbol: ${inst.tradingsymbol}`);
      console.log(`  instrument_token: ${inst.instrument_token}`);
      console.log(`  segment: ${inst.segment}`);
      console.log(`  exchange: ${inst.exchange}`);
      console.log(`  lot_size: ${inst.lot_size}`);
      console.log('');
    });
    
    // Check GroupedQuantity for MCX instruments
    console.log('\n=== GroupedQuantity for MCX ===');
    const grouped = await GroupedQuantity.find({
      exchange_name: { $in: ['MCX-OPT', 'MCX-FUT', 'MCX'] },
      deleted_at: null
    }).limit(5).lean();
    
    if (grouped.length === 0) {
      console.log('No MCX entries found in GroupedQuantity');
    } else {
      grouped.forEach(g => {
        console.log(`Exchange: ${g.exchange_name}, Lot: ${g.lot_name}`);
        console.log(`  Symbol: ${g.instrument_symbol}`);
        console.log(`  instrument_id: ${g.instrument_id}`);
        console.log(`  lot_size: ${g.lot_size}`);
        console.log(`  max_qty: ${g.max_qty}`);
        console.log('');
      });
    }
    
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
