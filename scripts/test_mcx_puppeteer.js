/**
 * MCX Bhavcopy via Puppeteer — captures CSV blob download via JS injection.
 * The #btnDateWiseCSV button triggers a client-side blob download that can't be
 * intercepted via network. Instead we override the download mechanism to capture
 * the blob content directly in-page, then extract it.
 * Run: node scripts/test_mcx_puppeteer.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');

function pad(n) { return String(n).padStart(2, '0'); }

async function fetchMcxBhavcopyPuppeteer(targetDate) {
  const dd = pad(targetDate.getDate());
  const mm = pad(targetDate.getMonth() + 1);
  const yyyy = targetDate.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;

  console.log(`Fetching MCX bhavcopy for ${dateStr}...`);
  console.log('Launching Puppeteer...');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });

  let csvText = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('Navigating to MCX BhavCopy page...');
    await page.goto('https://www.mcxindia.com/market-data/BhavCopy', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    const title = await page.title();
    console.log('Page title:', title);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 100));
    if (bodyText.includes('Access Denied') || bodyText.includes('403')) {
      console.log('❌ Blocked by Akamai.');
      return null;
    }

    // Wait for the date input
    await page.waitForSelector('#bhavCopyDateWise', { timeout: 15000 });

    // Set the date
    await page.evaluate((d) => {
      const input = document.getElementById('bhavCopyDateWise');
      if (input) {
        input.value = d;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const hdn = document.getElementById('hdnUCDate');
      if (hdn) hdn.value = d;
    }, dateStr);
    console.log(`Set date to ${dateStr}`);

    // Wait for page to load data for the new date
    await new Promise(r => setTimeout(r, 3000));

    // ── Strategy: Override the blob download to capture content ──
    // The CSV button creates a Blob and triggers a download via <a> click.
    // We inject code to intercept URL.createObjectURL and capture the blob text.
    await page.evaluate(() => {
      window.__mcxCsvData = null;
      window.__mcxCsvReady = false;

      // Override createElement to intercept the download <a> element
      const origCreateElement = document.createElement.bind(document);
      document.createElement = function(tagName) {
        const el = origCreateElement(tagName);
        if (tagName.toLowerCase() === 'a') {
          // Override the click to capture the href blob
          const origClick = el.click.bind(el);
          el.click = function() {
            if (el.href && el.href.startsWith('blob:')) {
              // Fetch the blob and read as text
              fetch(el.href).then(r => r.text()).then(text => {
                window.__mcxCsvData = text;
                window.__mcxCsvReady = true;
              }).catch(() => {
                origClick();
              });
            } else {
              origClick();
            }
          };
        }
        return el;
      };

      // Also override URL.createObjectURL to capture the blob directly
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function(blob) {
        const url = origCreateObjectURL(blob);
        if (blob instanceof Blob && (blob.type.includes('csv') || blob.type.includes('octet') || blob.type === '')) {
          blob.text().then(text => {
            if (text.length > 50 && !text.startsWith('<!')) {
              window.__mcxCsvData = text;
              window.__mcxCsvReady = true;
            }
          });
        }
        return url;
      };
    });

    console.log('Blob interceptors injected.');

    // Click the CSV download button
    const csvBtn = await page.$('#btnDateWiseCSV');
    if (!csvBtn) {
      console.log('❌ CSV button #btnDateWiseCSV not found.');
      return null;
    }

    console.log('Clicking #btnDateWiseCSV...');
    await csvBtn.click();

    // Wait for the blob to be captured (up to 15 seconds)
    let captured = false;
    for (let i = 0; i < 30; i++) {
      captured = await page.evaluate(() => window.__mcxCsvReady === true);
      if (captured) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (captured) {
      csvText = await page.evaluate(() => window.__mcxCsvData);
      console.log(`✅ Captured CSV blob: ${csvText.length} chars`);
    } else {
      console.log('Blob capture timed out. Trying alternate approach...');

      // Alternate: use CDP to set download path and trigger file download
      const downloadPath = path.join(__dirname, 'downloads');
      if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

      const client = await page.createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
      });

      // Re-click
      await csvBtn.click();
      await new Promise(r => setTimeout(r, 5000));

      // Check if file was downloaded
      const files = fs.readdirSync(downloadPath).filter(f => f.endsWith('.csv'));
      if (files.length > 0) {
        const newest = files.sort().pop();
        csvText = fs.readFileSync(path.join(downloadPath, newest), 'utf8');
        console.log(`✅ Downloaded file: ${newest} (${csvText.length} chars)`);
        // Clean up
        try { fs.unlinkSync(path.join(downloadPath, newest)); } catch (_) {}
      } else {
        console.log('No CSV file downloaded either.');

        // Last resort: scrape all pages of the table
        console.log('Falling back to full table scraping (all pages)...');
        let allRows = [];
        let pageNum = 1;
        while (true) {
          const rows = await page.evaluate(() => {
            const trs = document.querySelectorAll('#tblDatewise tbody tr, table tbody tr');
            return Array.from(trs).map(tr => {
              const cells = tr.querySelectorAll('td');
              return Array.from(cells).map(c => c.innerText.trim());
            }).filter(r => r.length >= 6);
          });
          if (rows.length === 0) break;
          allRows = allRows.concat(rows);
          console.log(`   Page ${pageNum}: ${rows.length} rows`);

          // Try to click next page
          const nextBtn = await page.evaluate((currentPage) => {
            const buttons = document.querySelectorAll('.page-link, .pagination button, button[class*="page"]');
            for (const btn of buttons) {
              if (btn.innerText.trim() === String(currentPage + 1)) {
                btn.click();
                return true;
              }
            }
            return false;
          }, pageNum);

          if (!nextBtn) break;
          pageNum++;
          await new Promise(r => setTimeout(r, 2000));
        }

        if (allRows.length > 0) {
          csvText = allRows.map(r => r.join(',')).join('\n');
          console.log(`✅ Scraped ${allRows.length} total rows across ${pageNum} pages.`);
        }
      }
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }

  if (csvText) {
    const lines = csvText.trim().split('\n');
    console.log(`\n=== MCX Bhavcopy Result ===`);
    console.log(`Total lines/rows: ${lines.length}`);
    console.log('First 5:');
    for (const line of lines.slice(0, 5)) {
      console.log('  ', line.substring(0, 130));
    }
    console.log('Last 3:');
    for (const line of lines.slice(-3)) {
      console.log('  ', line.substring(0, 130));
    }
    return csvText;
  }

  console.log('❌ No MCX data retrieved.');
  return null;
}

// ── Run ──
(async () => {
  // Target: most recent Friday (or use system date - rollback to last trading day)
  const now = new Date();
  let target = new Date(now);
  if (target.getDay() === 0) target.setDate(target.getDate() - 2);
  else if (target.getDay() === 6) target.setDate(target.getDate() - 1);
  // If still in the future for MCX, go back one more day
  target.setDate(target.getDate() - 1);
  if (target.getDay() === 0) target.setDate(target.getDate() - 2);
  if (target.getDay() === 6) target.setDate(target.getDate() - 1);

  console.log(`Target date: ${target.toISOString().slice(0, 10)} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][target.getDay()]})\n`);

  const csv = await fetchMcxBhavcopyPuppeteer(target);
  if (csv) {
    console.log('\n✅ SUCCESS — MCX bhavcopy data retrieved!');
    console.log(`Total entries: ${csv.trim().split('\n').length}`);
  } else {
    console.log('\n❌ FAILED — No MCX bhavcopy data.');
  }
})();
