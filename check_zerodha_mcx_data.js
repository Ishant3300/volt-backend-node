const axios = require('axios');
const { promisify } = require('util');
const { gunzip: gunzipCallback } = require('zlib');
const gunzip = promisify(gunzipCallback);
require('dotenv').config();

/**
 * Check what lot_size Zerodha returns for MCX instruments
 * This will help us determine if the issue is in Zerodha's data or our interpretation
 */

async function checkZerodhaMCXData() {
  try {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  CHECKING ZERODHA MCX DATA');
    console.log('  Fetching instruments directly from Zerodha API');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Get access token from database
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/stocker');
    
    const AccessToken = require('./src/models/KiteConfig').AccessToken;
    const tokenDoc = await AccessToken.findOne({
      expires_at: { $gt: new Date() }
    }).sort({ created_at: -1 });

    if (!tokenDoc) {
      console.error('❌ No valid access token found. Please login first.');
      process.exit(1);
    }

    const accessToken = tokenDoc.access_token;
    const apiKey = process.env.KITE_API_KEY;

    console.log('✅ Found valid access token\n');
    console.log('📡 Fetching MCX instruments from Zerodha...\n');

    // Fetch MCX instruments
    const url = 'https://api.kite.trade/instruments/MCX';
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${apiKey}:${accessToken}`,
        'Accept-Encoding': 'gzip'
      },
      responseType: 'arraybuffer',
      timeout: 60000
    });

    // Handle gzipped response
    let csvData;
    if (response.headers['content-encoding'] === 'gzip') {
      const decompressed = await gunzip(response.data);
      csvData = decompressed.toString('utf8');
    } else {
      csvData = response.data.toString('utf8');
    }

    // Parse CSV
    const lines = csvData.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    
    console.log('📋 CSV Headers:', headers.join(', '));
    console.log('');

    // Find lot_size column index
    const lotSizeIndex = headers.indexOf('lot_size');
    const symbolIndex = headers.indexOf('tradingsymbol');
    const segmentIndex = headers.indexOf('segment');
    const instrumentTypeIndex = headers.indexOf('instrument_type');
    const expiryIndex = headers.indexOf('expiry');

    console.log('=== Sample MCX-FUT Instruments (GOLD) ===\n');
    
    let goldCount = 0;
    for (let i = 1; i < lines.length && goldCount < 5; i++) {
      const values = lines[i].split(',');
      const symbol = values[symbolIndex]?.trim().replace(/"/g, '');
      const segment = values[segmentIndex]?.trim().replace(/"/g, '');
      const instrumentType = values[instrumentTypeIndex]?.trim().replace(/"/g, '');
      const lotSize = values[lotSizeIndex]?.trim().replace(/"/g, '');
      const expiry = values[expiryIndex]?.trim().replace(/"/g, '');

      if (symbol && symbol.includes('GOLD') && instrumentType === 'FUT') {
        console.log(`Symbol: ${symbol}`);
        console.log(`  Segment: ${segment}`);
        console.log(`  Type: ${instrumentType}`);
        console.log(`  Expiry: ${expiry}`);
        console.log(`  LOT_SIZE from Zerodha: ${lotSize}`);
        console.log('');
        goldCount++;
      }
    }

    console.log('\n=== Sample MCX-OPT Instruments (COPPER) ===\n');
    
    let copperCount = 0;
    for (let i = 1; i < lines.length && copperCount < 5; i++) {
      const values = lines[i].split(',');
      const symbol = values[symbolIndex]?.trim().replace(/"/g, '');
      const segment = values[segmentIndex]?.trim().replace(/"/g, '');
      const instrumentType = values[instrumentTypeIndex]?.trim().replace(/"/g, '');
      const lotSize = values[lotSizeIndex]?.trim().replace(/"/g, '');
      const expiry = values[expiryIndex]?.trim().replace(/"/g, '');
      const strikeIndex = headers.indexOf('strike');
      const strike = values[strikeIndex]?.trim().replace(/"/g, '');

      if (symbol && symbol.includes('COPPER') && (instrumentType === 'CE' || instrumentType === 'PE')) {
        console.log(`Symbol: ${symbol}`);
        console.log(`  Segment: ${segment}`);
        console.log(`  Type: ${instrumentType}`);
        console.log(`  Strike: ${strike}`);
        console.log(`  Expiry: ${expiry}`);
        console.log(`  LOT_SIZE from Zerodha: ${lotSize}`);
        console.log('');
        copperCount++;
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('If lot_size = 1 from Zerodha:');
    console.log('  → Zerodha\'s CSV has lot_size = 1 for MCX');
    console.log('  → We need to manually configure 1 lot = 100 qty in our system');
    console.log('  → This is a business rule, not data from Zerodha');
    console.log('');
    console.log('If lot_size = 100 from Zerodha:');
    console.log('  → Zerodha\'s CSV already has the correct lot_size');
    console.log('  → Our database should reflect this');
    console.log('  → No manual configuration needed');
    console.log('');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

checkZerodhaMCXData();
