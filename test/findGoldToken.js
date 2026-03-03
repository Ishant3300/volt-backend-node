/**
 * Helper script to find the instrument token for GOLD APR 2026 FUT
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const instrumentsFile = path.join(__dirname, '../instruments.csv');

console.log('🔍 Searching for GOLD APR 2026 FUT instrument...\n');

if (!fs.existsSync(instrumentsFile)) {
  console.error('❌ instruments.csv not found!');
  console.log('   Run: node scripts/fetchInstruments.js first\n');
  process.exit(1);
}

const results = [];

fs.createReadStream(instrumentsFile)
  .pipe(csv())
  .on('data', (row) => {
    // Look for GOLD futures expiring in April 2026
    const symbol = row.tradingsymbol || row.trading_symbol || '';
    const name = row.name || '';
    const expiry = row.expiry || '';
    
    if (symbol.includes('GOLD') && symbol.includes('26APR')) {
      results.push({
        token: row.instrument_token,
        symbol: symbol,
        name: name,
        expiry: expiry,
        exchange: row.exchange,
        segment: row.segment,
        instrument_type: row.instrument_type
      });
    }
  })
  .on('end', () => {
    if (results.length === 0) {
      console.log('❌ No GOLD APR 2026 instruments found');
      console.log('\n💡 Try searching for other GOLD futures:');
      
      // Search for any GOLD instruments
      fs.createReadStream(instrumentsFile)
        .pipe(csv())
        .on('data', (row) => {
          const symbol = row.tradingsymbol || row.trading_symbol || '';
          if (symbol.includes('GOLD') && symbol.includes('FUT')) {
            console.log(`   ${symbol} - Token: ${row.instrument_token}`);
          }
        })
        .on('end', () => {
          console.log('');
        });
    } else {
      console.log('✅ Found GOLD APR 2026 instruments:\n');
      results.forEach((inst, idx) => {
        console.log(`${idx + 1}. ${inst.symbol}`);
        console.log(`   Token: ${inst.token}`);
        console.log(`   Name: ${inst.name}`);
        console.log(`   Exchange: ${inst.exchange}`);
        console.log(`   Expiry: ${inst.expiry}`);
        console.log(`   Type: ${inst.instrument_type}`);
        console.log('');
      });
      
      console.log('📝 Update testBidAsk.js with the correct token:');
      console.log(`   const GOLD_INSTRUMENT_TOKEN = ${results[0].token};\n`);
    }
  });
