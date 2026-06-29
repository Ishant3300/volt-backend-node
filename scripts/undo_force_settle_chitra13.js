/**
 * UNDO: Restore chitra13's 62 trades that were incorrectly force-settled.
 * Those trades are from the CURRENT week (Jun 22-29) and should NOT have been settled.
 * Reverts: un-delete the trades, subtract the wrongly added settled_pnl.
 * Run: node scripts/undo_force_settle_chitra13.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const SettlementHistory = require('../src/models/SettlementHistory');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'chitra13' }).lean();
  console.log(`Before: credits=${user.credits}, settled_pnl=${user.settled_pnl}`);

  // Find the trades we incorrectly deleted — they were deleted by our force_settle script
  // which used a specific settlementRunId. We can identify them by:
  // - user_id = chitra13
  // - remarks = 'Settlement: week reset (flat position)'
  // - deleted_at is very recent (today, within last few hours)
  // - trade_type is 'regular' (not carry_forward)
  const today6am = new Date('2026-06-29T00:00:00.000Z'); // anything deleted today by our script
  
  const wronglyDeleted = await Trade.find({
    user_id: user._id,
    status: 'completed',
    trade_type: 'regular',
    remarks: 'Settlement: week reset (flat position)',
    deleted_at: { $gte: today6am },
    // Exclude the 9 BNF FUT trades that were CORRECTLY settled earlier by the real settlement
    // Those were deleted at 2026-06-29T02:14:36Z (07:44 IST) — our script ran later
  }).lean();

  // The real settlement ran at ~07:44 IST = ~02:14 UTC on Jun 29
  // Our force script ran much later (around ~12:00+ IST). Filter by that.
  const realSettlementTime = new Date('2026-06-29T02:15:00.000Z'); // just after real settlement
  const ourMistakes = wronglyDeleted.filter(t => {
    const delTime = new Date(t.deleted_at);
    return delTime > realSettlementTime; // deleted AFTER the real settlement = our mistake
  });

  console.log(`\nFound ${wronglyDeleted.length} trades with 'flat position' remarks deleted today`);
  console.log(`Of those, ${ourMistakes.length} were deleted AFTER the real settlement (= our mistake)`);

  if (ourMistakes.length === 0) {
    console.log('Nothing to undo!');
    await mongoose.disconnect();
    return;
  }

  // Show what we're restoring
  const byInstr = {};
  for (const t of ourMistakes) {
    if (!byInstr[t.tradingsymbol]) byInstr[t.tradingsymbol] = 0;
    byInstr[t.tradingsymbol]++;
  }
  for (const [sym, count] of Object.entries(byInstr)) {
    console.log(`  Restoring: ${sym} — ${count} trades`);
  }

  // Restore: clear deleted_at and remarks
  const ids = ourMistakes.map(t => t._id);
  const restoreResult = await Trade.updateMany(
    { _id: { $in: ids } },
    { $set: { deleted_at: null, remarks: '' } }
  );
  console.log(`\n✅ Restored ${restoreResult.modifiedCount} trades (cleared deleted_at + remarks)`);

  // Revert settled_pnl: subtract what we incorrectly added (16988.17)
  // Calculate exact amount from those trades' P&L
  let pnlToRevert = 0;
  for (const t of ourMistakes) {
    pnlToRevert += (t.pnl || 0);
  }
  // We also subtracted brokerage when computing net_pnl — need to figure exact delta
  // The force script added net_pnl = sum(pnl) - sum(brokerage) to settled_pnl
  // settled_pnl went from 4923.92 to 21912.09, so delta was 16988.17
  const deltaToRevert = 16988.17; // exact amount from the script output

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { settled_pnl: -deltaToRevert } },
    { new: true }
  ).lean();

  console.log(`✅ Reverted settled_pnl: -${deltaToRevert} → now ${updated.settled_pnl}`);

  // Also delete the incorrectly created SettlementHistory snapshots
  // They were created by our force_settle script with settlement_date > realSettlementTime
  const deletedSnaps = await SettlementHistory.deleteMany({
    user_id: user._id,
    settlement_date: { $gt: realSettlementTime },
  });
  console.log(`✅ Deleted ${deletedSnaps.deletedCount} incorrect ledger snapshot(s)`);

  // Final state
  const finalUser = await User.findById(user._id).lean();
  const activeCount = await Trade.countDocuments({ user_id: user._id, status: 'completed', deleted_at: null });
  console.log(`\nFinal: credits=${finalUser.credits}, settled_pnl=${finalUser.settled_pnl}, active_trades=${activeCount}`);

  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
