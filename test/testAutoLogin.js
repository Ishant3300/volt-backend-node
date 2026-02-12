require('dotenv').config();
const mongoose = require('mongoose');
const kiteAuthService = require('../src/services/kiteAuthService');

async function testAutoLogin() {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected\n');

    // Perform automated login
    console.log('🤖 Starting automated Kite login...\n');
    const result = await kiteAuthService.performAutomatedLogin();

    console.log('\n📊 Login Result:');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('\n✅ Auto-login successful!');
      console.log('You can now run: node test/testKite.js');
    } else {
      console.log('\n❌ Auto-login failed');
      console.log('Error:', result.error);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
}

testAutoLogin();
