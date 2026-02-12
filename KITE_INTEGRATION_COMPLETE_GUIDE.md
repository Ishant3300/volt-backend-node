# Complete Kite Integration Guide - Backend Implementation

## Overview
This document provides a comprehensive guide to replicate the Kite (Zerodha) integration from this backend. It covers authentication, token management, instrument fetching, live price streaming, and automated login.

---

## 1. KITE AUTHENTICATION & TOKEN GENERATION

### 1.1 Environment Variables Required
```env
# Kite API Configuration
KITE_API_KEY=your_api_key_here
KITE_API_SECRET=your_api_secret_here
KITE_REDIRECT_URL=http://localhost:3000/api/kite/callback

# Zerodha Auto-Login Credentials (for automated login)
ZERODHA_USER_ID=your_user_id
ZERODHA_PASSWORD=your_password
ZERODHA_TOTP_SECRET=your_totp_secret_key
```

### 1.2 Authentication Flow

#### Manual Login Flow (Browser-based)
```javascript
// Step 1: Generate Kite Login URL
const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${KITE_API_KEY}`;

// Step 2: User completes login in browser and is redirected to callback URL with request_token
// Callback URL: http://localhost:3000/api/kite/callback?request_token=xxx&status=success

// Step 3: Exchange request_token for access_token
const checksum = crypto
  .createHash("sha256")
  .update(apiKey + requestToken + apiSecret)
  .digest("hex");

