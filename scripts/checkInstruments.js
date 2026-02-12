require('dotenv').config();
const mongoose = require('mongoose');
const KiteInstrument = require('../src/models/KiteInstrument');

async function checkInstruments() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    const count = await KiteInstrument.countDocuments();
    console.log('✅ Total instruments in DB:', count);
    
    const niftyCount = await KiteInstrument.countDocuments({
      tradingsymbol: { $regex: 'NIFTY', $options: 'i' }
    });
    console.log('📊 NIFTY instruments:', niftyCount);
    
    const samples = await KiteInstrument.find({ 
      tradingsymbol: { $regex: 'NIFTY', $options: 'i' } 
    }).limit(5);
    
    console.log('\n📝 Sample NIFTY instruments:');
    samples.forEach(s => {
      console.log(`   - ${s.tradingsymbol} (${s.exchange}, ${s.instrument_type})`);
    });
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkInstruments();
