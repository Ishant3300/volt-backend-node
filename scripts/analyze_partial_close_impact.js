/**
 * READ-ONLY analysis of the partial-close average-cost bug (fixed in
 * src/utils/walletSplit.js, src/services/priceQueueService.js,
 * src/services/orderExecutionService.js — see that commit for the full
 * root-cause writeup).
 *
 * The bug: whenever a closing trade was SMALLER than the currently open
 * position (a partial close — very common), the closed side's running
 * totals were never decremented. A later same-side reopen then averaged
 * against the position's ORIGINAL pre-partial-close qty instead of what
 * was truly still open, producing a wrong `realisedPnl` at execution time.
 * That wrong value was written to `trade.pnl` AND folded directly into
 * `user.equity` via `balanceChange = realisedPnl - marginDelta - brokerage`
 * — so this corrupted real wallet balances, not just displayed reports.
 *
 * This script does NOT write anything. For every user's CURRENTLY LIVE
 * (unsettled: status='completed', deleted_at=null) trades, grouped by
 * instrument and walked chronologically, it recomputes what each closing
 * trade's realisedPnl SHOULD have been using the now-fixed logic, diffs
 * it against the actually-stored trade.pnl, and reports:
 *   - every trade where stored pnl disagrees with the correct pnl
 *   - the total equity correction that would be needed per user, if only
 *     correcting the CURRENTLY LIVE (unsettled) period
 *
 * Scope caveat: this only covers trades still in the live Trade collection
 * (i.e. since the last settlement for that user/instrument). Trades from
 * before the most recent settlement were soft-deleted at settlement time
 * and are not re-examined here — the same bug could have corrupted
 * realisedPnl (and therefore equity) on those too, in earlier settlement
 * periods, but recomputing across full history requires replaying every
 * past settlement boundary and is a much larger, separate effort. Treat
 * the totals below as a LOWER BOUND on the real impact, not the full
 * picture.
 *
 * Run: node scripts/analyze_partial_close_impact.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const { computeFlatResetState } = require('../src/utils/walletSplit');

function realisedPnlFor(isBuy, qty, price, state) {
  const netQty = state.totalBuyQty - state.totalSellQty;
  const avgBuy = state.totalBuyQty > 0 ? state.totalBuyValue / state.totalBuyQty : 0;
  const avgSell = state.totalSellQty > 0 ? state.totalSellValue / state.totalSellQty : 0;
  if (!isBuy && netQty > 0) {
    return (price - avgBuy) * Math.min(qty, netQty);
  }
  if (isBuy && netQty < 0) {
    return (avgSell - price) * Math.min(qty, Math.abs(netQty));
  }
  return 0;
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  const trades = await Trade.find({
    status: 'completed',
    deleted_at: null,
    trade_type: { $nin: ['carry_forward'] }, // marker records aren't real fills to re-derive pnl for
  })
    .select('user_id instrument_token tradingsymbol exchange transaction_type executed_quantity executed_price executed_at pnl')
    .sort({ user_id: 1, instrument_token: 1, executed_at: 1 })
    .lean();

  console.log(`Scanning ${trades.length} live (unsettled) completed trades...\n`);

  // Group by user_id + instrument_token
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.user_id}::${t.instrument_token}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const perUserDelta = new Map(); // user_id -> { deltaSum, mismatchCount, rows: [] }

  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at));
    // State BEFORE trade i, computed via the same fixed computeFlatResetState used in
    // production — re-derived from the prefix each iteration so this analysis can never
    // drift from the real fix.
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const isBuy = t.transaction_type === 'BUY';
      const qty = Number(t.executed_quantity) || 0;
      const price = Number(t.executed_price) || 0;
      const state = computeFlatResetState(sorted.slice(0, i));

      const correctPnl = Math.round(realisedPnlFor(isBuy, qty, price, state) * 100) / 100;
      const storedPnl = Math.round((Number(t.pnl) || 0) * 100) / 100;
      const delta = Math.round((correctPnl - storedPnl) * 100) / 100;

      if (Math.abs(delta) >= 0.01) {
        const uid = t.user_id.toString();
        if (!perUserDelta.has(uid)) perUserDelta.set(uid, { deltaSum: 0, mismatchCount: 0, rows: [] });
        const rec = perUserDelta.get(uid);
        rec.deltaSum = Math.round((rec.deltaSum + delta) * 100) / 100;
        rec.mismatchCount += 1;
        rec.rows.push({
          tradingsymbol: t.tradingsymbol,
          exchange: t.exchange,
          executed_at: t.executed_at,
          transaction_type: t.transaction_type,
          qty, price,
          storedPnl, correctPnl, delta,
        });
      }
    }
  }

  if (perUserDelta.size === 0) {
    console.log('No mismatches found in the currently-live (unsettled) trade set.');
    await mongoose.disconnect();
    return;
  }

  const userIds = [...perUserDelta.keys()];
  const users = await User.find({ _id: { $in: userIds } }).select('username name equity').lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  let grandDelta = 0;
  const sortedUsers = [...perUserDelta.entries()].sort((a, b) => Math.abs(b[1].deltaSum) - Math.abs(a[1].deltaSum));

  console.log('='.repeat(100));
  console.log('PER-USER IMPACT (currently-live/unsettled trades only — see scope caveat in file header)');
  console.log('='.repeat(100));
  for (const [uid, rec] of sortedUsers) {
    const u = userMap.get(uid);
    grandDelta += rec.deltaSum;
    console.log(`\n${u?.username || u?.name || uid} (equity now: ${u?.equity ?? 'unknown'})`);
    console.log(`  Mismatched trades: ${rec.mismatchCount}   Net equity correction needed: ${rec.deltaSum >= 0 ? '+' : ''}${rec.deltaSum}`);
    for (const r of rec.rows) {
      console.log(`    ${r.exchange} ${r.tradingsymbol} ${new Date(r.executed_at).toISOString()} ${r.transaction_type} ${r.qty}@${r.price}  stored=${r.storedPnl}  correct=${r.correctPnl}  delta=${r.delta >= 0 ? '+' : ''}${r.delta}`);
    }
  }
  console.log('\n' + '='.repeat(100));
  console.log(`TOTAL users affected: ${sortedUsers.length}`);
  console.log(`TOTAL net equity correction across all affected users (live period only): ${grandDelta >= 0 ? '+' : ''}${Math.round(grandDelta * 100) / 100}`);
  console.log('='.repeat(100));
  console.log('\nThis is READ-ONLY — nothing was written to the database.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
