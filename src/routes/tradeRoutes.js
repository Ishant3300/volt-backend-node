const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const { validateTrade } = require('../middlewares/validate');
const tradeController = require('../controllers/tradeController');
const { getTradeReport, getOpenPositions, getSettlementHistory } = require('../controllers/tradeReportController');
const { getRejectionLog } = require('../controllers/rejectionLogController');
const { getUserwisePositions } = require('../controllers/userwisePositionController');
const { getScriptQtyDetails, getAllLots, getInstrumentLimit } = require('../controllers/scriptQtyDetailController');
const { getDeletedTrades } = require('../controllers/deletedTradeController');

// All trade routes require authentication
router.use(authenticateAny);

// Place a new trade
router.post('/', tradeController.placeTrade);

// Cancel a pending trade
router.put('/:tradeId/cancel', tradeController.cancelTrade);

// Soft-delete a trade (admin/master)
router.delete('/:tradeId', tradeController.deleteTrade);

// Get current user metrics
router.get('/metrics', tradeController.getAccountMetrics);

// Save client-computed metrics to DB (called by Flutter periodically)
router.post('/metrics', tradeController.saveClientMetrics);

// Get positions for frontend metrics calculation
router.get('/positions', tradeController.getPositions);

// Get margin rules for frontend metrics calculation
router.get('/margins', tradeController.getMargins);

// Get brokerage rules for frontend brokerage calculation
router.get('/brokerage-rules', tradeController.getBrokerageRules);

// Trade report for PDF generation
router.get('/report', getTradeReport);

// Actual open positions for a user (no date filter — used by Live M2M PDF)
router.get('/open-positions', getOpenPositions);

// Immutable settlement-history ledger (durable source for historical bills)
router.get('/settlement-history', getSettlementHistory);

// Instrument info for trade card info sheet
router.get('/instrument-info', tradeController.getInstrumentInfo);

// Userwise open positions
router.get('/userwise-positions', getUserwisePositions);

// Script quantity details for user
router.get('/script-qty-details', getScriptQtyDetails);

// All lots overview (admin/master read-only)
router.get('/script-qty-all-lots', getAllLots);
router.get('/instrument-limit', getInstrumentLimit);

// Deleted trades history
router.get('/deleted-trades', getDeletedTrades);

// Rejection / cancellation / deletion log
router.get('/rejection-log', getRejectionLog);

// Auto square-off expired positions (called by Flutter on app open)
router.post('/auto-squareoff-expired', tradeController.autoSquareOffExpired);

module.exports = router;
