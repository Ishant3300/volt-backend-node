const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const base32 = require('hi-base32');
const crypto = require('crypto');
require('dotenv').config();

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

        const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${process.env.KITE_API_KEY}&v=3`;
        console.log("Navigating to", loginUrl);
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });

        console.log('📝 Entering user ID and password...');
        await page.waitForSelector('#userid', { timeout: 10000 });
        await page.type('#userid', process.env.ZERODHA_USER_ID, { delay: 50 });

        await page.waitForSelector('#password', { timeout: 10000 });
        await page.type('#password', process.env.ZERODHA_PASSWORD, { delay: 50 });

        console.log('Clicking submit...');
        await page.click('button[type="submit"]');

        console.log('🔐 Wait 5s for TOTP page... taking screenshot');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await page.screenshot({ path: 'totp_page_fixed.png' });

        console.log('🔐 Getting HTML to check selectors...');
        const html = await page.content();
        const fs = require('fs');
        fs.writeFileSync('totp_page_fixed.html', html);

        console.log("Done checking html.");

        await browser.close();
    } catch (e) {
        console.error(e);
        if (browser) await browser.close();
    }
})();
