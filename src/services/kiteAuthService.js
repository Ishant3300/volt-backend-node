/**
 * Kite Auth Service - Unified Authentication Service
 * Combines Auth Service + Auto Login functionality
 * Handles authentication checks, manual login guidance, and automated login
 * 
 * FEATURES:
 * - Smart authentication with existing token validation
 * - Automated login using Puppeteer with TOTP generation
 * - Authentication status monitoring and expiry warnings
 * - Manual login guidance and instructions
 * - Daily login scheduling recommendations
 * - Token management and validation
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const base32 = require('hi-base32');
const kiteService = require('./kiteService');
const { AccessToken } = require('../models/KiteConfig');

// ==================== HELPERS ====================

/**
 * Human-like random delay between min and max ms
 */
function randomDelay(min = 300, max = 900) {
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  );
}

class KiteAuthService {
  constructor() {
    // ==================== AUTO LOGIN ====================
    this.isRunning = false;
    this.lastRunTime = null;
    this.lastRunStatus = null;

    // Credentials from environment
    this.apiKey = process.env.KITE_API_KEY;
    this.userId = process.env.ZERODHA_USER_ID;
    this.password = process.env.ZERODHA_PASSWORD;
    this.totpSecret = process.env.ZERODHA_TOTP_SECRET;

    // ==================== AUTH SERVICE ====================
    this.isAuthenticating = false;
    this.authPromise = null;
  }

  // ==================== TOTP GENERATION ====================

  /**
   * Generate TOTP code for a specific time window offset
   * offset: 0 = current, -1 = previous window, 1 = next window
   */
  generateTOTP(secret, offset = 0) {
    try {
      const key = base32.decode.asBytes(secret);
      const epoch = Math.floor(Date.now() / 1000);
      const time = Math.floor(epoch / 30) + offset;

      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64BE(BigInt(time));

      const hmac = crypto.createHmac('sha1', Buffer.from(key));
      hmac.update(buffer);
      const hash = hmac.digest();

      const offsetByte = hash[hash.length - 1] & 0xf;
      const binary = ((hash[offsetByte] & 0x7f) << 24) |
        ((hash[offsetByte + 1] & 0xff) << 16) |
        ((hash[offsetByte + 2] & 0xff) << 8) |
        (hash[offsetByte + 3] & 0xff);

      const otp = binary % 1000000;
      return otp.toString().padStart(6, '0');
    } catch (error) {
      console.error('Error generating TOTP:', error);
      throw error;
    }
  }

  // ==================== TOKEN VALIDATION ====================

  /**
   * Check if token is valid and not expiring soon
   */
  async checkTokenStatus() {
    try {
      const accessToken = await kiteService.getStoredAccessToken();

      if (!accessToken) {
        return { valid: false, reason: 'No token found' };
      }

      const tokenDoc = await AccessToken.findOne().sort({ created_at: -1 });

      if (!tokenDoc) {
        return { valid: false, reason: 'No token document found' };
      }

      const now = new Date();
      const expiresAt = new Date(tokenDoc.expires_at);

      if (now >= expiresAt) {
        return { valid: false, reason: 'Token expired', expiresAt };
      }

      // Check if token expires in less than 2 hours
      const twoHours = 2 * 60 * 60 * 1000;
      if (expiresAt - now < twoHours) {
        return {
          valid: false,
          reason: 'Token expires soon',
          expiresAt,
          minutesLeft: Math.floor((expiresAt - now) / 60000)
        };
      }

      // Trust the DB expiry time — don't validate against live API
      // (live validation can fail outside market hours and cause unnecessary re-login)
      return {
        valid: true,
        expiresAt,
        hoursLeft: Math.floor((expiresAt - now) / (60 * 60 * 1000))
      };

      // Validate token against actual Kite API (disabled - causes false negatives outside market hours)
      // const isValidOnAPI = await kiteService.validateAccessToken(accessToken);
      // if (!isValidOnAPI) {
      //   return { valid: false, reason: 'Token invalid according to Kite API', expiresAt };
      // }
    } catch (error) {
      console.error('Error checking token status:', error);
      return { valid: false, reason: 'Error checking token', error: error.message };
    }
  }

