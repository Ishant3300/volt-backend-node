/**
 * Export all active, non-expired instruments from KiteInstrument to CSV.
 * Usage: node scripts/exportActiveInstruments.js
 * Output: scripts/downloads/active_instruments.csv
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const KiteInstrument = require('../src/models/KiteInstrument');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const instruments = await KiteInstrument.find({
    is_active: true,
    $or: [
      { expiry: { $gte: today } },
      { expiry: null }
    ]
  }).lean();

  // Sort in-memory to avoid Atlas memory limit
  instruments.sort((a, b) => {
    const s = (a.segment || '').localeCompare(b.segment || '');
    if (s !== 0) return s;
    const n = (a.raw_name || '').localeCompare(b.raw_name || '');
    if (n !== 0) return n;
    const ea = a.expiry ? new Date(a.expiry).getTime() : 0;
    const eb = b.expiry ? new Date(b.expiry).getTime() : 0;
    if (ea !== eb) return ea - eb;
    return (a.strike || 0) - (b.strike || 0);
  });

  console.log(`Found ${instruments.length} active instruments`);

  // CSV header
  const fields = [
    'instrument_token', 'exchange_token', 'tradingsymbol', 'name', 'raw_name',
    'display_name', 'last_price', 'expiry', 'strike', 'tick_size', 'lot_size',
    'instrument_type', 'segment', 'exchange', 'is_active'
  ];

  const rows = [fields.join(',')];

  for (const inst of instruments) {
    const row = fields.map(f => {
      let val = inst[f];
      if (val === null || val === undefined) return '';
      if (f === 'expiry' && val) {
        const d = new Date(val);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      // Escape commas in string values
      val = String(val);
      if (val.includes(',') || val.includes('"')) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    rows.push(row.join(','));
  }

  const outDir = path.resolve(__dirname, 'downloads');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'active_instruments.csv');
  fs.writeFileSync(outPath, rows.join('\n'), 'utf8');

  console.log(`Exported to ${outPath}`);
  console.log(`Total rows: ${instruments.length}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
