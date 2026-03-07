const express = require('express');
const router = express.Router();
const { authenticateAdminOrMaster } = require('../middlewares/auth');

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
  getAggregatedPositions,
  getInstrumentUserBreakdown,
  getUserMetrics,
  getAdminMasterMetrics
} = require('../controllers/masterPositionController');

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

module.exports = router;
