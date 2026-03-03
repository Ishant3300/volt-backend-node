/**
 * Check what data pending orders have
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function checkPendingOrders() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    const Trade = require('../src/models/Trade');
    
    console.log('📋 Pending Orders:\n');
    
    const pendingOrders = await Trade.find({
      status: 'pending'
    }).sort({ created_at: -1 }).limit(5);
    
    if (pendingOrders.length === 0) {
      console.log('No pending orders found');
    } else {
      pendingOrders.forEach((trade, idx) => {
        console.log(`${idx + 1}. ${trade.tradingsymbol} ${trade.transaction_type}`);
        console.log(`   quantity: ${trade.quantity} (type: ${typeof trade.quantity})`);
        console.log(`   executed_quantity: ${trade.executed_quantity} (type: ${typeof trade.executed_quantity})`);
        console.log(`   price: ${trade.price}`);
        console.log(`   status: ${trade.status}`);
        console.log(`   order_type: ${trade.order_type}`);
        console.log(`   ID: ${trade._id}`);
        console.log('');
      });
    }
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

checkPendingOrders();
