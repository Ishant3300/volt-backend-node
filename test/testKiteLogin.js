/**
 * Test script for Kite automated login with visible browser
 * This helps debug the login process by showing what's happening
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const base32 = require('hi-base32');

// TOTP Generator
function generateTOTP(secret) {
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

async function testLogin() {
  const apiKey = process.env.KITE_API_KEY;
  const userId = process.env.ZERODHA_USER_ID;
  const password = process.env.ZERODHA_PASSWORD;
  const totpSecret = process.env.ZERODHA_TOTP_SECRET;

  console.log('🧪 Testing Kite Login with Visible Browser\n');
  console.log('Credentials:');
  console.log(`  User ID: ${userId}`);
  console.log(`  Password: ${'*'.repeat(password.length)}`);
  console.log(`  API Key: ${apiKey}\n`);

  let browser = null;
  let requestToken = null;

  try {
    // Launch browser in NON-headless mode so you can see what's happening
    browser = await puppeteer.launch({
      headless: false, // VISIBLE BROWSER
      slowMo: 50, // Slow down actions so you can see them
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1200,900'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
    console.log('🌐 Opening Kite login page...');
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // Step 1: User ID
    console.log('\n📝 Step 1: Entering User ID...');
    await page.waitForSelector('#userid', { timeout: 10000 });
    await page.type('#userid', userId, { delay: 50 });
    console.log(`   ✅ Entered: ${userId}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.click('button[type="submit"]');
    console.log('   ✅ Clicked submit');

    // Step 2: Password
    console.log('\n🔑 Step 2: Entering Password...');
    await page.waitForSelector('#password', { timeout: 10000 });
    await page.type('#password', password, { delay: 50 });
    console.log('   ✅ Password entered');
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.click('button[type="submit"]');
    console.log('   ✅ Clicked submit');

    // Step 3: TOTP
    console.log('\n🔐 Step 3: Entering TOTP...');
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
    
    await page.waitForSelector('#userid', { timeout: 10000 });
    
    const totp = generateTOTP(totpSecret);
    console.log(`   Generated TOTP: ${totp}`);
    
    // Clear field first
    await page.evaluate(() => {
      const input = document.querySelector('#userid');
      if (input) input.value = '';
    });
    
    await page.type('#userid', totp, { delay: 100 });
    
    // Verify what was entered
    const enteredValue = await page.evaluate(() => {
      const input = document.querySelector('#userid');
      return input ? input.value : '';
    });
    console.log(`   Entered value: ${enteredValue}`);
    
    if (enteredValue !== totp) {
      throw new Error(`TOTP mismatch! Expected ${totp}, got ${enteredValue}`);
    }

    // Set up request interception
    console.log('\n⏳ Step 4: Setting up redirect interception...');
    await page.setRequestInterception(true);
    
    page.on('request', (interceptedRequest) => {
      const url = interceptedRequest.url();
      
      if (url.includes('callback') || url.includes('request_token')) {
        console.log(`\n🔗 REDIRECT DETECTED: ${url}`);
        
        try {
          const urlObj = new URL(url);
          const token = urlObj.searchParams.get('request_token');
          if (token) {
            requestToken = token;
            console.log(`\n✅ REQUEST TOKEN CAPTURED: ${token}\n`);
          }
        } catch (e) {
          console.log('⚠️  Error parsing URL');
        }
      }
      
      // Abort localhost requests, continue others
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        interceptedRequest.abort().catch(() => {});
      } else {
        interceptedRequest.continue().catch(() => {});
      }
    });

    console.log('   ✅ Interception set up');
    console.log('\n📤 Submitting TOTP...');
    await page.click('button[type="submit"]');
    console.log('   ✅ Clicked submit');

    // Wait and observe
    console.log('\n⏳ Waiting 10 seconds to observe...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Check final state
    const finalUrl = await page.url();
    console.log(`\n📍 Final URL: ${finalUrl}`);

    if (requestToken) {
      console.log(`\n🎉 SUCCESS! Request token: ${requestToken}`);
      console.log('\n📋 Next steps:');
      console.log('   1. Copy this request token');
      console.log('   2. Exchange it for access token using your backend API');
      console.log(`   3. Or use: curl -X POST http://localhost:3000/api/kite/callback?request_token=${requestToken}`);
    } else {
      console.log('\n❌ FAILED: No request token captured');
      console.log('\n🔍 Debugging info:');
      console.log(`   - Still on login page: ${finalUrl.includes('kite.zerodha.com/connect/login')}`);
      
      // Check for errors on page
      const pageText = await page.evaluate(() => document.body.textContent);
      if (pageText.includes('error') || pageText.includes('invalid') || pageText.includes('incorrect')) {
        console.log('   - Page contains error text');
        
        try {
          const errorMsg = await page.evaluate(() => {
            const errorEl = document.querySelector('.error, .message, [class*="error"]');
            return errorEl ? errorEl.textContent.trim() : null;
          });
          if (errorMsg) {
            console.log(`   - Error message: ${errorMsg}`);
          }
        } catch (e) {
          console.log('   - Could not extract error message');
        }
      }
    }

    console.log('\n⏸️  Browser will stay open for 30 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return requestToken;
}

// Run the test
console.log('=' .repeat(60));
testLogin().then((token) => {
  console.log('\n' + '='.repeat(60));
  if (token) {
    console.log('✅ Test completed successfully');
    console.log(`   Request Token: ${token}`);
  } else {
    console.log('❌ Test failed - no token captured');
  }
  console.log('='.repeat(60) + '\n');
  process.exit(token ? 0 : 1);
});
