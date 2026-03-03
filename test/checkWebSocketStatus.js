/**
 * Check if backend server is running and WebSocket is connected
 */

const http = require('http');

async function checkWebSocketStatus() {
  console.log('🔍 Checking Backend Server Status\n');

  // Check if server is running
  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/',
    method: 'GET',
    timeout: 5000
  };

  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      console.log('✅ Backend server is RUNNING');
      console.log(`   Status: ${res.statusCode}`);
      console.log(`   Port: 3000`);
      console.log('');

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('📋 NEXT STEPS:');
        console.log('   1. Check backend console logs for:');
        console.log('      - "✅ Connected to Kite WebSocket"');
        console.log('      - "📊 Subscribing to X tokens on Kite"');
        console.log('      - "📈 Received X tick(s)" (should see this frequently)');
        console.log('');
        console.log('   2. If you see "⚠️ Kite WebSocket closed" or no tick messages:');
        console.log('      - WebSocket connection is down');
        console.log('      - Restart the backend server');
        console.log('');
        console.log('   3. If you see ticks but not for token 291849:');
        console.log('      - GIFT NIFTY is not subscribed');
        console.log('      - Add it to watchlist in Flutter app');
        console.log('      - Or manually subscribe via WebSocket');
        console.log('');
        console.log('   4. If market is closed:');
        console.log('      - No live ticks will be received');
        console.log('      - Orders will execute when market opens');
        resolve();
      });
    });

    req.on('error', (err) => {
      console.log('❌ Backend server is NOT running');
      console.log(`   Error: ${err.message}`);
      console.log('');
      console.log('📋 TO FIX:');
      console.log('   1. Start the backend server:');
      console.log('      cd stocker-backend-node');
      console.log('      node src/index.js');
      console.log('');
      console.log('   2. The server will:');
      console.log('      - Connect to MongoDB');
      console.log('      - Connect to Redis');
      console.log('      - Initialize BullMQ worker');
      console.log('      - Connect to Kite WebSocket');
      console.log('      - Start processing price updates');
      resolve();
    });

    req.on('timeout', () => {
      console.log('❌ Backend server connection timeout');
      req.destroy();
      resolve();
    });

    req.end();
  });
}

checkWebSocketStatus().then(() => process.exit(0));
