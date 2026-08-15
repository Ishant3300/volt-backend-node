/**
 * Multi-Tier Brokerage Hierarchy Test
 * 
 * Tests the full hierarchy flow:
 * 1. Admin login
 * 2. Admin creates Main Master (with brokerage rate)
 * 3. Main Master logs in, creates Sub-Master
 * 4. Sub-Master logs in, creates User
 * 5. Verify brokerage inheritance at each level
 * 6. Test floor validation (can't go below parent)
 * 7. Test isolation (changing one doesn't affect others)
 * 8. Verify Weekly Admin Report cascade math
 *
 * Run: node test/testBrokerageHierarchy.js
 * Prerequisite: Server running on BASE_URL
 */

const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION — Change these to match your environment
// ═══════════════════════════════════════════════════════════════════════════
const BASE_URL = 'https://apexlive-api.mynpe.in/api'; // Production
// const BASE_URL = 'http://localhost:3000/api'; // Local dev

const ADMIN_CREDENTIALS = {
  username: 'devarshadmin',
  password: '12345678'
};

// Will be auto-generated
const TEST_PREFIX = `brktest_${Date.now().toString(36)}`;
const MAIN_MASTER_USERNAME = `${TEST_PREFIX}_main`;
const SUB_MASTER_USERNAME = `${TEST_PREFIX}_sub`;
const USER_USERNAME = `${TEST_PREFIX}_user`;
const PASSWORD = '12345678';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
let adminToken = '';
let mainMasterToken = '';
let subMasterToken = '';
let mainMasterId = '';
let subMasterId = '';
let userId = '';
let serverId = '';

let passed = 0, failed = 0;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function api(method, endpoint, data = null, token = null) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    if (data) config.data = data;
    const res = await axios(config);
    return { success: true, status: res.status, data: res.data };
  } catch (err) {
    return {
      success: false,
      status: err.response?.status || 0,
      data: err.response?.data || { message: err.message },
      error: err.response?.data?.message || err.message,
    };
  }
}

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAILED: ${message}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function test1_AdminLogin() {
  console.log('\n═══ TEST 1: Admin Login ═══');
  const res = await api('POST', '/auth/login', ADMIN_CREDENTIALS);
  assert(res.data?.success === true, 'Login successful');
  adminToken = res.data?.data?.token;
  assert(!!adminToken, 'Got admin token');
}

async function test2_GetServer() {
  console.log('\n═══ TEST 2: Get Server ID ═══');
  const res = await api('GET', '/servers', null, adminToken);
  assert(res.data?.success === true, 'Fetched servers');
  const servers = res.data?.data?.servers || res.data?.data || [];
  if (servers.length > 0) {
    serverId = servers[0].id || servers[0]._id;
    assert(!!serverId, `Got server: ${servers[0].name} (${serverId})`);
  } else {
    assert(false, 'No servers found — cannot proceed');
  }
}

async function test3_AdminSetGlobalBrokerage() {
  console.log('\n═══ TEST 3: Admin Sets Global Brokerage (0.5 paise for NFO-FUT) ═══');
  const res = await api('POST', '/admin/brokerage-settings/bulk-create', {
    exchange_name: 'NFO-FUT',
    type: 'TURNOVER WISE',
    default_brk_value: 0.5,
  }, adminToken);
  assert(res.status === 201 || res.status === 200, `Global brokerage created/exists`);
}

async function test4_CreateMainMaster() {
  console.log('\n═══ TEST 4: Admin Creates Main Master ═══');
  const res = await api('POST', '/masters', {
    name: 'Test Main Master',
    username: MAIN_MASTER_USERNAME,
    password: PASSWORD,
    credits: 100000,
    note: 'Brokerage hierarchy test',
    pnl_sharing: 90,
    brokerage_sharing: 90,
    exchanges_allowed: ['NFO-FUT', 'NFO-OPT', 'MCX-FUT'],
    trade_limit: ['NFO-FUT', 'NFO-OPT', 'MCX-FUT'],
    add_master: true,
    change_pass_on_first_login: false,
    server_id: serverId,
  }, adminToken);

  assert(res.data?.success === true, `Main Master created: ${MAIN_MASTER_USERNAME}`);
  mainMasterId = res.data?.data?.id || res.data?.data?._id;
  assert(!!mainMasterId, `Main Master ID: ${mainMasterId}`);
}

