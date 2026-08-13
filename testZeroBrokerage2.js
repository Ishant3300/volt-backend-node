const mongoose = require('mongoose');
const BrokerageSettings = require('./src/models/BrokerageSettings');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const brokerage = await BrokerageSettings.findOne({ user_id: '6a792e293aeaf7a5a4c8a80a' }).lean();
  console.log("Brokerage for user 119743:", brokerage);
  process.exit(0);
});
