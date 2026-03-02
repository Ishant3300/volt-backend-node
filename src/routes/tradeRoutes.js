const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const tradeController = require('../controllers/tradeController');

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

module.exports = router;
