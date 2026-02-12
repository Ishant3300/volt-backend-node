require('dotenv').config();
const mongoose = require('mongoose');
const kiteService = require('../src/services/kiteService');

async function generateSession() {
  try {
    const requestToken = process.argv[2];

    if (!requestToken) {
      console.error('Error: Request token is required');
      console.log('Usage: node test/generateSession.js <request_token>');
      process.exit(1);
    }

    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    console.log('\n=== Generating Kite Session ===\n');
    console.log('Request Token:', requestToken);

    const tokenResponse = await kiteService.exchangeToken(requestToken);

    if (tokenResponse.status === 'success') {
      const { access_token, login_time, user_id, user_name, user_type, email } = tokenResponse.data;

      // Store access token
      await kiteService.storeAccessToken(access_token, login_time);

      console.log('\n✓ Session generated successfully!');
      console.log('Access Token:', access_token);
      console.log('User ID:', user_id);
      console.log('User Name:', user_name);
      console.log('User Type:', user_type);
      console.log('Email:', email);

      console.log('\n✓ Access token saved to database');
      console.log('\nYou can now run: node test/testKite.js');
    } else {
      throw new Error('Token exchange failed');
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
    process.exit(0);
  }
}

generateSession();
