const mongoose = require('mongoose');
const Master = require('./src/models/Master');
const User = require('./src/models/User');

// Using the URI from .env
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(async () => {
  const res = await Master.updateMany({}, { $set: { deleted_at: null } });
  console.log('Restored masters:', res.modifiedCount);
  const res2 = await User.updateMany({}, { $set: { deleted_at: null } });
  console.log('Restored users:', res2.modifiedCount);
  process.exit(0);
});
