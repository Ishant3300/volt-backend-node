/**
 * Seed BHUJ NIFTY synthetic instrument into KiteInstrument collection.
 * Run: node scripts/seedBhujNifty.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const KiteInstrument = require('../src/models/KiteInstrument');

const BHUJ_NIFTY_TOKEN = '9999999'; // Synthetic token — must not collide with real Kite tokens

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const existing = await KiteInstrument.findOne({ instrument_token: BHUJ_NIFTY_TOKEN });
  if (existing) {
    console.log('BHUJ NIFTY already exists, updating...');
    existing.tradingsymbol = 'BHUJ NIFTY';
    existing.name = 'BHUJ NIFTY';
    existing.raw_name = 'BHUJ NIFTY';
    existing.display_name = 'Bhuj Nifty';
    existing.instrument_type = 'EQ';
    existing.segment = 'SGX';
    existing.exchange = 'SGX';
    existing.lot_size = 1;
    existing.is_active = true;
    await existing.save();
    console.log('Updated BHUJ NIFTY');
  } else {
    await KiteInstrument.create({
      instrument_token: BHUJ_NIFTY_TOKEN,
      exchange_token: BHUJ_NIFTY_TOKEN,
      tradingsymbol: 'BHUJ NIFTY',
      name: 'BHUJ NIFTY',
      raw_name: 'BHUJ NIFTY',
      display_name: 'Bhuj Nifty',
      last_price: 0,
      expiry: null,
      strike: 0,
      tick_size: 0.05,
      lot_size: 1,
      instrument_type: 'EQ',
      segment: 'SGX',
      exchange: 'SGX',
      is_active: true,
    });
    console.log('Created BHUJ NIFTY');
  }

  await mongoose.disconnect();
  console.log('Done');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
