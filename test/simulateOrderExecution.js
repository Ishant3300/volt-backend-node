/**
 * Simulate a complete order execution flow
 * This will manually trigger everything to see where it fails
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const priceQueueService = require('../src/services/priceQueueService');
const orderBookService = require('../src/services/orderBookService');

async function simulateOrderExecution() {
  try {
    console.log('🧪 SIMULATING ORDER EXECUTION\n');
    console.log('═'.repeat(60));

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

    // Initialize price queue service (this starts the worker)
    priceQueueService.init();
    console.log('✅ Price queue service initialized');
    console.log('═'.repeat(60));
    console.log('');

    // Wait for worker to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get a pending order
    const Trade = require('../src/models/Trade');
    const pendingOrders = await Trade.find({
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ created_at: -1 }).limit(1);

    if (pendingOrders.length === 0) {
      console.log('❌ No pending orders found');
      console.log('   Create a limit order in the app first');
      process.exit(0);
    }

    const order = pendingOrders[0];
    console.log('📋 Found pending order:');
    console.log(`   Symbol: ${order.tradingsymbol}`);
    console.log(`   Type: ${order.transaction_type}`);
    console.log(`   Quantity: ${order.quantity}`);
    console.log(`   Limit Price: ${order.price}`);
    console.log(`   Token: ${order.instrument_token}`);
    console.log(`   User ID: ${order.user_id}`);
    console.log(`   Order ID: ${order._id}`);
    console.log('');

    // Check if order is in Redis
    const client = redisService.getClient();
    const key = order.transaction_type === 'BUY' 
      ? `ob:${order.instrument_token}:buy`
      : `ob:${order.instrument_token}:sell`;
    
    const score = await client.zscore(key, order._id.toString());
    if (score === null) {
      console.log('❌ Order NOT found in Redis!');
      console.log(`   Expected key: ${key}`);
      console.log('   Adding it now...');
      await orderBookService.addOrder(
        order._id.toString(),
        order.instrument_token,
        order.price,
        order.transaction_type
      );
      console.log('✅ Order added to Redis');
      console.log('');
    } else {
      console.log(`✅ Order found in Redis at key: ${key}`);
      console.log(`   Score (price): ${score}`);
      console.log('');
    }

    // Determine a price that will trigger execution
    let triggerPrice;
    if (order.transaction_type === 'BUY') {
      // BUY executes when price <= limit
      triggerPrice = order.price - 1; // 1 rupee below limit
      console.log(`📊 Trigger price for BUY order: ${triggerPrice}`);
      console.log(`   (Current limit: ${order.price}, trigger is 1 below)`);
    } else {
      // SELL executes when price >= limit
      triggerPrice = order.price + 1; // 1 rupee above limit
      console.log(`📊 Trigger price for SELL order: ${triggerPrice}`);
      console.log(`   (Current limit: ${order.price}, trigger is 1 above)`);
    }
    console.log('');

    // Verify matching logic
    console.log('🔍 Testing matching logic...');
    const matchingOrders = order.transaction_type === 'BUY'
      ? await orderBookService.getMatchingBuyOrders(order.instrument_token, triggerPrice)
      : await orderBookService.getMatchingSellOrders(order.instrument_token, triggerPrice);
    
    console.log(`   Matching orders: ${matchingOrders.length}`);
    if (matchingOrders.includes(order._id.toString())) {
      console.log(`   ✅ Our order WILL match at price ${triggerPrice}`);
    } else {
      console.log(`   ❌ Our order will NOT match (logic error!)`);
    }
    console.log('');

    // Publish price update
    console.log(`⚡ Publishing price update: ${order.instrument_token} @ ${triggerPrice}`);
    await priceQueueService.publishPriceUpdate(order.instrument_token, triggerPrice);
    console.log('✅ Price update published to BullMQ queue');
    console.log('');

    // Wait for worker to process
    console.log('⏳ Waiting 5 seconds for worker to process...');
    console.log('   Watch for these logs:');
    console.log('   - 🔄 [PriceQueue] Processing price update');
    console.log('   - ⚡ [PriceQueue] X order(s) to execute');
    console.log('   - ✅ [PriceQueue] Executed...');
    console.log('   - 📤 [WS] Sent trade_executed...');
    console.log('');
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if order was executed
    const updatedOrder = await Trade.findById(order._id);
    
    console.log('═'.repeat(60));
    console.log('📊 RESULT:');
    console.log('═'.repeat(60));
    
    if (updatedOrder.status === 'completed') {
      console.log('✅ SUCCESS! Order was executed');
      console.log(`   Executed at: ${updatedOrder.executed_at}`);
      console.log(`   Executed price: ${updatedOrder.executed_price}`);
      console.log(`   P&L: ${updatedOrder.pnl}`);
      console.log('');
      console.log('🎉 The system is working correctly!');
      console.log('   If the Flutter app didn\'t update:');
      console.log('   1. Check if WebSocket is connected in Flutter');
      console.log('   2. Check if user authenticated (look for userId in backend logs)');
      console.log('   3. Restart Flutter app and try again');
    } else {
      console.log('❌ FAILED! Order is still pending');
      console.log(`   Current status: ${updatedOrder.status}`);
      console.log('');
      console.log('🔍 Possible causes:');
      console.log('   1. Worker is not running (check for "✅ [PriceQueue] Queue and worker initialised")');
      console.log('   2. Worker crashed (check for error logs above)');
      console.log('   3. Job failed silently (check BullMQ failed jobs)');
      console.log('');
      console.log('💡 Next steps:');
      console.log('   1. Check backend console for error messages');
      console.log('   2. Run: node test/checkBullMQ.js (check failed jobs)');
      console.log('   3. Restart backend server');
    }

  } catch (error) {
    console.error('\n❌ Error:', error);
    console.error(error.stack);
  } finally {
    await priceQueueService.shutdown();
    await mongoose.disconnect();
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

simulateOrderExecution();