async function test5_VerifyMainMasterInheritedBrokerage() {
  console.log('\n═══ TEST 5: Verify Main Master Inherited Global Brokerage ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${mainMasterId}&limit=5`, null, adminToken);
  assert(res.data?.success === true, 'Fetched Main Master brokerage records');
  const items = res.data?.data?.items || [];
  assert(items.length > 0, `Main Master has ${items.length} brokerage record(s) for NFO-FUT`);
  if (items.length > 0) {
    assert(items[0].brk_value === 0.5, `Inherited rate = 0.5 (got ${items[0].brk_value})`);
  }
}

async function test6_MainMasterLogin() {
  console.log('\n═══ TEST 6: Main Master Login ═══');
  const res = await api('POST', '/auth/login', { username: MAIN_MASTER_USERNAME, password: PASSWORD });
  assert(res.data?.success === true, 'Main Master login successful');
  mainMasterToken = res.data?.data?.token;
  assert(!!mainMasterToken, 'Got Main Master token');
}

async function test7_MainMasterSetOwnBrokerage() {
  console.log('\n═══ TEST 7: Main Master Sets Own Brokerage to 1.0 paise ═══');
  // First get the record IDs
  const getRes = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${mainMasterId}&limit=100`, null, mainMasterToken);
  const items = getRes.data?.data?.items || [];
  if (items.length === 0) {
    assert(false, 'No brokerage records found for Main Master');
    return;
  }
  const ids = items.map(i => i.id || i._id);
  const res = await api('PUT', '/admin/brokerage-settings/bulk-update', {
    ids: ids.slice(0, 5), // update a few
    brk_value: 1.0,
    type: 'TURNOVER WISE',
  }, mainMasterToken);
  assert(res.data?.success === true, `Updated Main Master rate to 1.0 paise`);
}

async function test8_MainMasterCreateSubMaster() {
  console.log('\n═══ TEST 8: Main Master Creates Sub-Master ═══');
  const res = await api('POST', '/master/masters', {
    name: 'Test Sub Master',
    username: SUB_MASTER_USERNAME,
    password: PASSWORD,
    credits: 50000,
    note: 'Sub master for brk test',
    pnl_sharing: 80,
    brokerage_sharing: 80,
    exchanges_allowed: ['NFO-FUT', 'NFO-OPT', 'MCX-FUT'],
    trade_limit: ['NFO-FUT', 'NFO-OPT', 'MCX-FUT'],
    add_master: false,
    change_pass_on_first_login: false,
    server_id: serverId,
  }, mainMasterToken);

  assert(res.data?.success === true, `Sub-Master created: ${SUB_MASTER_USERNAME}`);
  const childData = res.data?.data?.child_master || res.data?.data;
  subMasterId = childData?.id || childData?._id;
  assert(!!subMasterId, `Sub-Master ID: ${subMasterId}`);
}

async function test9_VerifySubMasterInheritedBrokerage() {
  console.log('\n═══ TEST 9: Verify Sub-Master Inherited Main Master Brokerage (1.0) ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${subMasterId}&limit=5`, null, mainMasterToken);
  assert(res.data?.success === true, 'Fetched Sub-Master brokerage records');
  const items = res.data?.data?.items || [];
  assert(items.length > 0, `Sub-Master has ${items.length} brokerage record(s)`);
  if (items.length > 0) {
    assert(items[0].brk_value === 1.0, `Inherited rate = 1.0 (got ${items[0].brk_value})`);
  }
}

async function test10_SubMasterLogin() {
  console.log('\n═══ TEST 10: Sub-Master Login ═══');
  const res = await api('POST', '/auth/login', { username: SUB_MASTER_USERNAME, password: PASSWORD });
  assert(res.data?.success === true, 'Sub-Master login successful');
  subMasterToken = res.data?.data?.token;
  assert(!!subMasterToken, 'Got Sub-Master token');
}

