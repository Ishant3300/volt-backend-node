const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} = require('../controllers/watchlistController');

// All routes require user or admin authentication
router.use(authenticateAny);

router.get('/', getWatchlist);
router.post('/', addToWatchlist);
router.delete('/:id', removeFromWatchlist);

module.exports = router;
