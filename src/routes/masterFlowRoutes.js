const express = require('express');
const router = express.Router();
const { authenticateAdminOrMaster } = require('../middlewares/auth');
const User = require('../models/User');
const Master = require('../models/Master');
const LoginHistory = require('../models/LoginHistory');

// Import controllers
const {
  createChildMaster,
  getAllChildMasters,
  getChildMasterById,
  updateChildMasterPermissions,
  updateChildMasterDetails,
  creditChildMaster,
  debitChildMaster,
  getChildMasterPosition,
  sendMessageToChildMaster,
  deleteChildMaster
} = require('../controllers/masterChildController');

const {
  createUser,
  getAllUsers,
  getUserById,
  updateUserDetails,
  updateUserIntradaySquareoff,
  updateUserMarginSquareoffPercentage,
  creditUser,
  debitUser,
  getUserPosition,
  sendMessageToUser,
  deleteUser
} = require('../controllers/masterUserController');

const {
  getAllTrades
} = require('../controllers/masterTradeController');

const {
  getTransactionHistory
} = require('../controllers/transactionController');

const {
  getAggregatedPositions,
  getInstrumentUserBreakdown,
  getUserMetrics,
  getAdminMasterMetrics,
  getBulkEquity,
  getLiveMetrics
} = require('../controllers/masterPositionController');

const { getPnlSummary } = require('../controllers/pnlSummaryController');
const { getWeeklyAdminReport } = require('../controllers/weeklyAdminController');
const { getSettlementReport } = require('../controllers/settlementController');

// All routes require admin or master authentication
router.use(authenticateAdminOrMaster);

// ============================================
// Child Master Management Routes
// ============================================

// Create child master
router.post('/masters', createChildMaster);

// Get all child masters
router.get('/masters', getAllChildMasters);

// Get child master by ID
router.get('/masters/:id', getChildMasterById);

// Update child master permissions
router.put('/masters/:id/permissions', updateChildMasterPermissions);

// Update child master details
router.put('/masters/:id/details', updateChildMasterDetails);

// Credit child master
router.post('/masters/:id/credit', creditChildMaster);

// Debit child master
router.post('/masters/:id/debit', debitChildMaster);

// Get child master position
router.get('/masters/:id/position', getChildMasterPosition);

// Send message to child master
router.post('/masters/:id/messages', sendMessageToChildMaster);

// Delete child master
router.delete('/masters/:id', deleteChildMaster);

// ============================================
// User Management Routes
// ============================================

// Create user
router.post('/users', createUser);

// Get all users
router.get('/users', getAllUsers);

// Get user by ID
router.get('/users/:id', getUserById);

// Update user details
router.put('/users/:id/details', updateUserDetails);

// Update user (full update)
router.put('/users/:id', updateUserDetails);

// Update user intraday squareoff settings
router.put('/users/:id/intraday-squareoff', updateUserIntradaySquareoff);

// Update user margin squareoff percentage
router.put('/users/:id/margin-squareoff-percentage', updateUserMarginSquareoffPercentage);

// Credit user
router.post('/users/:id/credit', creditUser);

// Debit user
router.post('/users/:id/debit', debitUser);

// Get user position
router.get('/users/:id/position', getUserPosition);

// Send message to user
router.post('/users/:id/messages', sendMessageToUser);

// Delete user
router.delete('/users/:id', deleteUser);

// ============================================
// Trade Management Routes
// ============================================

// Get all trades in hierarchy
router.get('/trades', getAllTrades);

// ============================================
// Transaction History Routes
// ============================================
router.get('/transactions', getTransactionHistory);

// ============================================
// Master Position Aggregation Routes
// ============================================

// Get aggregated positions across all child users
router.get('/positions/aggregated', getAggregatedPositions);

// Get full metrics per child user (6 metrics like user orders page)
router.get('/positions/user-metrics', getUserMetrics);

// Get per-user breakdown for a specific instrument
router.get('/positions/aggregated/:instrumentToken', getInstrumentUserBreakdown);

// Admin: get all masters with their users' positions for live P&L
router.get('/positions/admin-master-metrics', getAdminMasterMetrics);

// Bulk computed equity for user management list view
router.get('/positions/bulk-equity', getBulkEquity);

// Live metrics from metricsEngine cache (same data as WebSocket push)
router.get('/positions/live-metrics', getLiveMetrics);

// P&L summary: Master sees per-user, Admin sees per-master
router.get('/pnl-summary', getPnlSummary);

// Weekly admin report: Master sees per-user, Admin sees per-master
router.get('/weekly-admin-report', getWeeklyAdminReport);

// Settlement report: per-user P&L + brokerage for a given date
router.get('/settlement-report', getSettlementReport);

// ============================================
// Sharing Details Route
// ============================================
router.get('/sharing-details', async (req, res) => {
  try {
    const { master_id } = req.query;
    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin ? req.admin.id : req.master.id;

    // Determine which master's children to fetch
    const targetMasterId = (role === 'admin' && master_id) ? master_id : callerId;

    // Fetch the master itself
    const master = await Master.findOne({ _id: targetMasterId, deleted_at: null })
      .select('name username pnl_sharing brokerage_sharing')
      .lean();

    // Fetch child masters under this master
    const childMasters = await Master.find({ master_id: targetMasterId, deleted_at: null })
      .select('name username pnl_sharing brokerage_sharing')
      .sort({ createdAt: -1 })
      .lean();

    // Fetch users under this master
    const users = await User.find({ master_id: targetMasterId, deleted_at: null })
      .select('name username pnl_sharing brokerage_sharing')
      .sort({ createdAt: -1 })
      .lean();

    const formatEntry = (doc, role) => ({
      id: doc._id,
      name: doc.name,
      username: doc.username,
      role,
      pnl_sharing: doc.pnl_sharing || 0,
      brokerage_sharing: doc.brokerage_sharing || 0,
    });

    const data = {
      master: master ? formatEntry(master, 'MASTER') : null,
      children: [
        ...childMasters.map(m => formatEntry(m, 'MASTER')),
        ...users.map(u => formatEntry(u, 'USER')),
      ],
    };

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// Login History Route
// ============================================
router.get('/login-history', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const role = req.admin ? 'admin' : 'master';
    const callerId = req.admin ? req.admin.id : req.master.id;

    // Build filter: admin sees all, master sees own children + self
    const filter = {};
    if (role === 'master') {
      // Get child user IDs and child master IDs
      const childUserIds = await User.find({ master_id: callerId, deleted_at: null }).distinct('_id');
      const childMasterIds = await Master.find({ parent_master_id: callerId, deleted_at: null }).distinct('_id');
      const mongoose = require('mongoose');
      const selfId = new mongoose.Types.ObjectId(callerId);
      filter.userId = { $in: [selfId, ...childUserIds, ...childMasterIds] };
    }

    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
      ];
    }

    const [entries, total] = await Promise.all([
      LoginHistory.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      LoginHistory.countDocuments(filter)
    ]);

    // Map to consistent shape
    const data = entries.map(e => ({
      _id: e._id,
      username: e.username,
      name: e.name,
      role: e.userModel?.toUpperCase() || 'USER',
      ip_address: e.ip_address,
      logged_in_at: e.createdAt,
    }));

    res.status(200).json({ success: true, data, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
