const express = require('express');
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

// Category trade-wallet funding (Task 12 / Requirements 5.1–5.7)
const {
  assign: walletAssign,
  withdraw: walletWithdraw,
  getWallet: walletGet,
  reconcile: walletReconcile,
} = require('../controllers/walletController');

// All routes require admin authentication


// User CRUD operations
router.post('/users', authenticateMaster, createUser);
router.get('/users', authenticateAdminOrMaster, getAllUsers);
router.get('/users/:id', authenticateAdminOrMaster, getUserById);
router.put('/users/:id', authenticateAdminOrMaster, updateUser);
router.delete('/users/:id', authenticateMaster, deleteUser);
router.post('/users/:id/credit', authenticateAdmin, creditUserByAdmin);
router.post('/users/:id/debit', authenticateAdmin, debitUserByAdmin);

// ==================== WALLET FUNDING ROUTES (admin grant/remove) ====================
// Admin is the root of funds: assign is a grant (credit only, no debit source),
// withdraw removes funds from the target. The walletController resolves req.admin
// as the actor; walletService owns the Mongo transaction + Transaction audit.
router.post('/wallet/assign', authenticateAdmin, walletAssign);
router.post('/wallet/withdraw', authenticateAdmin, walletWithdraw);
router.get('/wallet', authenticateAdmin, walletGet);
// Drift audit: per-category { available, blocked, total } from open positions
router.get('/wallet/reconcile', authenticateAdmin, walletReconcile);

// Grouped Quantity CRUD operations
router.post('/grouped-quantities', authenticateAdmin, createGroupedQuantity);
router.post('/grouped-quantities/bulk-create', authenticateAdmin, bulkCreateGroup);
router.get('/grouped-quantities/unique-raw-names/:segment', authenticateAdminOrMaster, getUniqueRawNamesBySegment);
router.get('/grouped-quantities/group/:exchange_name/:lot_name', authenticateAdminOrMaster, getGroupInstruments);
router.get('/grouped-quantities/exchange/:exchange_name/lot-names', authenticateAdminOrMaster, getLotNamesByExchange);
router.get('/grouped-quantities', authenticateAdminOrMaster, getAllGroupedQuantities);
router.get('/grouped-quantities/:id', authenticateAdminOrMaster, getGroupedQuantityById);
router.put('/grouped-quantities/:id', authenticateAdmin, updateGroupedQuantity);
router.delete('/grouped-quantities/:id', authenticateAdmin, deleteGroupedQuantity);

// Script Quantity CRUD operations
router.post('/script-quantities/bulk-create', authenticateAdminOrMaster, bulkCreateScriptQuantity);
router.get('/script-quantities/exchange/:exchange_name', authenticateAdminOrMaster, getScriptQuantityByExchange);
router.post('/script-quantities', authenticateAdminOrMaster, createScriptQuantity);
router.get('/script-quantities', authenticateAdminOrMaster, getAllScriptQuantities);
router.get('/script-quantities/:id', authenticateAdminOrMaster, getScriptQuantityById);
router.put('/script-quantities/:id', authenticateAdminOrMaster, updateScriptQuantity);
router.delete('/script-quantities/:id', authenticateAdminOrMaster, deleteScriptQuantity);

