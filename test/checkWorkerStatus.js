/**
 * Check if BullMQ worker is running in the main server
 */

require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const redisService = require('../src/services/redisService');

async function checkWorkerStatus() {
  try {
    console.log('🔍 Checking BullMQ Worker Status\n');

    await redisService.init();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!redisService.isAvailable()) {
      console.log('❌ Redis is NOT available');
      process.exit(1);
    }

    const connection = {
      host: redisService.getClient().options.host || '127.0.0.1',
      port: redisService.getClient().options.port || 6379,
      maxRetriesPerRequest: null,
    };

    const queue = new Queue('price-updates', { connection });

    // Get worker information
    console.log('📋 Checking for active workers...\n');

    const workers = await queue.getWorkers();
    console.log(`Active workers: ${workers.length}`);
    
    if (workers.length === 0) {
      console.log('❌ NO WORKERS RUNNING!');
      console.log('');
      console.log('This is the problem! The BullMQ worker is not running.');
      console.log('');
      console.log('Possible causes:');
      console.log('1. Backend server not started');
      console.log('2. priceQueueService.init() not called');
      console.log('3. Worker crashed during initialization');
      console.log('4. Redis connection failed');
      console.log('');
      console.log('Solution:');
      console.log('1. Make sure backend server is running: node src/index.js');
      console.log('2. Check server logs for "✅ [PriceQueue] Queue and worker initialised"');
      console.log('3. If not present, check for errors during startup');
    } else {
      console.log('✅ Workers are running:');
      workers.forEach((worker, idx) => {
        console.log(`   ${idx + 1}. Worker ID: ${worker.id}`);
        console.log(`      Name: ${worker.name || 'N/A'}`);
      });
      console.log('');
      console.log('Workers are running, but jobs aren\'t being processed.');
      console.log('This suggests the worker is stuck or the job processor is failing silently.');
    }

    // Try to add a test job and see if it gets picked up
    console.log('\n🧪 Publishing test job...');
    await queue.add('TEST_JOB', {
      instrument_token: 'TEST_TOKEN',
      live_price: 12345,
      timestamp: Date.now(),
    }, {
      jobId: `test_${Date.now()}`,
      removeOnComplete: 10,
      removeOnFail: 10,
    });
    console.log('✅ Test job published');
    console.log('');

    console.log('⏳ Waiting 3 seconds to see if worker picks it up...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const counts = await queue.getJobCounts();
    console.log('\nJob counts after test:');
    console.log(`   Waiting: ${counts.waiting}`);
    console.log(`   Active: ${counts.active}`);
    console.log(`   Completed: ${counts.completed}`);
    console.log(`   Failed: ${counts.failed}`);

    if (counts.waiting > 0) {
      console.log('\n❌ Job is still WAITING - worker is NOT processing jobs!');
      console.log('   The worker exists but is not functioning.');
      console.log('   Check backend server logs for errors in _processJob function.');
    } else if (counts.completed > 0 || counts.failed > 0) {
      console.log('\n✅ Job was processed! Worker is functioning.');
      console.log('   The issue might be with the specific job or matching logic.');
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

checkWorkerStatus();
