const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./src/models/User');
const Trade = require('./src/models/Trade');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: '495433' });
  const trades = await Trade.find({ user_id: user._id, trade_type: 'margin_square_off' }).sort({ createdAt: -1 });
  console.log("Margin SQ OFF trades:", trades);
  process.exit(0);
}
main();
