/**
 * Manually Trigger Price Update
 * 
 * Simulates a price update to test if order execution works
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const priceQueueService = require('../src/services/priceQueueService');
const orderBookService = require('../src/services/orderBookService');

async function manualPriceUpdate() {
  try {
    console.log('🧪 Manual Price Update Test\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available');
      process.exit(1);
    }
    
    console.log('✅ Redis is available');

    // Initialize price queue service
    priceQueueService.init();
    console.log('✅ Price queue service initialized\n');

    // Wait for worker to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test with GIFT NIFTY token
    const instrumentToken = '291849';
    const testPrice = 24400; // Price that should trigger all orders

    console.log(`📊 Publishing price update:`);
    console.log(`   Token: ${instrumentToken}`);
    console.log(`   Price: ${testPrice}`);
    console.log('');

    // Check what orders should match
    const matchingBuys = await orderBookService.getMatchingBuyOrders(instrumentToken, testPrice);
    console.log(`   Expected to match: ${matchingBuys.length} BUY orders`);
    console.log('');

    // Publish the price update
    await priceQueueService.publishPriceUpdate(instrumentToken, testPrice);
    console.log('✅ Price update published to queue');
    console.log('');

    // Wait for processing
    console.log('⏳ Waiting 5 seconds for worker to process...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if orders were executed
    const Trade = require('../src/models/Trade');
    const stillPending = await Trade.find({
      instrument_token: instrumentToken,
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    });

    const recentlyCompleted = await Trade.find({
      instrument_token: instrumentToken,
      status: 'completed',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ executed_at: -1 }).limit(10);

    console.log('\n📊 Results:');
    console.log(`   Still pending: ${stillPending.length} orders`);
    console.log(`   Recently completed: ${recentlyCompleted.length} orders`);
    console.log('');

    if (recentlyCompleted.length > 0) {
      console.log('   Recently completed orders:');
      recentlyCompleted.forEach((order, idx) => {
        const executedAt = order.executed_at ? order.executed_at.toLocaleString() : 'N/A';
        console.log(`   ${idx + 1}. ${order.transaction_type} ${order.quantity} @ ${order.price}`);
        console.log(`      Executed at: ${executedAt}`);
        console.log(`      Executed price: ${order.executed_price}`);
      });
    }

    if (stillPending.length > 0) {
      console.log('\n   Still pending orders:');
      stillPending.forEach((order, idx) => {
        console.log(`   ${idx + 1}. ${order.transaction_type} ${order.quantity} @ ${order.price}`);
        console.log(`      ID: ${order._id}`);
      });
    }

    console.log('\n✅ Test complete!');
    console.log('   If orders are still pending, check:');
    console.log('   1. Worker logs for errors');
    console.log('   2. BullMQ job status (failed jobs)');
    console.log('   3. WebSocket connection to Flutter client');

  } catch (error) {
    console.error('\n❌ Error:', error);
  } finally {
    await priceQueueService.shutdown();
    await mongoose.disconnect();
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

manualPriceUpdate();
