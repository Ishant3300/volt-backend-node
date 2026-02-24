/**
 * Test file for Admin Flow - Master Management
 * 
 * Prerequisites:
 * 1. Server must be running (npm start or npm run dev)
 * 2. Admin must be logged in to get admin token
 * 3. Server must exist in database
 * 
 * Run: node test/testMasterFlow.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';
let adminToken = '';
let masterId = '';
let messageId = '';
let masterToken = '';

// Test configuration
const testConfig = {
  adminCredentials: {
    username: 'admin',
    password: 'admin',
    server: 'test'
  },
  masterData: {
    name: 'Test Master three',
    username: 'test_master_003',
    password: 'master123',
    credits: 50000,
    note: 'Test master for NSE trading',
    pnl_sharing: 60.5,
    brokerage_sharing: 40.0,
    exchanges_allowed: ['nse', 'mcx', 'callput'],
    trade_limit: ['nse', 'mcx'],
    add_master: true,
    change_pass_on_first_login: false,
    server_id: '698c22b313203b38f16f7da9', // Replace with actual server ID
    max_credit: 100000,
    status: 'active',
    active_status: true,
    exchanges: ['NSE', 'MCX'],
    permissions: {
      account_summary: true,
      pnl_summary: true,
      client_summary: false,
      settlement_report: true,
      generate_pdf: true,
      weekly_admin: false,
      intraday_history: true,
      userwise_open_position: true,
      script_quantity: false,
      deleted_trade: false,
      trade_account: true,
      close_only: false,
      bet: true,
      margin_square: true,
      fresh_stoploss: false
    }
  }
};

// Helper function to make API calls
async function apiCall(method, endpoint, data = null, token = null) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: {}
    };

    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }

    if (data) {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }

    const response = await axios(config);
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

// Test 1: Admin Login
async function testAdminLogin() {
  console.log('\n📝 Test 1: Admin Login');
  const result = await apiCall('POST', '/auth/admin/login', testConfig.adminCredentials);
  
  if (result.success && result.data.success) {
    adminToken = result.data.data.token;
    console.log('✅ Admin login successful');
    console.log('   Token:', adminToken.substring(0, 20) + '...');
    return true;
  } else {
    console.log('❌ Admin login failed:', result.error);
    return false;
  }
}

// Test 2: Create Master
async function testCreateMaster() {
  console.log('\n📝 Test 2: Create Master');
  const result = await apiCall('POST', '/masters', testConfig.masterData, adminToken);
  
  if (result.success && result.data.success) {
    masterId = result.data.data.id;
    console.log('✅ Master created successfully');
    console.log('   Master ID:', masterId);
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Credits:', result.data.data.credits);
    console.log('   P&L Sharing:', result.data.data.pnl_sharing + '%');
    console.log('   Brokerage Sharing:', result.data.data.brokerage_sharing + '%');
    console.log('   Add Master:', result.data.data.add_master);
    return true;
  } else {
    console.log('❌ Master creation failed:', result.error);
    return false;
  }
}

// Test 3: Get All Masters
async function testGetAllMasters() {
  console.log('\n📝 Test 3: Get All Masters');
  const result = await apiCall('GET', '/masters?page=1&limit=10', null, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Masters retrieved successfully');
    console.log('   Total:', result.data.data.total);
    console.log('   Page:', result.data.data.page);
    console.log('   Masters:', result.data.data.masters.length);
    return true;
  } else {
    console.log('❌ Get masters failed:', result.error);
    return false;
  }
}

// Test 4: Credit Master Account
async function testCreditMaster() {
  console.log('\n📝 Test 4: Credit Master Account');
  const creditData = {
    amount: 25000,
    note: 'Monthly credit allocation'
  };
  
  const result = await apiCall('POST', `/masters/${masterId}/credit`, creditData, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Credit added successfully');
    console.log('   Previous Credits:', result.data.data.previous_credits);
    console.log('   Amount Credited:', result.data.data.amount_credited);
    console.log('   Current Credits:', result.data.data.current_credits);
    console.log('   Transaction ID:', result.data.data.transaction_id);
    return true;
  } else {
    console.log('❌ Credit operation failed:', result.error);
    return false;
  }
}

// Test 5: Debit Master Account
async function testDebitMaster() {
  console.log('\n📝 Test 5: Debit Master Account');
  const debitData = {
    amount: 10000,
    note: 'Settlement adjustment'
  };
  
  const result = await apiCall('POST', `/masters/${masterId}/debit`, debitData, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Amount debited successfully');
    console.log('   Previous Credits:', result.data.data.previous_credits);
    console.log('   Amount Debited:', result.data.data.amount_debited);
    console.log('   Current Credits:', result.data.data.current_credits);
    console.log('   Transaction ID:', result.data.data.transaction_id);
    return true;
  } else {
    console.log('❌ Debit operation failed:', result.error);
    return false;
  }
}

// Test 6: Get Master Position
async function testGetMasterPosition() {
  console.log('\n📝 Test 6: Get Master Position');
  const result = await apiCall('GET', `/masters/${masterId}/position`, null, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Master position retrieved successfully');
    console.log('   Realised P&L:', result.data.data.position.realised_pnl);
    console.log('   M2M P&L:', result.data.data.position.m2m_pnl);
    console.log('   Credit:', result.data.data.position.credit);
    console.log('   Equity:', result.data.data.position.equity);
    console.log('   Margin Used:', result.data.data.position.margin_used);
    console.log('   Free Margin:', result.data.data.position.free_margin);
    return true;
  } else {
    console.log('❌ Get position failed:', result.error);
    return false;
  }
}

// Test 7: Update Master Details
async function testUpdateMasterDetails() {
  console.log('\n📝 Test 7: Update Master Details');
  const updateData = {
    name: 'Test Master One Updated',
    credits: 70000,
    note: 'Updated test master',
    exchanges_allowed: ['nse', 'mcx', 'sgx'],
    trade_limit: ['nse', 'mcx']
  };
  
  const result = await apiCall('PUT', `/masters/${masterId}/details`, updateData, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Master details updated successfully');
    console.log('   Name:', result.data.data.name);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Note:', result.data.data.note);
    console.log('   Exchanges Allowed:', result.data.data.exchanges_allowed);
    return true;
  } else {
    console.log('❌ Update details failed:', result.error);
    return false;
  }
}

// Test 8: Update Master Permissions
async function testUpdatePermissions() {
  console.log('\n📝 Test 8: Update Master Permissions');
  const permissions = {
    permissions: {
      account_summary: false,
      generate_pdf: false,
      weekly_admin: true,
      bet: false
    }
  };
  
  const result = await apiCall('PUT', `/masters/${masterId}/permissions`, permissions, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Permissions updated successfully');
    console.log('   Updated permissions:', result.data.data.permissions);
    return true;
  } else {
    console.log('❌ Permission update failed:', result.error);
    return false;
  }
}

// Test 9: Update Master Status
async function testUpdateStatus() {
  console.log('\n📝 Test 9: Update Master Status');
  const statusUpdate = {
    active_status: true,
    last_due_bill: new Date().toISOString()
  };
  
  const result = await apiCall('PUT', `/masters/${masterId}/status`, statusUpdate, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Status updated successfully');
    console.log('   Active:', result.data.data.active_status);
    console.log('   Last Due Bill:', result.data.data.last_due_bill);
    return true;
  } else {
    console.log('❌ Status update failed:', result.error);
    return false;
  }
}

// Test 10: Send Message to Master
async function testSendMessage() {
  console.log('\n📝 Test 10: Send Message to Master');
  const message = {
    subject: 'Credit Limit Update',
    message: 'Your credit limit has been increased to 75,000. Please review the updated terms.'
  };
  
  const result = await apiCall('POST', `/masters/${masterId}/messages`, message, adminToken);
  
  if (result.success && result.data.success) {
    messageId = result.data.data.id;
    console.log('✅ Message sent successfully');
    console.log('   Message ID:', messageId);
    console.log('   Subject:', result.data.data.subject);
    console.log('   Read:', result.data.data.read);
    return true;
  } else {
    console.log('❌ Send message failed:', result.error);
    return false;
  }
}

// Test 11: Master Login
async function testMasterLogin() {
  console.log('\n📝 Test 11: Master Login');
  const credentials = {
    username: testConfig.masterData.username,
    password: testConfig.masterData.password
  };
  
  const result = await apiCall('POST', '/auth/master/login', credentials);
  
  if (result.success && result.data.success) {
    masterToken = result.data.data.token;
    console.log('✅ Master login successful');
    console.log('   Token:', masterToken.substring(0, 20) + '...');
    return true;
  } else {
    console.log('❌ Master login failed:', result.error);
    return false;
  }
}

// Test 12: Get Master's Messages (Inbox)
async function testGetMessages() {
  console.log('\n📝 Test 12: Get Master Messages (Inbox)');
  const result = await apiCall('GET', '/master/messages?page=1&limit=10', null, masterToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Messages retrieved successfully');
    console.log('   Total:', result.data.data.total);
    console.log('   Unread:', result.data.data.unread_count);
    console.log('   Messages:', result.data.data.messages.length);
    return true;
  } else {
    console.log('❌ Get messages failed:', result.error);
    return false;
  }
}

// Test 13: Mark Message as Read
async function testMarkMessageAsRead() {
  console.log('\n📝 Test 13: Mark Message as Read');
  const result = await apiCall('PUT', `/master/messages/${messageId}/read`, null, masterToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Message marked as read');
    console.log('   Read:', result.data.data.read);
    console.log('   Read At:', result.data.data.read_at);
    return true;
  } else {
    console.log('❌ Mark as read failed:', result.error);
    return false;
  }
}

// Test 14: Get Master by ID
async function testGetMasterById() {
  console.log('\n📝 Test 14: Get Master by ID');
  const result = await apiCall('GET', `/masters/${masterId}`, null, adminToken);
  
  if (result.success && result.data.success) {
    console.log('✅ Master retrieved successfully');
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Status:', result.data.data.status);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Add Master:', result.data.data.add_master);
    return true;
  } else {
    console.log('❌ Get master failed:', result.error);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting Admin Flow Tests...');
  console.log('================================');
  
  const tests = [
    testAdminLogin,
    testCreateMaster,
    testGetAllMasters,
    testCreditMaster,
    testDebitMaster,
    testGetMasterPosition,
    testUpdateMasterDetails,
    testUpdatePermissions,
    testUpdateStatus,
    testSendMessage,
    testMasterLogin,
    testGetMessages,
    testMarkMessageAsRead,
    testGetMasterById
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    const result = await test();
    if (result) {
      passed++;
    } else {
      failed++;
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between tests
  }
  
  console.log('\n================================');
  console.log('📊 Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Total: ${tests.length}`);
  console.log('================================\n');
}

// Run tests
runAllTests().catch(console.error);
