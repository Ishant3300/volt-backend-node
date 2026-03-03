/**
 * Test Limit Order Execution Logic
 * 
 * Simulates price updates to verify order matching logic
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const orderBookService = require('../src/services/orderBookService');
const Trade = require('../src/models/Trade');

async function testLimitOrderLogic() {
  try {
    console.log('🧪 Testing Limit Order Execution Logic\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected\n');

    // Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available');
      process.exit(1);
    }
    
    console.log('✅ Redis is available\n');

    // Get pending orders for GIFT NIFTY (token 291849)
    const instrumentToken = '291849';
    console.log(`📋 Checking pending orders for token ${instrumentToken}...\n`);

    const pendingOrders = await Trade.find({
      instrument_token: instrumentToken,
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ price: 1 });

    if (pendingOrders.length === 0) {
      console.log('   No pending orders found');
      process.exit(0);
    }

    console.log(`Found ${pendingOrders.length} pending orders:\n`);
    pendingOrders.forEach((order, idx) => {
      console.log(`${idx + 1}. ${order.transaction_type} ${order.quantity} @ ${order.price}`);
      console.log(`   ID: ${order._id}`);
      console.log(`   Created: ${order.created_at?.toLocaleString() || 'N/A'}`);
    });
    console.log('');

    // Test different price scenarios
    const testPrices = [
      24360,  // Below all orders
      24371.69, // Exactly at lowest order
      24380,  // Between orders
      24390.69, // Exactly at highest order
      24400,  // Above all orders
    ];

    console.log('🧪 Testing order matching logic:\n');

    for (const testPrice of testPrices) {
      console.log(`\n📊 Test Price: ${testPrice}`);
      console.log('─'.repeat(50));

      // Get matching BUY orders
      const matchingBuys = await orderBookService.getMatchingBuyOrders(instrumentToken, testPrice);
      
      console.log(`   Matching BUY orders: ${matchingBuys.length}`);
      
      if (matchingBuys.length > 0) {
        console.log('   Orders that would execute:');
        for (const tradeId of matchingBuys) {
          const order = pendingOrders.find(o => o._id.toString() === tradeId);
          if (order) {
            console.log(`      ✅ ${order.transaction_type} ${order.quantity} @ ${order.price}`);
            console.log(`         Reason: Live price ${testPrice} <= Limit price ${order.price}`);
          }
        }
      } else {
        console.log('   ❌ No orders would execute');
        console.log(`      Reason: Live price ${testPrice} is above all BUY limit prices`);
      }
    }

    console.log('\n\n📝 Explanation of BUY order logic:');
    console.log('   A BUY limit order executes when: livePrice <= limitPrice');
    console.log('   This means the buyer can get the stock at or below their desired price.');
    console.log('');
    console.log('   Example:');
    console.log('   - Order: BUY @ 24390.69 (buyer willing to pay up to 24390.69)');
    console.log('   - If live price = 24380 → EXECUTE (buyer gets better price)');
    console.log('   - If live price = 24400 → WAIT (price too high)');
    console.log('');

    // Check current state in Redis
    console.log('📊 Current Redis state:');
    const client = redisService.getClient();
    const buyKey = `ob:${instrumentToken}:buy`;
    const allOrders = await client.zrange(buyKey, 0, -1, 'WITHSCORES');
    
    console.log(`   Key: ${buyKey}`);
    console.log(`   Orders: ${allOrders.length / 2}`);
    for (let i = 0; i < allOrders.length; i += 2) {
      const tradeId = allOrders[i];
      const price = allOrders[i + 1];
      console.log(`      ${tradeId} @ ${price}`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

testLimitOrderLogic();
