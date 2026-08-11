const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./src/models/User');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ username: '495433' }).select('margin_square_off margin_square_off_percentage credits');
  console.log("User:", user);
  process.exit(0);
}
main();
