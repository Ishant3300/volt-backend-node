const mongoose = require('mongoose');
require('dotenv').config({ path: '/Users/ryomen07/Coding_Space/Stocker_Dev/stocker-backend-node/.env' });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stocker');
  const User = require('/Users/ryomen07/Coding_Space/Stocker_Dev/stocker-backend-node/src/models/User');
  const Trade = require('/Users/ryomen07/Coding_Space/Stocker_Dev/stocker-backend-node/src/models/Trade');
  
  const user = await User.findOne({ username: '119743' });
  if (!user) {
    console.log('User not found');
    process.exit();
  }
  
  const trades = await Trade.find({ user_id: user._id, status: 'pending' }).lean();
  console.log('Pending trades:', JSON.stringify(trades, null, 2));
  
  process.exit();
}

run().catch(console.error);