const response = await axios.post(
  'https://api.kite.trade/session/token',
  `api_key=${apiKey}&request_token=${requestToken}&checksum=${checksum}`,
  {
    headers: {
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }
);

// Response contains: access_token, user_id, user_name, email, etc.
```

#### Token Storage in MongoDB
```javascript
// Token Schema
const accessTokenSchema = new mongoose.Schema({
  access_token: { type: String, required: true },
  created_at: { type: Date, required: true },
  expires_at: { type: Date, required: true }, // 6 AM IST next day
  updated_at: { type: Date, default: Date.now }
});

// Calculate expiry (6 AM IST next day)
const loginDate = new Date(loginTime);
const nextDay = new Date(loginDate);
nextDay.setDate(nextDay.getDate() + 1);
const expiryUTC = new Date(nextDay);
expiryUTC.setUTCHours(0, 30, 0, 0); // 12:30 AM UTC = 6:00 AM IST

// Store token
await AccessToken.create({
  access_token: accessToken,
  created_at: loginTime,
  expires_at: expiryUTC
});
```

### 1.3 Automated Login (Puppeteer + TOTP)

The system uses Puppeteer to automate the login process with TOTP generation:

```javascript
// TOTP Generation
function generateTOTP(secret) {
  const key = base32.decode.asBytes(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / 30);
  
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(time));
  
  const hmac = crypto.createHmac('sha1', Buffer.from(key));
  hmac.update(buffer);
  const hash = hmac.digest();
  
  const offset = hash[hash.length - 1] & 0xf;
  const binary = ((hash[offset] & 0x7f) << 24) |
                 ((hash[offset + 1] & 0xff) << 16) |
                 ((hash[offset + 2] & 0xff) << 8) |
                 (hash[offset + 3] & 0xff);
  
  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

// Automated Login Flow
async function performAutomatedLogin() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
  
  await page.goto(loginUrl);
  
  // Step 1: Enter User ID
  await page.waitForSelector('#userid');
  await page.type('#userid', userId);
  await page.click('button[type="submit"]');
  
  // Step 2: Enter Password
  await page.waitForSelector('#password');
  await page.type('#password', password);
  await page.click('button[type="submit"]');
  
  // Step 3: Enter TOTP
  await page.waitForSelector('#userid');
  const totp = generateTOTP(totpSecret);
  await page.type('#userid', totp);
  await page.click('button[type="submit"]');
  
  // Step 4: Wait for redirect and extract request_token
  await page.waitForFunction(
    () => window.location.href.includes('request_token'),
    { timeout: 15000 }
  );
  
  const redirectUrl = page.url();
  const urlParams = new URLSearchParams(redirectUrl.split('?')[1]);
  const requestToken = urlParams.get('request_token');
  
  await browser.close();
  
  // Exchange request_token for access_token
  return await exchangeToken(requestToken);
}
```

### 1.4 Scheduled Auto-Login (Daily at 7:35 AM IST)

```javascript
// Using node-cron
cron.schedule("35 7 * * *", async () => {
  console.log("🔐 Starting daily Kite auto-login...");
  
  // Clear existing tokens
  await kiteService.clearSession();
  
  // Perform automated login
  const result = await kiteAuthService.performAutomatedLogin();
  
  if (result.success) {
    console.log("✅ Auto-login successful");
  } else {
    console.error("❌ Auto-login failed:", result.error);
  }
}, {
  timezone: "Asia/Kolkata"
});
```

---

## 2. FETCHING & STORING KITE INSTRUMENTS

### 2.1 Instrument Schema

```javascript
const instrumentSchema = new mongoose.Schema({
  instrument_token: { type: String, required: true },
  exchange_token: { type: String, required: true },
  tradingsymbol: { type: String, required: true },
  name: { type: String, default: '' },
  last_price: { type: Number, default: 0 },
  expiry: { type: Date, default: null },
  strike: { type: Number, default: 0 },
  tick_size: { type: Number, default: 0 },
  lot_size: { type: Number, default: 0 },
  instrument_type: { type: String, required: true },
  segment: { type: String, required: true },
  exchange: { type: String, required: true },
  updated_at: { type: Date, default: Date.now }
}, {
  indexes: [
    { exchange: 1, tradingsymbol: 1, unique: true },
    { instrument_token: 1 },
    { exchange: 1, instrument_type: 1, tradingsymbol: 1 },
    { tradingsymbol: 'text', name: 'text' } // For fuzzy search
  ]
});
```

### 2.2 Fetching Instruments from Kite API

```javascript
async function fetchInstrumentsFromKite(exchange = null) {
  const accessToken = await getStoredAccessToken();
  const endpoint = exchange ? `/instruments/${exchange}` : "/instruments";
  const url = `https://api.kite.trade${endpoint}`;
  
  const response = await axios({
    method: "GET",
    url,
    headers: {
      "X-Kite-Version": "3",
      "Authorization": `token ${apiKey}:${accessToken}`,
      "Accept-Encoding": "gzip"
    },
    responseType: "arraybuffer",
    timeout: 60000
  });
  
  // Handle gzipped response
  let csvData;
  if (response.headers["content-encoding"] === "gzip") {
    const decompressed = await gunzip(response.data);
    csvData = decompressed.toString("utf8");
  } else {
    csvData = response.data.toString("utf8");
  }
  
  return csvData;
}
```

### 2.3 Parsing CSV to Instruments

```javascript
function parseInstrumentsCsv(csvText) {
  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  const instruments = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const instrument = {};
    
    headers.forEach((key, index) => {
      let value = values[index].trim();
      
      // Remove quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      
      // Type casting
      if (["instrument_token", "exchange_token"].includes(key)) {
        instrument[key] = value;
      } else if (["last_price", "strike", "tick_size"].includes(key)) {
        instrument[key] = parseFloat(value) || 0;
      } else if (["lot_size"].includes(key)) {
        instrument[key] = parseInt(value, 10) || 0;
      } else {
        instrument[key] = value;
      }
    });
    
    instrument.updated_at = new Date();
    instruments.push(instrument);
  }
  
  return instruments;
}
```

### 2.4 Storing Instruments (NUCLEAR MODE - Fastest)

```javascript
async function storeInstruments(instruments) {
  console.log(`💥 NUCLEAR MODE: Inserting ${instruments.length} instruments...`);
  
  // Drop collection and recreate for maximum speed
  await Instrument.collection.drop().catch(() => {});
  
  // Bulk insert with fire-and-forget
  const result = await Instrument.insertMany(instruments, {
    ordered: false,
    writeConcern: { w: 0 } // Maximum speed
  });
  
  console.log(`✅ Inserted ${result.length} instruments`);
  return result;
}
```

### 2.5 Scheduled Instrument Fetch (Daily at 8:30 AM IST)

```javascript
cron.schedule("30 8 * * *", async () => {
  console.log("📊 Starting scheduled instrument fetch...");
  
  const csvData = await fetchInstrumentsFromKite();
  const instruments = parseInstrumentsCsv(csvData);
  await storeInstruments(instruments);
  
  console.log("✅ Instrument fetch completed");
}, {
  timezone: "Asia/Kolkata"
});
```

---

## 3. FETCHING LIVE PRICES

### 3.1 Market Quote Schema (Ultra-Minimal)

```javascript
const marketQuoteSchema = new mongoose.Schema({
  instrument_token: { type: Number, required: true, unique: true },
  last_price: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now }
}, {
  indexes: [
    { instrument_token: 1, unique: true },
    { instrument_token: 1, last_price: 1 } // Compound index for covered queries
  ]
});
```

### 3.2 REST API - Fetching Quotes

```javascript
async function getMarketQuotes(instruments, quoteType = "ltp") {
  const accessToken = await getStoredAccessToken();
  
  // Batch size to avoid URL length issues
  const batchSize = quoteType === 'ltp' ? 400 : 200;
  const batches = [];
  
  for (let i = 0; i < instruments.length; i += batchSize) {
    batches.push(instruments.slice(i, i + batchSize));
  }
  
  let allQuotes = {};
  
  for (const batch of batches) {
    const queryParams = batch
      .map(inst => `i=${encodeURIComponent(inst)}`)
      .join("&");
    
    const endpoint = quoteType === "full" ? "/quote" : `/quote/${quoteType}`;
    const url = `https://api.kite.trade${endpoint}?${queryParams}`;
    
    const response = await axios({
      method: "GET",
      url,
      headers: {
        "X-Kite-Version": "3",
        "Authorization": `token ${apiKey}:${accessToken}`
      },
      timeout: 30000
    });
    
    Object.assign(allQuotes, response.data.data);
  }
  
  return allQuotes;
}

