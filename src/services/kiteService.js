/**
 * Kite Service - Complete Implementation
 * Handles all Kite API interactions including:
 * - Token management with 6 AM IST expiry
 * - Instrument fetching and storage (NUCLEAR MODE)
 * - Market quotes (REST API)
 * - WebSocket streaming
 * - Profile and account info
 */

const crypto = require('crypto');
const axios = require('axios');
const { promisify } = require('util');
const { gunzip: gunzipCallback } = require('zlib');
const gunzip = promisify(gunzipCallback);
const { AccessToken } = require('../models/KiteConfig');
const KiteInstrument = require('../models/KiteInstrument');
const KiteMarketQuote = require('../models/KiteMarketQuote');

class KiteService {
  constructor() {
    this.apiKey = process.env.KITE_API_KEY;
    this.apiSecret = process.env.KITE_API_SECRET;
    this.baseUrl = 'https://api.kite.trade';
  }

  // ==================== TOKEN MANAGEMENT ====================

  /**
   * Exchange request token for access token
   */
  async exchangeToken(requestToken) {
    try {
      const checksum = crypto
        .createHash('sha256')
        .update(this.apiKey + requestToken + this.apiSecret)
        .digest('hex');

      const response = await axios.post(
        `${this.baseUrl}/session/token`,
        `api_key=${this.apiKey}&request_token=${requestToken}&checksum=${checksum}`,
        {
          headers: {
            'X-Kite-Version': '3',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('Token exchange error:', error.response?.data || error.message);
      throw new Error(`Token exchange failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Store access token with 6 AM IST next day expiry
   */
  async storeAccessToken(accessToken, loginTime = new Date()) {
    try {
      // Calculate expiry: 6 AM IST next day
      const loginDate = new Date(loginTime);
      const nextDay = new Date(loginDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      // 6:00 AM IST = 12:30 AM UTC
      const expiryUTC = new Date(nextDay);
      expiryUTC.setUTCHours(0, 30, 0, 0);

      // Clear existing tokens
      await AccessToken.deleteMany({});

      // Store new token
      const tokenDoc = await AccessToken.create({
        access_token: accessToken,
        created_at: loginTime,
        expires_at: expiryUTC
      });

      console.log(`✅ Access token stored, expires at: ${expiryUTC.toISOString()}`);
      return tokenDoc;
    } catch (error) {
      console.error('Error storing access token:', error);
      throw error;
    }
  }

  /**
   * Get stored access token
   */
  async getStoredAccessToken() {
    try {
      const tokenDoc = await AccessToken.findOne({
        expires_at: { $gt: new Date() }
      }).sort({ created_at: -1 });

      if (!tokenDoc) {
        return null;
      }

      return tokenDoc.access_token;
    } catch (error) {
      console.error('Error getting access token:', error);
      return null;
    }
  }

  /**
   * Validate access token against Kite API
   */
  async validateAccessToken(accessToken) {
    try {
      const response = await axios.get(`${this.baseUrl}/user/profile`, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${this.apiKey}:${accessToken}`
        }
      });

      return response.data.status === 'success';
    } catch (error) {
      return false;
    }
  }

  /**
   * Clear session (logout)
   */
  async clearSession() {
    try {
      await AccessToken.deleteMany({});
      console.log('✅ Session cleared');
      return { success: true };
    } catch (error) {
      console.error('Error clearing session:', error);
      throw error;
    }
  }

  // ==================== INSTRUMENTS ====================

  /**
   * Fetch instruments from Kite API
   */
  async fetchInstrumentsFromKite(exchange = null) {
    try {
      const accessToken = await this.getStoredAccessToken();
      if (!accessToken) {
        throw new Error('No valid access token found');
      }

      const endpoint = exchange ? `/instruments/${exchange}` : '/instruments';
      const url = `${this.baseUrl}${endpoint}`;

      console.log(`📡 Fetching instruments from: ${url}`);

      const response = await axios({
        method: 'GET',
        url,
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${this.apiKey}:${accessToken}`,
          'Accept-Encoding': 'gzip'
        },
        responseType: 'arraybuffer',
        timeout: 60000
      });

      // Handle gzipped response
      let csvData;
      if (response.headers['content-encoding'] === 'gzip') {
        const decompressed = await gunzip(response.data);
        csvData = decompressed.toString('utf8');
      } else {
        csvData = response.data.toString('utf8');
      }

      return csvData;
    } catch (error) {
      console.error('Error fetching instruments:', error.message);
      throw error;
    }
  }

  /**
   * Parse CSV instruments data
   */
  parseInstrumentsCsv(csvText) {
    try {
      const lines = csvText.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      
      console.log('📋 CSV Headers:', headers.slice(0, 10));
      
      const instruments = [];

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        const instrument = {};

        headers.forEach((key, index) => {
          let value = values[index]?.trim() || '';

          // Remove quotes
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }

          // Type casting
          if (['instrument_token', 'exchange_token'].includes(key)) {
            instrument[key] = value;
          } else if (['last_price', 'strike', 'tick_size'].includes(key)) {
            instrument[key] = parseFloat(value) || 0;
          } else if (['lot_size'].includes(key)) {
            instrument[key] = parseInt(value, 10) || 0;
          } else if (key === 'expiry' && value) {
            instrument[key] = new Date(value);
          } else {
            instrument[key] = value;
          }
        });

        // Filter: FUT, CE, PE (derivatives) and EQ (equity/indices)
        if (['FUT', 'CE', 'PE', 'EQ'].includes(instrument.instrument_type)) {
          instrument.updated_at = new Date();
          instruments.push(instrument);
        }
      }

      // Log first instrument to see structure
      if (instruments.length > 0) {
        console.log('📝 Sample instrument keys:', Object.keys(instruments[0]));
      }

      return instruments;
    } catch (error) {
      console.error('Error parsing CSV:', error);
      throw error;
    }
  }

  /**
   * Store instruments - NUCLEAR MODE (fastest)
   */
  async storeInstruments(instruments) {
    try {
      console.log(`💥 NUCLEAR MODE: Inserting ${instruments.length} instruments...`);

      // Drop collection for maximum speed
      await KiteInstrument.collection.drop().catch(() => {
        console.log('Collection does not exist, creating new one');
      });

      // Bulk insert
      const result = await KiteInstrument.insertMany(instruments, {
        ordered: false
      });

      console.log(`✅ Inserted ${result.length || result.insertedCount || 0} instruments`);
      console.log('   Result type:', typeof result);
      console.log('   Result keys:', Object.keys(result).slice(0, 5));
      
      const insertedCount = Array.isArray(result) ? result.length : (result.insertedCount || 0);
      
      return {
        success: true,
        inserted: insertedCount,
        total: instruments.length
      };
    } catch (error) {
      console.error('Error storing instruments:', error.message);
      throw error;
    }
  }

  /**
   * Fetch and store all instruments
   */
  async fetchAndStoreAllInstruments(exchange = null) {
    try {
      console.log('📊 Starting instrument fetch...');

      const csvData = await this.fetchInstrumentsFromKite(exchange);
      const instruments = this.parseInstrumentsCsv(csvData);

      console.log(`📈 Parsed ${instruments.length} FUT/CE/PE instruments`);

      const result = await this.storeInstruments(instruments);

      // Calculate breakdown
      const breakdown = {
        FUT: instruments.filter(i => i.instrument_type === 'FUT').length,
        CE: instruments.filter(i => i.instrument_type === 'CE').length,
        PE: instruments.filter(i => i.instrument_type === 'PE').length
      };

      return {
        success: true,
        total: instruments.length,
        inserted: result.inserted,
        breakdown
      };
    } catch (error) {
      console.error('Error in fetchAndStoreAllInstruments:', error);
      throw error;
    }
  }

  /**
   * Search instruments
   */
  async searchInstruments(query, exchange = null, instrumentType = null) {
    try {
      console.log('🔍 Backend: Searching instruments...');
      console.log('   Query:', query);
      console.log('   Exchange:', exchange);
      console.log('   Instrument Type:', instrumentType);
      
      const filter = {
        $or: [
          { tradingsymbol: { $regex: query, $options: 'i' } },
          { name: { $regex: query, $options: 'i' } }
        ],
        instrument_type: { $in: ['FUT', 'CE', 'PE', 'EQ'] }
      };

      if (exchange) {
        filter.exchange = exchange;
      }

      if (instrumentType) {
        filter.instrument_type = instrumentType;
      }

      console.log('   Filter:', JSON.stringify(filter, null, 2));
      
      // Check total count in database
      const totalCount = await KiteInstrument.countDocuments();
      console.log('   Total instruments in DB:', totalCount);
      
      const instruments = await KiteInstrument.find(filter).limit(50);
      console.log('   ✅ Found', instruments.length, 'matching instruments');
      
      return instruments;
    } catch (error) {
      console.error('❌ Error searching instruments:', error);
      throw error;
    }
  }

  /**
   * Get instruments info
   */
  async getInstrumentsInfo() {
    try {
      const total = await KiteInstrument.countDocuments();
      const lastUpdated = await KiteInstrument.findOne().sort({ updated_at: -1 });

      const breakdown = await KiteInstrument.aggregate([
        {
          $group: {
            _id: '$instrument_type',
            count: { $sum: 1 }
          }
        }
      ]);

      return {
        totalInstruments: total,
        lastUpdated: lastUpdated?.updated_at,
        breakdown: breakdown.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {})
      };
    } catch (error) {
      console.error('Error getting instruments info:', error);
      throw error;
    }
  }

  // ==================== MARKET QUOTES (REST API) ====================

  /**
   * Fetch market quotes from Kite API
   */
  async getMarketQuotes(instruments, quoteType = 'ltp') {
    try {
      const accessToken = await this.getStoredAccessToken();
      if (!accessToken) {
        throw new Error('No valid access token found');
      }

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
          .join('&');

        const endpoint = quoteType === 'full' ? '/quote' : `/quote/${quoteType}`;
        const url = `${this.baseUrl}${endpoint}?${queryParams}`;

        const response = await axios({
          method: 'GET',
          url,
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${this.apiKey}:${accessToken}`
          },
          timeout: 30000
        });

        Object.assign(allQuotes, response.data.data);
      }

      return allQuotes;
    } catch (error) {
      console.error('Error fetching market quotes:', error.message);
      throw error;
    }
  }

  /**
   * Store market quotes in database
   */
  async storeMarketQuotes(quotes) {
    try {
      const timestamp = new Date();
      const bulkOps = [];

      for (const [key, data] of Object.entries(quotes)) {
        bulkOps.push({
          updateOne: {
            filter: { instrument_token: data.instrument_token },
            update: {
              $set: {
                instrument_token: data.instrument_token,
                last_price: data.last_price,
                timestamp: timestamp
              }
            },
            upsert: true
          }
        });
      }

      if (bulkOps.length > 0) {
        await KiteMarketQuote.bulkWrite(bulkOps, { ordered: false });
        console.log(`📊 Stored ${bulkOps.length} market quotes`);
      }

      return { success: true, count: bulkOps.length };
    } catch (error) {
      console.error('Error storing market quotes:', error);
      throw error;
    }
  }

  /**
   * Get latest quotes from database
   */
  async getLatestQuotes(instruments = null, limit = 100) {
    try {
      const filter = {};

      if (instruments && instruments.length > 0) {
        filter.instrument_token = { $in: instruments };
      }

      const quotes = await KiteMarketQuote.find(filter)
        .sort({ timestamp: -1 })
        .limit(limit);

      return quotes;
    } catch (error) {
      console.error('Error getting latest quotes:', error);
      throw error;
    }
  }

  // ==================== PROFILE & ACCOUNT ====================

  /**
   * Get user profile
   */
  async getProfile() {
    try {
      const accessToken = await this.getStoredAccessToken();
      if (!accessToken) {
        throw new Error('No valid access token found');
      }

      const response = await axios.get(`${this.baseUrl}/user/profile`, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${this.apiKey}:${accessToken}`
        }
      });

      return response.data.data;
    } catch (error) {
      console.error('Error getting profile:', error.message);
      throw error;
    }
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get login URL
   */
  getLoginUrl() {
    return `https://kite.zerodha.com/connect/login?v=3&api_key=${this.apiKey}`;
  }

  /**
   * Get market depth for an instrument
   */
  async getMarketDepth(exchange, tradingsymbol) {
    try {
      const accessToken = await this.getStoredAccessToken();
      if (!accessToken) {
        throw new Error('Not authenticated');
      }

      const instrumentKey = `${exchange}:${tradingsymbol}`;
      const response = await axios.get(
        `${this.baseUrl}/quote/ohlc`,
        {
          params: { i: instrumentKey },
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${this.apiKey}:${accessToken}`
          }
        }
      );

      if (response.data && response.data.status === 'success') {
        return response.data.data;
      }

      return null;
    } catch (error) {
      console.error('Error fetching market depth:', error.message);
      throw error;
    }
  }

  /**
   * Check authentication status
   */
  async isAuthenticated() {
    try {
      const token = await this.getStoredAccessToken();
      return token !== null;
    } catch (error) {
      return false;
    }
  }
}

module.exports = new KiteService();
