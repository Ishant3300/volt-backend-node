const mongoose = require('mongoose');
const { getAllSubMasterIds } = require('./src/services/masterHierarchyService');

const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(async () => {
  const ids = await getAllSubMasterIds('6a7961d53aeaf7a5a4cd2dd5'); // parent
  console.log('Hierarchy for parent:', ids);
  process.exit(0);
});
