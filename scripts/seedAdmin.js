require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Admin = require('../src/models/Admin');

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ username: 'admin' });
    
    if (existingAdmin) {
      console.log('Admin "admin" already exists:', existingAdmin.toJSON());
    } else {
      // Hash password
      const hashedPassword = await bcrypt.hash('admin', 10);
      
      const admin = await Admin.create({
        username: 'admin',
        password: hashedPassword
      });
      
      console.log('Admin "admin" created successfully:', admin.toJSON());
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

seedAdmin();
