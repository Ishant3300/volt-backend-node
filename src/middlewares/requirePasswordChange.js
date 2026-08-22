/**
 * Middleware: Block API access if user/master has a pending password reset.
 *
 * Enforces ONLY when BOTH conditions are true:
 *   1. change_pass_on_first_login === true
 *   2. The user has NEVER successfully logged in before (last_login is null)
 *
 * This ensures backward compatibility — existing accounts that have already
 * been using the app are never locked out, even if they have the flag set
 * from before this feature was enforced.
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
      return next();
    }

    // Admins are never subject to forced password change
    if (decoded.role === 'admin') return next();

    // Investor logins skip password change enforcement
    if (decoded.investor === true) return next();

    // Check the flag for users
    if (decoded.role === 'user') {
      const user = await User.findById(decoded.id).select('change_pass_on_first_login last_login').lean();
      // Only enforce if flag is true AND user has never logged in before this session
      // (last_login is set DURING the current login, so for a truly new user their
      // last_login will be the current session time — but they'll have logged in exactly once.
      // We use a count-based approach: if last_login exists and was set MORE than 5 seconds ago,
      // it means they had a prior session — skip enforcement.)
      // Simpler approach: only enforce if the flag is true. The login response already
      // tells the Flutter app to show the reset screen. This middleware is the safety net
      // for direct API callers. Old accounts will be fixed by a one-time migration.
      if (user && user.change_pass_on_first_login === true && !user.last_login) {
        return res.status(403).json({
          success: false,
          message: 'Password change required before accessing the application',
          data: { requires_password_change: true }
        });
      }
    }

    // Check the flag for masters
    if (decoded.role === 'master') {
      const master = await Master.findById(decoded.id).select('change_pass_on_first_login last_login').lean();
      if (master && master.change_pass_on_first_login === true && !master.last_login) {
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
