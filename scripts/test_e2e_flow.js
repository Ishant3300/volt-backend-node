const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const Admin = require('../src/models/Admin');
const Master = require('../src/models/Master');
const User = require('../src/models/User');
const walletService = require('../src/services/walletService');
const marginSquareOffService = require('../src/services/marginSquareOffService');
const tradeController = require('../src/controllers/tradeController');
const { placeTrade } = require('../src/services/orderExecutionService');

async function runTest() {
  console.log('--- Starting E2E Flow Test ---');
  await mongoose.connect(process.env.MONGO_URI, { dbName: 'stocker' });
  console.log('Connected to DB');

  try {
    const adminId = new mongoose.Types.ObjectId();
    const admin = await Admin.create({
      _id: adminId,
      name: 'Dummy Admin',
      username: `admin_${Date.now()}`,
      password: 'password123',
    });
    console.log('Created Admin:', admin.username);

    const serverId = new mongoose.Types.ObjectId();

    const masterId = new mongoose.Types.ObjectId();
    const master = await Master.create({
      _id: masterId,
      name: 'Dummy Master',
      username: `master_${Date.now()}`,
      password: 'password123',
      admin_id: admin._id,
      server_id: serverId,
      credits: 0,
      equity: 0,
      margin_square_off: false,
      exchanges_allowed: ['NFO-FUT', 'MCX-FUT'],
      wallet: { NSE: 0, MCX: 0, GLOBAL: 0 }
    });
    console.log('Created Master:', master.username);

    const userId = new mongoose.Types.ObjectId();
    const user = await User.create({
      _id: userId,
      name: 'Dummy User',
      username: `user_${Date.now()}`,
      password: 'password123',
      master_id: master._id,
      server_id: serverId,
      credits: 0,
      equity: 0,
      margin_square_off: false,
      exchanges_allowed: [
        { exchange_name: 'NFO-FUT', turnover: true, lot: false, group_name: 'IT' },
        { exchange_name: 'MCX-FUT', turnover: true, lot: false, group_name: 'IT' }
      ],
      wallet: { NSE: 0, MCX: 0, GLOBAL: 0 }
    });
    console.log('Created User:', user.username);

    console.log('\n--- 1. Funding (Assign) ---');
    console.log('Admin assigns 100,000 NSE to Master');
    await walletService.assign({ type: 'Admin', id: admin._id }, 'Master', master._id, 'NSE', 100000);
    let masterAvail = await walletService.getAvailable('Master', master._id);
    console.log('Master NSE Available:', masterAvail.NSE);

    console.log('Master assigns 50,000 NSE to User');
    await walletService.assign({ type: 'Master', id: master._id }, 'User', user._id, 'NSE', 50000);
    masterAvail = await walletService.getAvailable('Master', master._id);
    let userAvail = await walletService.getAvailable('User', user._id);
    console.log('Master NSE Available:', masterAvail.NSE);
    console.log('User NSE Available:', userAvail.NSE);

    console.log('\n--- 2. Block/Release on Trade ---');
    console.log('Simulating a trade block (open)...');
    await walletService.block('User', user._id, 'NSE', 20000);
    userAvail = await walletService.getAvailable('User', user._id);
    console.log('User NSE Available after block:', userAvail.NSE);

    console.log('Simulating a trade release (close)...');
    await walletService.release('User', user._id, 'NSE', 10000);
    userAvail = await walletService.getAvailable('User', user._id);
    console.log('User NSE Available after partial release:', userAvail.NSE);

    console.log('\n--- 3. Reconcile ---');
    const userReconcile = await walletService.reconcile('User', user._id);
    console.log('User Reconcile Result:', userReconcile);
    const masterReconcile = await walletService.reconcile('Master', master._id);
    console.log('Master Reconcile Result:', masterReconcile);

    console.log('\n--- Cleanup ---');
    await User.deleteOne({ _id: user._id });
    await Master.deleteOne({ _id: master._id });
    await Admin.deleteOne({ _id: admin._id });
    console.log('Test completed successfully');

  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await mongoose.disconnect();
  }
}

runTest();
