/**
 * Manually sync pending orders from MongoDB to Redis
 * 
 * Run this if orders are stuck in "pending" status
 */

require('dotenv').config();
const mongoose = require('mongoose');
const redisService = require('../src/services/redisService');
const orderBookService = require('../src/services/orderBookService');

async function syncOrders() {
  try {
    console.log('🔄 Syncing pending orders to Redis...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is not available!');
      process.exit(1);
    }
    
    console.log('✅ Redis connected\n');

    // Sync from database
    await orderBookService.syncFromDatabase();

    console.log('\n✅ Sync complete!');
    console.log('   Pending orders are now in Redis and will auto-execute when price is hit.');
    
  } catch (error) {
    console.error('\n❌ Sync failed:', error);
  } finally {
    await mongoose.disconnect();
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

syncOrders();
