const express = require('express');
const router = express.Router();
const {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
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
const { getLotNamesByExchange } = require('../controllers/groupedQuantityController');
const { authenticateAdmin, authenticateAdminOrMaster ,authenticateMaster} = require('../middlewares/auth');

// All routes require admin authentication


// User CRUD operations
router.post('/users', authenticateMaster, createUser);
router.get('/users', authenticateAdminOrMaster ,getAllUsers);
router.get('/users/:id', authenticateAdminOrMaster,getUserById);
router.put('/users/:id', updateUser);
router.delete('/users/:id', authenticateMaster ,deleteUser);

// Grouped Quantity CRUD operations
router.post('/grouped-quantities', authenticateAdmin,createGroupedQuantity);
router.get('/grouped-quantities/exchange/:exchange_name/lot-names',authenticateAdminOrMaster ,getLotNamesByExchange);
router.get('/grouped-quantities', authenticateAdminOrMaster,getAllGroupedQuantities);
router.get('/grouped-quantities/:id', authenticateAdminOrMaster,getGroupedQuantityById);
router.put('/grouped-quantities/:id', authenticateAdmin,updateGroupedQuantity);
router.delete('/grouped-quantities/:id', authenticateAdmin,deleteGroupedQuantity);

// Script Quantity CRUD operations
router.post('/script-quantities', authenticateAdmin,createScriptQuantity);
router.get('/script-quantities', authenticateAdminOrMaster,getAllScriptQuantities);
router.get('/script-quantities/:id', authenticateAdminOrMaster,getScriptQuantityById);
router.put('/script-quantities/:id', authenticateAdmin,updateScriptQuantity);
router.delete('/script-quantities/:id', authenticateAdmin,deleteScriptQuantity);

// Trade Margin CRUD operations
router.post('/trade-margins', authenticateAdmin,createTradeMargin);
router.get('/trade-margins', authenticateAdminOrMaster,getAllTradeMargins);
router.get('/trade-margins/:id', authenticateAdminOrMaster,getTradeMarginById);
router.put('/trade-margins/:id', authenticateAdmin,updateTradeMargin);
router.delete('/trade-margins/:id', authenticateAdmin,deleteTradeMargin);

// Brokerage Settings CRUD operations
router.post('/brokerage-settings', authenticateAdmin,createBrokerageSettings);
router.get('/brokerage-settings', authenticateAdminOrMaster,getAllBrokerageSettings);
router.get('/brokerage-settings/:id', authenticateAdminOrMaster,getBrokerageSettingsById);
router.put('/brokerage-settings/:id', authenticateAdmin,updateBrokerageSettings);
router.delete('/brokerage-settings/:id', authenticateAdmin,deleteBrokerageSettings);

module.exports = router;
