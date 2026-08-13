require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const Admin = require('./src/models/Admin');
  const Master = require('./src/models/Master');
  const User = require('./src/models/User');

  const admin = await Admin.findOne({});
  const master = await Master.findOne({ deleted_at: null });
  const user = await User.findOne({ master_id: master._id, deleted_at: null });

  // Get another master
  const otherMaster = await Master.findOne({ _id: { $ne: master._id }, deleted_at: null });

  const adminToken = jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const masterToken = jwt.sign({ id: master._id, role: 'master' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  console.log('ADMIN_TOKEN=' + adminToken);
  console.log('MASTER_TOKEN=' + masterToken);
  console.log('ADMIN_ID=' + admin._id);
  console.log('MASTER_ID=' + master._id);
  console.log('USER_ID=' + user._id);
  console.log('OTHER_MASTER_ID=' + otherMaster._id);
  
  process.exit(0);
}
run();
