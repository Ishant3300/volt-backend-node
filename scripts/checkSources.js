require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const KI = require('../src/models/KiteInstrument');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const names = ['SG 30', 'US 100', 'US 30', 'USDINR', 'NIFTY 50'];
  for (const n of names) {
    const r = await KI.findOne(
      { $or: [{ tradingsymbol: n }, { name: n }, { display_name: n }], is_active: true },
      'instrument_token tradingsymbol name display_name last_price segment exchange'
    ).lean();
    console.log(`${n}: ${r ? JSON.stringify(r) : 'NOT FOUND'}`);
  }
  await mongoose.disconnect();
  process.exit(0);
})();
