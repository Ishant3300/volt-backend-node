/**
 * Check Current Live Price
 * 
 * Fetches the current price from Kite API
 */

require('dotenv').config();
const kiteService = require('../src/services/kiteService');

async function checkCurrentPrice() {
  try {
    console.log('📊 Fetching Current Live Price\n');

    // GIFT NIFTY token
    const instrumentToken = 291849;

    console.log(`Instrument: GIFT NIFTY`);
    console.log(`Token: ${instrumentToken}\n`);

    // Fetch quote from Kite
    const quotes = await kiteService.getLatestQuotes([instrumentToken], 1);

    if (quotes.length === 0) {
      console.log('❌ No quote data received');
      console.log('   Possible reasons:');
      console.log('   1. Market is closed');
      console.log('   2. Kite API not authenticated');
      console.log('   3. Invalid instrument token');
      process.exit(1);
    }

    const quote = quotes[0];
    console.log('📈 Current Quote:');
    console.log(`   Last Price (LTP): ${quote.last_price}`);
    console.log(`   Open: ${quote.ohlc?.open || 'N/A'}`);
    console.log(`   High: ${quote.ohlc?.high || 'N/A'}`);
    console.log(`   Low: ${quote.ohlc?.low || 'N/A'}`);
    console.log(`   Close (prev): ${quote.ohlc?.close || 'N/A'}`);
    console.log('');

    // Check pending orders
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGO_URI);
    
    const Trade = require('../src/models/Trade');
    const pendingOrders = await Trade.find({
      instrument_token: instrumentToken.toString(),
      status: 'pending',
      order_type: 'LIMIT',
      deleted_at: null
    }).sort({ price: 1 });

    console.log(`📋 Pending Orders (${pendingOrders.length}):\n`);
    
    pendingOrders.forEach((order, idx) => {
      const diff = quote.last_price - order.price;
      const shouldExecute = order.transaction_type === 'BUY' 
        ? quote.last_price <= order.price
        : quote.last_price >= order.price;
      
      console.log(`${idx + 1}. ${order.transaction_type} ${order.quantity} @ ${order.price}`);
      console.log(`   Current price: ${quote.last_price}`);
      console.log(`   Difference: ${diff > 0 ? '+' : ''}${diff.toFixed(2)}`);
      console.log(`   Should execute: ${shouldExecute ? '✅ YES' : '❌ NO'}`);
      
      if (order.transaction_type === 'BUY') {
        if (shouldExecute) {
          console.log(`   Reason: Current price (${quote.last_price}) ≤ Limit price (${order.price})`);
        } else {
          console.log(`   Reason: Current price (${quote.last_price}) > Limit price (${order.price})`);
          console.log(`   Waiting for price to drop to ${order.price} or below`);
        }
      } else {
        if (shouldExecute) {
          console.log(`   Reason: Current price (${quote.last_price}) ≥ Limit price (${order.price})`);
        } else {
          console.log(`   Reason: Current price (${quote.last_price}) < Limit price (${order.price})`);
          console.log(`   Waiting for price to rise to ${order.price} or above`);
        }
      }
      console.log('');
    });

    console.log('📝 How Limit Orders Work:');
    console.log('   BUY Limit @ X: Executes when market price drops to X or below');
    console.log('   SELL Limit @ X: Executes when market price rises to X or above');
    console.log('');
    console.log('   Example:');
    console.log('   - Current price: 24500');
    console.log('   - BUY limit @ 24400: Will execute when price drops to 24400');
    console.log('   - SELL limit @ 24600: Will execute when price rises to 24600');

    await mongoose.disconnect();

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
  }
}

checkCurrentPrice();