// Example usage
const instruments = ["NSE:INFY", "NSE:TCS", "BSE:RELIANCE"];
const quotes = await getMarketQuotes(instruments, "ltp");

// Response format:
// {
//   "NSE:INFY": {
//     instrument_token: 408065,
//     last_price: 1450.50
//   },
//   ...
// }
```

### 3.3 WebSocket - Real-time Streaming

#### WebSocket Connection

```javascript
async function connectWebSocket(accessToken) {
  const wsUrl = `wss://ws.kite.trade?api_key=${apiKey}&access_token=${accessToken}`;
  const ws = new WebSocket(wsUrl);
  
  ws.on("open", () => {
    console.log("🔗 WebSocket connected");
    
    // Subscribe to instruments
    subscribeToInstruments(ws, instruments);
  });
  
  ws.on("message", (data) => {
    handleWebSocketMessage(data);
  });
  
  ws.on("close", () => {
    console.log("🔌 WebSocket closed");
    handleReconnection();
  });
  
  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error);
  });
  
  return ws;
}
```

#### Subscribing to Instruments

```javascript
async function subscribeToInstruments(ws, instruments) {
  // Get instrument tokens from database
  const tokens = [];
  
  for (const instrument of instruments) {
    const [exchange, symbol] = instrument.split(":");
    const inst = await Instrument.findOne({ exchange, tradingsymbol: symbol });
    
    if (inst) {
      tokens.push(parseInt(inst.instrument_token));
    }
  }
  
  // Subscribe message
  const subscribeMessage = {
    a: "subscribe",
    v: tokens
  };
  ws.send(JSON.stringify(subscribeMessage));
  
  // Set mode to 'ltp' for lightweight data
  const modeMessage = {
    a: "mode",
    v: ["ltp", tokens]
  };
  ws.send(JSON.stringify(modeMessage));
  
  console.log(`📡 Subscribed to ${tokens.length} instruments`);
}
```

#### Parsing Binary Market Data

```javascript
function parseBinaryMarketData(buffer) {
  const quotes = [];
  let offset = 0;
  
  // Read number of packets (first 2 bytes)
  const numPackets = buffer.readUInt16BE(offset);
  offset += 2;
  
  for (let i = 0; i < numPackets; i++) {
    // Read packet length
    const packetLength = buffer.readUInt16BE(offset);
    offset += 2;
    
    // Extract packet data
    const packetData = buffer.slice(offset, offset + packetLength);
    offset += packetLength;
    
    // Parse packet
    const quote = parseQuotePacket(packetData);
    if (quote) {
      quotes.push(quote);
    }
  }
  
  return quotes;
}

