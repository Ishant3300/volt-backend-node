const mongoose = require('mongoose');
const User = require('./src/models/User');
const axios = require('axios');
const mongoUri = 'mongodb://vinayakindi07_db_user:fo1kKJESl2wnYW0I@ac-kk9fxmq-shard-00-00.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-01.ayji87i.mongodb.net:27017,ac-kk9fxmq-shard-00-02.ayji87i.mongodb.net:27017/stocker?ssl=true&replicaSet=atlas-583cyl-shard-0&authSource=admin&appName=stocker';
const adminToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNjYzMjRmYmMyNDQ2MDE1MmMyNzM3OCIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc4NjUxMDg5NH0.UBn8iZz0414db1cZXkEU_LqoWS5TfjLLIdRnQ7UyV7A';

mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const user = await User.findOne({ username: '495433' }).lean();
  
  try {
    const res = await axios.post('http://localhost:3000/api/trade', {
      instrument_token: "738561",
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      segment: "NSE",
      transaction_type: "BUY",
      quantity: 1,
      price: 1500,
      order_type: "LIMIT",
      user_id: user._id.toString()
    }, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    console.log(res.data);
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
  process.exit(0);
});
