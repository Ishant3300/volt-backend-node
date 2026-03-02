/**
 * Live Price Service
 * Connects to Kite WebSocket for live ticks and broadcasts to Flutter clients via WS
 */

const WebSocket = require('ws');
const kiteService = require('./kiteService');
const priceQueueService = require('./priceQueueService');

class LivePriceService {
  constructor() {
    this.wss = null;           // WebSocket server for Flutter clients
    this.kiteTicker = null;    // Kite WebSocket connection
    this.subscribedTokens = new Set();
    this.clients = new Set();
    this.latestPrices = new Map();
    this.reconnectTimer = null;
    this.isKiteConnected = false;
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
            // Retry connection immediately
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
        // Reconnect after 5 seconds
        console.log('   Reconnecting in 5 seconds...');
        this.reconnectTimer = setTimeout(() => this._connectToKite(), 5000);
      });

      this.kiteTicker.on('error', (err) => {
        console.log('❌ Kite WebSocket error:', err.message);
        this.isKiteConnected = false;
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
   */
  _parseTick(packet) {
    try {
      if (packet.length < 4) return null;

      const instrumentToken = packet.readInt32BE(0);

      // LTP mode (8 bytes)
      if (packet.length === 8) {
        const lastPrice = packet.readInt32BE(4) / 100;
        return {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
        };
      }

      // Quote/Full mode (28+ bytes)
      if (packet.length >= 28) {
        const lastPrice = packet.readInt32BE(4) / 100;
        const highPrice = packet.readInt32BE(8) / 100;
        const lowPrice = packet.readInt32BE(12) / 100;
        const openPrice = packet.readInt32BE(16) / 100;
        const closePrice = packet.readInt32BE(20) / 100;

        const change = lastPrice - closePrice;
        let changePercent = 0;

        // Only calculate percentage if closePrice is valid and reasonable
        if (closePrice > 0.01) {
          changePercent = (change / closePrice) * 100;
          // Cap percentage to reasonable values (-100% to +1000%)
          changePercent = Math.max(-100, Math.min(1000, changePercent));
        }

        return {
          instrument_token: instrumentToken.toString(),
          last_price: lastPrice,
          high: highPrice,
          low: lowPrice,
          open: openPrice,
          close: closePrice,
          change: change,
          change_percent: changePercent,
        };
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
}

module.exports = new LivePriceService();
