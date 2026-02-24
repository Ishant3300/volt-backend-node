const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000/api';

// Test configuration
const TEST_CONFIG = {
  masterUsername: 'master1', // Replace with actual master username
  masterPassword: 'password123', // Replace with actual master password
  userId: '', // Will be filled after creating a user
};

let masterToken = '';

// Helper function to log responses
const logResponse = (title, response) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(title);
  console.log(`${'='.repeat(50)}`);
  console.log('Status:', response.status);
  console.log('Data:', JSON.stringify(response.data, null, 2));
};

// Helper function to log errors
const logError = (title, error) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`❌ ${title}`);
  console.log(`${'='.repeat(50)}`);
  if (error.response) {
    console.log('Status:', error.response.status);
    console.log('Data:', JSON.stringify(error.response.data, null, 2));
  } else {
    console.log('Error:', error.message);
  }
};

// 1. Login as Master
async function loginAsMaster() {
  try {
    const response = await axios.post(`${BASE_URL}/auth/master/login`, {
      username: TEST_CONFIG.masterUsername,
      password: TEST_CONFIG.masterPassword,
    });
    
    logResponse('✅ Master Login', response);
    masterToken = response.data.data.token;
    return true;
  } catch (error) {
    logError('Master Login Failed', error);
    return false;
  }
}

// 2. Create a test user
async function createTestUser() {
  try {
    const response = await axios.post(
      `${BASE_URL}/master/users`,
      {
        name: 'Test User Update',
        username: `testuser_${Date.now()}`,
        password: 'password123',
        credits: 10000,
        note: 'Test user for update',
        pnl_sharing: 50,
        brokerage_sharing: 50,
        exchanges_allowed: [
          {
            exchange_name: 'NSE',
            turnover: true,
            lot: false,
            group_name: 'Group1'
          }
        ],
        trade_limit: ['NSE', 'MCX'],
        margin_square_off: false,
        change_pass_on_first_login: true,
        server_id: '507f1f77bcf86cd799439011' // Replace with actual server ID
      },
      {
        headers: {
          Authorization: `Bearer ${masterToken}`,
        },
      }
    );
    
    logResponse('✅ User Created', response);
    TEST_CONFIG.userId = response.data.data.user.id;
    return true;
  } catch (error) {
    logError('User Creation Failed', error);
    return false;
  }
}

// 3. Update the user
async function updateUser() {
  try {
    const response = await axios.put(
      `${BASE_URL}/master/users/${TEST_CONFIG.userId}`,
      {
        name: 'Updated Test User',
        credits: 15000,
        note: 'Updated note',
        exchanges_allowed: [
          {
            exchange_name: 'NSE',
            turnover: true,
            lot: true,
            group_name: 'Group2'
          },
          {
            exchange_name: 'MCX',
            turnover: false,
            lot: true,
            group_name: 'Group1'
          }
        ],
        trade_limit: ['NSE', 'MCX', 'SGX'],
        margin_square_off: true,
        change_pass_on_first_login: false
      },
      {
        headers: {
          Authorization: `Bearer ${masterToken}`,
        },
      }
    );
    
    logResponse('✅ User Updated', response);
    return true;
  } catch (error) {
    logError('User Update Failed', error);
    return false;
  }
}

// 4. Get updated user details
async function getUserDetails() {
  try {
    const response = await axios.get(
      `${BASE_URL}/master/users/${TEST_CONFIG.userId}`,
      {
        headers: {
          Authorization: `Bearer ${masterToken}`,
        },
      }
    );
    
    logResponse('✅ User Details Retrieved', response);
    return true;
  } catch (error) {
    logError('Get User Details Failed', error);
    return false;
  }
}

// Run all tests
async function runTests() {
  console.log('🚀 Starting User Update Tests...\n');
  
  // Step 1: Login
  const loginSuccess = await loginAsMaster();
  if (!loginSuccess) {
    console.log('\n❌ Tests aborted: Master login failed');
    return;
  }
  
  // Step 2: Create user
  const createSuccess = await createTestUser();
  if (!createSuccess) {
    console.log('\n❌ Tests aborted: User creation failed');
    return;
  }
  
  // Step 3: Update user
  const updateSuccess = await updateUser();
  if (!updateSuccess) {
    console.log('\n❌ Tests aborted: User update failed');
    return;
  }
  
  // Step 4: Get updated details
  await getUserDetails();
  
  console.log('\n✅ All tests completed!');
}

// Execute tests
runTests().catch(error => {
  console.error('Unexpected error:', error);
});
