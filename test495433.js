const mongoose = require('mongoose');
const User = require('./src/models/User');
const Trade = require('./src/models/Trade');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';
mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const user = await User.findOne({ username: '495433' }).lean();
  console.log("User credits:", user.credits);
  const trades = await Trade.find({ user_id: user._id }).sort({ executed_at: 1 }).lean();
  console.log(`Found ${trades.length} trades for user.`);
  trades.forEach(t => {
      console.log(`[${t.executed_at ? t.executed_at.toISOString() : 'Pending'}] ${t.trade_type} | ${t.status} | ${t.transaction_type} ${t.quantity} @ ${t.price} (Pnl: ${t.pnl})`);
  });
  process.exit(0);
});
