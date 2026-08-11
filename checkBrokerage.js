const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./src/models/User');
const Trade = require('./src/models/Trade');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: '119743' });
  if (!user) {
    console.log("User 119743 not found");
    process.exit(1);
  }
  const trades = await Trade.find({ user_id: user._id, tradingsymbol: 'PAYTM26AUGFUT' }).sort({ createdAt: 1 });
  console.log("PAYTM Trades:", trades.map(t => ({
    qty: t.quantity,
    price: t.price,
    brokerage: t.brokerage,
    placed_by: t.placed_by,
    trade_type: t.trade_type
  })));
  process.exit(0);
}
main();
