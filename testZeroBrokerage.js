const mongoose = require('mongoose');
const User = require('./src/models/User');
const Trade = require('./src/models/Trade');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const user = await User.findOne({ username: '119743' }).lean();
  if (user) {
    const trades = await Trade.find({ user_id: user._id, brokerage: 0 }).limit(5).lean();
    console.log("Zero brokerage trades:", trades);
  } else {
    console.log("User 119743 not found");
  }
  process.exit(0);
});
