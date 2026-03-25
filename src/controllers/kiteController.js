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
    // If tokens query param is provided, return only those instruments
    const tokensParam = req.query.tokens;
    if (tokensParam) {
      const tokens = tokensParam.split(',').filter(t => t.trim());
      const KiteInstrument = require('../models/KiteInstrument');
      const instruments = await KiteInstrument.find(
        { instrument_token: { $in: tokens } },
        'instrument_token lot_size segment name raw_name'
      ).lean();
      return res.status(200).json({
        success: true,
        message: 'Instruments info retrieved',
        data: instruments
      });
    }

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

/**
 * Smart search instruments with fuzzy matching and grouping
 */
const smartSearchInstruments = async (req, res) => {
  try {
    const { q, category, limit } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query (q) is required',
        data: null
      });
    }

    const instrumentSearchService = require('../services/instrumentSearchService');
    const result = await instrumentSearchService.smartSearch(
      q,
      category || 'ALL',
      limit ? parseInt(limit) : 50
    );

    res.status(200).json({
      success: true,
      message: `Found ${result.total} instruments`,
      data: result
    });
  } catch (error) {
    console.error('❌ Smart search error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get search categories
 */
const getSearchCategories = async (req, res) => {
  try {
    const instrumentSearchService = require('../services/instrumentSearchService');
    const categories = instrumentSearchService.getCategories();

    res.status(200).json({
      success: true,
      message: 'Categories retrieved',
      data: categories
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

// ==================== OPTION CHAIN ====================

/**
 * Get option chain for a trading symbol
 */
const getOptionChain = async (req, res) => {
  try {
    const { tradingSymbol } = req.params;
    const { expiry } = req.query; // Optional expiry filter
    
    console.log(`📊 Fetching option chain for ${tradingSymbol}`);
    
    const KiteInstrument = require('../models/KiteInstrument');
    
    // Build query
    const query = {
      tradingsymbol: new RegExp(`^${tradingSymbol}`, 'i'),
      instrument_type: { $in: ['CE', 'PE'] },
      segment: 'NFO-OPT'
    };
    
    if (expiry) {
      query.expiry = new Date(expiry);
    }
    
    // Get all options for this symbol
    const options = await KiteInstrument.find(query)
      .sort({ strike: 1, instrument_type: 1 })
      .lean();
    
    console.log(`   Found ${options.length} options`);
    
    // Try to fetch live quotes for these options (if Kite is authenticated)
    let liveQuotes = {};
    try {
      const accessToken = await kiteService.getStoredAccessToken();
      if (accessToken && options.length > 0) {
        // Kite quote API expects exchange:tradingsymbol format, NOT instrument_token
        const batchSize = 100;
        const instrumentKeys = options.map(o => `${o.exchange}:${o.tradingsymbol}`);
        
        for (let i = 0; i < instrumentKeys.length; i += batchSize) {
          const batch = instrumentKeys.slice(i, i + batchSize);
          try {
            const quotes = await kiteService.getMarketQuotes(batch, 'ltp');
            liveQuotes = { ...liveQuotes, ...quotes };
          } catch (quoteError) {
            console.log(`   ⚠️  Failed to fetch quotes for batch ${i}: ${quoteError.message}`);
          }
        }
        console.log(`   ✅ Fetched live quotes for ${Object.keys(liveQuotes).length} options`);
      }
    } catch (quoteError) {
      console.log(`   ⚠️  Could not fetch live quotes: ${quoteError.message}`);
    }
    
    // Group by strike price and merge with live quotes
    const optionChain = {};
    
    options.forEach(option => {
      const strike = option.strike;
      if (!optionChain[strike]) {
        optionChain[strike] = { strike, CE: null, PE: null };
      }
      
      // Merge live quote data if available — key matches exchange:tradingsymbol
      const quoteKey = `${option.exchange}:${option.tradingsymbol}`;
      if (liveQuotes[quoteKey]) {
        option.last_price = liveQuotes[quoteKey].last_price || option.last_price;
        option.volume = liveQuotes[quoteKey].volume;
        option.buy_quantity = liveQuotes[quoteKey].buy_quantity;
        option.sell_quantity = liveQuotes[quoteKey].sell_quantity;
      }
      
      if (option.instrument_type === 'CE') {
        optionChain[strike].CE = option;
      } else if (option.instrument_type === 'PE') {
        optionChain[strike].PE = option;
      }
    });
    
    // Convert to array and sort by strike
    const chainArray = Object.values(optionChain).sort((a, b) => a.strike - b.strike);
    
    res.json({
      success: true,
      message: `Found ${chainArray.length} strike prices`,
      data: {
        tradingSymbol,
        expiry: expiry || 'all',
        chain: chainArray,
        hasLiveData: Object.keys(liveQuotes).length > 0
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching option chain:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get market depth for an instrument
 */
const getMarketDepth = async (req, res) => {
  try {
    const { instrumentToken } = req.params;
    
    console.log(`📊 Fetching market depth for token ${instrumentToken}`);
    
    // First, get instrument details from database
    const KiteInstrument = require('../models/KiteInstrument');
    const instrument = await KiteInstrument.findOne({ instrument_token: instrumentToken });
    
    if (!instrument) {
      return res.status(404).json({
        success: false,
        message: 'Instrument not found',
        data: null
      });
    }
    
    // Get market depth from Kite API
    try {
      const depth = await kiteService.getMarketDepth(instrument.exchange, instrument.tradingsymbol);
      
      if (depth && Object.keys(depth).length > 0) {
        return res.json({
          success: true,
          message: 'Market depth fetched successfully',
          data: depth
        });
      }
    } catch (apiError) {
      console.log(`   ⚠️  Kite API error: ${apiError.message}`);
    }
    
    // Fallback: return instrument data from database
    console.log(`   ℹ️  Using database data (market may be closed)`);
    res.json({
      success: true,
      message: 'Market depth from database (market may be closed)',
      data: {
        [`${instrument.exchange}:${instrument.tradingsymbol}`]: {
          instrument_token: instrumentToken,
          last_price: instrument.last_price,
          ohlc: {
            open: instrument.last_price,
            high: instrument.last_price,
            low: instrument.last_price,
            close: instrument.last_price
          },
          volume: 0,
          tradingsymbol: instrument.tradingsymbol,
          exchange: instrument.exchange
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching market depth:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * Get historical candle data for an instrument
 */
const getHistoricalData = async (req, res) => {
  try {
    const { instrumentToken, interval } = req.params;
    const { from, to } = req.query;

    if (!instrumentToken || !interval) {
      return res.status(400).json({
        success: false,
        message: 'Instrument token and interval are required',
        data: null
      });
    }

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: 'From and to dates are required (YYYY-MM-DD format)',
        data: null
      });
    }

    console.log(`📊 Fetching historical data for token: ${instrumentToken}`);
    console.log(`   Interval: ${interval}, From: ${from}, To: ${to}`);

    const historicalData = await kiteService.getHistoricalData(
      instrumentToken,
      interval,
      from,
      to
    );

    res.status(200).json({
      success: true,
      message: 'Historical data fetched successfully',
      data: historicalData
    });
  } catch (error) {
    console.error('❌ Error fetching historical data:', error);
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
  smartSearchInstruments,
  getSearchCategories,
  
  // Market Quotes
  fetchQuotes,
  getLatestQuotes,
  getLTPByToken,
  
  // Option Chain & Market Depth
  getOptionChain,
  getMarketDepth,
  
  // Historical Data
  getHistoricalData,
  
  // Profile
  getProfile
};