function parseQuotePacket(packet) {
  if (packet.length < 8) return null;
  
  // Read instrument token (first 4 bytes)
  const instrument_token = packet.readUInt32BE(0);
  
  // Read last price (next 4 bytes) - convert from paise to rupees
  const last_price = packet.readUInt32BE(4) / 100;
  
  return {
    instrument_token,
    last_price,
    timestamp: new Date()
  };
}
```

#### Storing WebSocket Quotes

```javascript
async function storeWebSocketQuotes(quotes) {
  const timestamp = new Date();
  
  // Update existing documents (one per instrument)
  const bulkOps = quotes.map(quote => ({
    updateOne: {
      filter: { instrument_token: quote.instrument_token },
      update: {
        $set: {
          last_price: quote.last_price,
          timestamp: timestamp
        }
      },
      upsert: true
    }
  }));
  
  await MarketQuote.bulkWrite(bulkOps, { ordered: false });
  console.log(`📡 Updated ${quotes.length} quotes`);
}
```

### 3.4 Multiple WebSocket Connections (3 parallel)

Kite allows up to 3 WebSocket connections with 3000 instruments each:

```javascript
class KiteService {
  constructor() {
    this.wsConnections = []; // Array of WebSocket connections
    this.subscribedInstruments = [new Set(), new Set(), new Set()];
    this.maxInstrumentsPerSocket = 3000;
    this.maxSockets = 3;
  }
  
  async connectMultipleWebSockets(accessToken, instrumentBatches) {
    const connectionPromises = instrumentBatches.map((batch, index) => 
      this.connectSingleWebSocket(accessToken, batch, index)
    );
    
    await Promise.all(connectionPromises);
    console.log(`✅ All ${instrumentBatches.length} WebSocket connections established`);
  }
  
  async connectSingleWebSocket(accessToken, instruments, socketIndex) {
    const wsUrl = `wss://ws.kite.trade?api_key=${this.apiKey}&access_token=${accessToken}`;
    const ws = new WebSocket(wsUrl);
    
    ws.on("open", async () => {
      console.log(`🔗 Socket ${socketIndex + 1} connected`);
      this.wsConnections[socketIndex] = ws;
      await this.subscribeToInstrumentsOnSocket(ws, instruments, socketIndex);
    });
    
    ws.on("message", (data) => {
      this.handleWebSocketMessage(data, socketIndex);
    });
    
    return ws;
  }
}
```

---

## 4. API ENDPOINTS

### 4.1 Authentication Endpoints

```javascript
// Initiate login
GET /api/kite/login
// Redirects to Kite login page

// Handle callback
GET /api/kite/callback?request_token=xxx&status=success
// Exchanges request_token for access_token and stores it

// Check auth status
GET /api/kite/auth-status
// Returns: { authenticated: true/false }

// Get detailed auth status
GET /api/kite/auth/status
// Returns: { status, expiresAt, hoursUntilExpiry }

// Trigger auto-login
POST /api/kite/auth/auto-login
// Performs automated login using Puppeteer

