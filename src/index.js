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

// Trust proxy so req.ip returns real client IP behind nginx/load balancer
app.set('trust proxy', true);

const server = http.createServer(app);

// ── Security Middleware ──────────────────────────────────────────────────────

// Helper: skip middleware for WebSocket upgrade path
const skipForWs = (middleware) => (req, res, next) => {
  if (req.url === '/ws/live-prices') return next();
  return middleware(req, res, next);
};

// Security headers (CSP, X-Frame-Options, HSTS, X-Content-Type-Options, etc.)
app.use(skipForWs(helmet({
  contentSecurityPolicy: false, // Disable CSP for API-only server
  crossOriginEmbedderPolicy: false,
})));

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
app.use(skipForWs(globalLimiter));

// Database connectivity and index synchronization are awaited in startServer
// before the HTTP listener is opened.

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

// Initialize WebSocket live price service BEFORE server.listen
// so the upgrade handler is registered before any connections arrive. Defer
// outbound Kite connectivity until the startup readiness barrier is complete.
livePriceService.init(server, { connectKite: false });

// Handle WebSocket upgrade manually to bypass Express middleware
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws/live-prices') {
    livePriceService.wss.handleUpgrade(request, socket, head, (ws) => {
      livePriceService.wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Open the HTTP listener only after all startup prerequisites are ready.
const PORT = process.env.PORT || 5000;
const startServer = async () => {
  const _t0 = Date.now();
  const _ts = (label) => console.log(`⏱️  [${((Date.now() - _t0) / 1000).toFixed(2)}s] ${label}`);

  _ts('Starting server...');

  await connectDatabase();
  _ts('Database connected + indexes synced');

  // Run settlement price preload and instrument search cache in PARALLEL —
  // both load from KiteInstrument independently with no shared state.
  const instrumentSearchService = require('./services/instrumentSearchService');
  const [, searchCacheResult] = await Promise.allSettled([
    livePriceService._preloadSettlementPrices(),
    instrumentSearchService.loadInstrumentCache(),
  ]);
  _ts('Settlement prices + instrument search cache loaded (parallel)');
  if (searchCacheResult.status === 'rejected') {
    console.error('⚠️  Failed to warm instrument cache:', searchCacheResult.reason?.message);
  }

  // Initialize Redis and wait for readiness before selecting the order engine.
  try {
    redisService.init();
    // Wait for Redis to be ready (up to 5 seconds)
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (redisService.isAvailable()) break;
    }
    _ts(`Redis ready: ${redisService.isAvailable()}`);

    if (redisService.isAvailable()) {
      // Bootstrap Redis state, but do not start BullMQ consumers until missed
      // settlement recovery has materialized/fenced the latest Friday.
      await orderBookService.syncFromDatabase();
      _ts('Redis Order Book synced from DB');
    } else {
      console.log('⚠️  Redis not available – using DB-polling fallback for limit orders');
    }
  } catch (err) {
    console.error('⚠️  Redis init error:', err.message, '– falling back to DB polling');
  }

  // These services are readiness-critical; failures must abort startup.
  const syntheticInstrumentService = require('./services/syntheticInstrumentService');
  await syntheticInstrumentService.init(livePriceService);
  _ts('Synthetic instrument service ready');

  const metricsEngine = require('./services/metricsEngine');
  await metricsEngine.init(livePriceService);
  _ts('MetricsEngine initialized (all user caches built)');

  await metricsEngine.scheduleMidnightAudit();

  // Reconcile an interrupted run (or a missed weekend run after a restart)
  // before accepting HTTP traffic. If official prices are not ready the run is
  // durable `failed` and the distributed trade-write guard remains closed until
  // a scheduled recovery succeeds; reads and administrative diagnostics can
  // still come online.
  try {
    const settlementService = require('./services/settlementService');
    const recovery = await settlementService.recoverIncompleteSettlements({ ensureCurrentPeriod: true });
    if (recovery.recovered || recovery.ensuredCurrentPeriod) {
      console.log(`[Settlement] Startup reconciliation: ${recovery.message || recovery.periodKey || 'completed'}`);
    }
    _ts('Settlement recovery complete');
  } catch (error) {
    console.error(`[Settlement] Startup reconciliation could not establish a durable fence: ${error.message}`);
    throw error;
  }

  const bgDisabled = process.env.DISABLE_BG_SERVICES === 'true';

  // Only now may retained BullMQ jobs mutate trades. A failed/blocked durable
  // run remains visible to beginTradeWrite() and causes jobs to retry safely.
  if (!bgDisabled && redisService.isAvailable()) {
    await priceQueueService.init();
    _ts('BullMQ Price Queue initialized');
  }

  // Initialize margin square-off monitoring and background jobs.
  if (!bgDisabled) {
    const marginSquareOffService = require('./services/marginSquareOffService');
    await marginSquareOffService.init(livePriceService);
    await cronService.init();
    _ts('Margin square-off + cron jobs initialized');
  } else {
    console.log('⏭️  Background services DISABLED (DISABLE_BG_SERVICES=true)');
  }

  // Establish Kite authentication prerequisites before outbound live-price setup.
  if (!bgDisabled) {
    console.log('\n🔐 Checking Kite authentication...');
    try {
      const status = await kiteAuthService.checkTokenStatus();

      if (status.valid) {
        console.log(`✅ Kite already authenticated (valid for ${status.hoursLeft} hours)`);
      } else {
        console.log(`⚠️  Kite not authenticated: ${status.reason}`);
        console.log('🤖 Attempting auto-login...\n');

        const loginResult = await kiteAuthService.performAutomatedLogin();
        console.log({ loginResult });
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
    _ts('Kite auth complete');

    await livePriceService._connectToKite();
    _ts('Kite WebSocket connected');

    await livePriceService._updateKiteSubscription();
    _ts('Kite subscriptions updated');
  } else {
    console.log('⏭️  Kite auth & live prices SKIPPED (local dev mode)');
  }

  server.listen(PORT, () => {
    _ts(`SERVER LISTENING on port ${PORT}`);
    console.log('📡 Live price WebSocket ready at ws://localhost:' + PORT + '/ws/live-prices');
    console.log('\n🚀 Server ready!\n');
  });
};

startServer().catch(error => {
  console.error(`Server startup failed: ${error.message}`);
  process.exit(1);
});
