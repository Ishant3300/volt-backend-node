const express = require('express');
const { sanitizeErrorMessage } = require('../utils/sanitizeError');
const router = express.Router();
const {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  creditUserByAdmin,
  debitUserByAdmin,
  // Grouped Quantity
  createGroupedQuantity,
  getAllGroupedQuantities,
  getGroupedQuantityById,
  updateGroupedQuantity,
  deleteGroupedQuantity,
  // Script Quantity
  createScriptQuantity,
  getAllScriptQuantities,
  getScriptQuantityById,
  updateScriptQuantity,
  deleteScriptQuantity,
  // Brokerage Settings
  createBrokerageSettings,
  getAllBrokerageSettings,
  getBrokerageSettingsById,
  updateBrokerageSettings,
  deleteBrokerageSettings
} = require('../controllers/adminController');
const { getLotNamesByExchange, getUniqueRawNamesBySegment, bulkCreateGroup, getGroupInstruments, bulkCreateBrokerage, getBrokerageByExchange, bulkCreateScriptQuantity, getScriptQuantityByExchange } = require('../controllers/groupedQuantityController');
const { authenticateAdmin, authenticateAdminOrMaster, authenticateMaster, authenticateAny } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');
const { requireAdminPermission } = require('../middlewares/requireAdminPermission');
const { rejectIfAdminWatchOnly } = require('../middlewares/rejectIfAdminWatchOnly');
const { escapeRegex } = require('../utils/escapeRegex');

// Category trade-wallet funding (Task 12 / Requirements 5.1–5.7)
const {
  assign: walletAssign,
  withdraw: walletWithdraw,
  getWallet: walletGet,
  reconcile: walletReconcile,
} = require('../controllers/walletController');

// All routes require admin authentication


// User CRUD operations
router.post('/users', authenticateMaster, rejectIfInvestor, createUser);
router.get('/users', authenticateAdminOrMaster, getAllUsers);
router.get('/users/:id', authenticateAdminOrMaster, getUserById);
router.put('/users/:id', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, updateUser);
router.delete('/users/:id', authenticateMaster, rejectIfInvestor, deleteUser);
// Money-moving, previously ungated — WALLET_MANAGE already gates the
// semantically identical /admin/wallet/assign|withdraw below, but these two
// (direct `credits` ledger, not the category wallet) had no permission key
// at all, letting any regular Admin move money regardless of granted keys.
router.post('/users/:id/credit', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('WALLET_MANAGE'), creditUserByAdmin);
router.post('/users/:id/debit', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('WALLET_MANAGE'), debitUserByAdmin);

// ==================== WALLET FUNDING ROUTES (admin grant/remove) ====================
// Admin is the root of funds: assign is a grant (credit only, no debit source),
// withdraw removes funds from the target. The walletController resolves req.admin
// as the actor; walletService owns the Mongo transaction + Transaction audit.
router.post('/wallet/assign', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('WALLET_MANAGE'), walletAssign);
router.post('/wallet/withdraw', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('WALLET_MANAGE'), walletWithdraw);
router.get('/wallet', authenticateAdmin, walletGet);
// Drift audit: per-category { available, blocked, total } from open positions
router.get('/wallet/reconcile', authenticateAdmin, walletReconcile);

// Grouped Quantity CRUD operations
// QUANTITY_MANAGE previously didn't exist — these writes (and Script
// Quantity's below) had no permission key at all, unlike every sibling
// CRUD surface (Brokerage/Instrument/FreshStoploss), letting any regular
// Admin mutate platform-wide quantity limits regardless of granted keys.
// requireAdminPermission is a no-op for a Master caller (see its own doc
// comment), so this doesn't affect the Master-shared script-quantity routes.
router.post('/grouped-quantities', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), createGroupedQuantity);
router.post('/grouped-quantities/bulk-create', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), bulkCreateGroup);
router.get('/grouped-quantities/unique-raw-names/:segment', authenticateAdminOrMaster, getUniqueRawNamesBySegment);
router.get('/grouped-quantities/group/:exchange_name/:lot_name', authenticateAdminOrMaster, getGroupInstruments);
router.get('/grouped-quantities/exchange/:exchange_name/lot-names', authenticateAdminOrMaster, getLotNamesByExchange);
router.get('/grouped-quantities', authenticateAdminOrMaster, getAllGroupedQuantities);
router.get('/grouped-quantities/:id', authenticateAdminOrMaster, getGroupedQuantityById);
router.put('/grouped-quantities/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), updateGroupedQuantity);
router.delete('/grouped-quantities/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), deleteGroupedQuantity);

// Script Quantity CRUD operations
router.post('/script-quantities/bulk-create', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), bulkCreateScriptQuantity);
router.get('/script-quantities/exchange/:exchange_name', authenticateAdminOrMaster, getScriptQuantityByExchange);
router.post('/script-quantities', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), createScriptQuantity);
router.get('/script-quantities', authenticateAdminOrMaster, getAllScriptQuantities);
router.get('/script-quantities/:id', authenticateAdminOrMaster, getScriptQuantityById);
router.put('/script-quantities/:id', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), updateScriptQuantity);
router.delete('/script-quantities/:id', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('QUANTITY_MANAGE'), deleteScriptQuantity);