// Logout
DELETE /api/kite/logout
// Clears stored tokens
```

### 4.2 Instrument Endpoints

```javascript
// Fetch and store instruments
POST /api/kite/instruments/fetch
// Optional query params: ?memory=true (for filtered mode)

// Get instruments info
GET /api/kite/instruments/info
// Returns: { totalInstruments, lastUpdated, exchangeBreakdown }

// Search instruments
GET /api/kite/instruments/search?q=INFY&exchange=NSE&limit=50
```

### 4.3 Market Quote Endpoints

```javascript
// Fetch market quotes (REST API)
POST /api/kite/quotes/fetch
Body: {
  instruments: ["NSE:INFY", "NSE:TCS"],
  type: "ltp" // or "full", "ohlc"
}

// Get latest quotes from database
GET /api/kite/quotes/latest?instruments=NSE:INFY,NSE:TCS&limit=100

// Get LTP for specific instrument
GET /api/kite/quotes/ltp/:instrumentToken

// Start WebSocket streaming
POST /api/kite/streaming/start

// Stop WebSocket streaming
POST /api/kite/streaming/stop
```

---

## 5. SCHEDULED JOBS (node-cron)

```javascript
const cron = require("node-cron");

// Daily auto-login at 7:35 AM IST
cron.schedule("35 7 * * *", async () => {
  await kiteAuthService.performAutomatedLogin();
}, { timezone: "Asia/Kolkata" });

// Daily instrument fetch at 8:30 AM IST
cron.schedule("30 8 * * *", async () => {
  await kiteService.fetchAndStoreAllInstruments();
}, { timezone: "Asia/Kolkata" });

// Start streaming at market open (9:15 AM IST)
cron.schedule("15 9 * * 1-5", async () => {
  await kiteService.startLiveDataStreaming();
}, { timezone: "Asia/Kolkata" });

// Stop streaming at market close (3:30 PM IST)
cron.schedule("30 15 * * 1-5", async () => {
  await kiteService.stopLiveDataStreaming();
}, { timezone: "Asia/Kolkata" });
```

---

## 6. KEY FEATURES & OPTIMIZATIONS

### 6.1 Token Management
- Tokens stored in MongoDB with expiry tracking
- Auto-expiry at 6 AM IST next day
- Automated daily login at 7:35 AM IST
- Token validation before API calls

### 6.2 Instrument Management
- NUCLEAR MODE: Drop & recreate collection for fastest insert
- 123,452+ instruments supported
- Filtered mode available for memory-constrained environments
- Text indexes for fuzzy search

### 6.3 Price Streaming
- Multiple WebSocket connections (up to 9000 instruments)
- Binary data parsing for efficiency
- Batch writes to database
- Real-time price cache for SSE clients
- Dynamic subscription management

### 6.4 Error Handling
- Automatic WebSocket reconnection with exponential backoff
- Token expiry detection and refresh
- Graceful degradation (REST API fallback)
- Comprehensive logging

---

## 7. DEPENDENCIES

```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "crypto": "built-in",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "hi-base32": "^0.5.1",
    "mongoose": "^8.0.0",
    "node-cron": "^3.0.2",
    "puppeteer": "^21.5.0",
    "ws": "^8.14.2",
    "zlib": "built-in"
  }
}
```

---

## 8. IMPLEMENTATION CHECKLIST

### Phase 1: Basic Authentication
- [ ] Set up environment variables
- [ ] Create AccessToken model
- [ ] Implement login URL generation
- [ ] Implement callback handler
- [ ] Implement token exchange
- [ ] Implement token storage with expiry

### Phase 2: Automated Login
- [ ] Install Puppeteer
- [ ] Implement TOTP generation
- [ ] Implement automated login flow
- [ ] Schedule daily auto-login (7:35 AM IST)
- [ ] Add error handling and logging

### Phase 3: Instrument Management
- [ ] Create Instrument model with indexes
- [ ] Implement CSV fetching from Kite API
- [ ] Implement CSV parsing
- [ ] Implement NUCLEAR MODE storage
- [ ] Schedule daily instrument fetch (8:30 AM IST)

### Phase 4: Price Fetching (REST API)
- [ ] Create MarketQuote model
- [ ] Implement REST API quote fetching
- [ ] Implement batch processing for large requests
- [ ] Implement quote storage
- [ ] Create API endpoints

### Phase 5: WebSocket Streaming
- [ ] Implement WebSocket connection
- [ ] Implement instrument subscription
- [ ] Implement binary data parsing
- [ ] Implement quote storage from WebSocket
- [ ] Implement multiple WebSocket connections
- [ ] Implement reconnection logic
- [ ] Schedule streaming start/stop

### Phase 6: API Endpoints
- [ ] Create authentication endpoints
- [ ] Create instrument endpoints
- [ ] Create quote endpoints
- [ ] Create streaming control endpoints
- [ ] Add error handling and validation

### Phase 7: Optimization
- [ ] Implement price cache for SSE
- [ ] Implement dynamic subscription management
- [ ] Add monitoring and health checks
- [ ] Optimize database queries
- [ ] Add rate limiting

---

## 9. TESTING

### Manual Testing
```bash
# Test login
curl http://localhost:3000/api/kite/login

