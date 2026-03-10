const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const tradeController = require('../controllers/tradeController');
const { getTradeReport } = require('../controllers/tradeReportController');
const { getRejectionLog } = require('../controllers/rejectionLogController');
const { getUserwisePositions } = require('../controllers/userwisePositionController');
const { getScriptQtyDetails, getAllLots } = require('../controllers/scriptQtyDetailController');
const { getDeletedTrades } = require('../controllers/deletedTradeController');

// All trade routes require authentication
router.use(authenticateAny);

// Place a new trade
router.post('/', tradeController.placeTrade);

// Cancel a pending trade
router.put('/:tradeId/cancel', tradeController.cancelTrade);

// Get current user metrics
router.get('/metrics', tradeController.getAccountMetrics);

// Get positions for frontend metrics calculation
router.get('/positions', tradeController.getPositions);

// Get margin rules for frontend metrics calculation
router.get('/margins', tradeController.getMargins);

// Trade report for PDF generation
router.get('/report', getTradeReport);

// Userwise open positions
router.get('/userwise-positions', getUserwisePositions);

// Script quantity details for user
router.get('/script-qty-details', getScriptQtyDetails);

// All lots overview (admin/master read-only)
router.get('/script-qty-all-lots', getAllLots);

// Deleted trades history
router.get('/deleted-trades', getDeletedTrades);

// Rejection / cancellation / deletion log
router.get('/rejection-log', getRejectionLog);

module.exports = router;
