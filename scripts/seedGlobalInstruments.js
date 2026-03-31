/**
 * Fetch global instruments from Kite API and insert into KiteInstrument.
 * Run: node scripts/seedGlobalInstruments.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const axios = require('axios');
const KiteInstrument = require('../src/models/KiteInstrument');

const ACCESS_TOKEN = 'dFe5IE0X8VfrSwhI3aCNh4AEOELRZ2jA';
const API_KEY = process.env.KITE_API_KEY || '';

const TARGETS = ['SG 30', 'US 100', 'US 30', 'USDINR', 'US 500', 'UK 100', 'JP 225', 'HK 50', 'DE 40', 'EU 50', 'FR 40', 'AU 200', 'CN 50'];

async function run() {
  console.log('Fetching instruments CSV from Kite...');
  const url = 'https://api.kite.trade/instruments';
  const res = await axios.get(url, {
    headers: { 'Authorization': `token ${API_KEY}:${ACCESS_TOKEN}` },
    responseType: 'text',
  });

  const csv = res.data;
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  console.log(`Parsed ${lines.length - 1} instruments from Kite\n`);

  const found = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/"/g, '').trim(); });

    for (const t of TARGETS) {
      if (row.name === t || row.tradingsymbol === t) {
        found.push(row);
        console.log(`FOUND: name="${row.name}" symbol="${row.tradingsymbol}" exchange="${row.exchange}" segment="${row.segment}" type="${row.instrument_type}" token="${row.instrument_token}" lot=${row.lot_size} last_price=${row.last_price}`);
      }
    }
  }

  if (found.length === 0) {
    console.log('\nNo matching instruments found in Kite feed.');
    process.exit(0);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\nConnected to MongoDB. Inserting ${found.length} instruments...`);

  for (const row of found) {
    const doc = {
      instrument_token: row.instrument_token,
      exchange_token: row.exchange_token || row.instrument_token,
      tradingsymbol: row.tradingsymbol,
      name: row.name,
      raw_name: row.name,
      display_name: row.name,
      last_price: parseFloat(row.last_price) || 0,
      expiry: row.expiry ? new Date(row.expiry) : null,
      strike: parseFloat(row.strike) || 0,
      tick_size: parseFloat(row.tick_size) || 0.05,
      lot_size: parseInt(row.lot_size) || 1,
      instrument_type: row.instrument_type || 'IDX',
      segment: row.segment || 'INDICES',
      exchange: row.exchange || 'NSE',
      is_active: true,
    };

    const existing = await KiteInstrument.findOne({ instrument_token: doc.instrument_token });
    if (existing) {
      Object.assign(existing, doc);
      await existing.save();
      console.log(`  Updated: ${doc.name} (token ${doc.instrument_token})`);
    } else {
      await KiteInstrument.create(doc);
      console.log(`  Created: ${doc.name} (token ${doc.instrument_token})`);
    }
  }

  console.log('\nDone');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error(err.message); process.exit(1); });