# Test auth status
curl http://localhost:3000/api/kite/auth-status

# Test instrument fetch
curl -X POST http://localhost:3000/api/kite/instruments/fetch

# Test quote fetch
curl -X POST http://localhost:3000/api/kite/quotes/fetch \
  -H "Content-Type: application/json" \
  -d '{"instruments": ["NSE:INFY"], "type": "ltp"}'

# Test streaming start
curl -X POST http://localhost:3000/api/kite/streaming/start
```

---

## 10. PRODUCTION CONSIDERATIONS

### Security
- Store API keys in environment variables
- Use HTTPS for all API calls
- Implement rate limiting
- Add authentication middleware for sensitive endpoints

### Performance
- Use connection pooling for MongoDB
- Implement caching for frequently accessed data
- Use batch operations for bulk updates
- Monitor memory usage

### Reliability
- Implement health checks
- Add comprehensive logging
- Set up monitoring and alerts
- Implement graceful shutdown

### Scalability
- Use horizontal scaling for WebSocket connections
- Implement load balancing
- Use Redis for distributed caching
- Consider message queues for heavy operations

---

## 11. TROUBLESHOOTING

### Common Issues

**Token Expired**
- Check token expiry in database
- Trigger manual or automated login
- Verify system time is correct

**WebSocket Connection Failed**
- Check network connectivity
- Verify access token is valid
- Check firewall rules
- Verify WebSocket URL format

**Instrument Fetch Failed**
- Check access token validity
- Verify API rate limits
- Check network connectivity
- Verify MongoDB connection

**High Memory Usage**
- Use filtered instrument fetch
- Reduce WebSocket subscriptions
- Implement batch processing
- Monitor and optimize queries

---

## 12. ADDITIONAL RESOURCES

- Kite Connect API Documentation: https://kite.trade/docs/connect/v3/
- WebSocket Streaming Guide: https://kite.trade/docs/connect/v3/websocket/
- Puppeteer Documentation: https://pptr.dev/
- Node-cron Documentation: https://www.npmjs.com/package/node-cron

---

## SUMMARY

This backend implements a complete Kite integration with:
1. **Automated daily login** using Puppeteer + TOTP (7:35 AM IST)
2. **Token management** with MongoDB storage and expiry tracking
3. **Instrument fetching** with NUCLEAR MODE for 123K+ instruments (8:30 AM IST)
4. **Live price streaming** via WebSocket (3 parallel connections, 9000 instruments)
5. **REST API fallback** for quotes when WebSocket is unavailable
6. **Scheduled jobs** for automation using node-cron
7. **Comprehensive API endpoints** for all operations
8. **Error handling** with automatic reconnection and graceful degradation

The system is production-ready with optimizations for performance, reliability, and scalability.
