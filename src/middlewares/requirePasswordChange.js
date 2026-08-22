/**
 * Middleware: Block API access if user/master has a pending password reset.
 *
 * When change_pass_on_first_login is true, the user must change their password
 * before accessing any other API endpoint. Only auth-related paths are allowed through.
 *
 * This middleware decodes the JWT independently (before route-level auth middleware)
 * so it can check the flag without depending on req.user/req.master being set.
 */
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Master = require('../models/Master');

// Paths that are always allowed even when password change is pending
const ALLOWED_PATHS = [
  '/api/auth/change-password',
  '/api/auth/user/logout',
  '/api/auth/master/logout',
  '/api/auth/admin/logout',
  '/api/auth/login',
  '/api/auth/fcm-token/remove',
  '/api/auth/fcm-token',
];

const requirePasswordChanged = async (req, res, next) => {
  try {
    // Allow whitelisted paths through
    const path = req.originalUrl.split('?')[0];
    if (ALLOWED_PATHS.some(allowed => path === allowed || path.startsWith(allowed))) return next();

    // No token = not authenticated, let downstream auth middleware handle it
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return next();

    // Decode token to check role
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      // Invalid token — let downstream auth middleware handle the error
      return next();
    }

    // Admins are never subject to forced password change
    if (decoded.role === 'admin') return next();

    // Check the flag for users
    if (decoded.role === 'user') {
      const user = await User.findById(decoded.id).select('change_pass_on_first_login').lean();
      if (user && user.change_pass_on_first_login === true) {
        return res.status(403).json({
          success: false,
          message: 'Password change required before accessing the application',
          data: { requires_password_change: true }
        });
      }
    }

    // Check the flag for masters
    if (decoded.role === 'master') {
      const master = await Master.findById(decoded.id).select('change_pass_on_first_login').lean();
      if (master && master.change_pass_on_first_login === true) {
        return res.status(403).json({
          success: false,
          message: 'Password change required before accessing the application',
          data: { requires_password_change: true }
        });
      }
    }

    next();
  } catch (error) {
    // On error, don't block — let the request through (fail-open for this check)
    next();
  }
};

module.exports = { requirePasswordChanged };
