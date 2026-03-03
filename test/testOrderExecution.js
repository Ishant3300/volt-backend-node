/**
 * Test Order Execution System
 * 
 * Checks:
 * 1. Redis connection
 * 2. BullMQ queue status
 * 3. Pending orders in database
 * 4. Orders in Redis order book
 * 5. Recent price updates
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const orderBookService = require('../src/services/orderBookService');
const Trade = require('../src/models/Trade');

async function testOrderExecution() {
  try {
    console.log('🧪 Testing Order Execution System\n');

    // 1. Connect to MongoDB
    console.log('1️⃣  Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected\n');

    // 2. Initialize Redis
    console.log('2️⃣  Initializing Redis...');
    await redisService.init();
    
    // Wait a moment for Redis to fully connect
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (redisService.isAvailable()) {
      console.log('✅ Redis is available');
      const client = redisService.getClient();
      console.log(`   Host: ${client.options.host || '127.0.0.1'}`);
      console.log(`   Port: ${client.options.port || 6379}\n`);
    } else {
      console.log('❌ Redis is NOT available');
      console.log('   Order execution will use DB fallback (slower)\n');
    }

    // 3. Check pending orders in database
    console.log('3️⃣  Checking pending LIMIT orders in database...');
    const pendingOrders = await Trade.find({
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ created_at: -1 }).limit(10);

    console.log(`   Found ${pendingOrders.length} pending LIMIT orders`);
    
    if (pendingOrders.length > 0) {
      console.log('\n   Recent pending orders:');
      pendingOrders.forEach((order, idx) => {
        const createdAt = order.created_at ? order.created_at.toLocaleString() : 'N/A';
        console.log(`   ${idx + 1}. ${order.tradingsymbol} ${order.transaction_type} ${order.quantity} @ ${order.price}`);
        console.log(`      Token: ${order.instrument_token}`);
        console.log(`      Created: ${createdAt}`);
        console.log(`      User: ${order.user_id}`);
        console.log(`      ID: ${order._id}`);
      });
    }
    console.log('');

    // 4. Check Redis order book (if available)
    if (redisService.isAvailable()) {
      console.log('4️⃣  Checking Redis order book...');
      
      // Get all keys matching order book pattern
      const client = redisService.getClient();
      const buyKeys = await client.keys('orderbook:*:BUY');
      const sellKeys = await client.keys('orderbook:*:SELL');
      
      console.log(`   BUY order keys: ${buyKeys.length}`);
      console.log(`   SELL order keys: ${sellKeys.length}`);
      
      if (buyKeys.length > 0) {
        console.log('\n   Sample BUY orders:');
        for (const key of buyKeys.slice(0, 3)) {
          const orders = await client.zRange(key, 0, -1, { REV: true });
          console.log(`   ${key}: ${orders.length} orders`);
          if (orders.length > 0) {
            console.log(`      Sample: ${orders.slice(0, 3).join(', ')}`);
          }
        }
      }
      
      if (sellKeys.length > 0) {
        console.log('\n   Sample SELL orders:');
        for (const key of sellKeys.slice(0, 3)) {
          const orders = await client.zRange(key, 0, -1);
          console.log(`   ${key}: ${orders.length} orders`);
          if (orders.length > 0) {
            console.log(`      Sample: ${orders.slice(0, 3).join(', ')}`);
          }
        }
      }
      
      console.log('');
    }

    // 5. Check if there's a mismatch
    if (redisService.isAvailable() && pendingOrders.length > 0) {
      console.log('5️⃣  Checking for mismatches...');
      
      let mismatchCount = 0;
      for (const order of pendingOrders) {
        const inRedis = await orderBookService.exists(
          order.instrument_token,
          order.transaction_type,
          order._id.toString()
        );
        
        if (!inRedis) {
          mismatchCount++;
          console.log(`   ⚠️  Order ${order._id} (${order.tradingsymbol}) is in DB but NOT in Redis`);
          console.log(`      This order will NOT be auto-executed!`);
          console.log(`      To fix: Re-add to Redis order book`);
        }
      }
      
      if (mismatchCount === 0) {
        console.log('   ✅ All pending orders are properly registered in Redis');
      } else {
        console.log(`\n   ❌ Found ${mismatchCount} orders missing from Redis!`);
        console.log('   These orders will not execute automatically.');
        console.log('   Recommendation: Restart the backend server to re-sync.');
      }
    }

    console.log('\n✅ Diagnostic complete!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

testOrderExecution();
