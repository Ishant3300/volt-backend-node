/**
 * Input validation & sanitization middleware.
 * Strips dangerous characters and validates required fields.
 */

/**
 * Sanitize a string — remove null bytes, trim whitespace
 */
const sanitizeString = (val) => {
  if (typeof val !== 'string') return val;
  return val.replace(/\0/g, '').trim();
};

/**
 * Deep-sanitize all string values in an object
 */
const sanitizeBody = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    const sanitize = (obj) => {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string') {
          obj[key] = sanitizeString(obj[key]);
        } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          sanitize(obj[key]);
        }
      }
    };
    sanitize(req.body);
  }
  next();
};

/**
 * Validate login request body
 */
const validateLogin = (req, res, next) => {
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.length < 1 || username.length > 100) {
    return res.status(400).json({ success: false, message: 'Valid username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 1 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Valid password is required' });
  }
  // Sanitize
  req.body.username = sanitizeString(username);
  req.body.password = password; // Don't trim passwords
  next();
};

/**
 * Validate trade request body
 */
const validateTrade = (req, res, next) => {
  const { instrument_token, tradingsymbol, exchange, transaction_type, quantity, price, order_type } = req.body;

  if (!instrument_token || typeof instrument_token !== 'string') {
    return res.status(400).json({ success: false, message: 'instrument_token is required' });
  }
  if (!tradingsymbol || typeof tradingsymbol !== 'string') {
    return res.status(400).json({ success: false, message: 'tradingsymbol is required' });
  }
  if (!exchange || typeof exchange !== 'string') {
    return res.status(400).json({ success: false, message: 'exchange is required' });
  }
  if (!['BUY', 'SELL'].includes(transaction_type)) {
    return res.status(400).json({ success: false, message: 'transaction_type must be BUY or SELL' });
  }
  if (!quantity || typeof quantity !== 'number' || quantity <= 0 || !Number.isFinite(quantity)) {
    return res.status(400).json({ success: false, message: 'quantity must be a positive number' });
  }
  if (price !== undefined && price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) {
    return res.status(400).json({ success: false, message: 'price must be a non-negative number' });
  }
  if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(order_type)) {
    return res.status(400).json({ success: false, message: 'order_type must be MARKET, LIMIT, SL, or SL-M' });
  }
  next();
};

module.exports = { sanitizeBody, sanitizeString, validateLogin, validateTrade };