async function test11_SubMasterSetOwnBrokerage() {
  console.log('\n═══ TEST 11: Sub-Master Sets Own Brokerage to 2.0 paise ═══');
  const getRes = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${subMasterId}&limit=100`, null, subMasterToken);
  const items = getRes.data?.data?.items || [];
  if (items.length === 0) {
    assert(false, 'No brokerage records for Sub-Master');
    return;
  }
  const ids = items.map(i => i.id || i._id);
  const res = await api('PUT', '/admin/brokerage-settings/bulk-update', {
    ids: ids.slice(0, 5),
    brk_value: 2.0,
    type: 'TURNOVER WISE',
  }, subMasterToken);
  assert(res.data?.success === true, `Updated Sub-Master rate to 2.0 paise`);
}

async function test12_SubMasterCreateUser() {
  console.log('\n═══ TEST 12: Sub-Master Creates User ═══');
  const res = await api('POST', '/master/users', {
    name: 'Test User',
    username: USER_USERNAME,
    password: PASSWORD,
    credits: 10000,
    note: 'User for brk test',
    pnl_sharing: 80,
    brokerage_sharing: 80,
    exchanges_allowed: [
      { exchange_name: 'NFO-FUT', turnover: true, lot: false, group_name: 'Default' }
    ],
    trade_limit: ['NFO-FUT'],
    margin_square_off: false,
    change_pass_on_first_login: false,
    server_id: serverId,
  }, subMasterToken);

  assert(res.data?.success === true, `User created: ${USER_USERNAME}`);
  const userData = res.data?.data?.user || res.data?.data;
  userId = userData?.id || userData?._id;
  assert(!!userId, `User ID: ${userId}`);
}

async function test13_VerifyUserInheritedBrokerage() {
  console.log('\n═══ TEST 13: Verify User Inherited Sub-Master Brokerage (2.0) ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${userId}&limit=5`, null, subMasterToken);
  assert(res.data?.success === true, 'Fetched User brokerage records');
  const items = res.data?.data?.items || [];
  assert(items.length > 0, `User has ${items.length} brokerage record(s)`);
  if (items.length > 0) {
    assert(items[0].brk_value === 2.0, `Inherited rate = 2.0 (got ${items[0].brk_value})`);
  }
}

async function test14_FloorValidation_BelowParent() {
  console.log('\n═══ TEST 14: Floor Validation — Try Setting User to 0.5 (Below Parent 2.0) ═══');
  // Get user's brokerage record IDs
  const getRes = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${userId}&limit=5`, null, subMasterToken);
  const items = getRes.data?.data?.items || [];
  if (items.length === 0) {
    assert(false, 'No user brokerage records to test');
    return;
  }
  const ids = items.map(i => i.id || i._id);

  const res = await api('PUT', '/admin/brokerage-settings/bulk-update', {
    ids: [ids[0]],
    brk_value: 0.5,
    type: 'TURNOVER WISE',
  }, subMasterToken);

  assert(res.status === 422, `Got 422 rejection (got ${res.status})`);
  assert(res.data?.message?.includes('parent limit'), `Error message mentions parent limit: "${res.data?.message}"`);
}

async function test15_FloorValidation_AboveParent() {
  console.log('\n═══ TEST 15: Floor Validation — Set User to 3.0 (Above Parent 2.0) — Should Succeed ═══');
  const getRes = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${userId}&limit=5`, null, subMasterToken);
  const items = getRes.data?.data?.items || [];
  if (items.length === 0) {
    assert(false, 'No user brokerage records to test');
    return;
  }
  const ids = items.map(i => i.id || i._id);

  const res = await api('PUT', '/admin/brokerage-settings/bulk-update', {
    ids: [ids[0]],
    brk_value: 3.0,
    type: 'TURNOVER WISE',
  }, subMasterToken);

  assert(res.data?.success === true, `Successfully set user rate to 3.0`);
}

