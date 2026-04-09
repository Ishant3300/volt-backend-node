const express = require('express');
const router = express.Router();
const { userLogin, adminLogin, masterLogin, userLogout, adminLogout, masterLogout, universalLogin, changePassword, getNotificationSettings, updateNotificationSettings, registerFcmToken, removeFcmToken, deleteAccount } = require('../controllers/authController');
const { authenticateUser, authenticateAdmin, authenticateMaster } = require('../middlewares/auth');
const { authenticateAny } = require('../middlewares/auth');

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

// Change password (any role)
router.post('/change-password', authenticateAny, changePassword);

// Notification settings (any role)
router.get('/notification-settings', authenticateAny, getNotificationSettings);
router.put('/notification-settings', authenticateAny, updateNotificationSettings);

// FCM token management (any role)
router.post('/fcm-token', authenticateAny, registerFcmToken);
router.delete('/fcm-token', authenticateAny, removeFcmToken);

// Delete account (any role)
router.delete('/account', authenticateAny, deleteAccount);

module.exports = router;
