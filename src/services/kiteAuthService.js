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
const base32 = require('hi-base32');
const puppeteer = require('puppeteer');
const kiteService = require('./kiteService');
const { AccessToken } = require('../models/KiteConfig');

class KiteAuthService {
  constructor() {
    // ==================== AUTO LOGIN ====================
    this.isRunning = false;
    this.lastRunTime = null;
    this.lastRunStatus = null;
    
    // Credentials from environment
    this.apiKey = process.env.KITE_API_KEY;
    this.userId = process.env.ZERODHA_USER_ID 
    this.password = process.env.ZERODHA_PASSWORD 
    this.totpSecret = process.env.ZERODHA_TOTP_SECRET

    // ==================== AUTH SERVICE ====================
    this.isAuthenticating = false;
    this.authPromise = null;
  }

  // ==================== TOTP GENERATION ====================

  /**
   * Generate TOTP code for automated login
   */
  generateTOTP(secret) {
    try {
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

      // Validate token against actual Kite API
      const isValidOnAPI = await kiteService.validateAccessToken(accessToken);
      if (!isValidOnAPI) {
        return { 
          valid: false, 
          reason: 'Token invalid according to Kite API', 
          expiresAt 
        };
      }

      return { 
        valid: true, 
        expiresAt,
        hoursLeft: Math.floor((expiresAt - now) / (60 * 60 * 1000))
      };
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
      // Check if we already have a valid token
      const existingToken = await kiteService.getStoredAccessToken();
      
      if (existingToken) {
        // Validate token against actual Kite API
        const isValid = await kiteService.validateAccessToken(existingToken);
        if (isValid) {
          console.log('✅ Using existing valid access token');
          return { success: true, token: existingToken, source: 'existing' };
        } else {
          console.log('❌ Stored token is invalid according to Kite API');
        }
      }

      // No valid token - need manual login
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
   * Perform automated login using Puppeteer
   */
  async performAutomatedLogin() {
    if (this.isRunning) {
      console.log('⚠️  Login already in progress, skipping...');
      return { success: false, reason: 'Already running' };
    }

    this.isRunning = true;
    let browser = null;

    try {
      console.log('🚀 Starting automated Kite login...');
      
      const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${this.apiKey}&v=3`;
      
      // Launch browser
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });

      const page = await browser.newPage();
      await page.goto(loginUrl, { waitUntil: 'networkidle2' });

      // Step 1: Enter User ID
      console.log('📝 Entering user ID...');
      await page.waitForSelector('#userid', { timeout: 10000 });
      await page.type('#userid', this.userId);
      await page.click('button[type="submit"]');

      // Step 2: Enter Password
      console.log('🔑 Entering password...');
      await page.waitForSelector('#password', { timeout: 10000 });
      await page.type('#password', this.password);
      await page.click('button[type="submit"]');

      // Step 3: Enter TOTP
      console.log('🔐 Generating and entering TOTP...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await page.waitForSelector('#userid', { timeout: 10000 });
      const totp = this.generateTOTP(this.totpSecret);
      console.log(`   TOTP: ${totp}`);
      await page.type('#userid', totp);
      await page.click('button[type="submit"]');

      // Step 4: Wait for redirect (with error handling for navigation issues)
      console.log('⏳ Waiting for redirect...');
      
      let redirectUrl = null;
      let requestToken = null;
      
      try {
        // Try to wait for redirect, but handle navigation errors gracefully
        await page.waitForFunction(
          () => window.location.href.includes('request_token'),
          { timeout: 15000 }
        );

        await new Promise(resolve => setTimeout(resolve, 2000));
        redirectUrl = page.url();
        console.log(`🔗 Redirected to: ${redirectUrl}`);

        // Extract request token from URL
        const urlParams = new URLSearchParams(redirectUrl.split('?')[1]);
        requestToken = urlParams.get('request_token');
        
      } catch (navigationError) {
        console.log('⚠️  Navigation error (common with Puppeteer), but login may have succeeded');
        console.log('🔍 Checking if token was stored in database...');
        
        // Wait a bit for the callback to process
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      // Always check if token was stored, regardless of navigation success
      const status = await this.checkTokenStatus();
      if (status.valid) {
        console.log('✅ Token verified in MongoDB - login successful!');
        this.lastRunStatus = 'success';
        return { 
          success: true, 
          message: 'Login successful, token stored and verified', 
          requestToken: requestToken || 'extracted_from_callback'
        };
      }
      
      // If we got a request token, manually exchange it for access token
      if (requestToken) {
        console.log(`🎫 Request token found: ${requestToken}`);
        console.log('🔄 Manually exchanging request token for access token...');
        
        try {
          // Exchange request token for access token (same as manual login)
          const tokenResponse = await kiteService.exchangeToken(requestToken);
          
          if (tokenResponse.status === "success") {
            const { access_token, login_time } = tokenResponse.data;
            
            // Store access token (same as manual login)
            await kiteService.storeAccessToken(access_token, login_time);
            
            console.log('✅ Token exchanged and stored successfully');
            this.lastRunStatus = 'success';
            return { 
              success: true, 
              message: 'Login successful, token exchanged and stored', 
              requestToken,
              accessToken: access_token
            };
          } else {
            throw new Error('Token exchange failed: ' + JSON.stringify(tokenResponse));
          }
        } catch (exchangeError) {
          console.error('❌ Token exchange failed:', exchangeError.message);
          this.lastRunStatus = 'failed';
          return { 
            success: false, 
            error: `Token exchange failed: ${exchangeError.message}`,
            requestToken 
          };
        }
      }
      
      // No request token found - this shouldn't happen if login succeeded
      console.log('⚠️  No request token found in URL - login may have failed');
      throw new Error('Login completed but no request token found in redirect URL');

    } catch (error) {
      console.error('❌ Login error:', error.message);
      
      // Check if token was stored despite the error (common with navigation issues)
      try {
        console.log('🔍 Checking if login succeeded despite error...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const status = await this.checkTokenStatus();
        if (status.valid) {
          console.log('✅ Login actually succeeded! Token found in database.');
          this.lastRunStatus = 'success';
          return { 
            success: true, 
            message: 'Login successful despite navigation error', 
            warning: error.message 
          };
        }
      } catch (checkError) {
        console.log('❌ Token check also failed:', checkError.message);
      }
      
      this.lastRunStatus = 'failed';
      return { success: false, error: error.message };
    } finally {
      if (browser) {
        await browser.close();
      }
      this.isRunning = false;
      this.lastRunTime = new Date();
    }
  }

  /**
   * Main login flow with token check
   */
  async login() {
    console.log('\n🔍 Checking Kite authentication status...');
    
    // Check current token status
    const status = await this.checkTokenStatus();
    
    if (status.valid) {
      console.log(`✅ Token is valid for ${status.hoursLeft} more hours`);
      return { success: true, message: 'Token already valid', skipped: true };
    }

    console.log(`⚠️  Token invalid: ${status.reason}`);
    console.log('🔄 Starting login process...\n');

    // Perform automated login
    const result = await this.performAutomatedLogin();
    
    if (result.success) {
      console.log('🎉 Kite authentication completed successfully\n');
    } else {
      console.error('❌ Kite authentication failed\n');
    }

    return result;
  }

  // ==================== MANUAL LOGIN GUIDANCE ====================

  /**
   * Get authentication instructions for manual login
   */
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

  /**
   * Get daily login schedule recommendations
   */
  getDailyLoginSchedule() {
    return {
      recommended_login_time: '08:00 AM IST',
      market_open_time: '09:15 AM IST',
      token_expiry_time: '06:00 AM IST (next day)',
      automation_script: `
# Daily automation script (run at 8:00 AM IST)
#!/bin/bash

# Check if login is needed
STATUS=$(curl -s http://localhost:3000/api/kite/auth-status | jq -r '.authenticated')

if [ "$STATUS" != "true" ]; then
  echo "🔑 Login required - attempting auto-login"
  
  # Try automated login first
  AUTO_RESULT=$(curl -s -X POST http://localhost:3000/api/kite/auth/auto-login)
  AUTO_SUCCESS=$(echo $AUTO_RESULT | jq -r '.success')
  
  if [ "$AUTO_SUCCESS" == "true" ]; then
    echo "✅ Automated login successful"
  else
    echo "⚠️  Automated login failed - opening manual login"
    open "http://localhost:3000/api/kite/login"
    
    # Wait for manual login (check every 30 seconds)
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

# Trigger instrument fetch
curl -X POST http://localhost:3000/api/kite/instruments/fetch?quick=true

echo "🚀 System ready for market hours"
      `
    };
  }

  // ==================== STATUS AND MONITORING ====================

  /**
   * Get status of last automated login run
   */
  getAutoLoginStatus() {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunStatus: this.lastRunStatus,
      canRunNow: !this.isRunning
    };
  }

  /**
   * Get comprehensive authentication status
   */
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

  /**
   * Get recommendations based on current status
   */
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

  /**
   * Initialize the auth service
   */
  async initialize() {
    try {
      console.log('🔐 Initializing Kite Auth Service...');
      
      // Check current authentication status
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

  /**
   * Attempt smart login (auto first, manual fallback)
   */
  async smartLogin() {
    try {
      console.log('🧠 Attempting smart login...');
      
      // First check if we already have a valid token
      const ensureResult = await this.ensureAuthenticated();
      if (ensureResult.success) {
        return ensureResult;
      }

      // Try automated login
      console.log('🤖 Trying automated login...');
      const autoResult = await this.login();
      
      if (autoResult.success) {
        return autoResult;
      }

      // Automated login failed - provide manual instructions
      console.log('👤 Automated login failed - manual login required');
      const instructions = this.getAuthInstructions();
      
      return {
        success: false,
        requiresManualLogin: true,
        autoLoginError: autoResult.error,
        instructions: instructions,
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
  // Maintain compatibility with existing authService and kiteAutoLogin usage

  // Auto Login compatibility (different method names to avoid conflicts)
  async performLogin() { return this.performAutomatedLogin(); }
  getStatus() { return this.getAutoLoginStatus(); }
  
  // Auth Service methods are already available with their original names
}

// Export singleton
module.exports = new KiteAuthService();