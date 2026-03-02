const express = require('express');
const router = express.Router();
const { getUserProfile, getUserTrades } = require('../controllers/userController');
const { authenticateUser } = require('../middlewares/auth');

// Make sure users are authenticated
router.get('/:id', authenticateUser, getUserProfile);

// Get a user's trade history
router.get('/:id/trades', authenticateUser, getUserTrades);

module.exports = router;
