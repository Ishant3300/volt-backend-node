/**
 * Test file for Master Flow - Child Master & User Management
 * 
 * Prerequisites:
 * 1. Server must be running (npm start or npm run dev)
 * 2. Admin must be logged in to create parent master
 * 3. Parent master must exist with add_master: true
 * 4. Server must exist in database
 * 
 * Run: node test/testMasterFlow.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';
let adminToken = '';
let parentMasterToken = '';
let parentMasterId = '';
let childMasterId = '';
let userId = '';
let messageId = '';

// Test configuration
const testConfig = {
  adminCredentials: {
    username: 'admin',
    password: 'admin'
  },
  parentMasterData: {
    name: 'Parent Master 3',
    username: 'parent_master_003',
    password: 'master123',
    credits: 100000,
    note: 'Parent master with add_master permission',
    pnl_sharing: 70.0,
    brokerage_sharing: 50.0,
    exchanges_allowed: ['NFO-FUT', 'NFO-OPT', 'MCX-FUT', 'MCX-OPT', 'GLOBAL'],
    trade_limit: ['nse', 'mcx', 'sgx'],
    add_master: true, // Can create child masters
    change_pass_on_first_login: false,
    server_id: '698c22b313203b38f16f7da9', // Replace with actual server ID
    max_credit: 200000,
    status: 'active',
    active_status: true,
    exchanges: ['NSE', 'MCX'],
    permissions: {
      account_summary: true,
      pnl_summary: true,
      client_summary: true,
      settlement_report: true,
      generate_pdf: true,
      weekly_admin: true,
      intraday_history: true,
      userwise_open_position: true,
      script_quantity: true,
      deleted_trade: true,
      trade_account: true,
      close_only: true,
      bet: true,
      margin_square: true,
      fresh_stoploss: true
    }
  },
  childMasterData: {
    name: 'Child Master One',
    username: 'child_master_002',
    password: 'child123',
    credits: 30000,
    note: 'Child master for NSE trading',
    pnl_sharing: 50.0,
    brokerage_sharing: 30.0,
    exchanges_allowed: ['nse', 'mcx'],
    trade_limit: ['nse'],
    add_master: false, // Cannot create child masters
    change_pass_on_first_login: false,
    server_id: '698c22b313203b38f16f7da9',
    max_credit: 50000,
    status: 'active',
    active_status: true,
    exchanges: ['NSE'],
    permissions: {
      account_summary: true,
      pnl_summary: true,
      trade_account: true,
      bet: true
    }
  },
  userData: {
    name: 'Trading User One',
    username: 'user_002',
    password: 'user123',
    credits: 10000,
    note: 'Active trader for NSE',
    pnl_sharing: 40.0,
    brokerage_sharing: 20.0,
    exchanges_allowed: [
      {
        exchange_name: 'nse',
        turnover: true,
        lot: false,
        group_name: 'equity_group'
      },
      {
        exchange_name: 'mcx',
        turnover: false,
        lot: true,
        group_name: 'commodity_group'
      }
    ],
    trade_limit: ['nse'],
    margin_square_off: true,
    change_pass_on_first_login: true,
    server_id: '698c22b313203b38f16f7da9',
    status: 'active'
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

// Test 2: Create Parent Master (by Admin)
async function testCreateParentMaster() {
  console.log('\n📝 Test 2: Create Parent Master (by Admin)');
  const result = await apiCall('POST', '/masters', testConfig.parentMasterData, adminToken);

  if (result.success && result.data.success) {
    parentMasterId = result.data.data.id;
    console.log('✅ Parent master created successfully');
    console.log('   Master ID:', parentMasterId);
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Add Master:', result.data.data.add_master);
    console.log('   P&L Sharing:', result.data.data.pnl_sharing + '%');
    return true;
  } else {
    console.log('❌ Parent master creation failed:', result.error);
    return false;
  }
}

// Test 3: Parent Master Login
async function testParentMasterLogin() {
  console.log('\n📝 Test 3: Parent Master Login');
  const credentials = {
    username: testConfig.parentMasterData.username,
    password: testConfig.parentMasterData.password
  };

  const result = await apiCall('POST', '/auth/master/login', credentials);

  if (result.success && result.data.success) {
    parentMasterToken = result.data.data.token;
    console.log('✅ Parent master login successful');
    console.log('   Token:', parentMasterToken.substring(0, 20) + '...');
    console.log('   Last Login:', result.data.data.master.last_login);
    console.log('   IP Address:', result.data.data.master.ip_address);
    return true;
  } else {
    console.log('❌ Parent master login failed:', result.error);
    return false;
  }
}

// Test 4: Create Child Master (by Parent Master)
async function testCreateChildMaster() {
  console.log('\n📝 Test 4: Create Child Master (by Parent Master)');
  const result = await apiCall('POST', '/master/masters', testConfig.childMasterData, parentMasterToken);

  if (result.success && result.data.success) {
    childMasterId = result.data.data.id;
    console.log('✅ Child master created successfully');
    console.log('   Master ID:', childMasterId);
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Add Master:', result.data.data.add_master);
    console.log('   Parent Master ID:', result.data.data.master_id);
    return true;
  } else {
    console.log('❌ Child master creation failed:', result.error);
    return false;
  }
}

// Test 5: Create User (by Parent Master)
async function testCreateUser() {
  console.log('\n📝 Test 5: Create User (by Parent Master)');
  const result = await apiCall('POST', '/master/users', testConfig.userData, parentMasterToken);

  if (result.success && result.data.success) {
    userId = result.data.data.id;
    console.log('✅ User created successfully');
    console.log('   User ID:', userId);
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Margin Square Off:', result.data.data.margin_square_off);
    console.log('   Change Pass on First Login:', result.data.data.change_pass_on_first_login);
    console.log('   Exchanges Allowed:', JSON.stringify(result.data.data.exchanges_allowed, null, 2));
    return true;
  } else {
    console.log('❌ User creation failed:', result.error);
    return false;
  }
}

// Test 6: Get All Child Masters
async function testGetAllChildMasters() {
  console.log('\n📝 Test 6: Get All Child Masters');
  const result = await apiCall('GET', '/master/masters?page=1&limit=10', null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Child masters retrieved successfully');
    console.log('   Total:', result.data.data.total);
    console.log('   Page:', result.data.data.page);
    console.log('   Masters:', result.data.data.masters.length);
    if (result.data.data.masters.length > 0) {
      console.log('   First Master:', result.data.data.masters[0].name);
    }
    return true;
  } else {
    console.log('❌ Get child masters failed:', result.error);
    return false;
  }
}

// Test 7: Get All Users
async function testGetAllUsers() {
  console.log('\n📝 Test 7: Get All Users');
  const result = await apiCall('GET', '/master/users?page=1&limit=10', null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Users retrieved successfully');
    console.log('   Total:', result.data.data.total);
    console.log('   Page:', result.data.data.page);
    console.log('   Users:', result.data.data.users.length);
    if (result.data.data.users.length > 0) {
      console.log('   First User:', result.data.data.users[0].name);
    }
    return true;
  } else {
    console.log('❌ Get users failed:', result.error);
    return false;
  }
}

// Test 8: Credit Child Master
async function testCreditChildMaster() {
  console.log('\n📝 Test 8: Credit Child Master');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const creditData = {
    amount: 15000,
    note: 'Monthly credit allocation'
  };

  const result = await apiCall('POST', `/master/masters/${childMasterId}/credit`, creditData, parentMasterToken);

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

// Test 9: Debit Child Master
async function testDebitChildMaster() {
  console.log('\n📝 Test 9: Debit Child Master');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const debitData = {
    amount: 5000,
    note: 'Settlement adjustment'
  };

  const result = await apiCall('POST', `/master/masters/${childMasterId}/debit`, debitData, parentMasterToken);

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

// Test 10: Credit User
async function testCreditUser() {
  console.log('\n📝 Test 10: Credit User');
  const creditData = {
    amount: 5000,
    note: 'Trading credit allocation'
  };

  const result = await apiCall('POST', `/master/users/${userId}/credit`, creditData, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Credit added successfully');
    console.log('   Previous Credits:', result.data.data.previous_credits);
    console.log('   Amount Credited:', result.data.data.amount_credited);
    console.log('   Current Credits:', result.data.data.current_credits);
    return true;
  } else {
    console.log('❌ Credit user failed:', result.error);
    return false;
  }
}

// Test 11: Debit User
async function testDebitUser() {
  console.log('\n📝 Test 11: Debit User');
  const debitData = {
    amount: 2000,
    note: 'Fee deduction'
  };

  const result = await apiCall('POST', `/master/users/${userId}/debit`, debitData, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Amount debited successfully');
    console.log('   Previous Credits:', result.data.data.previous_credits);
    console.log('   Amount Debited:', result.data.data.amount_debited);
    console.log('   Current Credits:', result.data.data.current_credits);
    return true;
  } else {
    console.log('❌ Debit user failed:', result.error);
    return false;
  }
}

// Test 12: Update Child Master Permissions
async function testUpdateChildMasterPermissions() {
  console.log('\n📝 Test 12: Update Child Master Permissions');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const permissions = {
    permissions: {
      account_summary: false,
      pnl_summary: true,
      bet: false
    }
  };

  const result = await apiCall('PUT', `/master/masters/${childMasterId}/permissions`, permissions, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Permissions updated successfully');
    console.log('   Updated permissions:', result.data.data.permissions);
    return true;
  } else {
    console.log('❌ Permission update failed:', result.error);
    return false;
  }
}

// Test 13: Update Child Master Details
async function testUpdateChildMasterDetails() {
  console.log('\n📝 Test 13: Update Child Master Details');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const updateData = {
    name: 'Child Master One Updated',
    credits: 45000,
    note: 'Updated child master',
    exchanges_allowed: ['nse', 'mcx', 'sgx'],
    trade_limit: ['nse', 'mcx']
  };

  const result = await apiCall('PUT', `/master/masters/${childMasterId}/details`, updateData, parentMasterToken);

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

// Test 14: Update User Details
async function testUpdateUserDetails() {
  console.log('\n📝 Test 14: Update User Details');
  const updateData = {
    name: 'Trading User One Updated',
    credits: 15000,
    note: 'Updated active trader',
    exchanges_allowed: [
      {
        exchange_name: 'nse',
        turnover: true,
        lot: true,
        group_name: 'premium_equity_group'
      }
    ],
    trade_limit: ['nse', 'mcx']
  };

  const result = await apiCall('PUT', `/master/users/${userId}/details`, updateData, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ User details updated successfully');
    console.log('   Name:', result.data.data.name);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Note:', result.data.data.note);
    console.log('   Exchanges Allowed:', JSON.stringify(result.data.data.exchanges_allowed, null, 2));
    return true;
  } else {
    console.log('❌ Update user details failed:', result.error);
    return false;
  }
}

// Test 15: Get Child Master Position
async function testGetChildMasterPosition() {
  console.log('\n📝 Test 15: Get Child Master Position');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const result = await apiCall('GET', `/master/masters/${childMasterId}/position`, null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Child master position retrieved successfully');
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

// Test 16: Get User Position
async function testGetUserPosition() {
  console.log('\n📝 Test 16: Get User Position');
  const result = await apiCall('GET', `/master/users/${userId}/position`, null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ User position retrieved successfully');
    console.log('   Realised P&L:', result.data.data.position.realised_pnl);
    console.log('   M2M P&L:', result.data.data.position.m2m_pnl);
    console.log('   Credit:', result.data.data.position.credit);
    console.log('   Equity:', result.data.data.position.equity);
    return true;
  } else {
    console.log('❌ Get user position failed:', result.error);
    return false;
  }
}

// Test 17: Get All Trades
async function testGetAllTrades() {
  console.log('\n📝 Test 17: Get All Trades in Hierarchy');
  const result = await apiCall('GET', '/master/trades?page=1&limit=50', null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Trades retrieved successfully');
    console.log('   Total:', result.data.data.total);
    console.log('   Page:', result.data.data.page);
    console.log('   Trades:', result.data.data.trades.length);
    if (result.data.data.summary) {
      console.log('   Total P&L:', result.data.data.summary.total_pnl);
      console.log('   Total Brokerage:', result.data.data.summary.total_brokerage);
    }
    return true;
  } else {
    console.log('❌ Get trades failed:', result.error);
    return false;
  }
}

// Test 18: Send Message to Child Master
async function testSendMessageToChildMaster() {
  console.log('\n📝 Test 18: Send Message to Child Master');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const message = {
    subject: 'Credit Update',
    message: 'Your credit has been updated. Please check your account.'
  };

  const result = await apiCall('POST', `/master/masters/${childMasterId}/messages`, message, parentMasterToken);

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

// Test 19: Send Message to User
async function testSendMessageToUser() {
  console.log('\n📝 Test 19: Send Message to User');
  const message = {
    subject: 'Trading Alert',
    message: 'Please review your trading limits and positions.'
  };

  const result = await apiCall('POST', `/master/users/${userId}/messages`, message, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Message sent successfully');
    console.log('   Message ID:', result.data.data.id);
    console.log('   Subject:', result.data.data.subject);
    return true;
  } else {
    console.log('❌ Send message to user failed:', result.error);
    return false;
  }
}

// Test 20: Get Child Master by ID
async function testGetChildMasterById() {
  console.log('\n📝 Test 20: Get Child Master by ID');

  if (!childMasterId) {
    console.log('⚠️  Skipping - no child master created');
    return true; // Skip if no child master
  }

  const result = await apiCall('GET', `/master/masters/${childMasterId}`, null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ Child master retrieved successfully');
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Status:', result.data.data.status);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Add Master:', result.data.data.add_master);
    return true;
  } else {
    console.log('❌ Get child master failed:', result.error);
    return false;
  }
}

// Test 21: Get User by ID
async function testGetUserById() {
  console.log('\n📝 Test 21: Get User by ID');
  const result = await apiCall('GET', `/master/users/${userId}`, null, parentMasterToken);

  if (result.success && result.data.success) {
    console.log('✅ User retrieved successfully');
    console.log('   Name:', result.data.data.name);
    console.log('   Username:', result.data.data.username);
    console.log('   Status:', result.data.data.status);
    console.log('   Credits:', result.data.data.credits);
    console.log('   Margin Square Off:', result.data.data.margin_square_off);
    return true;
  } else {
    console.log('❌ Get user failed:', result.error);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting Master Flow Tests...');
  console.log('================================');

  const tests = [
    testAdminLogin,
    testCreateParentMaster,
    testParentMasterLogin,
    testCreateChildMaster,
    testCreateUser,
    testGetAllChildMasters,
    testGetAllUsers,
    testCreditChildMaster,
    testDebitChildMaster,
    testCreditUser,
    testDebitUser,
    testUpdateChildMasterPermissions,
    testUpdateChildMasterDetails,
    testUpdateUserDetails,
    testGetChildMasterPosition,
    testGetUserPosition,
    testGetAllTrades,
    testSendMessageToChildMaster,
    testSendMessageToUser,
    testGetChildMasterById,
    testGetUserById
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
