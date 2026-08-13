require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Master = require('./src/models/Master');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';

mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const master = await Master.findOne().lean();
  const token = jwt.sign(
      { id: master._id, role: 'master', session_id: master.session_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
  );
  console.log(token);
  process.exit(0);
});
