const mongoose = require('mongoose');
require('dotenv').config();

/**
 * Fix MCX lot sizes in KiteInstrument collection
 * 
 * Problem: Zerodha's instruments CSV has lot_size = 1 for MCX instruments
 * Reality: MCX trading lot size is 100 (1 LOT = 100 QTY)
 * 
 * This script updates all MCX-FUT and MCX-OPT instruments to have lot_size = 100
 */

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/stocker')
  .then(async () => {
    console.log('Connected to MongoDB\n');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  MCX LOT SIZE FIX');
    console.log('  Updating all MCX instruments to lot_size = 100');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const KiteInstrument = require('./src/models/KiteInstrument');
    
    // Count MCX instruments before fix
    const mcxCount = await KiteInstrument.countDocuments({ 
      exchange: 'MCX',
      segment: { $in: ['MCX-FUT', 'MCX-OPT'] }
    });
    console.log(`Found ${mcxCount} MCX instruments (MCX-FUT + MCX-OPT)\n`);
    
    // Show some examples before fix
    console.log('=== Before Fix (Sample) ===');
    const beforeSamples = await KiteInstrument.find({ 
      exchange: 'MCX',
      segment: { $in: ['MCX-FUT', 'MCX-OPT'] }
    }).limit(3).lean();
    
    beforeSamples.forEach(inst => {
      console.log(`${inst.tradingsymbol} (${inst.segment}): lot_size = ${inst.lot_size}`);
    });
    
    // Update all MCX instruments
    console.log('\n🔧 Updating lot_size to 100 for all MCX instruments...');
    const result = await KiteInstrument.updateMany(
      { 
        exchange: 'MCX',
        segment: { $in: ['MCX-FUT', 'MCX-OPT'] }
      },
      { 
        $set: { 
          lot_size: 100,
          updated_at: new Date()
        } 
      }
    );
    
    console.log(`✅ Updated ${result.modifiedCount} instruments\n`);
    
    // Show some examples after fix
    console.log('=== After Fix (Sample) ===');
    const afterSamples = await KiteInstrument.find({ 
      exchange: 'MCX',
      segment: { $in: ['MCX-FUT', 'MCX-OPT'] }
    }).limit(3).lean();
    
    afterSamples.forEach(inst => {
      console.log(`${inst.tradingsymbol} (${inst.segment}): lot_size = ${inst.lot_size}`);
    });
    
    // Verify COPPER specifically
    console.log('\n=== COPPER Instruments (Verification) ===');
    const copper = await KiteInstrument.find({
      exchange: 'MCX',
      tradingsymbol: /COPPER/i
    }).limit(3).lean();
    
    copper.forEach(inst => {
      console.log(`${inst.tradingsymbol}: lot_size = ${inst.lot_size} ✅`);
    });
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ✅ FIX COMPLETE');
    console.log(`  Updated ${result.modifiedCount} MCX instruments`);
    console.log('  All MCX-FUT and MCX-OPT now have lot_size = 100');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
