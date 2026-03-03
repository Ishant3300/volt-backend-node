/**
 * Test script to verify historical data endpoint
 * 
 * Usage: node test/testHistoricalData.js
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000';

async function testHistoricalData() {
  try {
    console.log('🧪 Testing Historical Data Endpoint\n');

    // Test parameters
    const instrumentToken = '256265'; // NIFTY 50
    const interval = '5minute';
    const toDate = new Date().toISOString().split('T')[0]; // Today
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 7 days ago

    console.log('📊 Test Parameters:');
    console.log(`   Instrument Token: ${instrumentToken}`);
    console.log(`   Interval: ${interval}`);
    console.log(`   From: ${fromDate}`);
    console.log(`   To: ${toDate}\n`);

    // First, login as admin to get token
    console.log('🔐 Logging in as admin...');
    const loginResponse = await axios.post(`${BASE_URL}/api/auth/admin/login`, {
      username: 'admin',
      password: 'admin'
    });

    if (!loginResponse.data.success) {
      throw new Error('Login failed');
    }

    const token = loginResponse.data.data.token;
    console.log('✅ Login successful\n');

    // Test the historical data endpoint
    console.log('📡 Fetching historical data...');
    const url = `${BASE_URL}/api/kite/historical/${instrumentToken}/${interval}?from=${fromDate}&to=${toDate}`;
    console.log(`   URL: ${url}\n`);

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('✅ Response received:');
    console.log(`   Status: ${response.status}`);
    console.log(`   Success: ${response.data.success}`);
    console.log(`   Message: ${response.data.message}`);
    
    if (response.data.data && Array.isArray(response.data.data)) {
      console.log(`   Candles: ${response.data.data.length}`);
      
      if (response.data.data.length > 0) {
        console.log('\n📊 Sample candle (first):');
        console.log(JSON.stringify(response.data.data[0], null, 2));
      }
    } else {
      console.log('   Data:', response.data.data);
    }

    console.log('\n✅ Test completed successfully!');

  } catch (error) {
    console.error('\n❌ Test failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
    } else {
      console.error(`   Error: ${error.message}`);
    }
    process.exit(1);
  }
}

// Run the test
testHistoricalData();
