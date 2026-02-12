const kiteService = require('../services/kiteService');
const kiteAuthService = require('../services/kiteAuthService');

// ==================== AUTHENTICATION ====================

/**
 * Initiate Kite login - redirects to Kite login page
 */
const initiateLogin = (req, res) => {
  try {
    const loginUrl = kiteService.getLoginUrl();
    res.redirect(loginUrl);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Handle Kite callback after login
 */
const handleCallback = async (req, res) => {
  try {
    const { request_token, status } = req.query;

    if (status !== 'success' || !request_token) {
      return res.status(400).json({
        success: false,
        message: 'Login failed or request token missing',
        data: null
      });
    }

    // Exchange request token for access token
    const tokenResponse = await kiteService.exchangeToken(request_token);

    if (tokenResponse.status === 'success') {
      const { access_token, login_time } = tokenResponse.data;

      // Store access token
      await kiteService.storeAccessToken(access_token, login_time);

      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user_id: tokenResponse.data.user_id,
          user_name: tokenResponse.data.user_name,
          email: tokenResponse.data.email
        }
      });
    } else {
      throw new Error('Token exchange failed');
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Check authentication status
 */
const checkAuthStatus = async (req, res) => {
  try {
    const isAuth = await kiteService.isAuthenticated();
    res.status(200).json({
      success: true,
      authenticated: isAuth,
      data: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get detailed auth status
 */
const getDetailedAuthStatus = async (req, res) => {
  try {
    const status = await kiteAuthService.checkAuthenticationStatus();
    res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Trigger automated login
 */
const triggerAutoLogin = async (req, res) => {
  try {
    const result = await kiteAuthService.performAutomatedLogin();
    
    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Automated login successful',
        data: result
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Automated login failed',
        data: result
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Logout - clear session
 */
const logout = async (req, res) => {
  try {
    await kiteService.clearSession();
    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
      data: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// ==================== INSTRUMENTS ====================

/**
 * Fetch and store instruments
 */
const fetchInstruments = async (req, res) => {
  try {
    const { exchange } = req.query;
    
    const result = await kiteService.fetchAndStoreAllInstruments(exchange);
    
    res.status(200).json({
      success: true,
      message: `Fetched ${result.total} instruments`,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get instruments info
 */
const getInstrumentsInfo = async (req, res) => {
  try {
    const info = await kiteService.getInstrumentsInfo();
    
    res.status(200).json({
      success: true,
      message: 'Instruments info retrieved',
      data: info
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Search instruments
 */
const searchInstruments = async (req, res) => {
  try {
    const { q, exchange, instrument_type, limit } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query (q) is required',
        data: null
      });
    }

    const instruments = await kiteService.searchInstruments(q, exchange, instrument_type);
    
    const limitedResults = limit ? instruments.slice(0, parseInt(limit)) : instruments;

    res.status(200).json({
      success: true,
      message: `Found ${limitedResults.length} instruments`,
      data: limitedResults
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// ==================== MARKET QUOTES ====================

/**
 * Fetch market quotes
 */
const fetchQuotes = async (req, res) => {
  try {
    const { instruments, type } = req.body;

    if (!instruments || !Array.isArray(instruments)) {
      return res.status(400).json({
        success: false,
        message: 'Instruments array is required',
        data: null
      });
    }

    const quoteType = type || 'ltp';
    const quotes = await kiteService.getMarketQuotes(instruments, quoteType);

    // Store quotes in database
    await kiteService.storeMarketQuotes(quotes);

    res.status(200).json({
      success: true,
      message: 'Quotes fetched successfully',
      data: quotes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get latest quotes from database
 */
const getLatestQuotes = async (req, res) => {
  try {
    const { instruments, limit } = req.query;

    let instrumentTokens = null;
    if (instruments) {
      instrumentTokens = instruments.split(',').map(i => parseInt(i));
    }

    const quotes = await kiteService.getLatestQuotes(
      instrumentTokens,
      limit ? parseInt(limit) : 100
    );

    res.status(200).json({
      success: true,
      message: 'Latest quotes retrieved',
      data: quotes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get LTP for specific instrument
 */
const getLTPByToken = async (req, res) => {
  try {
    const { instrumentToken } = req.params;

    const quote = await kiteService.getLatestQuotes([parseInt(instrumentToken)], 1);

    if (quote.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Quote not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'LTP retrieved',
      data: quote[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// ==================== PROFILE ====================

/**
 * Get user profile
 */
const getProfile = async (req, res) => {
  try {
    const profile = await kiteService.getProfile();

    res.status(200).json({
      success: true,
      message: 'Profile retrieved',
      data: profile
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

module.exports = {
  // Authentication
  initiateLogin,
  handleCallback,
  checkAuthStatus,
  getDetailedAuthStatus,
  triggerAutoLogin,
  logout,
  
  // Instruments
  fetchInstruments,
  getInstrumentsInfo,
  searchInstruments,
  
  // Market Quotes
  fetchQuotes,
  getLatestQuotes,
  getLTPByToken,
  
  // Profile
  getProfile
};
