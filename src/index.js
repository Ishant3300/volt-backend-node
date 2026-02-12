require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const connectDatabase = require('./database/database');
const kiteAuthService = require('./services/kiteAuthService');
const livePriceService = require('./services/livePriceService');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to database
connectDatabase();

// Import routes
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const kiteRoutes = require('./routes/kiteRoutes');
const watchlistRoutes = require('./routes/watchlistRoutes');

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
app.use('/api/kite', kiteRoutes);
app.use('/api/watchlist', watchlistRoutes);

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Initialize WebSocket live price service
  livePriceService.init(server);
  console.log('📡 Live price WebSocket ready at ws://localhost:' + PORT + '/ws/live-prices');
  
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
});
