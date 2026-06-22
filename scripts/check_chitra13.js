require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Trade = require('../src/models/Trade');
const SettlementHistory = require('../src/models/SettlementHistory');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  for (const uname of ['chitra13', 'chitra11']) {
    const u = await User.findOne({ username: uname }).lean();
    if (!u) { console.log(`\n${uname}: USER NOT FOUND`); continue; }
    console.log(`\n=== ${uname} (id: ${u._id}) ===`);

    const totalTrades = await Trade.countDocuments({ user_id: u._id });
    const activeTrades = await Trade.countDocuments({ user_id: u._id, status: 'completed', deleted_at: null });
    const from = new Date('2026-06-15'); const to = new Date('2026-06-20T23:59:59.999Z');
    const liveInWindow = await Trade.countDocuments({
      user_id: u._id, status: 'completed', deleted_at: null,
      trade_type: { $nin: ['carry_forward','margin_square_off'] },
      executed_at: { $gte: from, $lte: to },
    });
    const ledgerTotal = await SettlementHistory.countDocuments({ user_id: u._id });
    const ledgerOverlap = await SettlementHistory.countDocuments({
      user_id: u._id, period_from: { $lte: to }, period_to: { $gte: from },
    });

    console.log(`  total trades (any): ${totalTrades}`);
    console.log(`  active completed trades: ${activeTrades}`);
    console.log(`  live regular fills in Jun15-20: ${liveInWindow}`);
    console.log(`  ledger snapshots total: ${ledgerTotal}`);
    console.log(`  ledger snapshots overlapping Jun15-20: ${ledgerOverlap}`);
  }

  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
