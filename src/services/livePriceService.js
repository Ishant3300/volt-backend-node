/**
 * Live Price Service
 * Connects to Kite WebSocket for live ticks and broadcasts to Flutter clients via WS
 */

const WebSocket = require('ws');
const kiteService = require('./kiteService');
const priceQueueService = require('./priceQueueService');
const syntheticInstrumentService = require('./syntheticInstrumentService');
const KiteInstrument = require('../models/KiteInstrument');
const KiteMarketQuote = require('../models/KiteMarketQuote');
const { LOG_LIVE_TICKS, LOG_WS_BROADCAST } = require('../config/logFlags');
const metricsEngine = require('./metricsEngine');

class LivePriceService {
  constructor() {
      this.wss = null;           // WebSocket server for Flutter clients
      this.kiteTicker = null;    // Kite WebSocket connection
      this.subscribedTokens = new Set();
      this.clients = new Set();
      this.latestPrices = new Map();
      this.reconnectTimer = null;
      this.isKiteConnected = false;
      this.autoLoginAttempted = false;
      this._consecutiveFails = 0;
      this._lastErrorWas403 = false;
    }

  /**
   * Initialize WebSocket server on the HTTP server
   */
  init(server) {
    this.wss = new WebSocket.Server({ noServer: true });
    console.log('📡 WebSocket server initialized (noServer mode)');

    this.wss.on('connection', (ws) => {
      console.log('🔌 New Flutter client connected');
      console.log(`   Total clients: ${this.wss.clients.size}`);
      this.clients.add(ws);

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          console.log('📩 Received from client:', JSON.stringify(data));
          this._handleClientMessage(ws, data);
        } catch (e) {
          console.log('❌ Invalid message from client:', e.message);
        }
      });

      ws.on('close', () => {
        console.log('🔌 Flutter client disconnected');
        this.clients.delete(ws);
        console.log(`   Remaining clients: ${this.wss.clients.size}`);
        this._cleanupUnusedTokens();
      });

