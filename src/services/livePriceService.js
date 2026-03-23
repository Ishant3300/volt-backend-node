/**
 * Live Price Service
 * Connects to Kite WebSocket for live ticks and broadcasts to Flutter clients via WS
 */

const WebSocket = require('ws');
const kiteService = require('./kiteService');
const priceQueueService = require('./priceQueueService');
const KiteInstrument = require('../models/KiteInstrument');
const KiteMarketQuote = require('../models/KiteMarketQuote');

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
    this.wss = new WebSocket.Server({ server, path: '/ws/live-prices' });
    console.log('📡 WebSocket server initialized at /ws/live-prices');

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

    // Connect to Kite WebSocket
    this._connectToKite();
  }

  /**
   * Handle messages from Flutter clients
   */
  _handleClientMessage(ws, data) {
    switch (data.type) {
      case 'auth':
        if (data.userId) {
          ws.userId = data.userId;
          console.log(`✅ Client authenticated for WS metrics as user: ${data.userId}`);
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
        // Update latest prices map
        ticks.forEach(t => {
          if (t && t.instrument_token && t.last_price) {
            this.latestPrices.set(t.instrument_token.toString(), t.last_price);
            this.latestPrices.set(parseInt(t.instrument_token), t.last_price);

            // Publish price update to BullMQ for order matching
            priceQueueService.publishPriceUpdate(t.instrument_token.toString(), t.last_price);
          }
        });

        console.log(`📈 Received ${ticks.length} tick(s):`);
        ticks.forEach(t => {
          console.log(`   Token: ${t.instrument_token} | LTP: ${t.last_price}`);
        });

        this._broadcastToClients({
          type: 'ticks',
          data: ticks,
        });
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

    if (data.type === 'ticks') {
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
    console.log(`🔔 [WS] broadcastToUser → target userId: "${userId}" | event: ${data.type} | authenticated clients: [${authenticatedClients.join(', ')}]`);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.userId === userId) {
        client.send(message);
        sentCount++;
      }
    });

    if (sentCount > 0) {
      console.log(`📤 [WS] Sent '${data.type}' to user ${userId} (${sentCount} connection(s))`);
    }
  }

  /**
   * Remove tokens that no clients need anymore
   */
  _cleanupUnusedTokens() {
    if (this.wss && this.wss.clients.size === 0) {
      console.log('🧹 No clients connected, clearing subscriptions and latest prices');
      this.subscribedTokens.clear();
      this.latestPrices.clear();
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
          console.log('📊 [refreshClosePrices] No tokens found (subscribed or watchlist), skipping.');
          return;
        }

        console.log(`📊 [refreshClosePrices] Refreshing close prices for ${allTokens.size} tokens (subscribed: ${this.subscribedTokens.size}, watchlist: ${watchlistTokens.length})...`);

        // Date range: today and 3 days back (covers weekends)
        const today = new Date();
        const threeDaysAgo = new Date(today);
        threeDaysAgo.setDate(today.getDate() - 3);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const fromDate = fmt(threeDaysAgo);
        const toDate = fmt(today);

        const ticks = [];
        const dbBulkOps = [];

        for (const tokenStr of allTokens) {
          try {
            const candles = await kiteService.getHistoricalData(tokenStr, 'day', fromDate, toDate);
            if (candles.length === 0) continue;

            const lastCandle = candles[candles.length - 1];
            const closePrice = lastCandle.close;

            // Update in-memory latest prices
            this.latestPrices.set(tokenStr, closePrice);
            this.latestPrices.set(parseInt(tokenStr), closePrice);

            // Build tick for broadcast (same format as _processKiteTick)
            ticks.push({
              instrument_token: tokenStr,
              last_price: closePrice,
              open: lastCandle.open,
              high: lastCandle.high,
              low: lastCandle.low,
            });

            // Queue DB update
            dbBulkOps.push({
              updateOne: {
                filter: { instrument_token: tokenStr },
                update: { $set: { instrument_token: tokenStr, last_price: closePrice, timestamp: new Date() } },
                upsert: true
              }
            });
          } catch (err) {
            console.log(`   ⚠️  Failed for token ${tokenStr}: ${err.message}`);
          }
        }

        // Broadcast corrected prices to Flutter clients
        if (ticks.length > 0) {
          console.log(`📊 [refreshClosePrices] Broadcasting ${ticks.length} corrected close prices`);
          ticks.forEach(t => console.log(`   📊 Token: ${t.instrument_token} (type: ${typeof t.instrument_token}) → close: ${t.last_price}`));
          console.log(`   📊 Connected WS clients: ${this.wss ? this.wss.clients.size : 0}`);
          this._broadcastToClients({ type: 'ticks', data: ticks });
        }

        // Update KiteMarketQuote DB
        if (dbBulkOps.length > 0) {
          await KiteMarketQuote.bulkWrite(dbBulkOps, { ordered: false });
          console.log(`📊 [refreshClosePrices] Updated ${dbBulkOps.length} quotes in KiteMarketQuote`);
        }

        // Also update KiteInstrument.last_price so app reload shows correct price
        if (ticks.length > 0) {
          const instrumentOps = ticks.map(t => ({
            updateOne: {
              filter: { instrument_token: t.instrument_token },
              update: { $set: { last_price: t.last_price } }
            }
          }));
          await KiteInstrument.bulkWrite(instrumentOps, { ordered: false });
          console.log(`📊 [refreshClosePrices] Updated ${instrumentOps.length} KiteInstrument last_price values`);
        }

        console.log('✅ [refreshClosePrices] Done.');
        return { tokensFound: allTokens.size, ticksBroadcast: ticks.length, dbUpdated: dbBulkOps.length, clientsConnected: this.wss ? this.wss.clients.size : 0 };
      } catch (error) {
        console.error('❌ [refreshClosePrices] Error:', error.message);
        return { error: error.message };
      }
    }

}

module.exports = new LivePriceService();
