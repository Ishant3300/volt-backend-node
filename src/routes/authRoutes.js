const express = require('express');
const router = express.Router();
const { userLogin, adminLogin, masterLogin, userLogout, adminLogout, masterLogout, universalLogin } = require('../controllers/authController');
const { authenticateUser, authenticateAdmin, authenticateMaster } = require('../middlewares/auth');

// User login
router.post('/user/login', userLogin);

// Admin login
router.post('/admin/login', adminLogin);

// Master login
router.post('/master/login', masterLogin);

// User logout (requires authentication)
router.post('/user/logout', authenticateUser, userLogout);

// Admin logout (requires authentication)
router.post('/admin/logout', authenticateAdmin, adminLogout);

// Master logout (requires authentication)
router.post('/master/logout', authenticateMaster, masterLogout);

// Universal login
router.post('/login', universalLogin);

module.exports = router;
