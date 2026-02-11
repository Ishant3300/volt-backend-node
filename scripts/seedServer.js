require('dotenv').config();
const mongoose = require('mongoose');
const Server = require('../src/models/Server');

const seedServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    // Check if server already exists
    const existingServer = await Server.findOne({ name: 'test' });
    
    if (existingServer) {
      console.log('Server "test" already exists:', existingServer);
    } else {
      const server = await Server.create({ name: 'test' });
      console.log('Server "test" created successfully:', server);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

seedServer();
