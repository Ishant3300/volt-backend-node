const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000/api';

// Test credentials - update these with valid credentials
const ADMIN_CREDENTIALS = {
  username: 'admin',
  password: 'admin'
};

let adminToken = '';

async function loginAsAdmin() {
  try {
    console.log('🔐 Logging in as admin...');
    const response = await axios.post(`${BASE_URL}/auth/admin/login`, ADMIN_CREDENTIALS);
    
    if (response.data.success && response.data.data.token) {
      adminToken = response.data.data.token;
      console.log('✅ Admin login successful');
      return true;
    } else {
      console.log('❌ Admin login failed:', response.data.message);
      return false;
    }
  } catch (error) {
    console.log('❌ Admin login error:', error.response?.data?.message || error.message);
    return false;
  }
}

async function testGetLotNamesByExchange(exchangeName) {
  try {
    console.log(`\n🔍 Testing: Get lot names for exchange ${exchangeName}`);
    const response = await axios.get(
      `${BASE_URL}/admin/grouped-quantities/exchange/${exchangeName}/lot-names`,
      {
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
      }
    );
    
    console.log('✅ Response:', response.data);
    console.log(`   Found ${response.data.data?.length || 0} lot names`);
    if (response.data.data && response.data.data.length > 0) {
      console.log('   Lot names:', response.data.data);
    }
  } catch (error) {
    console.log('❌ Error:', error.response?.data?.message || error.message);
  }
}

async function runTests() {
  console.log('='.repeat(50));
  console.log('Testing Lot Names API');
  console.log('='.repeat(50));
  
  // Login first
  const loginSuccess = await loginAsAdmin();
  if (!loginSuccess) {
    console.log('\n❌ Cannot proceed without admin login');
    return;
  }
  
  // Test different exchanges
  await testGetLotNamesByExchange('NSE');
  await testGetLotNamesByExchange('MCX');
  await testGetLotNamesByExchange('SGX');
  await testGetLotNamesByExchange('CALLPUT');
  
  console.log('\n' + '='.repeat(50));
  console.log('Tests completed');
  console.log('='.repeat(50));
}

runTests();
