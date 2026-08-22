const express = require('express');
const router = express.Router();
const { authenticateAdminOrMaster, authenticateAdmin } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');
const {
  createMaster,
  getAllMasters,
  getMasterById,
  updateMaster,
  updateMasterStatus,
  updateMasterPermissions,
  updateMasterDetails,
  updateMasterIntradaySquareoff,
  updateMasterMarginSquareoffPercentage,
  deleteMaster,
  creditMaster,
  debitMaster,
  getAllTrades,
  getMasterPosition,
  sendMessageToMaster,
  getAccountLimit,
  updateAccountLimit,
  getMasterBaseRates,
  updateMasterBaseRates
} = require('../controllers/masterController');


// Master CRUD
router.post('/', authenticateAdmin, createMaster);
router.get('/', authenticateAdminOrMaster, getAllMasters);

// Trades (admin can see all trades) — must be before /:id to avoid matching
router.get('/trades/all', authenticateAdminOrMaster, getAllTrades);

router.get('/:id', authenticateAdminOrMaster, getMasterById);
router.put('/:id', authenticateAdminOrMaster, rejectIfInvestor, updateMaster);
router.delete('/:id', authenticateAdminOrMaster, rejectIfInvestor, deleteMaster);

// Status management
router.put('/:id/status', authenticateAdminOrMaster, rejectIfInvestor, updateMasterStatus);

// Permission management
router.put('/:id/permissions', authenticateAdminOrMaster, rejectIfInvestor, updateMasterPermissions);

// Details management
router.put('/:id/details', authenticateAdminOrMaster, rejectIfInvestor, updateMasterDetails);

// Intraday Squareoff Settings
router.put('/:id/intraday-squareoff', authenticateAdminOrMaster, rejectIfInvestor, updateMasterIntradaySquareoff);

// Margin Squareoff Percentage
router.put('/:id/margin-squareoff-percentage', authenticateAdminOrMaster, rejectIfInvestor, updateMasterMarginSquareoffPercentage);

// Credit/Debit operations
router.post('/:id/credit', authenticateAdminOrMaster, rejectIfInvestor, creditMaster);
router.post('/:id/debit', authenticateAdminOrMaster, rejectIfInvestor, debitMaster);

// Position
router.get('/:id/position', authenticateAdminOrMaster, getMasterPosition);

// Messaging
router.post('/:id/messages', authenticateAdminOrMaster, rejectIfInvestor, sendMessageToMaster);

// Account Limit
router.get('/:id/account-limit', authenticateAdminOrMaster, getAccountLimit);
router.put('/:id/account-limit', authenticateAdminOrMaster, rejectIfInvestor, updateAccountLimit);

// Base rates
router.get('/:id/base-rates', authenticateAdminOrMaster, getMasterBaseRates);
router.put('/:id/base-rates', authenticateAdminOrMaster, rejectIfInvestor, updateMasterBaseRates);

module.exports = router;
