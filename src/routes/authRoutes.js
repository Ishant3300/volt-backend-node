const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { validateLogin } = require('../middlewares/validate');
const { userLogin, adminLogin, masterLogin, userLogout, adminLogout, masterLogout, universalLogin, changePassword, getNotificationSettings, updateNotificationSettings, registerFcmToken, removeFcmToken, deleteAccount } = require('../controllers/authController');
const { authenticateUser, authenticateAdmin, authenticateMaster } = require('../middlewares/auth');
const { authenticateAny } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');

// Rate limiter for login endpoints — 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, please try again after 15 minutes' },
});

// User login
router.post('/user/login', loginLimiter, validateLogin, userLogin);

// Admin login
router.post('/admin/login', loginLimiter, validateLogin, adminLogin);

// Master login
router.post('/master/login', loginLimiter, validateLogin, masterLogin);

// Universal login
router.post('/login', loginLimiter, validateLogin, universalLogin);

// User logout (requires authentication)
router.post('/user/logout', authenticateUser, userLogout);

// Admin logout (requires authentication)
router.post('/admin/logout', authenticateAdmin, adminLogout);

// Master logout (requires authentication)
router.post('/master/logout', authenticateMaster, masterLogout);

// Change password (any role — blocked in investor mode)
router.post('/change-password', authenticateAny, rejectIfInvestor, changePassword);

// Notification settings (any role — read allowed, write blocked in investor mode)
router.get('/notification-settings', authenticateAny, getNotificationSettings);
router.put('/notification-settings', authenticateAny, rejectIfInvestor, updateNotificationSettings);

// FCM token management (any role — allowed in investor mode for push notifications)
router.post('/fcm-token', authenticateAny, registerFcmToken);
router.delete('/fcm-token', authenticateAny, removeFcmToken);

// Delete account (any role — blocked in investor mode)
router.delete('/account', authenticateAny, rejectIfInvestor, deleteAccount);

module.exports = router;
