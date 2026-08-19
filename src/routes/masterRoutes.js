const express = require('express');
const router = express.Router();
const { authenticateAdminOrMaster, authenticateAdmin } = require('../middlewares/auth');
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
router.put('/:id', authenticateAdminOrMaster, updateMaster);
router.delete('/:id', authenticateAdminOrMaster, deleteMaster);

// Status management
router.put('/:id/status', authenticateAdminOrMaster, updateMasterStatus);

// Permission management
router.put('/:id/permissions', authenticateAdminOrMaster, updateMasterPermissions);

// Details management
router.put('/:id/details', authenticateAdminOrMaster, updateMasterDetails);

// Intraday Squareoff Settings
router.put('/:id/intraday-squareoff', authenticateAdminOrMaster, updateMasterIntradaySquareoff);

// Margin Squareoff Percentage
router.put('/:id/margin-squareoff-percentage', authenticateAdminOrMaster, updateMasterMarginSquareoffPercentage);

// Credit/Debit operations
router.post('/:id/credit', authenticateAdminOrMaster, creditMaster);
router.post('/:id/debit', authenticateAdminOrMaster, debitMaster);

// Position
router.get('/:id/position', authenticateAdminOrMaster, getMasterPosition);

// Messaging
router.post('/:id/messages', authenticateAdminOrMaster, sendMessageToMaster);

// Account Limit
router.get('/:id/account-limit', authenticateAdminOrMaster, getAccountLimit);
router.put('/:id/account-limit', authenticateAdminOrMaster, updateAccountLimit);

// Base rates — a master's own per-segment reference brokerage rate.
// Display/autofill only for the hierarchy creation UI; GET is also how the
// creation form fetches a selected parent's rates to prefill before save.
router.get('/:id/base-rates', authenticateAdminOrMaster, getMasterBaseRates);
router.put('/:id/base-rates', authenticateAdminOrMaster, updateMasterBaseRates);

module.exports = router;
