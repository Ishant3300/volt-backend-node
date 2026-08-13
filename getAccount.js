const mongoose = require('mongoose');
const User = require('./src/models/User');
const Master = require('./src/models/Master');
const Trade = require('./src/models/Trade');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';
mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const user = await User.findOne({ username: '495433' }).lean();
  console.log("User:", user ? `${user.username} (Margin SqOff: ${user.margin_square_off}, M2M: ${user.m2m_pnl})` : "Not Found");
  
  const trades = await Trade.find({ user_id: user?._id }).lean();
  console.log(`Found ${trades.length} trades for user.`);
  const sqoffTrades = trades.filter(t => t.trade_type === 'AUTO_SQOFF' || t.status === 'AUTO_SQUARE_OFF');
  console.log(`Found ${sqoffTrades.length} auto sqoff trades.`);
  process.exit(0);
});
