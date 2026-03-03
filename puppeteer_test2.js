const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const base32 = require('hi-base32');
const crypto = require('crypto');
require('dotenv').config();

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

(async () => {
    let browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Step 1: Go to main Kite page
        console.log("Navigating to https://kite.zerodha.com/");
        await page.goto("https://kite.zerodha.com/", { waitUntil: 'networkidle2' });

        console.log('📝 Entering user ID and password on Main page...');
        await page.waitForSelector('#userid', { timeout: 10000 });
        await page.type('#userid', process.env.ZERODHA_USER_ID, { delay: 50 });

        await page.waitForSelector('#password', { timeout: 10000 });
        await page.type('#password', process.env.ZERODHA_PASSWORD, { delay: 50 });

        console.log('Clicking submit...');
        await page.click('button[type="submit"]');

        console.log('🔐 Wait 5s for TOTP page... taking screenshot');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await page.screenshot({ path: 'totp_page_main.png' });

        console.log('🔐 Getting HTML to check selectors...');
        let html = await page.content();
        let fs = require('fs');
        fs.writeFileSync('totp_page_main.html', html);

        // Check if TOTP is asked
        if (html.includes('App Code') || html.includes('Mobile App Code') || html.includes('TOTP') || html.includes('userid')) {
            console.log("Entering TOTP on Main page...");
            // Notice: the field id might still be #userid or something else.
            // Let's check for inputs
            let inputs = html.match(/<input[^>]+>/g);
            console.log("Inputs on page:", inputs);

            // Generate TOTP
            const totp = generateTOTP(process.env.ZERODHA_TOTP_SECRET);
            console.log("TOTP generated:", totp);

            // Assuming it's still #userid, or maybe there's a new id. Let's just try #userid if it exists, or the first text input
            // But let's dump HTML first, so we don't break if it fails.
        } else {
            console.log("No TOTP requested or it failed.");
        }

        console.log("Done.");
        await browser.close();
    } catch (e) {
        console.error(e);
        if (browser) await browser.close();
    }
})();
