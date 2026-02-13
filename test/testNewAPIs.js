/**
 * Test file for new APIs: Option Chain and Market Depth
 * Run with: node test/testNewAPIs.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
let authToken = null;

// Test credentials - update these
const TEST_USER = {
  username: 'admin',
  password: 'admin123'
};

const TEST_ADMIN = {
  username: 'admin',
  password: 'admin'
};

/**
 * Helper function to make authenticated requests
 */
async function makeRequest(method, endpoint, data = null) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    };

    if (data) {
      config.data = data;
    }

    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response) {
      return error.response.data;
    }
    throw error;
  }
}

/**
 * Test 1: Login (try admin first, then user)
 */
async function testLogin() {
  console.log('\n🧪 Test 1: User Login');
  console.log('='.repeat(50));
  
  // Try admin login first
  let result = await makeRequest('POST', '/api/auth/admin/login', TEST_ADMIN);
  
  if (result.success && result.data && result.data.token) {
    authToken = result.data.token;
    console.log('✅ Admin login successful');
    console.log(`   Token: ${authToken.substring(0, 20)}...`);
    return true;
  }
  
  // Try regular user login
  result = await makeRequest('POST', '/api/auth/user/login', TEST_USER);
  
  if (result.success && result.data && result.data.token) {
    authToken = result.data.token;
    console.log('✅ User login successful');
    console.log(`   Token: ${authToken.substring(0, 20)}...`);
    return true;
  } else {
    console.log('❌ Login failed:', result.message || 'No error message');
    console.log('   Response:', JSON.stringify(result, null, 2));
    return false;
  }
}

/**
 * Test 2: Get Option Chain
 */
async function testOptionChain() {
  console.log('\n🧪 Test 2: Get Option Chain');
  console.log('='.repeat(50));
  
  const symbols = ['NIFTY', 'BANKNIFTY', 'RELIANCE'];
  
  for (const symbol of symbols) {
    console.log(`\n📊 Testing ${symbol}...`);
    
    const result = await makeRequest('GET', `/api/kite/option-chain/${symbol}`);
    
    if (result.success) {
      console.log(`✅ ${symbol} option chain fetched`);
      console.log(`   Strikes found: ${result.data.chain.length}`);
      
      if (result.data.chain.length > 0) {
        const sample = result.data.chain[0];
        console.log(`   Sample strike: ${sample.strike}`);
        console.log(`   Has CE: ${sample.CE ? 'Yes' : 'No'}`);
        console.log(`   Has PE: ${sample.PE ? 'Yes' : 'No'}`);
      }
    } else {
      console.log(`❌ Failed to fetch ${symbol}:`, result.message);
    }
  }
}

/**
 * Test 3: Get Option Chain with Expiry Filter
 */
async function testOptionChainWithExpiry() {
  console.log('\n🧪 Test 3: Get Option Chain with Expiry Filter');
  console.log('='.repeat(50));
  
  // Get current month's last Thursday (typical expiry)
  const now = new Date();
  const expiry = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  console.log(`\n📊 Testing NIFTY with expiry ${expiry.toISOString().split('T')[0]}...`);
  
  const result = await makeRequest(
    'GET',
    `/api/kite/option-chain/NIFTY?expiry=${expiry.toISOString().split('T')[0]}`
  );
  
  if (result.success) {
    console.log('✅ Option chain with expiry filter fetched');
    console.log(`   Strikes found: ${result.data.chain.length}`);
  } else {
    console.log('❌ Failed:', result.message);
  }
}

/**
 * Test 4: Get Market Depth
 */
async function testMarketDepth() {
  console.log('\n🧪 Test 4: Get Market Depth');
  console.log('='.repeat(50));
  
  // First, search for an instrument to get its token
  console.log('\n🔍 Searching for RELIANCE...');
  const searchResult = await makeRequest('GET', '/api/kite/instruments/search?q=RELIANCE&limit=1');
  
  if (!searchResult.success || searchResult.data.length === 0) {
    console.log('❌ Could not find instrument for testing');
    return;
  }
  
  const instrument = searchResult.data[0];
  const token = instrument.instrument_token;
  
  console.log(`✅ Found instrument: ${instrument.tradingsymbol}`);
  console.log(`   Token: ${token}`);
  
  console.log(`\n📊 Fetching market depth for token ${token}...`);
  const depthResult = await makeRequest('GET', `/api/kite/market-depth/${token}`);
  
  if (depthResult.success) {
    console.log('✅ Market depth fetched successfully');
    console.log('   Data:', JSON.stringify(depthResult.data, null, 2));
  } else {
    console.log('❌ Failed to fetch market depth:', depthResult.message);
  }
}

/**
 * Test 5: Search Instruments
 */
async function testInstrumentSearch() {
  console.log('\n🧪 Test 5: Search Instruments');
  console.log('='.repeat(50));
  
  const queries = ['NIFTY', 'BANK', 'RELIANCE'];
  
  for (const query of queries) {
    console.log(`\n🔍 Searching for "${query}"...`);
    
    const result = await makeRequest('GET', `/api/kite/instruments/search?q=${query}&limit=5`);
    
    if (result.success) {
      console.log(`✅ Found ${result.data.length} instruments`);
      result.data.forEach((inst, idx) => {
        console.log(`   ${idx + 1}. ${inst.tradingsymbol} (${inst.exchange}) - Token: ${inst.instrument_token}`);
      });
    } else {
      console.log(`❌ Search failed:`, result.message);
    }
  }
}

/**
 * Test 6: Get Watchlist
 */
async function testWatchlist() {
  console.log('\n🧪 Test 6: Get Watchlist');
  console.log('='.repeat(50));
  
  const result = await makeRequest('GET', '/api/watchlist');
  
  if (result.success) {
    console.log(`✅ Watchlist fetched: ${result.data.length} items`);
    result.data.forEach((item, idx) => {
      console.log(`   ${idx + 1}. ${item.instrument.tradingsymbol} - Token: ${item.instrument_token}`);
    });
  } else {
    console.log('❌ Failed to fetch watchlist:', result.message);
  }
}

/**
 * Test 7: Kite Authentication Status
 */
async function testKiteAuthStatus() {
  console.log('\n🧪 Test 7: Kite Authentication Status');
  console.log('='.repeat(50));
  
  const result = await makeRequest('GET', '/api/kite/auth-status');
  
  console.log('Kite Auth Status:', JSON.stringify(result, null, 2));
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('\n🚀 Starting API Tests');
  console.log('='.repeat(50));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);
  
  try {
    // Test 1: Login
    const loginSuccess = await testLogin();
    if (!loginSuccess) {
      console.log('\n❌ Login failed, cannot continue with authenticated tests');
      console.log('💡 Make sure you have a test user created');
      return;
    }
    
    // Test 2-7: Other tests
    await testInstrumentSearch();
    await testWatchlist();
    await testKiteAuthStatus();
    await testOptionChain();
    await testOptionChainWithExpiry();
    await testMarketDepth();
    
    console.log('\n✅ All tests completed!');
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    console.error(error.stack);
  }
}

// Run tests
runAllTests();
