const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');
const {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} = require('../controllers/watchlistController');

// All routes require user or admin authentication
router.use(authenticateAny);

// Read — allowed in investor mode
router.get('/', getWatchlist);

// Write — blocked in investor mode
router.post('/', rejectIfInvestor, addToWatchlist);
router.delete('/:id', rejectIfInvestor, removeFromWatchlist);

module.exports = router;