// Brokerage Settings CRUD operations
router.post('/brokerage-settings/bulk-create', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), bulkCreateBrokerage);
router.get('/brokerage-settings/exchange/:exchange_name', authenticateAdminOrMaster, getBrokerageByExchange);
router.post('/brokerage-settings', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), createBrokerageSettings);
router.get('/brokerage-settings', authenticateAdminOrMaster, getAllBrokerageSettings);
router.get('/brokerage-settings/:id', authenticateAdminOrMaster, getBrokerageSettingsById);
// Bulk update brokerage settings (update multiple IDs with same value)
router.put('/brokerage-settings/bulk-update', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), async (req, res) => {
  try {
    const { ids, brk_value, type } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0 || brk_value === undefined) {
      return res.status(400).json({ success: false, message: 'ids array and brk_value are required', data: null });
    }
    const BrokerageSettings = require('../models/BrokerageSettings');

    // Ownership check: every id in the batch must belong to the caller's own
    // subtree, not just the sample record used for the floor check below —
    // without this, a master could smuggle in ids belonging to unrelated
    // accounts platform-wide via this one bulk endpoint. Admin unrestricted.
    if (req.master) {
      const { getAllSubMasterIds } = require('../services/masterHierarchyService');
      const { resolveBrokerageOwnerMasterId } = require('../controllers/adminController');
      const allowedMasterIds = await getAllSubMasterIds(req.master.id);
      const records = await BrokerageSettings.find({ _id: { $in: ids }, deleted_at: null }).select('user_id').lean();
      for (const record of records) {
        const ownerMasterId = record.user_id ? await resolveBrokerageOwnerMasterId(record.user_id) : null;
        if (!ownerMasterId || !allowedMasterIds.includes(ownerMasterId)) {
          return res.status(403).json({ success: false, message: 'Not authorized to update one or more of these brokerage settings', data: null });
        }
      }
    }

    // Floor validation: check the first record to determine owner, then validate
    // Admin bypasses this — admin can set any rate on their children
    const sampleRecord = await BrokerageSettings.findOne({ _id: { $in: ids }, deleted_at: null }).lean();
    if (sampleRecord && sampleRecord.user_id && !req.admin) {
      const { validateBrokerageFloor } = require('../services/brokerageCopyService');
      const User = require('../models/User');
      const ownerUser = await User.findById(sampleRecord.user_id).select('_id').lean();
      const ownerType = ownerUser ? 'User' : 'Master';
      const effectiveType = type || sampleRecord.type;

      // Also check against the CALLER's own rate (the logged-in master)
      // The child's rate must be >= the caller master's rate
      const callerId = req.master.id;
      const callerRule = await BrokerageSettings.findOne({
        user_id: callerId,
        exchange_name: sampleRecord.exchange_name,
        script_name: sampleRecord.script_name,
        type: effectiveType,
        deleted_at: null,
      }).lean();

      if (callerRule && brk_value < callerRule.brk_value) {
        return res.status(422).json({
          success: false,
          message: `Brokerage cannot be less than the parent limit (${callerRule.brk_value})`,
          data: null
        });
      }

      // Fallback: also run the hierarchy-based validation
      const floorError = await validateBrokerageFloor(
        sampleRecord.user_id.toString(), ownerType,
        sampleRecord.exchange_name, sampleRecord.script_name, effectiveType, brk_value
      );
      if (floorError) {
        return res.status(422).json({ success: false, message: floorError, data: null });
      }
    }

    // Stamp effective_from so this new rate only applies to trades from now onwards.
    const updateFields = { brk_value, effective_from: new Date() };
    if (type) updateFields.type = type;
    // runValidators — updateMany skips schema validation by default (including
    // the `type` enum), so an unsupported type (e.g. a stale/removed option
    // like the old "CRORE WISE") would otherwise save silently and then
    // brokerageService.js would silently compute 0 brokerage for it forever.
    const result = await BrokerageSettings.updateMany(
      { _id: { $in: ids }, deleted_at: null },
      { $set: updateFields },
      { runValidators: true }
    );

    // Reload metricsEngine rules so brokerage calculations use the new values immediately
    try { const me = require('../services/metricsEngine'); me.reloadRules(); } catch (_) {}

    res.json({ success: true, message: `Updated ${result.modifiedCount} brokerage setting(s)`, data: { modified: result.modifiedCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});
router.put('/brokerage-settings/:id', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), updateBrokerageSettings);
router.delete('/brokerage-settings/:id', authenticateAdminOrMaster, rejectIfInvestor, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), deleteBrokerageSettings);

