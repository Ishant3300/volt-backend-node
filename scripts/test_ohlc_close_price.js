/**
 * Test: Compare Kite OHLC API last_price vs Historical API daily candle close.
 * The historical daily candle close should match the official NSE settlement price.
 *
 * Usage: node scripts/test_ohlc_close_price.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const kiteService = require('../src/services/kiteService');
const KiteInstrument = require('../src/models/KiteInstrument');

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Pick a few known instruments
    const testSymbols = [
      { exchange: 'NFO', tradingsymbol: 'NIFTY26MARFUT' },
      { exchange: 'NSE', tradingsymbol: 'NIFTY 50' },
    ];

    // Look up instrument tokens from DB
    const instruments = [];
    for (const s of testSymbols) {
      const inst = await KiteInstrument.findOne({
        exchange: s.exchange,
        tradingsymbol: s.tradingsymbol,
        is_active: true
      });
      if (inst) {
        instruments.push(inst);
        console.log(`✅ Found: ${s.exchange}:${s.tradingsymbol} → token ${inst.instrument_token}`);
      } else {
        console.log(`❌ Not found: ${s.exchange}:${s.tradingsymbol}`);
      }
    }

    if (instruments.length === 0) {
      console.log('No instruments found. Exiting.');
      return;
    }

    // 1. OHLC API
    const instrumentKeys = instruments.map(i => `${i.exchange}:${i.tradingsymbol}`);
    console.log('\n📡 Fetching OHLC quotes...');
    const ohlcQuotes = await kiteService.getMarketQuotes(instrumentKeys, 'ohlc');

    // 2. Historical daily candle (last trading day)
    // Use today and yesterday to get the latest daily candle
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3); // go back 3 days to cover weekends

    const formatDate = (d) => {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    console.log('\n📡 Fetching historical daily candles...');
    console.log(`   Range: ${formatDate(threeDaysAgo)} to ${formatDate(today)}\n`);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  COMPARISON: OHLC API vs Historical Daily Candle');
    console.log('═══════════════════════════════════════════════════════════\n');

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.tradingsymbol}`;
      const ohlcData = ohlcQuotes[key];

      console.log(`  ${key} (token: ${inst.instrument_token})`);
      console.log(`    OHLC API last_price : ${ohlcData?.last_price ?? 'N/A'}`);
      console.log(`    OHLC API ohlc.close : ${ohlcData?.ohlc?.close ?? 'N/A'}`);

      try {
        const candles = await kiteService.getHistoricalData(
          inst.instrument_token,
          'day',
          formatDate(threeDaysAgo),
          formatDate(today)
        );

        if (candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          console.log(`    Historical candles received: ${candles.length}`);
          console.log(`    Last candle date    : ${lastCandle.date}`);
          console.log(`    Last candle OHLC    : O=${lastCandle.open} H=${lastCandle.high} L=${lastCandle.low} C=${lastCandle.close}`);
          console.log(`    Last candle volume  : ${lastCandle.volume}`);

          // Compare
          const diff = (ohlcData?.last_price ?? 0) - lastCandle.close;
          if (Math.abs(diff) > 0.01) {
            console.log(`    ⚠️  DIFF: API last_price(${ohlcData?.last_price}) - candle close(${lastCandle.close}) = ${diff.toFixed(2)}`);
          } else {
            console.log(`    ✅ API last_price matches candle close`);
          }
        } else {
          console.log(`    ❌ No historical candles returned`);
        }
      } catch (err) {
        console.log(`    ❌ Historical API error: ${err.message}`);
      }

      console.log('');
    }

    console.log('💡 If "Last candle close" = 23140.50 (matching Groww), that\'s the settlement price.');
    console.log('   We can use the historical daily candle close to update LTP after market close.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