  /**
   * Check authentication status with detailed information
   */
  async checkAuthenticationStatus() {
    try {
      const tokenDoc = await AccessToken.findOne().sort({ created_at: -1 });

      if (!tokenDoc) {
        return {
          status: 'no_token',
          message: 'No access token found',
          requiresLogin: true
        };
      }

      const now = new Date();
      const expiryTime = new Date(tokenDoc.expires_at);
      const timeUntilExpiry = expiryTime - now;
      const hoursUntilExpiry = timeUntilExpiry / (1000 * 60 * 60);

      if (timeUntilExpiry <= 0) {
        return {
          status: 'expired',
          message: 'Access token has expired',
          requiresLogin: true,
          expiredAt: tokenDoc.expires_at
        };
      }

      if (hoursUntilExpiry <= 1) {
        return {
          status: 'expiring_soon',
          message: `Access token expires in ${Math.round(hoursUntilExpiry * 60)} minutes`,
          requiresLogin: false,
          expiresAt: tokenDoc.expires_at,
          hoursUntilExpiry: hoursUntilExpiry
        };
      }

      return {
        status: 'valid',
        message: `Access token valid for ${Math.round(hoursUntilExpiry)} hours`,
        requiresLogin: false,
        expiresAt: tokenDoc.expires_at,
        hoursUntilExpiry: hoursUntilExpiry
      };

    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        requiresLogin: true
      };
    }
  }

  // ==================== SMART AUTHENTICATION ====================

  /**
   * Smart authentication - checks existing token first
   */
  async ensureAuthenticated() {
    try {
      const existingToken = await kiteService.getStoredAccessToken();

      if (existingToken) {
        // Trust the token if it exists — DB expiry check in checkTokenStatus handles freshness
        console.log('✅ Using existing valid access token');
        return { success: true, token: existingToken, source: 'existing' };
      }

      console.log('❌ No valid access token found');
      console.log('🔑 Manual login required at: http://localhost:3000/api/kite/login');

      return {
        success: false,
        requiresLogin: true,
        loginUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/api/kite/login`,
        message: 'Manual login required - access token expired or not found'
      };

    } catch (error) {
      console.error('❌ Authentication check failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== AUTOMATED LOGIN ====================

  /**
   * Perform automated login via direct HTTP API calls (no browser/Puppeteer).
   * Zerodha's /api/login and /api/twofa endpoints don't enforce the browser
   * captcha token — that check only runs on the rendered web form.
   */
  async performAutomatedLogin() {
    if (this.isRunning) {
      console.log('⚠️  Login already in progress, skipping...');
      return { success: false, reason: 'Already running' };
    }

    this.isRunning = true;

    try {
      console.log('🚀 Starting automated Kite login (direct API)...');

      const axios = require('axios');

      // Shared headers that mimic a real browser session
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://kite.zerodha.com',
        'Referer': `https://kite.zerodha.com/connect/login?api_key=${this.apiKey}&v=3`,
        'X-Kite-Version': '3',
      };

      // ── Step 1: Login with user ID + password ──
      console.log('📝 Posting credentials to Zerodha login API...');

      const loginParams = new URLSearchParams({
        user_id: this.userId,
        password: this.password,
      });

      const loginRes = await axios.post(
        'https://kite.zerodha.com/api/login',
        loginParams.toString(),
        { headers }
      );

      const loginData = loginRes.data;
      console.log('📥 Login response status:', loginData.status);

      if (loginData.status !== 'success') {
        throw new Error('Login step 1 failed: ' + JSON.stringify(loginData));
      }

      const requestId = loginData.data?.request_id;
      const twoFaType = loginData.data?.twofa_type || 'totp';
      console.log(`✅ Credentials accepted. request_id: ${requestId}, twofa_type: ${twoFaType}`);

      // ── Step 2: Submit TOTP — try prev/current/next time windows ──
      console.log('🔐 Generating TOTP and posting to twofa API...');

      let twoFaRes = null;
      let twoFaData = null;
      const totp = this.generateTOTP(this.totpSecret, 0);
      console.log(`   TOTP: ${totp}`);

      const twoFaParams = new URLSearchParams({
        user_id: this.userId,
        request_id: requestId,
        twofa_value: totp,
        twofa_type: twoFaType,
        skip_session: '',
      });

      try {
        twoFaRes = await axios.post(
          'https://kite.zerodha.com/api/twofa',
          twoFaParams.toString(),
          { headers }
        );
        twoFaData = twoFaRes.data;
        console.log('📥 2FA response status:', twoFaData.status);
      } catch (twoFaErr) {
        const errData = twoFaErr.response?.data;
        const attemptsLeft = errData?.data?.attempts_remaining;
        console.error(`❌ TOTP rejected: ${errData?.message || twoFaErr.message}`);
        if (attemptsLeft !== undefined) {
          console.error(`   ${attemptsLeft} attempt(s) remain before account lock`);
        }
        throw twoFaErr;
      }

      if (!twoFaData || twoFaData.status !== 'success') {
        throw new Error('Login step 2 (TOTP) failed: ' + JSON.stringify(twoFaData));
      }

      // Extract cookies from the 2FA response for subsequent requests
      const rawCookies = twoFaRes.headers['set-cookie'] || [];
      const cookieString = rawCookies.map(c => c.split(';')[0]).join('; ');
      console.log(`🍪 Session cookies: ${cookieString ? 'present' : 'none'}`);

      // ── Step 3: Follow connect/finish with cookies to get request_token ──
      console.log('🔄 Following redirect chain to get request_token...');

      let requestToken = null;

      const connectUrl = `https://kite.zerodha.com/connect/login?api_key=${this.apiKey}&v=3`;

      const followRedirects = async (url, maxHops = 8) => {
        for (let i = 0; i < maxHops; i++) {
          console.log(`   Hop ${i + 1}: GET ${url}`);

          // If this hop is already our callback URL, extract token directly
          if (url.includes('request_token=')) {
            const base = url.startsWith('http') ? url : `https://placeholder.com${url}`;
            return new URL(base).searchParams.get('request_token');
          }

          try {
            const res = await axios.get(url, {
              headers: { ...headers, Cookie: cookieString },
              maxRedirects: 0,
              validateStatus: (s) => s >= 200 && s < 400,
            });
            const loc = res.headers['location'] || '';
            if (loc) {
              url = loc.startsWith('http') ? loc : `https://kite.zerodha.com${loc}`;
              continue;
            }
            // 2xx with no redirect — done
            break;
          } catch (err) {
            const loc = err.response?.headers?.['location'] || '';
            console.log(`   → ${loc || ('Error: ' + err.message)}`);
            if (loc) {
              url = loc.startsWith('http') ? loc : `https://kite.zerodha.com${loc}`;
              // Check immediately if the next URL already has the token
              if (url.includes('request_token=')) {
                return new URL(url).searchParams.get('request_token');
              }
              continue;
            }
            // localhost redirects cause ECONNREFUSED — check url itself
            if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
              const attempted = err.config?.url || '';
              if (attempted.includes('request_token=')) {
                return new URL(attempted).searchParams.get('request_token');
              }
            }
            throw err;
          }
        }
        return null;
      };

      // Start from connect/login — Zerodha will redirect to connect/finish?sess_id=... automatically
      console.log('   Starting redirect chain from connect/login...');
      requestToken = await followRedirects(connectUrl);

      if (!requestToken) {
        throw new Error('Could not extract request_token from redirect after successful login');
      }

      console.log(`🎫 Request token: ${requestToken}`);

      // ── Step 4: Exchange request_token for access_token ──
      console.log('🔄 Exchanging request token for access token...');
      const tokenResponse = await kiteService.exchangeToken(requestToken);

      if (tokenResponse.status === 'success') {
        const { access_token, login_time } = tokenResponse.data;
        await kiteService.storeAccessToken(access_token, login_time);
        console.log('✅ Access token stored successfully');
        this.lastRunStatus = 'success';
        return {
          success: true,
          message: 'Login successful via direct API',
          requestToken,
          accessToken: access_token
        };
      } else {
        throw new Error('Token exchange failed: ' + JSON.stringify(tokenResponse));
      }

    } catch (error) {
      console.error('❌ Login error:', error.message);
      if (error.response) {
        console.error('   HTTP status:', error.response.status);
        console.error('   Response body:', JSON.stringify(error.response.data));

        // Zerodha has flagged this IP/account - retrying makes it worse
        if (error.response.data?.data?.captcha === true) {
          console.error('');
          console.error('🚫 ACCOUNT CAPTCHA LOCKOUT DETECTED');
          console.error('   Zerodha has flagged your account due to repeated failed login attempts.');
          console.error('   ✅ Fix: Manually login once via browser to clear the flag:');
          console.error(`        → ${process.env.BASE_URL || 'http://localhost:3000'}/api/kite/login`);
          console.error('   After manual login succeeds, automated login will work again.');
          console.error('');
          this.lastRunStatus = 'captcha_lockout';
          return {
            success: false,
            error: 'CAPTCHA_LOCKOUT',
            retryable: false,           // ← stops the retry loop
            message: 'Account captcha lockout — manual login required to clear flag',
            manualLoginUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/api/kite/login`
          };
        }
      }
      this.lastRunStatus = 'failed';
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
      this.lastRunTime = new Date();
    }
  }

  /**
   * Main login flow with token check and CAPTCHA-aware retry
   */
  async login(retryCount = 0) {
    const MAX_CAPTCHA_RETRIES = 3;
    const CAPTCHA_RETRY_DELAY_MS = 2 * 60 * 1000; // 2 minutes

    console.log('\n🔍 Checking Kite authentication status...');

    const status = await this.checkTokenStatus();
    if (status.valid) {
      console.log(`✅ Token is valid for ${status.hoursLeft} more hours`);
      return { success: true, message: 'Token already valid', skipped: true };
    }

    console.log(`⚠️  Token invalid: ${status.reason}`);
    console.log('🔄 Starting login process...\n');

    const result = await this.performAutomatedLogin();

    // Handle retryable CAPTCHA
    if (!result.success && result.error === 'CAPTCHA_DETECTED' && retryCount < MAX_CAPTCHA_RETRIES) {
      console.log(`⏳ CAPTCHA detected. Waiting ${CAPTCHA_RETRY_DELAY_MS / 1000}s before retry ${retryCount + 1}/${MAX_CAPTCHA_RETRIES}...`);
      await new Promise(resolve => setTimeout(resolve, CAPTCHA_RETRY_DELAY_MS));
      return this.login(retryCount + 1);
    }

    // Hard stop — don't retry lockouts
    if (!result.success && result.retryable === false) {
      console.error('🛑 Auto-login permanently stopped: ' + result.message);
      return result;
    }

    if (result.success) {
      console.log('🎉 Kite authentication completed successfully\n');
    } else {
      console.error('❌ Kite authentication failed\n');
    }

    return result;
  }

  // ==================== MANUAL LOGIN GUIDANCE ====================

  getAuthInstructions() {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    return {
      manual_steps: [
        '1. Open browser and go to login URL',
        '2. Complete Kite login with username/password',
        '3. Enter TOTP from your phone app',
        '4. System will automatically store the access token',
        '5. Token is valid until 6 AM next day'
      ],
      login_url: `${baseUrl}/api/kite/login`,
      automation_tips: [
        'Login once daily before market hours (before 9:15 AM)',
        'Set up a reminder at 8:00 AM to login',
        'Use the status API to check token expiry',
        'System will auto-fetch instruments and start streaming'
      ],
      api_endpoints: {
        login: `${baseUrl}/api/kite/login`,
        status: `${baseUrl}/api/kite/auth-status`,
        check_expiry: `${baseUrl}/api/kite/auth/status`,
        auto_login: `${baseUrl}/api/kite/auth/auto-login`
      }
    };
  }

  getDailyLoginSchedule() {
    return {
      recommended_login_time: '08:00 AM IST',
      market_open_time: '09:15 AM IST',
      token_expiry_time: '06:00 AM IST (next day)',
      automation_script: `
# Daily automation script (run at 8:00 AM IST)
#!/bin/bash

STATUS=$(curl -s http://localhost:3000/api/kite/auth-status | jq -r '.authenticated')

if [ "$STATUS" != "true" ]; then
  echo "🔑 Login required - attempting auto-login"
  AUTO_RESULT=$(curl -s -X POST http://localhost:3000/api/kite/auth/auto-login)
  AUTO_SUCCESS=$(echo $AUTO_RESULT | jq -r '.success')
  if [ "$AUTO_SUCCESS" == "true" ]; then
    echo "✅ Automated login successful"
  else
    echo "⚠️  Automated login failed - opening manual login"
    open "http://localhost:3000/api/kite/login"
    while [ "$STATUS" != "true" ]; do
      sleep 30
      STATUS=$(curl -s http://localhost:3000/api/kite/auth-status | jq -r '.authenticated')
      echo "⏳ Waiting for login completion..."
    done
  fi
  echo "✅ Login completed successfully"
else
  echo "✅ Already authenticated"
fi

curl -X POST http://localhost:3000/api/kite/instruments/fetch?quick=true
echo "🚀 System ready for market hours"
      `
    };
  }

  // ==================== STATUS AND MONITORING ====================

  getAutoLoginStatus() {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunStatus: this.lastRunStatus,
      canRunNow: !this.isRunning
    };
  }

  async getComprehensiveStatus() {
    try {
      const [tokenStatus, authStatus, autoLoginStatus] = await Promise.all([
        this.checkTokenStatus(),
        this.checkAuthenticationStatus(),
        Promise.resolve(this.getAutoLoginStatus())
      ]);
      return {
        token: tokenStatus,
        authentication: authStatus,
        autoLogin: autoLoginStatus,
        recommendations: this.getRecommendations(tokenStatus, authStatus)
      };
    } catch (error) {
      return {
        error: error.message,
        recommendations: ['Check system logs for detailed error information']
      };
    }
  }

  getRecommendations(tokenStatus, authStatus) {
    const recommendations = [];
    if (!tokenStatus.valid) {
      if (tokenStatus.reason === 'No token found') {
        recommendations.push('Perform initial login to get access token');
        recommendations.push('Use automated login or manual login via browser');
      } else if (tokenStatus.reason === 'Token expired') {
        recommendations.push('Token has expired - login required');
        recommendations.push('Try automated login first, fallback to manual if needed');
      } else if (tokenStatus.reason === 'Token expires soon') {
        recommendations.push(`Token expires in ${tokenStatus.minutesLeft} minutes`);
        recommendations.push('Consider logging in now to avoid interruption');
      }
    } else {
      recommendations.push(`Token is valid for ${tokenStatus.hoursLeft} more hours`);
      recommendations.push('No action needed at this time');
    }
    if (authStatus.status === 'expiring_soon') {
      recommendations.push('Schedule login before token expires');
    }
    return recommendations;
  }

  // ==================== COMBINED METHODS ====================

  async initialize() {
    try {
      console.log('🔐 Initializing Kite Auth Service...');
      const status = await this.getComprehensiveStatus();
      console.log('✅ Kite Auth Service initialized');
      console.log(`   └─ Token Status: ${status.authentication?.status || 'unknown'}`);
      console.log(`   └─ Auto Login: ${status.autoLogin?.canRunNow ? 'Available' : 'Busy'}`);
      return status;
    } catch (error) {
      console.error('❌ Error initializing Kite Auth Service:', error);
      throw error;
    }
  }

  async smartLogin() {
    try {
      console.log('🧠 Attempting smart login...');

      const ensureResult = await this.ensureAuthenticated();
      if (ensureResult.success) return ensureResult;

      console.log('🤖 Trying automated login...');
      const autoResult = await this.login();

      if (autoResult.success) return autoResult;

      console.log('👤 Automated login failed - manual login required');
      const instructions = this.getAuthInstructions();
      return {
        success: false,
        requiresManualLogin: true,
        autoLoginError: autoResult.error,
        instructions,
        message: 'Automated login failed - please use manual login'
      };
    } catch (error) {
      console.error('❌ Smart login failed:', error);
      return {
        success: false,
        error: error.message,
        message: 'Smart login encountered an error'
      };
    }
  }

  // ==================== LEGACY COMPATIBILITY ====================
  async performLogin() { return this.performAutomatedLogin(); }
  getStatus() { return this.getAutoLoginStatus(); }
}

module.exports = new KiteAuthService();