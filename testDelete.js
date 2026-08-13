const mongoose = require('mongoose');
const Master = require('./src/models/Master');
const { getAllSubMasterIds } = require('./src/services/masterHierarchyService');

const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(async () => {
  const childId = '6a7c8288067fc7103541840e'; 
  const allHierarchyMasterIds = await getAllSubMasterIds(childId);

  const query = { _id: { $in: allHierarchyMasterIds, $ne: childId }, deleted_at: null };
  // Let's see what Mongoose compiles this to!
  const compiledQuery = Master.find(query).getFilter();
  console.log("Compiled Query:", compiledQuery);

  process.exit(0);
});