async function test16_Isolation_MainMasterUnchanged() {
  console.log('\n═══ TEST 16: Isolation — Verify Main Master Rate Still 1.0 ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${mainMasterId}&limit=5`, null, adminToken);
  const items = res.data?.data?.items || [];
  assert(items.length > 0, 'Main Master still has brokerage records');
  if (items.length > 0) {
    assert(items[0].brk_value === 1.0, `Main Master rate unchanged at 1.0 (got ${items[0].brk_value})`);
  }
}

async function test17_Isolation_SubMasterUnchanged() {
  console.log('\n═══ TEST 17: Isolation — Verify Sub-Master Rate Still 2.0 ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&user_id=${subMasterId}&limit=5`, null, adminToken);
  const items = res.data?.data?.items || [];
  assert(items.length > 0, 'Sub-Master still has brokerage records');
  if (items.length > 0) {
    assert(items[0].brk_value === 2.0, `Sub-Master rate unchanged at 2.0 (got ${items[0].brk_value})`);
  }
}

async function test18_Isolation_GlobalUnchanged() {
  console.log('\n═══ TEST 18: Isolation — Verify Global (Admin) Rate Still 0.5 ═══');
  const res = await api('GET', `/admin/brokerage-settings/exchange/NFO-FUT?type=TURNOVER%20WISE&limit=5`, null, adminToken);
  // No user_id param = global records
  const items = res.data?.data?.items || [];
  assert(items.length > 0, 'Global brokerage records exist');
  if (items.length > 0) {
    assert(items[0].brk_value === 0.5, `Global rate unchanged at 0.5 (got ${items[0].brk_value})`);
  }
}

async function test19_WeeklyAdminReport() {
  console.log('\n═══ TEST 19: Weekly Admin Report — Verify Hierarchy Data Returns ═══');
  const res = await api('GET', '/master/weekly-admin-report', null, adminToken);
  assert(res.data?.success === true, 'Weekly Admin Report returned successfully');
  const data = res.data?.data || [];
  assert(data.length > 0, `Report has ${data.length} entries`);
  if (data.length > 0) {
    const hasCallerFields = data[0].caller_brk !== undefined && data[0].caller_profit !== undefined;
    assert(hasCallerFields, 'Report includes caller_brk and caller_profit fields');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('\n═══ CLEANUP ═══');
  // NOT deleting test accounts — they should be manually reviewed and removed.
  // Automated deletion is too risky for production data.
  console.log('  ⚠️  Test accounts left intact for manual verification:');
  if (mainMasterId) console.log(`    Main Master: ${MAIN_MASTER_USERNAME} (${mainMasterId})`);
  if (subMasterId) console.log(`    Sub-Master: ${SUB_MASTER_USERNAME} (${subMasterId})`);
  if (userId) console.log(`    User: ${USER_USERNAME} (${userId})`);
  console.log('  💡 Delete manually from Admin panel when done testing.');
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  MULTI-TIER BROKERAGE HIERARCHY TEST                    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${BASE_URL}`);
  console.log(`║  Test prefix: ${TEST_PREFIX}`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  const tests = [
    test1_AdminLogin,
    test2_GetServer,
    test3_AdminSetGlobalBrokerage,
    test4_CreateMainMaster,
    test5_VerifyMainMasterInheritedBrokerage,
    test6_MainMasterLogin,
    test7_MainMasterSetOwnBrokerage,
    test8_MainMasterCreateSubMaster,
    test9_VerifySubMasterInheritedBrokerage,
    test10_SubMasterLogin,
    test11_SubMasterSetOwnBrokerage,
    test12_SubMasterCreateUser,
    test13_VerifyUserInheritedBrokerage,
    test14_FloorValidation_BelowParent,
    test15_FloorValidation_AboveParent,
    test16_Isolation_MainMasterUnchanged,
    test17_Isolation_SubMasterUnchanged,
    test18_Isolation_GlobalUnchanged,
    test19_WeeklyAdminReport,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (e) {
      console.log(`  ❌ EXCEPTION: ${e.message}`);
      failed++;
    }
  }

  await cleanup();

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)    `);
  console.log('╚══════════════════════════════════════════════════════════╝');

  process.exit(failed > 0 ? 1 : 0);
}

run();
