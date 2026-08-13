const mongoose = require('mongoose');
require('dotenv').config();
const Master = require('./src/models/Master');
const { createChildMaster } = require('./src/controllers/masterChildController');

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('Connected to DB');
    
    // Find an admin
    const admin = await mongoose.connection.db.collection('admins').findOne();
    
    // Create a parent master
    const parent = new Master({
      name: 'Parent Master Test',
      username: 'parent' + Date.now(),
      password: 'hash',
      credits: 1000,
      equity: 1000,
      pnl_sharing: 50,
      brokerage_sharing: 50,
      exchanges_allowed: ['NSE'],
      trade_limit: ['NSE'],
      add_master: true,
      admin_id: admin._id,
      server_id: (await mongoose.connection.db.collection('servers').findOne())._id,
      permissions: {}
    });
    await parent.save();
    console.log('Created parent master with equity 1000, ID:', parent._id);
    
    // Mock req and res
    const req = {
      master: { id: parent._id.toString() },
      body: {
        name: 'Child Master Test',
        username: 'child' + Date.now(),
        password: 'password123',
        credits: 200,
        note: 'Initial',
        pnl_sharing: 40,
        brokerage_sharing: 40,
        exchanges_allowed: ['NSE'],
        trade_limit: ['NSE'],
        server_id: parent.server_id.toString(),
        add_master: false,
        permissions: {}
      }
    };
    
    const res = {
      status: (code) => ({
        json: (data) => console.log(`Response ${code}:`, data)
      })
    };
    
    await createChildMaster(req, res);
    
    // Check parent equity
    const updatedParent = await Master.findById(parent._id);
    console.log('Parent equity after child creation:', updatedParent.equity);
    
    process.exit(0);
  })
  .catch(console.error);
