/**
 * Comprehensive Diagnostic for Order Execution Issue
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const orderBookService = require('../src/services/orderBookService');
const { Queue } = require('bullmq');

async function diagnoseIssue() {
  try {
    console.log('🔍 COMPREHENSIVE DIAGNOSTIC\n');
    console.log('═'.repeat(60));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available - THIS IS THE PROBLEM!');
      process.exit(1);
    }
    
    console.log('✅ Redis is available');
    console.log('═'.repeat(60));
    console.log('');

    // 1. Check the specific order
    const Trade = require('../src/models/Trade');
    const instrumentToken = '291849';
    const currentPrice = 24359.50;
    const orderPrice = 24360.69;

    console.log('📊 SCENARIO:');
    console.log(`   Instrument: GIFT NIFTY (${instrumentToken})`);
    console.log(`   Order: BUY limit @ ${orderPrice}`);
    console.log(`   Current Price: ${currentPrice}`);
    console.log(`   Should Execute: ${currentPrice <= orderPrice ? '✅ YES' : '❌ NO'}`);
    console.log('');

    // 2. Check if order exists in DB
    console.log('1️⃣  DATABASE CHECK:');
    const pendingOrders = await Trade.find({
      instrument_token: instrumentToken,
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    });

    console.log(`   Found ${pendingOrders.length} pending orders in DB`);
    pendingOrders.forEach(order => {
      console.log(`   - ${order.transaction_type} ${order.quantity} @ ${order.price} (ID: ${order._id})`);
    });
    console.log('');

    // 3. Check if order exists in Redis
    console.log('2️⃣  REDIS ORDER BOOK CHECK:');
    const client = redisService.getClient();
    const buyKey = `ob:${instrumentToken}:buy`;
    const ordersInRedis = await client.zrange(buyKey, 0, -1, 'WITHSCORES');
    
    console.log(`   Key: ${buyKey}`);
    console.log(`   Orders in Redis: ${ordersInRedis.length / 2}`);
    for (let i = 0; i < ordersInRedis.length; i += 2) {
      const tradeId = ordersInRedis[i];
      const price = parseFloat(ordersInRedis[i + 1]);
      console.log(`   - ${tradeId} @ ${price}`);
    }
    console.log('');

    // 4. Test matching logic
    console.log('3️⃣  MATCHING LOGIC TEST:');
    const matchingOrders = await orderBookService.getMatchingBuyOrders(instrumentToken, currentPrice);
    console.log(`   Price: ${currentPrice}`);
    console.log(`   Matching orders: ${matchingOrders.length}`);
    matchingOrders.forEach(id => {
      const order = pendingOrders.find(o => o._id.toString() === id);
      if (order) {
        console.log(`   ✅ Would execute: ${order.transaction_type} ${order.quantity} @ ${order.price}`);
      }
    });
    console.log('');

    // 5. Check BullMQ queue
    console.log('4️⃣  BULLMQ QUEUE CHECK:');
    const connection = {
      host: client.options.host || '127.0.0.1',
      port: client.options.port || 6379,
      maxRetriesPerRequest: null,
    };
    const queue = new Queue('price-updates', { connection });
    
    const counts = await queue.getJobCounts();
    console.log(`   Waiting: ${counts.waiting}`);
    console.log(`   Active: ${counts.active}`);
    console.log(`   Completed: ${counts.completed}`);
    console.log(`   Failed: ${counts.failed}`);
    
    // Check recent jobs for this instrument
    const completed = await queue.getCompleted(0, 50);
    const relevantJobs = completed.filter(job => 
      job.data.instrument_token === instrumentToken
    );
    
    console.log(`   Recent jobs for token ${instrumentToken}: ${relevantJobs.length}`);
    if (relevantJobs.length > 0) {
      const latest = relevantJobs[0];
      const timestamp = new Date(latest.data.timestamp).toLocaleString();
      console.log(`   Latest: Price ${latest.data.live_price} at ${timestamp}`);
    } else {
      console.log('   ⚠️  No recent price updates for this instrument!');
      console.log('   This means either:');
      console.log('   - WebSocket is not connected');
      console.log('   - Instrument is not subscribed');
      console.log('   - No price ticks received from Kite');
    }
    
    await queue.close();
    console.log('');

    // 6. Summary and diagnosis
    console.log('═'.repeat(60));
    console.log('📋 DIAGNOSIS:');
    console.log('═'.repeat(60));
    
    if (pendingOrders.length === 0) {
      console.log('❌ No pending orders in database');
    } else if (ordersInRedis.length === 0) {
      console.log('❌ Orders in DB but NOT in Redis order book');
      console.log('   FIX: Restart backend server to re-sync');
    } else if (matchingOrders.length === 0) {
      console.log('❌ Orders in Redis but matching logic returns 0 results');
      console.log('   This should not happen - check orderBookService logic');
    } else if (relevantJobs.length === 0) {
      console.log('❌ No price updates being processed for this instrument');
      console.log('   PROBLEM: WebSocket is not sending price updates');
      console.log('   CHECK:');
      console.log('   1. Is backend server running?');
      console.log('   2. Is Kite WebSocket connected?');
      console.log('   3. Is instrument subscribed in watchlist?');
      console.log('   4. Is market open?');
    } else {
      const latestPrice = relevantJobs[0].data.live_price;
      if (latestPrice > orderPrice) {
        console.log(`✅ System is working correctly`);
        console.log(`   Latest price (${latestPrice}) is above limit (${orderPrice})`);
        console.log(`   Order will execute when price drops to ${orderPrice} or below`);
      } else {
        console.log('❌ CRITICAL BUG FOUND:');
        console.log(`   Latest price (${latestPrice}) is at/below limit (${orderPrice})`);
        console.log(`   Order SHOULD have executed but didn't`);
        console.log('   POSSIBLE CAUSES:');
        console.log('   1. Worker is not running (check priceQueueService.init())');
        console.log('   2. Worker is crashing (check failed jobs)');
        console.log('   3. Price update happened before order was added to Redis');
      }
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

diagnoseIssue();
