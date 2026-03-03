/**
 * Check recently executed trades
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function checkRecentTrades() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    const Trade = require('../src/models/Trade');
    
    console.log('📋 Recently Executed Trades (last 10):\n');
    
    const recentTrades = await Trade.find({
      status: 'completed',
      order_type: 'LIMIT'
    }).sort({ executed_at: -1 }).limit(10);
    
    if (recentTrades.length === 0) {
      console.log('No completed limit orders found');
    } else {
      recentTrades.forEach((trade, idx) => {
        const executedAt = trade.executed_at ? trade.executed_at.toLocaleString() : 'N/A';
        console.log(`${idx + 1}. ${trade.tradingsymbol} ${trade.transaction_type} ${trade.quantity} @ ${trade.executed_price}`);
        console.log(`   Executed: ${executedAt}`);
        console.log(`   P&L: ${trade.pnl}`);
        console.log(`   User: ${trade.user_id}`);
        console.log(`   ID: ${trade._id}`);
        console.log('');
      });
    }
    
    // Check positions for the user
    console.log('📊 Checking positions aggregation...\n');
    
    const userId = recentTrades.length > 0 ? recentTrades[0].user_id : null;
    
    if (userId) {
      const allTrades = await Trade.find({
        user_id: userId,
        status: 'completed',
        deleted_at: null
      });
      
      // Group by instrument
      const byInstrument = {};
      allTrades.forEach(t => {
        if (!byInstrument[t.instrument_token]) {
          byInstrument[t.instrument_token] = {
            symbol: t.tradingsymbol,
            buyQty: 0,
            sellQty: 0,
            trades: []
          };
        }
        
        if (t.transaction_type === 'BUY') {
          byInstrument[t.instrument_token].buyQty += t.executed_quantity;
        } else {
          byInstrument[t.instrument_token].sellQty += t.executed_quantity;
        }
        
        byInstrument[t.instrument_token].trades.push(t);
      });
      
      console.log('Positions:');
      Object.entries(byInstrument).forEach(([token, data]) => {
        const netQty = data.buyQty - data.sellQty;
        console.log(`\n${data.symbol} (${token}):`);
        console.log(`   Buy: ${data.buyQty}, Sell: ${data.sellQty}`);
        console.log(`   Net Qty: ${netQty}`);
        console.log(`   Status: ${netQty === 0 ? 'FLAT (won\'t show in Trade tab)' : 'OPEN (should show in Trade tab)'}`);
      });
    }
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

checkRecentTrades();
