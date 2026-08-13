require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const Admin = require('./src/models/Admin');
  const Master = require('./src/models/Master');

  const admin = await Admin.findOne({});
  const master = await Master.findOne({ deleted_at: null });

  const adminToken = jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const masterToken = jwt.sign({ id: master._id, role: 'master' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  admin.active_token = adminToken;
  await admin.save();
  
  master.active_token = masterToken;
  await master.save();
  
  console.log('Tokens updated in DB.');
  console.log('ADMIN_TOKEN=' + adminToken);
  console.log('MASTER_TOKEN=' + masterToken);
  
  process.exit(0);
}
run();
