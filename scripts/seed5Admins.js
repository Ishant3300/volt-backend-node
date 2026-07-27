require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Admin = require('../src/models/Admin');

const admins = [
  { username: 'apex_admin_1', password: 'Apex@2025a' },
  { username: 'apex_admin_2', password: 'Apex@2025b' },
  { username: 'apex_admin_3', password: 'Apex@2025c' },
  { username: 'apex_admin_4', password: 'Apex@2025d' },
  { username: 'apex_admin_5', password: 'Apex@2025e' },
];

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    for (const { username, password } of admins) {
      const exists = await Admin.findOne({ username });
      if (exists) {
        console.log(`⚠️  "${username}" already exists — skipping`);
        continue;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await Admin.create({ username, password: hashedPassword });
      console.log(`✅ Created admin: ${username}`);
    }

    console.log('\n🎉 Done. All 5 admins seeded.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

seed();
