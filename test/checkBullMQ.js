/**
 * Check BullMQ Queue Status
 * 
 * Verifies if the price-updates queue is working and processing jobs
 */

require('dotenv').config();
const { Queue } = require('bullmq');
const redisService = require('../src/services/redisService');

async function checkBullMQ() {
  try {
    console.log('🔍 Checking BullMQ Queue Status\n');

    // Initialize Redis
    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available');
      process.exit(1);
    }
    
    console.log('✅ Redis is available\n');

    // Connect to the price-updates queue
    const connection = {
      host: redisService.getClient().options.host || '127.0.0.1',
      port: redisService.getClient().options.port || 6379,
      maxRetriesPerRequest: null,
    };

    const queue = new Queue('price-updates', { connection });

    console.log('📋 Queue: price-updates\n');

    // Get queue counts
    const counts = await queue.getJobCounts();
    console.log('Job Counts:');
    console.log(`   Waiting: ${counts.waiting}`);
    console.log(`   Active: ${counts.active}`);
    console.log(`   Completed: ${counts.completed}`);
    console.log(`   Failed: ${counts.failed}`);
    console.log(`   Delayed: ${counts.delayed}`);
    console.log('');

    // Get recent completed jobs
    console.log('Recent Completed Jobs (last 10):');
    const completed = await queue.getCompleted(0, 9);
    if (completed.length === 0) {
      console.log('   ⚠️  No completed jobs found');
      console.log('   This means either:');
      console.log('   1. No price updates have been received yet');
      console.log('   2. The worker is not running');
      console.log('   3. Jobs are being removed too quickly');
    } else {
      for (const job of completed) {
        const data = job.data;
        const timestamp = new Date(data.timestamp).toLocaleString();
        console.log(`   Job ${job.id}: Token ${data.instrument_token} @ ${data.live_price} (${timestamp})`);
      }
    }
    console.log('');

    // Get recent failed jobs
    console.log('Recent Failed Jobs (last 10):');
    const failed = await queue.getFailed(0, 9);
    if (failed.length === 0) {
      console.log('   ✅ No failed jobs');
    } else {
      for (const job of failed) {
        const data = job.data;
        const timestamp = new Date(data.timestamp).toLocaleString();
        console.log(`   Job ${job.id}: Token ${data.instrument_token} @ ${data.live_price} (${timestamp})`);
        console.log(`      Error: ${job.failedReason}`);
      }
    }
    console.log('');

    // Get waiting jobs
    console.log('Waiting Jobs (next 10):');
    const waiting = await queue.getWaiting(0, 9);
    if (waiting.length === 0) {
      console.log('   ✅ No jobs waiting (queue is empty)');
    } else {
      for (const job of waiting) {
        const data = job.data;
        const timestamp = new Date(data.timestamp).toLocaleString();
        console.log(`   Job ${job.id}: Token ${data.instrument_token} @ ${data.live_price} (${timestamp})`);
      }
    }
    console.log('');

    // Get active jobs
    console.log('Active Jobs (currently processing):');
    const active = await queue.getActive(0, 9);
    if (active.length === 0) {
      console.log('   ✅ No jobs currently processing');
    } else {
      for (const job of active) {
        const data = job.data;
        const timestamp = new Date(data.timestamp).toLocaleString();
        console.log(`   Job ${job.id}: Token ${data.instrument_token} @ ${data.live_price} (${timestamp})`);
      }
    }
    console.log('');

    // Summary
    console.log('📊 Summary:');
    if (counts.completed === 0 && counts.failed === 0 && counts.waiting === 0 && counts.active === 0) {
      console.log('   ❌ Queue is completely empty!');
      console.log('   This means price updates are NOT being published to the queue.');
      console.log('   Check if:');
      console.log('   1. Kite WebSocket is connected');
      console.log('   2. Instruments are subscribed');
      console.log('   3. livePriceService is calling publishPriceUpdate()');
    } else if (counts.waiting > 0 && counts.active === 0) {
      console.log('   ⚠️  Jobs are waiting but none are being processed!');
      console.log('   This means the BullMQ WORKER is NOT running.');
      console.log('   Check if priceQueueService.init() was called in index.js');
    } else if (counts.completed > 0) {
      console.log('   ✅ Queue is working! Jobs are being processed.');
    }

    await queue.close();

  } catch (error) {
    console.error('\n❌ Error:', error);
  } finally {
    if (redisService.isAvailable()) {
      await redisService.shutdown();
    }
    process.exit(0);
  }
}

checkBullMQ();
