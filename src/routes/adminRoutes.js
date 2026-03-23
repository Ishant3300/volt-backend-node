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
  // Trade Margin
  createTradeMargin,
  getAllTradeMargins,
  getTradeMarginById,
  updateTradeMargin,
  deleteTradeMargin,
  // Brokerage Settings
  createBrokerageSettings,
  getAllBrokerageSettings,
  getBrokerageSettingsById,
  updateBrokerageSettings,
  deleteBrokerageSettings
} = require('../controllers/adminController');
const { getLotNamesByExchange, getUniqueRawNamesBySegment, bulkCreateGroup, getGroupInstruments, bulkCreateBrokerage, getBrokerageByExchange, bulkCreateTradeMargin, getTradeMarginByExchange, bulkCreateScriptQuantity, getScriptQuantityByExchange } = require('../controllers/groupedQuantityController');
const { authenticateAdmin, authenticateAdminOrMaster, authenticateMaster } = require('../middlewares/auth');

// All routes require admin authentication


// User CRUD operations
router.post('/users', authenticateMaster, createUser);
router.get('/users', authenticateAdminOrMaster, getAllUsers);
router.get('/users/:id', authenticateAdminOrMaster, getUserById);
router.put('/users/:id', updateUser);
router.delete('/users/:id', authenticateMaster, deleteUser);
router.post('/users/:id/credit', authenticateAdmin, creditUserByAdmin);
router.post('/users/:id/debit', authenticateAdmin, debitUserByAdmin);

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
router.post('/script-quantities/bulk-create', authenticateAdmin, bulkCreateScriptQuantity);
router.get('/script-quantities/exchange/:exchange_name', authenticateAdminOrMaster, getScriptQuantityByExchange);
router.post('/script-quantities', authenticateAdmin, createScriptQuantity);
router.get('/script-quantities', authenticateAdminOrMaster, getAllScriptQuantities);
router.get('/script-quantities/:id', authenticateAdminOrMaster, getScriptQuantityById);
router.put('/script-quantities/:id', authenticateAdmin, updateScriptQuantity);
router.delete('/script-quantities/:id', authenticateAdmin, deleteScriptQuantity);

// Trade Margin CRUD operations
router.post('/trade-margins/bulk-create', authenticateAdmin, bulkCreateTradeMargin);
router.get('/trade-margins/exchange/:exchange_name', authenticateAdminOrMaster, getTradeMarginByExchange);
router.post('/trade-margins', authenticateAdmin, createTradeMargin);
router.get('/trade-margins', authenticateAdminOrMaster, getAllTradeMargins);
router.get('/trade-margins/:id', authenticateAdminOrMaster, getTradeMarginById);
router.put('/trade-margins/:id', authenticateAdmin, updateTradeMargin);
router.delete('/trade-margins/:id', authenticateAdmin, deleteTradeMargin);

// Brokerage Settings CRUD operations
router.post('/brokerage-settings/bulk-create', authenticateAdmin, bulkCreateBrokerage);
router.get('/brokerage-settings/exchange/:exchange_name', authenticateAdminOrMaster, getBrokerageByExchange);
router.post('/brokerage-settings', authenticateAdmin, createBrokerageSettings);
router.get('/brokerage-settings', authenticateAdminOrMaster, getAllBrokerageSettings);
router.get('/brokerage-settings/:id', authenticateAdminOrMaster, getBrokerageSettingsById);
router.put('/brokerage-settings/:id', authenticateAdmin, updateBrokerageSettings);
router.delete('/brokerage-settings/:id', authenticateAdmin, deleteBrokerageSettings);

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

module.exports = router;
