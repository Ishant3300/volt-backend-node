/**
 * Manually trigger refreshClosePrices() for testing.
 * Usage: node scripts/test_refresh_close_prices.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const livePriceService = require('../src/services/livePriceService');

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Manually add some tokens to simulate subscribed tokens
    // (since no Flutter clients are connected, subscribedTokens will be empty)
    const KiteInstrument = require('../src/models/KiteInstrument');
    const testInstruments = await KiteInstrument.find({
      tradingsymbol: { $in: ['NIFTY26MARFUT', 'NIFTY 50'] },
      is_active: true
    });

    if (testInstruments.length === 0) {
      console.log('❌ No test instruments found in DB');
      return;
    }

    for (const inst of testInstruments) {
      const token = parseInt(inst.instrument_token);
      livePriceService.subscribedTokens.add(token);
      console.log(`📋 Added token: ${token} (${inst.exchange}:${inst.tradingsymbol})`);
    }

    console.log('');
    await livePriceService.refreshClosePrices();

    // Show what latestPrices map has now
    console.log('\n📊 latestPrices map after refresh:');
    for (const [key, val] of livePriceService.latestPrices) {
      console.log(`   ${key} → ${val}`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
