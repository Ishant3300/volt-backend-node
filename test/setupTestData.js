/**
 * Setup script to fetch real server ID for testing
 * Run this first: node test/setupTestData.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

async function setup() {
  console.log('🔧 Setting up test data...\n');
  
  try {
    // 1. Login as admin
    console.log('1️⃣ Logging in as admin...');
    const loginResponse = await axios.post(`${BASE_URL}/auth/admin/login`, {
      username: 'admin',
      password: 'admin',
      server: 'test'
    });
    
    if (!loginResponse.data.success) {
      console.log('❌ Admin login failed');
      return;
    }
    
    const adminToken = loginResponse.data.data.token;
    console.log('✅ Admin logged in\n');
    
    // 2. Get servers
    console.log('2️⃣ Fetching servers...');
    const serversResponse = await axios.get(`${BASE_URL}/admin/servers`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    
    if (!serversResponse.data.success || serversResponse.data.data.servers.length === 0) {
      console.log('❌ No servers found. Creating one...');
      
      // Create a test server
      const createServerResponse = await axios.post(
        `${BASE_URL}/admin/servers`,
        {
          name: 'Test Server',
          host: 'localhost',
          port: 3000
        },
        {
          headers: { Authorization: `Bearer ${adminToken}` }
        }
      );
      
      if (createServerResponse.data.success) {
        const serverId = createServerResponse.data.data.id;
        console.log('✅ Server created:', serverId);
        console.log('\n📋 Use this server_id in your test:');
        console.log(`   server_id: '${serverId}'`);
      }
    } else {
      const serverId = serversResponse.data.data.servers[0].id;
      console.log('✅ Server found:', serverId);
      console.log('\n📋 Use this server_id in your test:');
      console.log(`   server_id: '${serverId}'`);
    }
    
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
  }
}

setup();
