require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const kiteService = require('../src/services/kiteService');

(async () => {
  console.log('Fetching instruments CSV from Kite...');
  const csv = await kiteService.fetchInstrumentsFromKite();
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const targets = ['SG 30', 'US 100', 'US 30', 'USDINR', 'US 500', 'UK 100', 'JP 225', 'HK 50'];

  console.log(`\nSearching for global instruments in ${lines.length - 1} rows...\n`);

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/"/g, '').trim(); });

    const name = row.name || '';
    const symbol = row.tradingsymbol || '';

    for (const t of targets) {
      if (name === t || symbol === t || name.includes(t) || symbol.includes(t)) {
        console.log(`FOUND: name="${name}" symbol="${symbol}" exchange="${row.exchange}" segment="${row.segment}" type="${row.instrument_type}" token="${row.instrument_token}" lot=${row.lot_size}`);
      }
    }
  }
  console.log('\nDone');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
