#!/usr/bin/env node
/**
 * API Performance Test Script
 * Tests all backend endpoints and measures response times.
 * Uses direct JWT signing (same secret) to bypass login flow.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// ─── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = process.env.TEST_BASE_URL || 'https://apexlive-api.mynpe.in';
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const TIMEOUT = 30000; // 30s timeout per request

// ─── Results Storage ─────────────────────────────────────────────────────────
const results = [];

// ─── Helper: Make a timed request ────────────────────────────────────────────
async function timedRequest(method, url, { headers = {}, data = null, params = null, label = '' } = {}) {
  const start = Date.now();
  let status, responseTime, error = null, size = 0;

  try {
    const config = {
      method,
      url: `${BASE_URL}${url}`,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: TIMEOUT,
      validateStatus: () => true, // Don't throw on 4xx/5xx
    };
    if (data) config.data = data;
    if (params) config.params = params;

    const res = await axios(config);
    responseTime = Date.now() - start;
    status = res.status;
    size = JSON.stringify(res.data || '').length;
  } catch (err) {
    responseTime = Date.now() - start;
    status = err.code === 'ECONNABORTED' ? 'TIMEOUT' : err.code || 'ERROR';
    error = err.message;
  }

  const result = {
    label: label || `${method.toUpperCase()} ${url}`,
    method: method.toUpperCase(),
    url,
    status,
    responseTime,
    size,
    error,
  };
  results.push(result);

  const icon = status >= 200 && status < 400 ? '✅' : status >= 400 && status < 500 ? '⚠️ ' : '❌';
  const timeColor = responseTime > 2000 ? '🔴' : responseTime > 500 ? '🟡' : '🟢';
  console.log(`${icon} ${timeColor} ${responseTime.toString().padStart(5)}ms | ${String(status).padStart(3)} | ${result.label}`);

  return result;
}

// ─── Main Test Suite ─────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  API Performance Test — ${BASE_URL}`);
  console.log(`  Started at: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Connect to MongoDB to get real IDs
  console.log('🔌 Connecting to MongoDB to fetch test entities...');
  await mongoose.connect(MONGO_URI);

  const Admin = mongoose.connection.collection('admins');
  const Master = mongoose.connection.collection('masters');
  const User = mongoose.connection.collection('users');
  const Trade = mongoose.connection.collection('trades');

  const admin = await Admin.findOne({ deleted_at: null });
  const master = await Master.findOne({ deleted_at: null, status: 'active' });
  const user = await User.findOne({ deleted_at: null, status: 'active' });

  if (!admin) { console.error('❌ No admin found in DB'); process.exit(1); }
  if (!master) { console.error('❌ No active master found in DB'); process.exit(1); }
  if (!user) { console.error('❌ No active user found in DB'); process.exit(1); }

  console.log(`  Admin: ${admin.username || admin.email} (${admin._id})`);
  console.log(`  Master: ${master.username} (${master._id})`);
  console.log(`  User: ${user.username} (${user._id})`);

  // Generate tokens using the same secret the server uses
  const adminToken = admin.active_token || jwt.sign({ id: admin._id.toString(), role: 'admin' }, JWT_SECRET);
  const masterToken = master.active_token || jwt.sign({ id: master._id.toString(), role: 'master' }, JWT_SECRET);
  const userToken = user.active_token || jwt.sign({ id: user._id.toString(), role: 'user' }, JWT_SECRET);

  const adminAuth = { Authorization: `Bearer ${adminToken}` };
  const masterAuth = { Authorization: `Bearer ${masterToken}` };
  const userAuth = { Authorization: `Bearer ${userToken}` };
  const anyAuth = adminAuth; // authenticateAny accepts any role

  // Get a sample child master and user under this master for path-param endpoints
  const childMaster = await Master.findOne({ parent_id: master._id, deleted_at: null });
  const childUser = await User.findOne({ master_id: master._id, deleted_at: null });
  const sampleTrade = await Trade.findOne({ deleted_at: null });

  await mongoose.disconnect();
  console.log('✅ MongoDB disconnected. Starting tests...\n');

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC ENDPOINTS (No Auth)
  // ═══════════════════════════════════════════════════════════════
  console.log('─── PUBLIC ENDPOINTS ──────────────────────────────────────────');

  await timedRequest('get', '/', { label: 'Health Check' });
  await timedRequest('get', '/api/kite/auth-status', { label: 'Kite Auth Status (simple)' });
  await timedRequest('get', '/api/kite/auth/status', { label: 'Kite Auth Status (detailed)' });
  await timedRequest('get', '/api/servers/', { label: 'Get All Servers' });
  await timedRequest('get', '/api/servers/search', { params: { name: 'test' }, label: 'Search Servers' });

  // ═══════════════════════════════════════════════════════════════
  // AUTH ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── AUTH ENDPOINTS ────────────────────────────────────────────');

  // Login with bad creds to measure auth speed without side effects
  await timedRequest('post', '/api/auth/login', { data: { username: 'perf_test_dummy', password: 'wrong' }, label: 'Login (invalid creds - measures auth pipeline)' });
  await timedRequest('get', '/api/auth/notification-settings', { headers: anyAuth, label: 'Get Notification Settings' });
  await timedRequest('post', '/api/auth/change-password', { headers: anyAuth, data: { currentPassword: 'dummy', newPassword: 'dummy2' }, label: 'Change Password (bad current pwd)' });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── ADMIN ENDPOINTS ───────────────────────────────────────────');

  await timedRequest('get', '/api/admin/profile', { headers: adminAuth, label: 'Admin Profile' });
  await timedRequest('get', '/api/admin/users', { headers: adminAuth, label: 'Admin Get All Users' });
  await timedRequest('get', '/api/admin/grouped-quantities', { headers: adminAuth, label: 'Admin Get Grouped Quantities' });
  await timedRequest('get', '/api/admin/script-quantities', { headers: adminAuth, label: 'Admin Get Script Quantities' });
  await timedRequest('get', '/api/admin/brokerage-settings', { headers: adminAuth, label: 'Admin Get Brokerage Settings' });
  await timedRequest('get', '/api/admin/announcements/active', { headers: anyAuth, label: 'Get Active Announcement' });
  await timedRequest('get', '/api/admin/fresh-stoploss-limits', { headers: adminAuth, label: 'Admin Get Fresh Stoploss Limits' });
  await timedRequest('get', '/api/admin/totp/status', { headers: adminAuth, label: 'Admin TOTP Status' });
  await timedRequest('get', '/api/admin/instruments', { headers: adminAuth, label: 'Admin List Instruments' });
  await timedRequest('get', '/api/admin/instruments/segments', { headers: adminAuth, label: 'Admin Instrument Segments' });
  await timedRequest('get', '/api/admin/settlement/status', { headers: adminAuth, label: 'Admin Settlement Status' });
  await timedRequest('get', '/api/admin/wallet', { headers: adminAuth, label: 'Admin Get Wallet' });
  await timedRequest('get', '/api/admin/wallet/reconcile', { headers: adminAuth, label: 'Admin Wallet Reconcile' });

  // ═══════════════════════════════════════════════════════════════
  // MASTER FLOW ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── MASTER FLOW ENDPOINTS ─────────────────────────────────────');

  await timedRequest('get', '/api/master/wallet', { headers: masterAuth, label: 'Master Get Wallet' });
  await timedRequest('get', '/api/master/username/generate', { headers: masterAuth, label: 'Master Generate Username' });
  await timedRequest('get', '/api/master/masters', { headers: masterAuth, label: 'Master Get Child Masters' });
  await timedRequest('get', '/api/master/users', { headers: masterAuth, label: 'Master Get Users' });
  await timedRequest('get', '/api/master/trades', { headers: masterAuth, label: 'Master Get Trades' });
  await timedRequest('get', '/api/master/transactions', { headers: masterAuth, label: 'Master Get Transactions' });
  await timedRequest('get', '/api/master/positions/aggregated', { headers: masterAuth, label: 'Master Aggregated Positions' });
  await timedRequest('get', '/api/master/positions/user-metrics', { headers: masterAuth, label: 'Master User Metrics' });
  await timedRequest('get', '/api/master/positions/admin-master-metrics', { headers: masterAuth, label: 'Master Admin Metrics' });
  await timedRequest('get', '/api/master/positions/bulk-equity', { headers: masterAuth, label: 'Master Bulk Equity' });
  await timedRequest('get', '/api/master/positions/live-metrics', { headers: masterAuth, label: 'Master Live Metrics' });
  await timedRequest('get', '/api/master/pnl-summary', { headers: masterAuth, label: 'Master PnL Summary' });
  await timedRequest('get', '/api/master/weekly-admin-report', { headers: masterAuth, label: 'Master Weekly Admin Report' });
  await timedRequest('get', '/api/master/settlement-report', { headers: masterAuth, label: 'Master Settlement Report' });
  await timedRequest('get', '/api/master/sharing-details', { headers: masterAuth, label: 'Master Sharing Details' });
  await timedRequest('get', '/api/master/login-history', { headers: masterAuth, label: 'Master Login History' });

  if (childMaster) {
    const cmId = childMaster._id.toString();
    await timedRequest('get', `/api/master/masters/${cmId}`, { headers: masterAuth, label: 'Master Get Child Master By ID' });
    await timedRequest('get', `/api/master/masters/${cmId}/position`, { headers: masterAuth, label: 'Master Get Child Master Position' });
  }

  if (childUser) {
    const cuId = childUser._id.toString();
    await timedRequest('get', `/api/master/users/${cuId}`, { headers: masterAuth, label: 'Master Get User By ID' });
    await timedRequest('get', `/api/master/users/${cuId}/position`, { headers: masterAuth, label: 'Master Get User Position' });
  }

  // ═══════════════════════════════════════════════════════════════
  // MASTERS CRUD ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── MASTERS CRUD ENDPOINTS ────────────────────────────────────');

  await timedRequest('get', '/api/masters/', { headers: adminAuth, label: 'Get All Masters' });
  await timedRequest('get', '/api/masters/trades/all', { headers: adminAuth, label: 'Get All Master Trades' });
  if (master) {
    await timedRequest('get', `/api/masters/${master._id}`, { headers: adminAuth, label: 'Get Master By ID' });
    await timedRequest('get', `/api/masters/${master._id}/position`, { headers: adminAuth, label: 'Get Master Position' });
    await timedRequest('get', `/api/masters/${master._id}/account-limit`, { headers: adminAuth, label: 'Get Master Account Limit' });
  }

  // ═══════════════════════════════════════════════════════════════
  // USER ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── USER ENDPOINTS ────────────────────────────────────────────');

  await timedRequest('get', `/api/users/${user._id}`, { headers: userAuth, label: 'User Get Profile' });
  await timedRequest('get', `/api/users/${user._id}/trades`, { headers: userAuth, label: 'User Get Trades' });

  // ═══════════════════════════════════════════════════════════════
  // KITE ENDPOINTS (authenticated)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── KITE ENDPOINTS ────────────────────────────────────────────');

  await timedRequest('get', '/api/kite/instruments/categories', { headers: anyAuth, label: 'Kite Get Categories' });
  await timedRequest('get', '/api/kite/instruments/search', { headers: anyAuth, params: { q: 'RELIANCE' }, label: 'Kite Instrument Search (RELIANCE)' });
  await timedRequest('get', '/api/kite/instruments/smart-search', { headers: anyAuth, params: { q: 'NIFTY' }, label: 'Kite Smart Search (NIFTY)' });
  await timedRequest('get', '/api/kite/instruments/browse', { headers: anyAuth, params: { exchange: 'NSE' }, label: 'Kite Browse Instruments (NSE)' });
  await timedRequest('get', '/api/kite/quotes/latest', { headers: anyAuth, label: 'Kite Latest Quotes' });
  await timedRequest('get', '/api/kite/profile', { headers: anyAuth, label: 'Kite Profile' });

  // ═══════════════════════════════════════════════════════════════
  // WATCHLIST ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── WATCHLIST ENDPOINTS ───────────────────────────────────────');

  await timedRequest('get', '/api/watchlist/', { headers: anyAuth, label: 'Get Watchlist' });

  // ═══════════════════════════════════════════════════════════════
  // TRADE ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── TRADE ENDPOINTS ───────────────────────────────────────────');

  await timedRequest('get', '/api/trade/metrics', { headers: userAuth, label: 'Trade Get Metrics' });
  await timedRequest('get', '/api/trade/positions', { headers: userAuth, label: 'Trade Get Positions' });
  await timedRequest('get', '/api/trade/brokerage-rules', { headers: userAuth, label: 'Trade Get Brokerage Rules' });
  await timedRequest('get', '/api/trade/report', { headers: userAuth, label: 'Trade Report' });
  await timedRequest('get', '/api/trade/open-positions', { headers: userAuth, label: 'Trade Open Positions' });
  await timedRequest('get', '/api/trade/settlement-history', { headers: userAuth, label: 'Trade Settlement History' });
  await timedRequest('get', '/api/trade/userwise-positions', { headers: masterAuth, label: 'Trade Userwise Positions' });
  await timedRequest('get', '/api/trade/script-qty-details', { headers: anyAuth, label: 'Trade Script Qty Details' });
  await timedRequest('get', '/api/trade/script-qty-all-lots', { headers: anyAuth, label: 'Trade Script Qty All Lots' });
  await timedRequest('get', '/api/trade/deleted-trades', { headers: anyAuth, label: 'Trade Deleted Trades' });
  await timedRequest('get', '/api/trade/rejection-log', { headers: anyAuth, label: 'Trade Rejection Log' });

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── MESSAGE ENDPOINTS ─────────────────────────────────────────');

  await timedRequest('get', '/api/master/messages/', { headers: masterAuth, label: 'Master Get Messages' });

  // ═══════════════════════════════════════════════════════════════
  // MISC INLINE ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n─── MISC ENDPOINTS ────────────────────────────────────────────');

  await timedRequest('get', '/api/my/login-history', { headers: anyAuth, label: 'My Login History' });
  await timedRequest('get', '/api/account-summary', { headers: anyAuth, label: 'Account Summary' });

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  PERFORMANCE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const successful = results.filter(r => typeof r.status === 'number');
  const failed = results.filter(r => typeof r.status !== 'number');
  const times = successful.map(r => r.responseTime);

  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
  const p99 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.99)];
  const max = Math.max(...times);
  const min = Math.min(...times);

  console.log(`  Total endpoints tested: ${results.length}`);
  console.log(`  Successful (HTTP response): ${successful.length}`);
  console.log(`  Failed (network/timeout): ${failed.length}`);
  console.log('');
  console.log(`  Average response time: ${avg}ms`);
  console.log(`  Median response time:  ${median}ms`);
  console.log(`  P95 response time:     ${p95}ms`);
  console.log(`  P99 response time:     ${p99}ms`);
  console.log(`  Min response time:     ${min}ms`);
  console.log(`  Max response time:     ${max}ms`);

  // Slow endpoints (>1s)
  const slow = results.filter(r => r.responseTime > 1000).sort((a, b) => b.responseTime - a.responseTime);
  if (slow.length > 0) {
    console.log(`\n  🐌 SLOW ENDPOINTS (>1000ms): ${slow.length}`);
    console.log('  ─────────────────────────────────────────────────────');
    slow.forEach(r => {
      console.log(`  ${r.responseTime.toString().padStart(5)}ms | ${String(r.status).padStart(3)} | ${r.label}`);
    });
  }

  // Medium endpoints (500-1000ms)
  const medium = results.filter(r => r.responseTime > 500 && r.responseTime <= 1000).sort((a, b) => b.responseTime - a.responseTime);
  if (medium.length > 0) {
    console.log(`\n  🟡 MEDIUM ENDPOINTS (500–1000ms): ${medium.length}`);
    console.log('  ─────────────────────────────────────────────────────');
    medium.forEach(r => {
      console.log(`  ${r.responseTime.toString().padStart(5)}ms | ${String(r.status).padStart(3)} | ${r.label}`);
    });
  }

  // Fast endpoints (<500ms)
  const fast = results.filter(r => r.responseTime <= 500);
  console.log(`\n  🟢 FAST ENDPOINTS (<500ms): ${fast.length}`);

  // Status code breakdown
  console.log('\n  📊 STATUS CODE BREAKDOWN:');
  const statusGroups = {};
  results.forEach(r => {
    const key = typeof r.status === 'number' ? `${Math.floor(r.status / 100)}xx` : r.status;
    statusGroups[key] = (statusGroups[key] || 0) + 1;
  });
  Object.entries(statusGroups).sort().forEach(([code, count]) => {
    console.log(`     ${code}: ${count} endpoints`);
  });

  // Errors
  if (failed.length > 0) {
    console.log('\n  ❌ FAILED REQUESTS:');
    failed.forEach(r => {
      console.log(`     ${r.label}: ${r.error}`);
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Completed at: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
