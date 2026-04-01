const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middlewares/auth');
const {
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
} = require('../controllers/kiteController');

// ==================== AUTHENTICATION ROUTES (PUBLIC) ====================

// Initiate login (redirects to Kite)
router.get('/login', initiateLogin);

// Handle callback from Kite
router.get('/callback', handleCallback);

// Check auth status (simple)
router.get('/auth-status', checkAuthStatus);

// Get detailed auth status
router.get('/auth/status', getDetailedAuthStatus);

// Trigger automated login
router.post('/auth/auto-login', triggerAutoLogin);

// ==================== PROTECTED ROUTES (REQUIRE AUTHENTICATION) ====================

// Apply authentication middleware to all routes below
router.use(authenticateAny);

// Logout
router.delete('/logout', logout);

// ==================== INSTRUMENT ROUTES ====================

// Fetch and store instruments
router.post('/instruments/fetch', fetchInstruments);

// Get instruments info
router.get('/instruments/info', getInstrumentsInfo);

// Search instruments (legacy)
router.get('/instruments/search', searchInstruments);

// Smart search instruments (new - with fuzzy matching and grouping)
router.get('/instruments/smart-search', smartSearchInstruments);

// Get search categories
router.get('/instruments/categories', getSearchCategories);

// ==================== MARKET QUOTE ROUTES ====================

// Fetch quotes from Kite API
router.post('/quotes/fetch', fetchQuotes);

// Get latest quotes from database
router.get('/quotes/latest', getLatestQuotes);

// Get LTP by instrument token
router.get('/quotes/ltp/:instrumentToken', getLTPByToken);

// Get option chain for an instrument
router.get('/option-chain/:tradingSymbol', getOptionChain);

// Get market depth for an instrument
router.get('/market-depth/:instrumentToken', getMarketDepth);

// Get historical candle data
router.get('/historical/:instrumentToken/:interval', getHistoricalData);

// ==================== PROFILE ROUTES ====================

// Get user profile
router.get('/profile', getProfile);

module.exports = router;