      ws.on('error', (err) => {
        console.log('❌ Client WebSocket error:', err.message);
      });

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to live price server',
        kiteConnected: this.isKiteConnected,
      }));
    });

    // Pre-load settlement prices from DB so reconnecting clients get correct prices
    this._preloadSettlementPrices();

    // Connect to Kite WebSocket
    this._connectToKite();
  }

  /**
   * Pre-load last_price from KiteInstrument DB into _settlementPrices map.
   * This ensures that when a Flutter client subscribes (or reconnects),
   * it gets the correct settlement/close price even if the server was restarted
   * and the in-memory maps are empty.
   * Live ticks from Kite will clear these as they arrive.
   */
  async _preloadSettlementPrices() {
    try {
      if (!this._settlementPrices) this._settlementPrices = new Map();

      const instruments = await KiteInstrument.find({
        is_active: true,
        last_price: { $gt: 0 },
        deleted_at: null,
      }).select('instrument_token last_price').lean();

      let loaded = 0;
      for (const inst of instruments) {
        const tokenStr = inst.instrument_token.toString();
        this._settlementPrices.set(tokenStr, inst.last_price);
        // Also populate latestPrices so other lookups work
        this.latestPrices.set(tokenStr, inst.last_price);
        this.latestPrices.set(parseInt(tokenStr), inst.last_price);
        loaded++;
      }

      console.log(`📊 [Settlement] Pre-loaded ${loaded} settlement prices from DB into memory.`);
    } catch (e) {
      console.error(`❌ [Settlement] Error pre-loading prices from DB: ${e.message}`);
    }
  }

  /**
   * Handle messages from Flutter clients
   */
  _handleClientMessage(ws, data) {
    switch (data.type) {
      case 'auth':
        if (data.userId) {
          ws.userId = data.userId;
          if (data.role === 'admin') ws.isAdmin = true;
          console.log(`✅ Client authenticated for WS metrics as user: ${data.userId}${ws.isAdmin ? ' (admin)' : ''}`);
        }
        break;

      case 'subscribe':
        if (data.tokens && Array.isArray(data.tokens)) {
          console.log(`📊 Subscribe request for tokens: ${data.tokens.join(', ')}`);
          data.tokens.forEach(token => {
            const numToken = parseInt(token);
            if (!isNaN(numToken)) {
              this.subscribedTokens.add(numToken);
            }
          });
          this._updateKiteSubscription();

          // Send cached prices immediately for newly subscribed tokens
          // Uses settlement prices (from bhavcopy) when available — these show during closed market hours
          // Live ticks from Kite will override these when market opens
          const cachedTicks = [];
          for (const token of data.tokens) {
            const tokenStr = token.toString();
            // Prefer settlement price (from bhavcopy), fall back to latest live price
            const settlementPrice = this._settlementPrices?.get(tokenStr);
            const livePrice = this.latestPrices.get(tokenStr) || this.latestPrices.get(parseInt(tokenStr));
            const price = settlementPrice || livePrice;
            if (price && price > 0) {
              cachedTicks.push({
                instrument_token: tokenStr,
                last_price: price,
                bid_price: price,
                ask_price: price,
                close: settlementPrice || price,
                is_settlement: !!settlementPrice,
              });
            }
          }
          if (cachedTicks.length > 0 && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ticks', data: cachedTicks }));
          }
        }
        break;

      case 'unsubscribe':
        if (data.tokens && Array.isArray(data.tokens)) {
          console.log(`📊 Unsubscribe request for tokens: ${data.tokens.join(', ')}`);
          data.tokens.forEach(token => {
            this.subscribedTokens.delete(parseInt(token));
          });
          this._updateKiteSubscription();
        }
        break;

      default:
        console.log(`❓ Unknown message type: ${data.type}`);
    }
  }

  /**
   * Connect to Kite WebSocket for live market data
   */
  async _connectToKite() {
      try {
        const accessToken = await kiteService.getStoredAccessToken();
        if (!accessToken) {
          console.log('⚠️  No Kite access token available for WebSocket');

          // Try auto-login once
          if (!this.autoLoginAttempted) {
            this.autoLoginAttempted = true;
            console.log('🤖 Attempting auto-login...');

            const kiteAuthService = require('./kiteAuthService');
            const loginResult = await kiteAuthService.performAutomatedLogin();

            if (loginResult.success) {
              console.log('✅ Auto-login successful, connecting to WebSocket...');
              return this._connectToKite();
            } else {
              console.log('❌ Auto-login failed:', loginResult.error);
            }
          }

          console.log('   Will retry in 30 seconds...');
          this.reconnectTimer = setTimeout(() => this._connectToKite(), 30000);
          return;
        }

        const apiKey = process.env.KITE_API_KEY;
        const wsUrl = `wss://ws.kite.trade?api_key=${apiKey}&access_token=${accessToken}`;

        console.log('🔌 Connecting to Kite WebSocket...');

        this.kiteTicker = new WebSocket(wsUrl);

        this.kiteTicker.on('open', () => {
          console.log('✅ Connected to Kite WebSocket');
          this.isKiteConnected = true;
          this.autoLoginAttempted = false; // Reset for next disconnect
          this._consecutiveFails = 0;
          this._broadcastToClients({
            type: 'kite_status',
            connected: true,
          });
          this._updateKiteSubscription();
        });

        this.kiteTicker.on('message', (data) => {
          this._processKiteTick(data);
        });

        this.kiteTicker.on('close', (code, reason) => {
          console.log(`⚠️  Kite WebSocket closed: ${code} - ${reason}`);
          this.isKiteConnected = false;
          this._broadcastToClients({
            type: 'kite_status',
            connected: false,
          });

          // Track consecutive failures
          this._consecutiveFails = (this._consecutiveFails || 0) + 1;

          // 1006 with a prior 403 error means token is rejected by Kite
          // Try auto-login to get a fresh token before reconnecting
          if (this._lastErrorWas403 && !this.autoLoginAttempted) {
            this._lastErrorWas403 = false;
            this.autoLoginAttempted = true;
            console.log('🔑 403 detected — attempting auto-login for fresh token...');
            const kiteAuthService = require('./kiteAuthService');
            kiteAuthService.performAutomatedLogin().then(result => {
              if (result.success) {
                console.log('✅ Auto-login successful, reconnecting WebSocket...');
                this.autoLoginAttempted = false;
                this._consecutiveFails = 0;
                this._connectToKite();
              } else {
                console.log('❌ Auto-login failed:', result.error);
                console.log('   Will retry in 60 seconds...');
                this.reconnectTimer = setTimeout(() => {
                  this.autoLoginAttempted = false;
                  this._connectToKite();
                }, 60000);
              }
            });
            return;
          }

          // Back off on repeated failures: 5s, 10s, 20s, 30s max
          const delay = Math.min(5000 * Math.pow(2, this._consecutiveFails - 1), 30000);
          console.log(`   Reconnecting in ${delay / 1000}s... (attempt ${this._consecutiveFails})`);
          this.reconnectTimer = setTimeout(() => this._connectToKite(), delay);
        });

        this.kiteTicker.on('error', (err) => {
          console.log('❌ Kite WebSocket error:', err.message);
          this.isKiteConnected = false;
          // Flag if this was a 403 so the close handler can act on it
          if (err.message && err.message.includes('403')) {
            this._lastErrorWas403 = true;
          }
        });

      } catch (error) {
        console.error('❌ Error connecting to Kite WebSocket:', error.message);
        this.reconnectTimer = setTimeout(() => this._connectToKite(), 10000);
      }
    }

  /**
   * Update Kite subscription with current tokens
   */
  _updateKiteSubscription() {
    if (!this.kiteTicker || this.kiteTicker.readyState !== WebSocket.OPEN) {
      console.log('⚠️  Kite WebSocket not ready, skipping subscription update');
      return;
    }

    // Include synthetic instrument source tokens so they always get ticks
    const syntheticSourceTokens = syntheticInstrumentService.getSourceTokens();
    syntheticSourceTokens.forEach(t => this.subscribedTokens.add(t));

    // Include all tokens with open positions so metricsEngine can check margin square-off
    try {
      const metricsEngine = require('./metricsEngine');
      const positionTokens = metricsEngine.getPositionTokens();
      positionTokens.forEach(t => this.subscribedTokens.add(t));
    } catch (_) {}

    const tokens = Array.from(this.subscribedTokens);
    if (tokens.length === 0) {
      console.log('📊 No tokens to subscribe');
      return;
    }

    console.log(`📊 Subscribing to ${tokens.length} tokens on Kite: ${tokens.join(', ')}`);

    // Subscribe message for Kite WebSocket
    const subscribeMsg = JSON.stringify({
      a: 'subscribe',
      v: tokens,
    });
    this.kiteTicker.send(subscribeMsg);

    // Set mode to full for all tokens (full tick data)
    const modeMsg = JSON.stringify({
      a: 'mode',
      v: ['full', tokens],
    });
    this.kiteTicker.send(modeMsg);

    console.log('   ✅ Subscription sent to Kite');
  }

  /**
   * Process binary tick data from Kite WebSocket
   */
  _processKiteTick(rawData) {
    try {
      // Kite sends binary data
      const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

      // First 2 bytes = number of packets
      if (buffer.length < 2) return;

      const numPackets = buffer.readInt16BE(0);
      let offset = 2;

      const ticks = [];

      for (let i = 0; i < numPackets; i++) {
        if (offset + 2 > buffer.length) break;

        const packetLength = buffer.readInt16BE(offset);
        offset += 2;

        if (offset + packetLength > buffer.length) break;

        const packet = buffer.slice(offset, offset + packetLength);
        offset += packetLength;

        const tick = this._parseTick(packet);
        if (tick) {
          ticks.push(tick);
        }
      }

      if (ticks.length > 0) {
        // Update latest prices map and filter out ticks for closed markets with settlement prices
        const liveTicks = [];
        ticks.forEach(t => {
          if (t && t.instrument_token && t.last_price) {
            const tokenStr = t.instrument_token.toString();

            // If settlement price exists for this token, check if market is open
            // before allowing live tick to override it
            if (this._settlementPrices && this._settlementPrices.has(tokenStr)) {
              const segment = (metricsEngine._kiteMap[tokenStr] || {}).segment || '';
              const exchange = segment.split('-')[0] || '';
              if (!this._isMarketOpen(exchange)) {
                // Market closed — ignore this tick entirely, keep settlement price
                return;
              }
              // Market open — clear settlement price, live tick takes over
              this._settlementPrices.delete(tokenStr);
            }

            this.latestPrices.set(tokenStr, t.last_price);
            this.latestPrices.set(parseInt(t.instrument_token), t.last_price);

            // Publish price update to BullMQ for order matching
            priceQueueService.publishPriceUpdate(t.instrument_token.toString(), t.last_price);

            // Update synthetic instruments that depend on this source
            syntheticInstrumentService.onTick(t.instrument_token, t.last_price);

            // Update real-time metrics engine (with bid/ask for P&L computation)
            metricsEngine.onTick(t.instrument_token, t.last_price, t.bid_price, t.ask_price);

            liveTicks.push(t);
          }
        });

        if (LOG_LIVE_TICKS) {
          console.log(`📈 Received ${ticks.length} tick(s), broadcasting ${liveTicks.length}:`);
          liveTicks.forEach(t => {
            console.log(`   Token: ${t.instrument_token} | LTP: ${t.last_price}`);
          });
        }

        if (liveTicks.length > 0) {
          this._broadcastToClients({
            type: 'ticks',
            data: liveTicks,
          });
        }
      }
    } catch (error) {
      console.log('❌ Error processing Kite tick:', error.message);
    }
  }

  /**
   * Parse a single tick packet from Kite binary data
   * Ref: https://kite.trade/docs/connect/v3/websocket/
   *
   * Quote packet (44 bytes):
   *   0-3   instrument_token
   *   4-7   last_price (/100)
   *   8-11  last_traded_quantity
   *  12-15  average_traded_price (/100)
   *  16-19  volume
   *  20-23  total_buy_quantity
   *  24-27  total_sell_quantity
   *  28-31  open (/100)
   *  32-35  high (/100)
   *  36-39  low (/100)
   *  40-43  close (/100)
   *
   * Full packet (184 bytes) adds:
   *  44-47  last_traded_timestamp
   *  48-51  oi
   *  52-55  oi_day_high
   *  56-59  oi_day_low
   *  60-63  exchange_timestamp
   *  64-183 market depth (10 entries × 12 bytes: qty(4) + price(4) + orders(2) + pad(2))
   *         entries 0-4 = bids, entries 5-9 = asks
   */
  _parseTick(packet) {
    try {
      if (packet.length < 4) return null;

      const instrumentToken = packet.readInt32BE(0);

      // Determine divisor: currencies use 10000000, everything else 100
      // Segment = token & 0xFF (last byte). CDS segment = 3
      const segment = instrumentToken & 0xFF;
      const divisor = (segment === 3) ? 10000000 : 100;

      // LTP mode (8 bytes) — all instruments
      if (packet.length === 8) {
        const lastPrice = packet.readInt32BE(4) / divisor;
        return {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
        };
      }

      // Index packets: quote=28 bytes, full=32 bytes
      // Structure: token(4), ltp(4), high(4), low(4), open(4), close(4), change(4), [exchange_ts(4)]
      if (packet.length === 28 || packet.length === 32) {
        const lastPrice = packet.readInt32BE(4) / divisor;
        const highPrice = packet.readInt32BE(8) / divisor;
        const lowPrice = packet.readInt32BE(12) / divisor;
        const openPrice = packet.readInt32BE(16) / divisor;
        const closePrice = packet.readInt32BE(20) / divisor;

        const change = lastPrice - closePrice;
        let changePercent = 0;
        if (closePrice > 0.01) {
          changePercent = (change / closePrice) * 100;
          changePercent = Math.max(-100, Math.min(1000, changePercent));
        }

        return {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
          high: highPrice,
          low: lowPrice,
          open: openPrice,
          close: closePrice,
          change,
          change_percent: changePercent,
        };
      }

      // Quote mode (44 bytes) or Full mode (184 bytes)
      if (packet.length >= 44) {
        const lastPrice = packet.readInt32BE(4) / divisor;
        const openPrice = packet.readInt32BE(28) / divisor;
        const highPrice = packet.readInt32BE(32) / divisor;
        const lowPrice = packet.readInt32BE(36) / divisor;
        const closePrice = packet.readInt32BE(40) / divisor;

        const change = lastPrice - closePrice;
        let changePercent = 0;

        if (closePrice > 0.01) {
          changePercent = (change / closePrice) * 100;
          changePercent = Math.max(-100, Math.min(1000, changePercent));
        }

        const tick = {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
          high: highPrice,
          low: lowPrice,
          open: openPrice,
          close: closePrice,
          change: change,
          change_percent: changePercent,
        };

        // Full mode (184 bytes) includes market depth starting at byte 64
        if (packet.length >= 184) {
          try {
            // Market depth: each entry = qty(4) + price(4) + orders(2) + pad(2) = 12 bytes
            // Best bid (first buy entry): price at offset 64 + 4 = 68
            // Best ask (first sell entry, after 5 buy entries): price at offset 64 + (5*12) + 4 = 128
            const bestBidPrice = packet.readInt32BE(68) / divisor;
            const bestAskPrice = packet.readInt32BE(128) / divisor;

            if (bestBidPrice > 0) {
              tick.bid_price = bestBidPrice;
            }
            if (bestAskPrice > 0) {
              tick.ask_price = bestAskPrice;
            }
          } catch (err) {
            console.log(`   ⚠️  Error parsing market depth: ${err.message}`);
          }
        }

        return tick;
      }

      // Minimal parse
      if (packet.length >= 8) {
        const lastPrice = packet.readInt32BE(4) / 100;
        return {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
        };
      }

      return null;
    } catch (error) {
      console.log('❌ Error parsing tick packet:', error.message);
      return null;
    }
  }

  /**
   * Check if market is currently open for a given exchange.
   * NSE/NFO/BFO: 9:15 AM - 3:30 PM IST (Mon-Fri)
   * MCX: 9:00 AM - 11:30 PM IST (Mon-Fri)
   */
  _isMarketOpen(exchange) {
    const now = new Date();
    const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const ist = new Date(istString);
    const day = ist.getDay();
    if (day === 0 || day === 6) return false; // Weekend

    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    const ex = (exchange || '').toUpperCase();
    if (ex === 'MCX') {
      // MCX: 9:00 AM to 11:30 PM
      return timeInMinutes >= 540 && timeInMinutes <= 1410;
    }
    // NSE/NFO/BFO/BSE: 9:15 AM to 3:30 PM
    return timeInMinutes >= 555 && timeInMinutes <= 930;
  }

  /**
   * Broadcast data to all connected Flutter clients
   */
  _broadcastToClients(data) {
    const message = JSON.stringify(data);
    let sentCount = 0;

    if (this.wss) {
      this.wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          sentCount++;
        }
      });
    }

    if (data.type === 'ticks' && LOG_LIVE_TICKS) {
      console.log(`   📤 Broadcasted to ${sentCount} client(s)`);
    }
  }

  /**
   * Send data to a specific user's WebSocket connection(s).
   * Requires the client to have sent an 'auth' message with userId.
   *
   * @param {string} userId - The user's MongoDB _id
   * @param {object} data   - The payload to send
   */
  broadcastToUser(userId, data) {
    if (!this.wss) return;

    const message = JSON.stringify(data);
    let sentCount = 0;

    // Count authenticated clients for debugging
    const authenticatedClients = [];
    this.wss.clients.forEach((client) => {
      if (client.userId) authenticatedClients.push(client.userId);
    });
    if (LOG_WS_BROADCAST) console.log(`🔔 [WS] broadcastToUser → target userId: "${userId}" | event: ${data.type} | authenticated clients: [${authenticatedClients.join(', ')}]`);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.userId === userId) {
        client.send(message);
        sentCount++;
      }
    });

    if (sentCount > 0) {
      if (LOG_WS_BROADCAST) console.log(`📤 [WS] Sent '${data.type}' to user ${userId} (${sentCount} connection(s))`);
    }
  }

  /**
   * Remove tokens that no clients need anymore.
   * Always keeps position tokens subscribed for margin square-off monitoring.
   */
  _cleanupUnusedTokens() {
    if (this.wss && this.wss.clients.size === 0) {
      console.log('🧹 No clients connected, clearing client subscriptions and latest prices');
      this.subscribedTokens.clear();
      this.latestPrices.clear();
      // Re-add position tokens so margin square-off still works
      try {
        const metricsEngine = require('./metricsEngine');
        const positionTokens = metricsEngine.getPositionTokens();
        positionTokens.forEach(t => this.subscribedTokens.add(t));
        if (positionTokens.length > 0) {
          this._updateKiteSubscription();
        }
      } catch (_) {}
    }
  }

  /**
   * Shutdown gracefully
   */
  shutdown() {
    console.log('🛑 Shutting down LivePriceService...');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.kiteTicker) this.kiteTicker.close();
    if (this.wss) this.wss.close();
  }

  /**
   * Fetch official settlement/close prices from Kite Historical API
   * and broadcast them to all connected Flutter clients.
   * Called via cron after market close.
   *
   * Uses Kite Historical daily candle API — the daily candle `close` field
   * is the official settlement price (not the last traded price).
   * Runs with concurrency control to avoid rate limits.
   */
  async refreshClosePrices() {
      try {
        // Gather tokens from: 1) currently subscribed clients, 2) all watchlists in DB
        const Watchlist = require('../models/Watchlist');
        const watchlistTokens = await Watchlist.distinct('instrument_token', { deleted_at: null });

        const allTokens = new Set([
          ...Array.from(this.subscribedTokens).map(t => t.toString()),
          ...watchlistTokens.map(t => t.toString()),
        ]);

        if (allTokens.size === 0) {
          console.log('📊 [refreshClosePrices] No tokens found, skipping.');
          return;
        }

        console.log(`📊 [refreshClosePrices] Refreshing close prices for ${allTokens.size} tokens...`);

        // Date range: today and 5 days back (covers weekends + holidays)
        const today = new Date();
        const daysBack = new Date(today);
        daysBack.setDate(today.getDate() - 5);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const fromDate = fmt(daysBack);
        const toDate = fmt(today);

        const ticks = [];
        const dbBulkOps = [];
        const instrumentOps = [];
        let failed = 0;

        // Process tokens with concurrency limit to avoid Kite rate limits
        const tokenArray = [...allTokens];
        const CONCURRENCY = 5;

        for (let i = 0; i < tokenArray.length; i += CONCURRENCY) {
          const batch = tokenArray.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (tokenStr) => {
              const candles = await kiteService.getHistoricalData(tokenStr, 'day', fromDate, toDate);
              if (!candles || candles.length === 0) return null;

              const lastCandle = candles[candles.length - 1];
              const closePrice = lastCandle.close;
              if (!closePrice || closePrice <= 0) return null;

              return { tokenStr, closePrice, open: lastCandle.open, high: lastCandle.high, low: lastCandle.low };
            })
          );
          for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value) {
              if (result.status === 'rejected') failed++;
              continue;
            }
            const { tokenStr, closePrice, open, high, low } = result.value;

            // Update in-memory latest prices
            this.latestPrices.set(tokenStr, closePrice);
            this.latestPrices.set(parseInt(tokenStr), closePrice);

            ticks.push({
              instrument_token: tokenStr,
              last_price: closePrice,
              open: open || 0,
              high: high || 0,
              low: low || 0,
            });

            dbBulkOps.push({
              updateOne: {
                filter: { instrument_token: tokenStr },
                update: { $set: { instrument_token: tokenStr, last_price: closePrice, timestamp: new Date() } },
                upsert: true
              }
            });

            instrumentOps.push({
              updateOne: {
                filter: { instrument_token: tokenStr },
                update: { $set: {
                  last_price: closePrice,
                  ohlc_open: open || 0,
                  ohlc_high: high || 0,
                  ohlc_low: low || 0,
                  ohlc_close: closePrice,
                } }
              }
            });
          }

          // Small delay between batches to respect rate limits
          if (i + CONCURRENCY < tokenArray.length) {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        // Broadcast corrected prices to Flutter clients
        if (ticks.length > 0) {
          console.log(`📊 [refreshClosePrices] Broadcasting ${ticks.length} corrected close prices (${failed} failed)`);
          this._broadcastToClients({ type: 'ticks', data: ticks });
        }

        // Update KiteMarketQuote DB
        if (dbBulkOps.length > 0) {
          await KiteMarketQuote.bulkWrite(dbBulkOps, { ordered: false });
          console.log(`📊 [refreshClosePrices] Updated ${dbBulkOps.length} quotes in KiteMarketQuote`);
        }

        // Update KiteInstrument.last_price so app reload shows correct price
        if (instrumentOps.length > 0) {
          await KiteInstrument.bulkWrite(instrumentOps, { ordered: false });
          console.log(`📊 [refreshClosePrices] Updated ${instrumentOps.length} KiteInstrument last_price values`);
        }

        console.log('✅ [refreshClosePrices] Done.');
        return { tokensFound: allTokens.size, ticksBroadcast: ticks.length, dbUpdated: dbBulkOps.length, failed, clientsConnected: this.wss ? this.wss.clients.size : 0 };
      } catch (error) {
        console.error('❌ [refreshClosePrices] Error:', error.message);
        return { error: error.message };
      }
    }

  /**
   * Fetch official settlement prices using Kite OHLC Quote API (batch).
   * ohlc.close = previous day's official settlement price.
   *
   * For NSE: available by ~6 PM same day.
   * For MCX: available by ~8-9 AM next morning.
   *
   * KEY: Only queries active, non-expired instruments to avoid silent drops.
   */
  async refreshSettlementPrices() {
    try {
      // Only refresh prices for tokens that matter:
      // 1. Currently subscribed (WebSocket clients watching)
      // 2. In watchlists
      // 3. With open positions (from metricsEngine)
      const Watchlist = require('../models/Watchlist');
      const watchlistTokens = await Watchlist.distinct('instrument_token', { deleted_at: null });

      let positionTokens = [];
      try {
        const metricsEngine = require('./metricsEngine');
        for (const [token] of metricsEngine._tokenToUsers || new Map()) {
          positionTokens.push(token);
        }
      } catch (_) {}

      const allTokens = new Set([
        ...Array.from(this.subscribedTokens).map(t => t.toString()),
        ...watchlistTokens.map(t => t.toString()),
        ...positionTokens,
      ]);

      if (allTokens.size === 0) {
        console.log('📊 [refreshSettlement] No relevant tokens, skipping.');
        return { total: 0, updated: 0, missing: 0 };
      }

      // Look up exchange:tradingsymbol for these tokens only
      const tokenArray = [...allTokens];
      const instruments = await KiteInstrument.find({
        instrument_token: { $in: tokenArray },
        is_active: true,
      }).select('instrument_token tradingsymbol exchange').lean();

      console.log(`📊 [refreshSettlement] Refreshing ${instruments.length} instruments (from ${allTokens.size} tokens)`);

      // Build EXCHANGE:TRADINGSYMBOL keys
      const keyToToken = new Map();
      const keys = [];
      for (const inst of instruments) {
        const key = `${inst.exchange}:${inst.tradingsymbol.trim()}`;
        keyToToken.set(key, inst.instrument_token.toString());
        keys.push(key);
      }

      if (keys.length === 0) {
        console.log('📊 [refreshSettlement] No keys to query, skipping.');
        return { total: 0, updated: 0, missing: 0 };
      }

      // 3. Batch OHLC API in chunks of 200
      const BATCH_SIZE = 200;
      const allOhlcData = {};

      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        try {
          const data = await kiteService.getMarketQuotes(batch, 'ohlc');
          Object.assign(allOhlcData, data);
        } catch (err) {
          console.error(`⚠️  [refreshSettlement] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
        }
      }

      const returnedCount = Object.keys(allOhlcData).length;
      console.log(`📊 [refreshSettlement] OHLC API returned ${returnedCount}/${keys.length} instruments`);

      // Log missing keys for debugging
      const missingKeys = keys.filter(k => !allOhlcData[k]);
      if (missingKeys.length > 0 && missingKeys.length <= 20) {
        console.warn(`⚠️  [refreshSettlement] Missing from OHLC (${missingKeys.length}):`, missingKeys.join(', '));
      } else if (missingKeys.length > 20) {
        console.warn(`⚠️  [refreshSettlement] ${missingKeys.length} instruments missing from OHLC response`);
      }

      // 4. Build bulk updates
      const ticks = [];
      const bulkOps = [];

      for (const [instKey, quote] of Object.entries(allOhlcData)) {
        const tokenStr = keyToToken.get(instKey);
        if (!tokenStr || !quote) continue;

        const ohlc = quote.ohlc || {};
        const settlementPrice = ohlc.close;
        if (!settlementPrice || settlementPrice <= 0) continue;

        // Update in-memory
        this.latestPrices.set(tokenStr, settlementPrice);
        this.latestPrices.set(parseInt(tokenStr), settlementPrice);

        ticks.push({
          instrument_token: tokenStr,
          last_price: settlementPrice,
          open: ohlc.open || 0,
          high: ohlc.high || 0,
          low: ohlc.low || 0,
          close: settlementPrice,
        });

        bulkOps.push({
          updateOne: {
            filter: { instrument_token: tokenStr },
            update: { $set: {
              last_price: settlementPrice,
              ohlc_open: ohlc.open || 0,
              ohlc_high: ohlc.high || 0,
              ohlc_low: ohlc.low || 0,
              ohlc_close: settlementPrice,
            } },
          }
        });
      }

      // 5. Broadcast to Flutter clients
      if (ticks.length > 0) {
        console.log(`📊 [refreshSettlement] Broadcasting ${ticks.length} settlement prices`);
        this._broadcastToClients({ type: 'ticks', data: ticks });
      }

      // 6. Update DB
      if (bulkOps.length > 0) {
        await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
        console.log(`📊 [refreshSettlement] Updated ${bulkOps.length} KiteInstrument last_price values`);
      }

      console.log('✅ [refreshSettlement] Done.');
      return { total: instruments.length, updated: bulkOps.length, missing: missingKeys.length };
    } catch (error) {
      console.error('❌ [refreshSettlement] Error:', error.message);
      return { error: error.message };
    }
  }

}

module.exports = new LivePriceService();
