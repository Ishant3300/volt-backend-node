require('dotenv').config();
const mongoose = require('mongoose');
const kiteService = require('../src/services/kiteService');

async function testKiteService() {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    console.log('\n=== Testing Kite Service ===\n');

    // Step 1: Get login URL
    console.log('Step 1: Get Login URL');
    const loginUrl = kiteService.getLoginUrl();
    console.log('Login URL:', loginUrl);
    console.log('\nPlease visit this URL in your browser and login.');
    console.log('After login, you will be redirected to a URL with request_token parameter.');
    console.log('Copy the request_token and run: node test/generateSession.js <request_token>\n');

    // Check if we have a valid access token
    const token = await kiteService.getStoredAccessToken();
    
    if (token) {
      console.log('✓ Valid access token found:', token.substring(0, 20) + '...');

      // Step 2: Test downloading instruments
      console.log('\n\nStep 2: Downloading FUT/CE/PE instruments from NFO...');
      const downloadResult = await kiteService.fetchAndStoreAllInstruments('NFO');
      console.log('Download Result:', JSON.stringify(downloadResult, null, 2));

      // Step 3: Search for instruments
      console.log('\n\nStep 3: Searching for NIFTY instruments...');
      const searchResults = await kiteService.searchInstruments('NIFTY', 'NFO');
      console.log(`Found ${searchResults.length} instruments`);
      if (searchResults.length > 0) {
        console.log('First 3 results:');
        searchResults.slice(0, 3).forEach((inst, idx) => {
          console.log(`${idx + 1}. ${inst.tradingsymbol} (${inst.instrument_type}) - Token: ${inst.instrument_token}`);
        });
      }

      // Step 4: Get LTP for some instruments
      if (searchResults.length > 0) {
        console.log('\n\nStep 4: Getting LTP for first instrument...');
        const firstInstrument = searchResults[0];
        const instrumentKey = `${firstInstrument.exchange}:${firstInstrument.tradingsymbol}`;
        
        try {
          const quotes = await kiteService.getMarketQuotes([instrumentKey], 'ltp');
          console.log('LTP Result:', JSON.stringify(quotes, null, 2));
        } catch (error) {
          console.log('LTP Error:', error.message);
        }
      }

      // Step 5: Get profile
      console.log('\n\nStep 5: Getting Kite profile...');
      try {
        const profile = await kiteService.getProfile();
        console.log('Profile:', JSON.stringify(profile, null, 2));
      } catch (error) {
        console.log('Profile Error:', error.message);
      }

      console.log('\n\n✓ All tests completed successfully!');
    } else {
      console.log('\n⚠ No valid access token found.');
      console.log('Please complete the authentication flow first:');
      console.log('1. Visit the login URL above');
      console.log('2. After login, run: node test/generateSession.js <request_token>');
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
}

testKiteService();
