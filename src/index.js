const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDatabase = require('./database/database');
const kiteAuthService = require('./services/kiteAuthService');
const livePriceService = require('./services/livePriceService');
const cronService = require('./services/cronService');
const redisService = require('./services/redisService');
const orderBookService = require('./services/orderBookService');
const priceQueueService = require('./services/priceQueueService');
const firebaseService = require('./services/firebaseService');

const app = express();
const server = http.createServer(app);

// ── Security Middleware ──────────────────────────────────────────────────────

// Security headers (CSP, X-Frame-Options, HSTS, X-Content-Type-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API-only server
  crossOriginEmbedderPolicy: false,
}));

// CORS — restrict origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
}));

// Body parsing with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitize all request bodies
const { sanitizeBody } = require('./middlewares/validate');
app.use(sanitizeBody);

// Request logger (temporary debug)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`📨 ${req.method} ${req.path}`);
  }
  next();
});

// Global rate limiter — 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

// Connect to database (awaited in server.listen callback)
// connectDatabase() is called inside server.listen to ensure proper ordering

// Initialize Firebase Admin SDK
firebaseService.init();

// Import routes
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const kiteRoutes = require('./routes/kiteRoutes');
const watchlistRoutes = require('./routes/watchlistRoutes');
const masterRoutes = require('./routes/masterRoutes');
const messageRoutes = require('./routes/messageRoutes');
const masterFlowRoutes = require('./routes/masterFlowRoutes');
const serverRoutes = require('./routes/serverRoutes');
const tradeRoutes = require('./routes/tradeRoutes');

// Import new models to ensure they're registered
require('./models/Trade');
require('./models/CreditTransaction');
require('./models/Transaction');
require('./models/LoginHistory');

// Routes
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Stocker Backend API is running',
    data: null
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/kite', kiteRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/masters', masterRoutes);
app.use('/api/master', masterFlowRoutes); // Master Flow routes
app.use('/api/master/messages', messageRoutes);
app.use('/api/servers', serverRoutes); // Server routes
app.use('/api/trade', tradeRoutes); // Trade & Metrics routes

// Self login history (accessible by all roles)
const { authenticateAny } = require('./middlewares/auth');
const LoginHistory = require('./models/LoginHistory');
const { getAccountSummary } = require('./controllers/accountSummaryController');

app.get('/api/my/login-history', authenticateAny, async (req, res) => {
  try {
    const callerId = req.user?.id || req.admin?.id || req.master?.id;
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [entries, total] = await Promise.all([
      LoginHistory.find({ userId: callerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      LoginHistory.countDocuments({ userId: callerId })
    ]);

    const data = entries.map(e => ({
      _id: e._id,
      username: e.username,
      name: e.name,
      role: e.userModel?.toUpperCase() || 'USER',
      ip_address: e.ip_address,
      logged_in_at: e.createdAt,
    }));

    res.status(200).json({ success: true, data, total });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Account summary (accessible by all roles)
app.get('/api/account-summary', authenticateAny, getAccountSummary);

// Centralized error handler — must be AFTER all routes
app.use((err, req, res, _next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    data: null,
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Connect to database first
  await connectDatabase();

  // Pre-warm instrument search cache (await so it's ready before first search)
  try {
    const instrumentSearchService = require('./services/instrumentSearchService');
    await instrumentSearchService.loadInstrumentCache();
    console.log('🔥 Instrument search cache warmed');
  } catch (err) {
    console.error('⚠️  Failed to warm instrument cache:', err.message);
  }

  // Initialize Redis connection
  try {
    redisService.init();
    // Give Redis a moment to connect before proceeding
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (redisService.isAvailable()) {
      // Bootstrap: sync pending orders from MongoDB into Redis order book
      await orderBookService.syncFromDatabase();

      // Initialize BullMQ price queue (producer + worker)
      priceQueueService.init();
      console.log('🚀 Redis Order Book + BullMQ Price Queue active');
    } else {
      console.log('⚠️  Redis not available – using DB-polling fallback for limit orders');
    }
  } catch (err) {
    console.error('⚠️  Redis init error:', err.message, '– falling back to DB polling');
  }

  // Initialize WebSocket live price service
  livePriceService.init(server);
  console.log('📡 Live price WebSocket ready at ws://localhost:' + PORT + '/ws/live-prices');

  // Initialize synthetic instruments (e.g. BHUJ NIFTY)
  const syntheticInstrumentService = require('./services/syntheticInstrumentService');
  await syntheticInstrumentService.init(livePriceService);

  // Initialize real-time metrics engine
  const metricsEngine = require('./services/metricsEngine');
  await metricsEngine.init(livePriceService);
  metricsEngine.scheduleMidnightAudit();

  // Initialize margin square off monitoring service
  const marginSquareOffService = require('./services/marginSquareOffService');
  marginSquareOffService.init(livePriceService);

  // Initialize background jobs
  cronService.init();

  // Perform Kite auto-login on server start
  console.log('\n🔐 Checking Kite authentication...');

  try {
    // Check if already authenticated
    const status = await kiteAuthService.checkTokenStatus();

    if (status.valid) {
      console.log(`✅ Kite already authenticated (valid for ${status.hoursLeft} hours)`);
    } else {
      console.log(`⚠️  Kite not authenticated: ${status.reason}`);
      console.log('🤖 Attempting auto-login...\n');

      const loginResult = await kiteAuthService.performAutomatedLogin();
      console.log({ loginResult })
      if (loginResult.success) {
        console.log('✅ Kite auto-login successful!');
      } else {
        console.log('❌ Kite auto-login failed:', loginResult.error);
        console.log('💡 You can manually login at: http://localhost:' + PORT + '/api/kite/login');
      }
    }
  } catch (error) {
    console.error('❌ Error during Kite authentication:', error.message);
    console.log('💡 You can manually login at: http://localhost:' + PORT + '/api/kite/login');
  }

  console.log('\n🚀 Server ready!\n');

  // Refresh settlement prices on startup via OHLC API
  // ohlc.close = previous day's official settlement price (available by ~8-9 AM)
  setTimeout(async () => {
    try {
      const kiteStatus = await kiteAuthService.checkTokenStatus();
      if (!kiteStatus.valid) {
        console.log('⚠️  [Startup] Kite not authenticated, skipping settlement price refresh.');
        return;
      }
      console.log('📊 [Startup] Refreshing settlement prices (OHLC API)...');
      const result = await livePriceService.refreshSettlementPrices();
      console.log('✅ [Startup] Settlement price refresh:', JSON.stringify(result));
    } catch (err) {
      console.error('⚠️  [Startup] Settlement price refresh failed:', err.message);
    }
  }, 15000);
});