// Platform base/clearing rates — the single fixed cost-basis per instrument
// (e.g. NSE Futures 1.5 paisa, MCX Gold ₹120/lot/side) used by the weekly
// admin report's owed_upward_brk cascade. Admin-only: this is a platform-
// wide figure, not something any individual master should be able to set.
router.get('/platform-base-rates', authenticateAdmin, requireAdminPermission('BROKERAGE_MANAGE'), async (req, res) => {
  try {
    const PlatformBaseRate = require('../models/PlatformBaseRate');
    const rates = await PlatformBaseRate.find({ deleted_at: null }).sort({ exchange_name: 1, script_name: 1 }).lean();
    res.json({ success: true, data: rates });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});
router.post('/platform-base-rates', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), async (req, res) => {
  try {
    const { type, exchange_name, script_name, brk_value } = req.body;
    if (!type || !exchange_name || brk_value === undefined) {
      return res.status(400).json({ success: false, message: 'type, exchange_name, and brk_value are required', data: null });
    }
    const PlatformBaseRate = require('../models/PlatformBaseRate');
    const rate = await PlatformBaseRate.create({
      type, exchange_name, script_name: script_name || '', brk_value, effective_from: new Date(),
    });
    res.status(201).json({ success: true, data: rate });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});
router.put('/platform-base-rates/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), async (req, res) => {
  try {
    const { brk_value, type } = req.body;
    if (brk_value === undefined) {
      return res.status(400).json({ success: false, message: 'brk_value is required', data: null });
    }
    const PlatformBaseRate = require('../models/PlatformBaseRate');
    const updateFields = { brk_value, effective_from: new Date() };
    if (type) updateFields.type = type;
    const rate = await PlatformBaseRate.findOneAndUpdate(
      { _id: req.params.id, deleted_at: null },
      { $set: updateFields },
      { new: true, runValidators: true }
    );
    if (!rate) return res.status(404).json({ success: false, message: 'Platform base rate not found', data: null });
    res.json({ success: true, data: rate });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});
router.delete('/platform-base-rates/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('BROKERAGE_MANAGE'), async (req, res) => {
  try {
    const PlatformBaseRate = require('../models/PlatformBaseRate');
    const rate = await PlatformBaseRate.findOneAndUpdate(
      { _id: req.params.id, deleted_at: null },
      { $set: { deleted_at: new Date() } },
      { new: true }
    );
    if (!rate) return res.status(404).json({ success: false, message: 'Platform base rate not found', data: null });
    res.json({ success: true, data: null });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// Refresh close prices (admin-only, for testing / manual trigger) — feeds
// the same settlement price pipeline as /admin/settlement/start, but had
// no permission key at all, unlike that SETTLEMENT_TRIGGER-gated sibling.
router.post('/refresh-close-prices', authenticateAdmin, requireAdminPermission('SETTLEMENT_TRIGGER'), async (req, res) => {
  try {
    const livePriceService = require('../services/livePriceService');
    const result = await livePriceService.refreshClosePrices();
    res.json({ success: true, message: 'Close prices refreshed', ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
  }
});

// Refresh settlement prices via OHLC API (admin-only, for testing / manual trigger)
router.post('/refresh-settlement-prices', authenticateAdmin, requireAdminPermission('SETTLEMENT_TRIGGER'), async (req, res) => {
  try {
    const livePriceService = require('../services/livePriceService');
    const result = await livePriceService.refreshSettlementPrices();
    res.json({ success: true, message: 'Settlement prices refreshed', ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
  }
});

// ==================== ANNOUNCEMENT ROUTES ====================
const { setAnnouncement, clearAnnouncement, getActiveAnnouncement } = require('../controllers/announcementController');
router.post('/announcements', authenticateAdmin, rejectIfAdminWatchOnly, setAnnouncement);
router.delete('/announcements', authenticateAdmin, rejectIfAdminWatchOnly, clearAnnouncement);
router.get('/announcements/active', authenticateAny, getActiveAnnouncement);

// ==================== FRESH STOPLOSS LIMIT ROUTES ====================
const { getAllFreshStoplossLimits, bulkCreateFreshStoplossLimits, updateFreshStoplossLimit, deleteFreshStoplossLimit, bulkUpdateFreshStoplossLimits } = require('../controllers/freshStoplossLimitController');
router.get('/fresh-stoploss-limits', authenticateAdmin, getAllFreshStoplossLimits);
router.post('/fresh-stoploss-limits/bulk-create', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('FRESH_STOPLOSS_MANAGE'), bulkCreateFreshStoplossLimits);
router.put('/fresh-stoploss-limits/bulk-update', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('FRESH_STOPLOSS_MANAGE'), bulkUpdateFreshStoplossLimits);
router.put('/fresh-stoploss-limits/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('FRESH_STOPLOSS_MANAGE'), updateFreshStoplossLimit);
router.delete('/fresh-stoploss-limits/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('FRESH_STOPLOSS_MANAGE'), deleteFreshStoplossLimit);

// ==================== TOTP ROUTES ====================
const totpService = require('../services/adminOtpService');

router.get('/totp/status', authenticateAdmin, async (req, res) => {
  try {
    const status = await totpService.getTotpStatus(req.admin.id);
    if (!status) return res.status(404).json({ success: false, message: 'Admin not found', data: null });
    res.json({ success: true, data: status });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

router.post('/totp/generate', authenticateAdmin, async (req, res) => {
  try {
    const result = await totpService.generateSecret(req.admin.id);
    res.json({ success: true, data: { qr_data_url: result.qrDataUrl, secret: result.secret } });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

router.post('/totp/verify-setup', authenticateAdmin, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'TOTP code required', data: null });
    const verified = await totpService.verifySetup(req.admin.id, token);
    if (!verified) return res.status(400).json({ success: false, message: 'Invalid TOTP code', data: null });
    res.json({ success: true, message: 'TOTP activated successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

router.post('/totp/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled === undefined) return res.status(400).json({ success: false, message: 'enabled field required', data: null });
    await totpService.toggleTotp(req.admin.id, enabled);
    res.json({ success: true, message: `TOTP ${enabled ? 'enabled' : 'disabled'}` });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

router.post('/totp/reset', authenticateAdmin, async (req, res) => {
  try {
    await totpService.resetTotp(req.admin.id);
    res.json({ success: true, message: 'TOTP reset successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// ==================== INSTRUMENT MANAGEMENT ROUTES ====================
const KiteInstrument = require('../models/KiteInstrument');

/**
 * Cancel pending LIMIT/SL/SL-M orders on an instrument being disabled or
 * deleted. Without this, a pending order placed before the toggle would
 * still sit in the book and could fill later, opening a fresh position on
 * a script the admin just disabled — placeTrade only guarded NEW placement,
 * not orders already pending (the fill-time gate in priceQueueService.js /
 * orderExecutionService.js now also blocks this, but cancelling proactively
 * avoids relying solely on that backstop).
 *
 * `blockAll: true` (used for a full delete, matching placeTrade's blanket
 * block on deleted instruments) cancels every pending order regardless of
 * direction. Otherwise (a plain disable, which still allows closing an
 * existing position) only orders that would OPEN or exceed the closeable
 * quantity are cancelled — a protective stop-loss on an already-open
 * position is left alone, same as placeTrade's own closing allowance.
 */
async function cancelPendingOrdersForInstrument(instrumentToken, { blockAll = false } = {}) {
  const Trade = require('../models/Trade');
  const orderBookService = require('../services/orderBookService');

  const pendingOrders = await Trade.find({
    status: 'pending',
    instrument_token: instrumentToken,
    deleted_at: null,
  }).select('_id user_id instrument_token transaction_type quantity order_type trigger_direction').lean();
  if (pendingOrders.length === 0) return 0;

  let toCancel = pendingOrders;
  if (!blockAll) {
    const posAgg = await Trade.aggregate([
      { $match: { user_id: { $in: pendingOrders.map(o => o.user_id) }, instrument_token: instrumentToken, status: 'completed', deleted_at: null } },
      { $group: {
        _id: '$user_id',
        buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
        sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
      } },
    ]);
    const netQtyByUser = new Map(posAgg.map(p => [p._id.toString(), p.buy_qty - p.sell_qty]));

    toCancel = pendingOrders.filter(order => {
      const netQty = netQtyByUser.get(order.user_id.toString()) || 0;
      const isClosing = (order.transaction_type === 'SELL' && netQty > 0) || (order.transaction_type === 'BUY' && netQty < 0);
      const staysWithinPosition = isClosing && order.quantity <= Math.abs(netQty);
      return !staysWithinPosition;
    });
  }
  if (toCancel.length === 0) return 0;

  await Trade.updateMany(
    { _id: { $in: toCancel.map(o => o._id) }, status: 'pending', deleted_at: null },
    { $set: { status: 'cancelled', remarks: blockAll ? 'Auto-cancelled: instrument deleted by admin' : 'Auto-cancelled: instrument disabled by admin' } }
  );
  for (const order of toCancel) {
    try {
      await orderBookService.removeOrder(order._id.toString(), order.instrument_token.toString(), order.transaction_type, order.order_type, order.trigger_direction);
    } catch (_) { /* best-effort — DB status is authoritative */ }
  }
  return toCancel.length;
}

// GET /admin/instruments/segments — get unique segments for filter dropdown
router.get('/instruments/segments', authenticateAdmin, async (req, res) => {
  try {
    const segments = await KiteInstrument.distinct('segment', { deleted_at: null });
    res.json({ success: true, data: segments.sort() });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// GET /admin/instruments/expiries?segment=NFO — distinct expiry dates for one segment
// (each segment has its own independent expiry calendar — NFO's dates are unrelated
// to MCX's or GIFT NIFTY's — so this always requires a segment, never returns a global list)
router.get('/instruments/expiries', authenticateAdmin, async (req, res) => {
  try {
    const { segment } = req.query;
    if (!segment) {
      return res.status(400).json({ success: false, message: 'segment is required', data: null });
    }
    // Only current/future expiries — matches the default (no ?expiry=) filter
    // on GET /admin/instruments, which already hides expired contracts.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiries = await KiteInstrument.distinct('expiry', {
      segment,
      deleted_at: null,
      expiry: { $gte: today },
    });
    expiries.sort((a, b) => new Date(a) - new Date(b));
    res.json({ success: true, data: expiries });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// PUT /admin/instruments/bulk-toggle — enable/disable multiple instruments
router.put('/instruments/bulk-toggle', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('INSTRUMENT_MANAGE'), async (req, res) => {
  try {
    const { ids, enabled } = req.body;
    if (!ids || !Array.isArray(ids) || enabled === undefined) {
      return res.status(400).json({ success: false, message: 'ids array and enabled field required', data: null });
    }
    const result = await KiteInstrument.updateMany({ _id: { $in: ids } }, { $set: { enabled } });

    if (enabled === false) {
      const disabledInstruments = await KiteInstrument.find({ _id: { $in: ids } }).select('instrument_token').lean();
      for (const inst of disabledInstruments) {
        try { await cancelPendingOrdersForInstrument(inst.instrument_token); } catch (_) {}
      }
    }

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: `${result.modifiedCount} instrument(s) ${enabled ? 'enabled' : 'disabled'}`, data: { modified: result.modifiedCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// GET /admin/instruments — list instruments with filters (paginated)
// Shows ALL instruments including soft-deleted ones (admin needs to see them to restore)
router.get('/instruments', authenticateAdmin, async (req, res) => {
  try {
    const { segment, raw_name, expiry, search, enabled, page = 1, limit = 50 } = req.query;
    const filter = {};

    // Default: only show non-expired instruments (indices have no expiry)
    if (!expiry) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      filter.$or = filter.$or || [];
      // Will be merged with search $or below if needed
      filter.expiry = { $gte: today };
      // Also include instruments with no expiry (indices)
      delete filter.expiry;
      filter.$and = [
        { $or: [{ expiry: { $gte: today } }, { expiry: null }] }
      ];
    }

    if (segment) filter.segment = segment;
    if (raw_name) filter.raw_name = { $regex: escapeRegex(raw_name), $options: 'i' };
    if (expiry) {
      // Override default expiry filter with specific date
      delete filter.$and;
      const d = new Date(expiry);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      filter.expiry = { $gte: d, $lt: nextDay };
    }
    if (enabled === 'true') filter.enabled = true;
    if (enabled === 'false') filter.enabled = false;
    if (search) {
      const safeSearch = escapeRegex(search);
      const searchOr = [
        { tradingsymbol: { $regex: safeSearch, $options: 'i' } },
        { raw_name: { $regex: safeSearch, $options: 'i' } },
        { display_name: { $regex: safeSearch, $options: 'i' } },
      ];
      if (filter.$and) {
        filter.$and.push({ $or: searchOr });
      } else {
        filter.$or = searchOr;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [instruments, total] = await Promise.all([
      KiteInstrument.find(filter)
        .select('instrument_token tradingsymbol raw_name display_name segment exchange instrument_type expiry strike lot_size enabled is_active last_price deleted_at')
        .sort({ raw_name: 1, instrument_type: 1, expiry: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      KiteInstrument.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: instruments,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// PUT /admin/instruments/:id/toggle — enable/disable an instrument
router.put('/instruments/:id/toggle', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('INSTRUMENT_MANAGE'), async (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled === undefined) {
      return res.status(400).json({ success: false, message: 'enabled field required', data: null });
    }
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { enabled }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    if (enabled === false) {
      try { await cancelPendingOrdersForInstrument(inst.instrument_token); } catch (_) {}
    }

    // Refresh search cache so disabled instruments stop appearing
    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: `Instrument ${enabled ? 'enabled' : 'disabled'}`, data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// DELETE /admin/instruments/:id — soft delete an instrument
router.delete('/instruments/:id', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('INSTRUMENT_MANAGE'), async (req, res) => {
  try {
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { deleted_at: new Date(), enabled: false }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    try { await cancelPendingOrdersForInstrument(inst.instrument_token, { blockAll: true }); } catch (_) {}

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: 'Instrument deleted', data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// PUT /admin/instruments/:id/restore — restore a soft-deleted instrument
router.put('/instruments/:id/restore', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('INSTRUMENT_MANAGE'), async (req, res) => {
  try {
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { deleted_at: null, enabled: true }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: 'Instrument restored', data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

// Trigger bhavcopy settlement price fetch (admin-only)
router.post('/bhavcopy/fetch', authenticateAdmin, requireAdminPermission('SETTLEMENT_TRIGGER'), async (req, res) => {
  try {
    const { date } = req.body; // optional: YYYY-MM-DD string
    const { fetchAndApplyBhavcopy } = require('../services/bhavcopyService');
    const result = await fetchAndApplyBhavcopy(date || undefined);
    res.json({
      success: true,
      message: 'Bhavcopy fetch completed',
      data: {
        nse: result.nseMatched,
        mcx: result.mcxMatched,
        nse_trading_date: result.nseTradingDate,
        mcx_trading_date: result.mcxTradingDate,
        total: Object.keys(result.closePriceMap).length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
  }
});

// Settlement
const { startSettlement, getSettlementStatus } = require('../controllers/settlementController');
router.post('/settlement/start', authenticateAdmin, rejectIfAdminWatchOnly, requireAdminPermission('SETTLEMENT_TRIGGER'), startSettlement);
router.get('/settlement/status', authenticateAdmin, getSettlementStatus);

// ==================== ADMIN PROFILE ROUTE ====================
router.get('/profile', authenticateAdmin, async (req, res) => {
  try {
    const Admin = require('../models/Admin');
    const Server = require('../models/Server');
    const admin = await Admin.findById(req.admin.id).lean();
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found', data: null });
    }

    // Get server info if admin has one assigned
    let serverName = null;
    if (admin.server_id) {
      const server = await Server.findById(admin.server_id).lean();
      serverName = server?.name || admin.server_id.toString();
    }

    res.json({
      success: true,
      data: {
        id: admin._id,
        username: admin.username,
        server_id: serverName || 'N/A',
        last_login: admin.last_login || null,
        created_at: admin.createdAt,
        // Added for the mobile app's Super Admin / permissions UI — the
        // login response already carries these (admin.toJSON()), but this
        // separate profile fetch (used to refresh/re-derive admin state
        // without a fresh login, e.g. after app restart) didn't.
        is_super_admin: !!admin.is_super_admin,
        watch_only: !!admin.watch_only,
        permissions: admin.permissions || [],
        active_status: admin.active_status !== false,
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(e), data: null });
  }
});

module.exports = router;
