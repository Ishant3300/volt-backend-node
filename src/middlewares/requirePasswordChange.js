/**
 * Middleware: Block API access if user/master has a pending password reset.
 *
 * Enforces purely on change_pass_on_first_login === true — NOT also on
 * last_login being unset. A prior version additionally required
 * `!user.last_login`, believing that distinguished "never logged in before"
 * from "has logged in before" — but universalLogin sets AND saves
 * `last_login = new Date()` on every login, including the very first one,
 * before the response is even sent. So by the time any request using that
 * fresh token reached this middleware, last_login was already set from that
 * same login, making `!user.last_login` always false and the block
 * permanently unreachable — the enforcement never actually fired for
 * anyone; only the Flutter app's own client-side check of the login
 * response's `requires_password_change` flag did anything.
 *
 * change_pass_on_first_login alone is the correct, sufficient signal: it's
 * only ever cleared in changePassword after a real password reset, so it
 * stays true across as many logins as it takes until the user actually
 * changes their password — which is the intended behavior (keep blocking
 * them every time, not just once).
 *
 * Backward compatibility for pre-existing accounts holds regardless: the
 * schema default is `false`, and `true` is only ever written explicitly by
 * the create-account controllers (adminController.js, masterController.js,
 * masterUserController.js, masterChildController.js) — an old account
 * created before this feature existed simply never had the field set, so
 * it reads back `undefined`/`false`, not `true`, and `=== true` correctly
 * skips enforcement for it.
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
