/**
 * Check Redis Order Book State
 * 
 * Verifies what's actually in Redis using the correct key pattern
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const Trade = require('../src/models/Trade');

async function checkRedisOrders() {
  try {
    console.log('🔍 Checking Redis Order Book State\n');

    // 1. Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected\n');

    // 2. Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available');
      process.exit(1);
    }
    
    console.log('✅ Redis is available\n');
    const client = redisService.getClient();

    // 3. Get all Redis keys with the correct pattern
    console.log('📋 Checking Redis keys with pattern "ob:*"...');
    const allKeys = await client.keys('ob:*');
    console.log(`   Found ${allKeys.length} keys in Redis\n`);

    if (allKeys.length > 0) {
      console.log('   Keys found:');
      for (const key of allKeys) {
        const count = await client.zcard(key);
        const members = await client.zrange(key, 0, -1, 'WITHSCORES');
        console.log(`   ${key}: ${count} orders`);
        
        // Print members with scores
        for (let i = 0; i < members.length; i += 2) {
          const tradeId = members[i];
          const price = members[i + 1];
          console.log(`      - Trade ${tradeId} @ price ${price}`);
        }
      }
      console.log('');
    } else {
      console.log('   ⚠️  No order book keys found in Redis!\n');
    }

    // 4. Check pending orders in database
    console.log('📋 Checking pending LIMIT orders in database...');
    const pendingOrders = await Trade.find({
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ created_at: -1 });

    console.log(`   Found ${pendingOrders.length} pending LIMIT orders in DB\n`);

    if (pendingOrders.length > 0) {
      console.log('   Pending orders:');
      for (const order of pendingOrders) {
        console.log(`   - ${order.tradingsymbol} ${order.transaction_type} ${order.quantity} @ ${order.price}`);
        console.log(`     Token: ${order.instrument_token}`);
        console.log(`     ID: ${order._id}`);
        console.log(`     Created: ${order.created_at?.toLocaleString() || 'N/A'}`);
        
        // Check if this order exists in Redis
        const expectedKey = order.transaction_type === 'BUY' 
          ? `ob:${order.instrument_token}:buy`
          : `ob:${order.instrument_token}:sell`;
        
        const score = await client.zscore(expectedKey, order._id.toString());
        
        if (score !== null) {
          console.log(`     ✅ Found in Redis at key "${expectedKey}" with score ${score}`);
        } else {
          console.log(`     ❌ NOT found in Redis (expected key: "${expectedKey}")`);
        }
        console.log('');
      }
    }

    // 5. Summary
    console.log('📊 Summary:');
    console.log(`   Redis keys: ${allKeys.length}`);
    console.log(`   DB pending orders: ${pendingOrders.length}`);
    
    if (allKeys.length === 0 && pendingOrders.length > 0) {
      console.log('\n❌ PROBLEM: Orders exist in DB but Redis is empty!');
      console.log('   This means orders are NOT being added to Redis when created.');
      console.log('   Check if orderBookService.addOrder() is being called in tradeController.js');
    } else if (allKeys.length > 0 && pendingOrders.length === 0) {
      console.log('\n⚠️  WARNING: Redis has keys but no pending orders in DB');
      console.log('   Redis may have stale data. Consider clearing Redis.');
    } else if (allKeys.length === 0 && pendingOrders.length === 0) {
      console.log('\n✅ Both Redis and DB are empty (no pending orders)');
    } else {
      console.log('\n✅ Both Redis and DB have data');
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

checkRedisOrders();
