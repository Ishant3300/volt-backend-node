const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');
const { validateTrade } = require('../middlewares/validate');
const tradeController = require('../controllers/tradeController');
const { getTradeReport, getOpenPositions, getSettlementHistory } = require('../controllers/tradeReportController');
const { getRejectionLog } = require('../controllers/rejectionLogController');
const { getUserwisePositions } = require('../controllers/userwisePositionController');
const { getScriptQtyDetails, getAllLots, getInstrumentLimit } = require('../controllers/scriptQtyDetailController');
const { getDeletedTrades } = require('../controllers/deletedTradeController');

// All trade routes require authentication
router.use(authenticateAny);

// Write operations — blocked in investor mode
router.post('/', rejectIfInvestor, tradeController.placeTrade);
router.put('/:tradeId/cancel', rejectIfInvestor, tradeController.cancelTrade);
router.delete('/:tradeId', rejectIfInvestor, tradeController.deleteTrade);
router.post('/metrics', rejectIfInvestor, tradeController.saveClientMetrics);
router.post('/auto-squareoff-expired', rejectIfInvestor, tradeController.autoSquareOffExpired);

// Read operations — allowed in investor mode
router.get('/metrics', tradeController.getAccountMetrics);
router.get('/positions', tradeController.getPositions);
router.get('/brokerage-rules', tradeController.getBrokerageRules);
router.get('/report', getTradeReport);
router.get('/open-positions', getOpenPositions);
router.get('/settlement-history', getSettlementHistory);
router.get('/instrument-info', tradeController.getInstrumentInfo);
router.get('/userwise-positions', getUserwisePositions);
router.get('/script-qty-details', getScriptQtyDetails);
router.get('/script-qty-all-lots', getAllLots);
router.get('/instrument-limit', getInstrumentLimit);
router.get('/deleted-trades', getDeletedTrades);
router.get('/rejection-log', getRejectionLog);

module.exports = router;
