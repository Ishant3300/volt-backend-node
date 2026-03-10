const Trade = require('../models/Trade');
const WeeklySummary = require('../models/WeeklySummary');
const User = require('../models/User');
const Master = require('../models/Master');
const Admin = require('../models/Admin');

/**
 * Snapshots weekly P&L for all users/masters/admins into WeeklySummary collection.
 * Designed to run every Sunday before balance reset.
 */
async function snapshotWeeklySummary() {
  // Week boundaries: Monday 00:00 → Sunday 23:59:59.999
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  console.log(`📊 [WEEKLY] Snapshotting ${weekStart.toISOString()} → ${weekEnd.toISOString()}`);

  // Aggregate completed trades for this week per user_id
  const tradeAgg = await Trade.aggregate([
    {
      $match: {
        status: 'completed',
        deleted_at: null,
        executed_at: { $gte: weekStart, $lte: weekEnd },
      }
    },
    {
      $group: {
        _id: '$user_id',
        pnl: { $sum: '$pnl' },
        brokerage: { $sum: '$brokerage' },
        total_trades: { $sum: 1 },
        buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
        sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
        turnover: { $sum: { $multiply: ['$executed_price', '$executed_quantity'] } },
        master_id: { $first: '$master_id' },
        admin_id: { $first: '$admin_id' },
      }
    }
  ]);

  // Build a userId → user info map for all roles
  const [users, masters, admins] = await Promise.all([
    User.find({ deleted_at: null }).select('_id username name master_id admin_id').lean(),
    Master.find({ deleted_at: null }).select('_id username name admin_id').lean(),
    Admin.find({ deleted_at: null }).select('_id username name').lean(),
  ]);

  const userMap = {};
  for (const u of users) userMap[u._id.toString()] = { ...u, userModel: 'User' };
  for (const m of masters) userMap[m._id.toString()] = { ...m, userModel: 'Master' };
  for (const a of admins) userMap[a._id.toString()] = { ...a, userModel: 'Admin' };

  // Upsert trade aggregations (these are User-role trades since trade.user_id = User)
  const bulkOps = [];
  for (const row of tradeAgg) {
    const uid = row._id.toString();
    const info = userMap[uid] || {};
    bulkOps.push({
      updateOne: {
        filter: { userId: row._id, week_start: weekStart },
        update: {
          $set: {
            userModel: info.userModel || 'User',
            username: info.username || 'unknown',
            name: info.name || null,
            master_id: row.master_id || info.master_id || null,
            admin_id: row.admin_id || info.admin_id || null,
            week_end: weekEnd,
            pnl: row.pnl,
            brokerage: row.brokerage,
            total_trades: row.total_trades,
            buy_qty: row.buy_qty,
            sell_qty: row.sell_qty,
            turnover: row.turnover,
          }
        },
        upsert: true,
      }
    });
  }

  // Also create zero-entry records for users with no trades this week
  const tradedUserIds = new Set(tradeAgg.map(r => r._id.toString()));
  for (const u of users) {
    if (!tradedUserIds.has(u._id.toString())) {
      bulkOps.push({
        updateOne: {
          filter: { userId: u._id, week_start: weekStart },
          update: {
            $set: {
              userModel: 'User',
              username: u.username,
              name: u.name || null,
              master_id: u.master_id || null,
              admin_id: u.admin_id || null,
              week_end: weekEnd,
              pnl: 0, brokerage: 0, total_trades: 0,
              buy_qty: 0, sell_qty: 0, turnover: 0,
            }
          },
          upsert: true,
        }
      });
    }
  }

  if (bulkOps.length > 0) {
    const result = await WeeklySummary.bulkWrite(bulkOps);
    console.log(`✅ [WEEKLY] Upserted ${result.upsertedCount} new, modified ${result.modifiedCount} existing summaries`);
  } else {
    console.log('ℹ️  [WEEKLY] No users/trades to snapshot');
  }

  return { total: bulkOps.length };
}

module.exports = { snapshotWeeklySummary };
