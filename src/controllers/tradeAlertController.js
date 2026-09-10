/**
 * GET /api/master/trade-alerts — backfill for the web-only Trade Alert
 * live-log page. Returns every trade (completed OR still-pending) across
 * the caller's whole downstream tree for a date range (default: today),
 * newest first — the same population the live `trade_alert` WebSocket
 * broadcast (metricsEngine.broadcastTradeAlert, wired into
 * tradeController.js/priceQueueService.js/orderExecutionService.js) feeds
 * live, so the page has a starting point before any live event arrives.
 *
 * A NEW, isolated file/route — does not modify any existing controller,
 * route, or query used elsewhere.
 */
const Trade = require('../models/Trade');
const User = require('../models/User');
const Master = require('../models/Master');
const { getAllSubMasterIds } = require('../services/masterHierarchyService');
const { sanitizeErrorMessage } = require('../utils/sanitizeError');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const getTradeAlerts = async (req, res) => {
  try {
    const isAdmin = !!req.admin;
    const callerId = req.admin?.id || req.master?.id;

    const { date_from, date_to, limit } = req.query;
    const executedAtFilter = { $gte: date_from ? new Date(date_from) : startOfToday() };
    if (date_to) executedAtFilter.$lte = new Date(date_to);
    const rowLimit = Math.min(parseInt(limit, 10) || 500, 2000);

    // Scope: admin sees every user platform-wide; a master sees only their
    // own subtree (any depth) — same getAllSubMasterIds helper already used
    // for the trade-placement authorization check in tradeController.js.
    let userFilter = { deleted_at: null };
    if (!isAdmin) {
      const masterIds = await getAllSubMasterIds(callerId);
      userFilter.master_id = { $in: masterIds };
    }
    const users = await User.find(userFilter).select('_id name username master_id').lean();
    const userIds = users.map((u) => u._id);
    const userById = {};
    for (const u of users) userById[u._id.toString()] = u;

    // Trades are keyed on createdAt for a pending order (never executed
    // yet, executed_at is null) and executed_at once it fills — filter on
    // whichever applies per row rather than excluding pending orders from
    // the date range entirely. Real schema field is `createdAt` (Mongoose
    // timestamps) — `created_at` only exists as a .toJSON() output
    // transform (see Trade.js's own "doesn't exist" comment on its index),
    // not a real queryable/sortable field.
    const trades = await Trade.find({
      user_id: { $in: userIds },
      deleted_at: null,
      $or: [
        { status: 'completed', executed_at: executedAtFilter },
        { status: 'pending', createdAt: executedAtFilter },
      ],
    })
      .select('user_id instrument_token tradingsymbol transaction_type quantity executed_quantity price executed_price order_type status executed_at createdAt')
      .sort({ createdAt: -1 })
      .limit(rowLimit)
      .lean();

    // Resolve each row's direct master name too — useful context on an
    // admin's wider view where "which master" isn't otherwise obvious.
    const masterIdsNeeded = [...new Set(users.map((u) => u.master_id?.toString()).filter(Boolean))];
    const masters = masterIdsNeeded.length
      ? await Master.find({ _id: { $in: masterIdsNeeded } }).select('_id name username').lean()
      : [];
    const masterById = {};
    for (const m of masters) masterById[m._id.toString()] = m;

    const data = trades.map((t) => {
      const u = userById[t.user_id.toString()];
      const m = u?.master_id ? masterById[u.master_id.toString()] : null;
      const isPending = t.status === 'pending';
      return {
        trade_id: t._id.toString(),
        user_id: t.user_id.toString(),
        client_name: u?.name || null,
        client_username: u?.username || null,
        master_name: m?.name || null,
        master_username: m?.username || null,
        instrument_token: t.instrument_token,
        tradingsymbol: t.tradingsymbol,
        transaction_type: t.transaction_type,
        quantity: isPending ? t.quantity : t.executed_quantity,
        price: isPending ? t.price : t.executed_price,
        order_type: t.order_type,
        status: t.status,
        executed_at: t.executed_at || t.createdAt,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('[TradeAlerts] Error:', error.message);
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
  }
};

module.exports = { getTradeAlerts };
