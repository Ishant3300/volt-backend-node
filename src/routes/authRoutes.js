const express = require('express');
const router = express.Router();
const { userLogin, adminLogin, userLogout, adminLogout } = require('../controllers/authController');
const { authenticateUser, authenticateAdmin } = require('../middlewares/auth');

// User login
router.post('/user/login', userLogin);

// Admin login
router.post('/admin/login', adminLogin);

// User logout (requires authentication)
router.post('/user/logout', authenticateUser, userLogout);

// Admin logout (requires authentication)
router.post('/admin/logout', authenticateAdmin, adminLogout);

module.exports = router;
