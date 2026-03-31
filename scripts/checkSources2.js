require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const KI = require('../src/models/KiteInstrument');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const indices = await KI.find(
    { segment: 'INDICES' },
    'instrument_token tradingsymbol name display_name last_price is_active'
  ).lean();
  console.log(`Found ${indices.length} INDICES instruments:`);
  indices.forEach(i => console.log(`  ${i.name} | ${i.tradingsymbol} | ${i.display_name} | LTP:${i.last_price} | active:${i.is_active}`));

  const cds = await KI.find(
    { $or: [{ exchange: 'CDS' }, { segment: 'CDS' }] },
    'instrument_token tradingsymbol name display_name last_price segment is_active'
  ).limit(20).lean();
  console.log(`\nFound ${cds.length} CDS instruments:`);
  cds.forEach(i => console.log(`  ${i.name} | ${i.tradingsymbol} | ${i.segment} | LTP:${i.last_price} | active:${i.is_active}`));

  await mongoose.disconnect();
  process.exit(0);
})();
