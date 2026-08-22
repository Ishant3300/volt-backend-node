/**
 * Middleware: Block write operations for investor-mode sessions.
 *
 * Investor mode is a read-only access level. When a user/master logs in
 * with their investor password, the JWT contains `investor: true`.
 * This middleware checks that flag and rejects any write operation with a 403.
 *
 * Apply this AFTER the auth middleware (authenticateAny/authenticateUser/authenticateMaster)
 * on any route that mutates data (POST/PUT/DELETE for trades, watchlist, settings, etc.).
 */
const rejectIfInvestor = (req, res, next) => {
  const decoded = req.user || req.master;
  if (decoded && decoded.investor === true) {
    return res.status(403).json({
      success: false,
      message: 'This action is not available in investor mode',
      data: { investor_mode: true }
    });
  }
  next();
};

module.exports = { rejectIfInvestor };