// Brokerage Settings CRUD operations
router.post('/brokerage-settings/bulk-create', authenticateAdminOrMaster, bulkCreateBrokerage);
router.get('/brokerage-settings/exchange/:exchange_name', authenticateAdminOrMaster, getBrokerageByExchange);
router.post('/brokerage-settings', authenticateAdminOrMaster, createBrokerageSettings);
router.get('/brokerage-settings', authenticateAdminOrMaster, getAllBrokerageSettings);
router.get('/brokerage-settings/:id', authenticateAdminOrMaster, getBrokerageSettingsById);
// Bulk update brokerage settings (update multiple IDs with same value)
router.put('/brokerage-settings/bulk-update', authenticateAdminOrMaster, async (req, res) => {
  try {
    const { ids, brk_value, type } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0 || brk_value === undefined) {
      return res.status(400).json({ success: false, message: 'ids array and brk_value are required', data: null });
    }
    const BrokerageSettings = require('../models/BrokerageSettings');
    // Stamp effective_from so this new rate only applies to trades from now onwards.
    const updateFields = { brk_value, effective_from: new Date() };
    if (type) updateFields.type = type;
    const result = await BrokerageSettings.updateMany({ _id: { $in: ids }, deleted_at: null }, { $set: updateFields });

    // Reload metricsEngine rules so brokerage calculations use the new values immediately
    try { const me = require('../services/metricsEngine'); me.reloadRules(); } catch (_) {}

    res.json({ success: true, message: `Updated ${result.modifiedCount} brokerage setting(s)`, data: { modified: result.modifiedCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});
router.put('/brokerage-settings/:id', authenticateAdminOrMaster, updateBrokerageSettings);
router.delete('/brokerage-settings/:id', authenticateAdminOrMaster, deleteBrokerageSettings);

// Refresh close prices (admin-only, for testing / manual trigger)
router.post('/refresh-close-prices', authenticateAdmin, async (req, res) => {
  try {
    const livePriceService = require('../services/livePriceService');
    const result = await livePriceService.refreshClosePrices();
    res.json({ success: true, message: 'Close prices refreshed', ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Refresh settlement prices via OHLC API (admin-only, for testing / manual trigger)
router.post('/refresh-settlement-prices', authenticateAdmin, async (req, res) => {
  try {
    const livePriceService = require('../services/livePriceService');
    const result = await livePriceService.refreshSettlementPrices();
    res.json({ success: true, message: 'Settlement prices refreshed', ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ANNOUNCEMENT ROUTES ====================
const { setAnnouncement, clearAnnouncement, getActiveAnnouncement } = require('../controllers/announcementController');
router.post('/announcements', authenticateAdmin, setAnnouncement);
router.delete('/announcements', authenticateAdmin, clearAnnouncement);
router.get('/announcements/active', authenticateAny, getActiveAnnouncement);

// ==================== FRESH STOPLOSS LIMIT ROUTES ====================
const { getAllFreshStoplossLimits, bulkCreateFreshStoplossLimits, updateFreshStoplossLimit, deleteFreshStoplossLimit, bulkUpdateFreshStoplossLimits } = require('../controllers/freshStoplossLimitController');
router.get('/fresh-stoploss-limits', authenticateAdmin, getAllFreshStoplossLimits);
router.post('/fresh-stoploss-limits/bulk-create', authenticateAdmin, bulkCreateFreshStoplossLimits);
router.put('/fresh-stoploss-limits/bulk-update', authenticateAdmin, bulkUpdateFreshStoplossLimits);
router.put('/fresh-stoploss-limits/:id', authenticateAdmin, updateFreshStoplossLimit);
router.delete('/fresh-stoploss-limits/:id', authenticateAdmin, deleteFreshStoplossLimit);

// ==================== TOTP ROUTES ====================
const totpService = require('../services/adminOtpService');

router.get('/totp/status', authenticateAdmin, async (req, res) => {
  try {
    const status = await totpService.getTotpStatus(req.admin.id);
    if (!status) return res.status(404).json({ success: false, message: 'Admin not found', data: null });
    res.json({ success: true, data: status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

router.post('/totp/generate', authenticateAdmin, async (req, res) => {
  try {
    const result = await totpService.generateSecret(req.admin.id);
    res.json({ success: true, data: { qr_data_url: result.qrDataUrl, secret: result.secret } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
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
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

router.post('/totp/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled === undefined) return res.status(400).json({ success: false, message: 'enabled field required', data: null });
    await totpService.toggleTotp(req.admin.id, enabled);
    res.json({ success: true, message: `TOTP ${enabled ? 'enabled' : 'disabled'}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

router.post('/totp/reset', authenticateAdmin, async (req, res) => {
  try {
    await totpService.resetTotp(req.admin.id);
    res.json({ success: true, message: 'TOTP reset successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// ==================== INSTRUMENT MANAGEMENT ROUTES ====================
const KiteInstrument = require('../models/KiteInstrument');

// GET /admin/instruments/segments — get unique segments for filter dropdown
router.get('/instruments/segments', authenticateAdmin, async (req, res) => {
  try {
    const segments = await KiteInstrument.distinct('segment', { deleted_at: null });
    res.json({ success: true, data: segments.sort() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// PUT /admin/instruments/bulk-toggle — enable/disable multiple instruments
router.put('/instruments/bulk-toggle', authenticateAdmin, async (req, res) => {
  try {
    const { ids, enabled } = req.body;
    if (!ids || !Array.isArray(ids) || enabled === undefined) {
      return res.status(400).json({ success: false, message: 'ids array and enabled field required', data: null });
    }
    const result = await KiteInstrument.updateMany({ _id: { $in: ids } }, { $set: { enabled } });

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: `${result.modifiedCount} instrument(s) ${enabled ? 'enabled' : 'disabled'}`, data: { modified: result.modifiedCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
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
    if (raw_name) filter.raw_name = { $regex: raw_name, $options: 'i' };
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
      const searchOr = [
        { tradingsymbol: { $regex: search, $options: 'i' } },
        { raw_name: { $regex: search, $options: 'i' } },
        { display_name: { $regex: search, $options: 'i' } },
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
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// PUT /admin/instruments/:id/toggle — enable/disable an instrument
router.put('/instruments/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled === undefined) {
      return res.status(400).json({ success: false, message: 'enabled field required', data: null });
    }
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { enabled }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    // Refresh search cache so disabled instruments stop appearing
    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: `Instrument ${enabled ? 'enabled' : 'disabled'}`, data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// DELETE /admin/instruments/:id — soft delete an instrument
router.delete('/instruments/:id', authenticateAdmin, async (req, res) => {
  try {
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { deleted_at: new Date(), enabled: false }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: 'Instrument deleted', data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// PUT /admin/instruments/:id/restore — restore a soft-deleted instrument
router.put('/instruments/:id/restore', authenticateAdmin, async (req, res) => {
  try {
    const inst = await KiteInstrument.findByIdAndUpdate(req.params.id, { deleted_at: null, enabled: true }, { new: true });
    if (!inst) return res.status(404).json({ success: false, message: 'Instrument not found', data: null });

    try {
      const searchService = require('../services/instrumentSearchService');
      searchService.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: 'Instrument restored', data: inst });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

// Trigger bhavcopy settlement price fetch (admin-only)
router.post('/bhavcopy/fetch', authenticateAdmin, async (req, res) => {
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// Settlement
const { startSettlement, getSettlementStatus } = require('../controllers/settlementController');
router.post('/settlement/start', authenticateAdmin, startSettlement);
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
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: null });
  }
});

module.exports = router;
