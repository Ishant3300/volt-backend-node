require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const KI = require('../src/models/KiteInstrument');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const r = await KI.updateMany({ exchange: 'GLOBAL', is_active: false }, { $set: { is_active: true } });
  console.log('Reactivated ' + r.modifiedCount + ' GLOBAL instruments');
  await mongoose.disconnect();
  process.exit(0);
})();
