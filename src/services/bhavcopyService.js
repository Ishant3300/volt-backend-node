/**
 * Bhavcopy Service
 *
 * Fetches official settlement/close prices from exchange bhavcopy CSVs:
 *   1. NSE F&O  → nsearchives.nseindia.com (session-based, cookie jar + manual forwarding)
 *   2. MCX      → mcxindia.com (ViewState POST) → Playwright fallback → Samco pwsh fallback
 *   3. BSE F&O  → bseindia.com direct download
 *
 * Main entry: fetchAndApplyBhavcopy(targetDate?)
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const KiteInstrument = require('../models/KiteInstrument');

const TMP_DIR = path.join(__dirname, '../../scripts/downloads');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function pad(n) { return String(n).padStart(2, '0'); }

function dateToYYYYMMDD(d) {
  if (!d) return null;
  const dt = new Date(d);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
}

function dateToDashed(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function dateParts(d) {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return {
    dd: pad(d.getDate()),
    mm: pad(d.getMonth() + 1),
    yy: String(d.getFullYear()).slice(2),
    yyyy: String(d.getFullYear()),
    mon: MONTHS[d.getMonth()],
    yyyymmdd: dateToYYYYMMDD(d),
    ddmmyyyy: `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`,
  };
}

/** Get last Friday (IST). */
function getLastFriday() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 3600000 - now.getTimezoneOffset() * 60000));
  const day = ist.getDay();
  let back = day === 0 ? 2 : day === 6 ? 1 : day === 5 ? 0 : day + 2;
  const result = new Date(ist);
  result.setDate(result.getDate() - back);
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
// NSE — FIXED: cross-subdomain cookie forwarding + request delays
// ═══════════════════════════════════════════════════════════════════════════

async function buildNSEClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
    validateStatus: () => true,
  }));

  console.log('   [NSE] Establishing session...');

  // Step 1: homepage — sets nsit + nseappid
  await client.get('https://www.nseindia.com/', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // CRITICAL: NSE bot detection checks timing. Instant requests = bot flag.
  await sleep(2000);

  // Step 2: API call — upgrades session to "verified browser"
  await client.get('https://www.nseindia.com/api/marketStatus', {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nseindia.com/',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  await sleep(1000);

  // Step 3: visit derivatives section — gets us closer to FO data permission
  await client.get('https://www.nseindia.com/market-data/derivatives-market', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: 'https://www.nseindia.com/',
    },
  });

  await sleep(1500);

  console.log('   [NSE] Session ready.');
  return { client, jar };
}

async function downloadNseSessionZip(date) {
  const { dd, yyyy, mon, yyyymmdd } = dateParts(date);

  const urls = [
    // New UDiFF format (2024+)
    `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyymmdd}_F_0000.csv.zip`,
    // Legacy format (fallback)
    `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${yyyy}/${mon}/fo${dd}${mon}${yyyy}bhav.csv.zip`,
  ];

  let client, jar;
  try {
    ({ client, jar } = await buildNSEClient());
  } catch (e) {
    console.warn(`   [NSE] Session setup failed: ${e.message}`);
    return null;
  }

  // CRITICAL FIX: tough-cookie scopes cookies to www.nseindia.com.
  // nsearchives.nseindia.com is a different subdomain — the jar sends NOTHING there.
  // Solution: manually extract cookies and forward them in the request header.
  let manualCookieHeader = '';
  try {
    const cookies = await jar.getCookies('https://www.nseindia.com/');
    manualCookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    console.log(`   [NSE] Forwarding ${cookies.length} session cookies to nsearchives subdomain.`);
  } catch (e) {
    console.warn(`   [NSE] Could not extract cookies: ${e.message}`);
  }

  for (const url of urls) {
    const filename = url.split('/').pop();
    console.log(`   [NSE] Trying: ${filename}`);

    try {
      const res = await client.get(url, {
        responseType: 'arraybuffer',
        headers: {
          Accept: 'application/octet-stream, application/zip, */*',
          Referer: 'https://www.nseindia.com/market-data/derivatives-market',
          // Forward cookies manually across subdomain boundary
          ...(manualCookieHeader ? { Cookie: manualCookieHeader } : {}),
        },
      });

      if (res.status === 404) {
        console.log(`   [NSE] 404 — trading holiday or URL pattern changed, trying next...`);
        continue;
      }
      if (res.status === 403) {
        console.warn(`   [NSE] 403 — session rejected (bot fingerprinted). Will retry with delay.`);
        await sleep(3000);
        continue;
      }
      if (res.status !== 200) {
        console.log(`   [NSE] HTTP ${res.status} — skipping.`);
        continue;
      }

      const buf = Buffer.from(res.data);
      if (buf.length < 100) {
        console.log(`   [NSE] Response too small (${buf.length}B) — likely an HTML error page.`);
        continue;
      }

      // Verify ZIP magic bytes: PK\x03\x04
      if (buf.slice(0, 4).toString('hex') !== '504b0304') {
        const preview = buf.toString('utf8', 0, 80).replace(/\n/g, ' ');
        console.log(`   [NSE] Not a ZIP — got: "${preview.substring(0, 60)}..."`);
        continue;
      }

      console.log(`   [NSE] ✅ ${(buf.length / 1024).toFixed(1)} KB downloaded.`);
      return buf;
    } catch (e) {
      console.warn(`   [NSE] Error on ${filename}: ${e.message}`);
    }
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// MCX — FIXED: ViewState POST instead of blind GET
// ═══════════════════════════════════════════════════════════════════════════

/** Extract a hidden ASP.NET form field value from HTML. */
function extractAspNetField(html, fieldName) {
  const match = html.match(new RegExp(
    `<input[^>]+id="${fieldName}"[^>]+value="([^"]*)"`, 'i'
  )) || html.match(new RegExp(
    `<input[^>]+name="${fieldName}"[^>]+value="([^"]*)"`, 'i'
  ));
  return match ? match[1] : null;
}

async function downloadMcxSession(date) {
  const { ddmmyyyy, yyyymmdd } = dateParts(date);

  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: () => true,
  }));

  try {
    // Step 1: Homepage — get ASP.NET_SessionId cookie
    console.log('   [MCX] Establishing session...');
    await client.get('https://www.mcxindia.com/', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    await sleep(1000);

    // Step 2: Visit bhavcopy page — get ViewState tokens
    // CRITICAL FIX: BackPage.aspx is ASP.NET WebForms.
    // A blind GET returns empty body. You must POST with __VIEWSTATE + __EVENTVALIDATION.
    console.log('   [MCX] Fetching ViewState from bhavcopy page...');
    const pageRes = await client.get('https://www.mcxindia.com/market-data/bhavcopy', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: 'https://www.mcxindia.com/',
      },
    });

    if (pageRes.status !== 200) {
      console.warn(`   [MCX] Bhavcopy page returned ${pageRes.status}`);
      return null;
    }

    const html = pageRes.data;
    const viewState = extractAspNetField(html, '__VIEWSTATE');
    const viewStateGenerator = extractAspNetField(html, '__VIEWSTATEGENERATOR');
    const eventValidation = extractAspNetField(html, '__EVENTVALIDATION');

    if (!viewState) {
      console.warn('   [MCX] Could not extract __VIEWSTATE — page structure may have changed.');
    }

    console.log(`   [MCX] ViewState: ${viewState ? `${viewState.substring(0, 20)}...` : 'not found'}`);
    await sleep(800);

    const backPageUrl = `https://www.mcxindia.com/BackPage.aspx?cat=bhavcopyarchive&date=${ddmmyyyy}`;

    let res;
    if (viewState) {
      // POST with ViewState — the correct ASP.NET WebForms approach
      const formData = new URLSearchParams();
      formData.append('__VIEWSTATE', viewState);
      if (viewStateGenerator) formData.append('__VIEWSTATEGENERATOR', viewStateGenerator);
      if (eventValidation) formData.append('__EVENTVALIDATION', eventValidation);
      formData.append('cat', 'bhavcopyarchive');
      formData.append('date', ddmmyyyy);

      console.log(`   [MCX] POSTing to BackPage.aspx (date=${ddmmyyyy})...`);
      res = await client.post(backPageUrl, formData.toString(), {
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.mcxindia.com/market-data/bhavcopy',
          Accept: 'application/octet-stream, application/zip, text/csv, */*',
          Origin: 'https://www.mcxindia.com',
        },
      });
    } else {
      // ViewState missing — fall back to GET
      console.log(`   [MCX] Trying GET fallback on BackPage.aspx...`);
      res = await client.get(backPageUrl, {
        responseType: 'arraybuffer',
        headers: {
          Referer: 'https://www.mcxindia.com/market-data/bhavcopy',
          Accept: 'application/octet-stream, */*',
        },
      });
    }

    if (res.status !== 200) {
      console.warn(`   [MCX] BackPage.aspx returned HTTP ${res.status}`);
      return null;
    }

    const buf = Buffer.from(res.data);
    if (buf.length < 200) {
      console.warn(`   [MCX] Response too small (${buf.length}B) — ViewState approach didn't work.`);
      return null;
    }

    // Check for HTML error response
    const preview = buf.toString('utf8', 0, 50);
    if (preview.startsWith('<!') || preview.startsWith('<html')) {
      console.warn(`   [MCX] Got HTML instead of file — session/ViewState rejected.`);
      return null;
    }

    const csvBuf = extractCsvFromBuffer(buf, 'MCX-Session');
    if (csvBuf) {
      console.log(`   [MCX] ✅ Session+ViewState POST: ${(csvBuf.length / 1024).toFixed(1)} KB`);
    }
    return csvBuf;

  } catch (e) {
    console.warn(`   [MCX] Session download failed: ${e.message}`);
    return null;
  }
}

// Playwright fallback — fixed download trigger
async function downloadMcxPlaywright(date) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.warn('   [MCX] Playwright not installed — skipping.');
    return null;
  }

  const { ddmmyyyy, yyyymmdd } = dateParts(date);
  const backPageUrl = `https://www.mcxindia.com/BackPage.aspx?cat=bhavcopyarchive&date=${ddmmyyyy}`;
  ensureTmpDir();
  const zipPath = path.join(TMP_DIR, `MCX_${yyyymmdd}_pw.zip`);

  console.log('   [MCX] Trying Playwright...');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // Establish session
    await page.goto('https://www.mcxindia.com/market-data/bhavcopy', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // FIX: Use evaluate to inject an anchor click — more reliable than page.goto for downloads
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.evaluate((url) => {
        const a = document.createElement('a');
        a.href = url;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 100);
      }, backPageUrl),
    ]);

    await download.saveAs(zipPath);
    const { size } = fs.statSync(zipPath);

    if (size < 200) {
      console.warn(`   [MCX] Playwright download too small: ${size}B`);
      return null;
    }

    console.log(`   [MCX] ✅ Playwright: ${(size / 1024).toFixed(1)} KB`);
    const buf = fs.readFileSync(zipPath);
    return extractCsvFromBuffer(buf, 'MCX-Playwright');

  } catch (e) {
    console.warn(`   [MCX] Playwright failed: ${e.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
  }
}

/**
 * Try MCX download via Samco pwsh (legacy fallback — works on Windows production).
 */
async function downloadMcxSamcoPwsh(date) {
  ensureTmpDir();
  const yyyymmdd = dateToYYYYMMDD(date);
  const dd = dateToDashed(date);
  const filePath = `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dd}/${yyyymmdd}_MCX.csv`;
  const b64 = Buffer.from(filePath).toString('base64').replace(/=+$/, '');
  const outPath = path.join(TMP_DIR, `samco_MCX_${yyyymmdd}.csv`);
  const dataUrl = `https://www.samco.in/bse_nse_mcx/datacopy/${b64}`;

  const { execSync } = require('child_process');
  let shell = null;
  try { execSync('pwsh -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'pwsh'; } catch (_) {
    try { execSync('powershell -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'powershell'; } catch (__) {}
  }
  if (!shell) {
    console.log('   [MCX] No PowerShell available — skipping Samco pwsh.');
    return null;
  }

  console.log(`   [MCX] Trying Samco via ${shell}...`);
  const urlFile = path.join(TMP_DIR, `samco_url_MCX_${Date.now()}.txt`);
  fs.writeFileSync(urlFile, dataUrl, 'utf8');

  const psScript = path.join(TMP_DIR, `samco_dl_MCX_${Date.now()}.ps1`);
  const ps = [
    '$session = $null',
    '$null = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
    `$dataUrl = (Get-Content "${urlFile}" -Raw).Trim()`,
    `Invoke-WebRequest -Uri $dataUrl -WebSession $session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -OutFile "${outPath}" -TimeoutSec 30`,
  ].join('\n');

  try {
    fs.writeFileSync(psScript, ps, 'utf8');
    execSync(`${shell} -ExecutionPolicy Bypass -File "${psScript}"`, { stdio: 'pipe', timeout: 60000 });
  } catch (_) {}
  try { fs.unlinkSync(psScript); } catch (_) {}
  try { fs.unlinkSync(urlFile); } catch (_) {}

  if (fs.existsSync(outPath)) {
    const buf = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch (_) {}
    if (buf.length > 100) {
      const text = buf.toString('utf8').substring(0, 100);
      if (!text.startsWith('<!') && !text.startsWith('<html')) {
        console.log(`   [MCX] ✅ Samco via ${shell}: ${buf.length} bytes.`);
        return buf;
      }
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// BSE — FIXED: actually implemented (was hardcoded to return 0)
// ═══════════════════════════════════════════════════════════════════════════

async function downloadBseFnO(date) {
  const { dd, mm, yy, yyyy, yyyymmdd } = dateParts(date);

  // ─── Attempt 1: BSE direct (works when Cloudflare isn't blocking) ──────
  const directUrls = [
    `https://www.bseindia.com/download/BhavCopy/F%26O/fo${dd}${mm}${yy}bhav.csv.zip`,
    `https://www.bseindia.com/download/BhavCopy/F%26O/fo${dd}${mm}${yyyy}bhav.csv.zip`,
  ];

  for (const url of directUrls) {
    const filename = url.split('/').pop();
    console.log(`   [BSE] Trying direct: ${filename}`);
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        validateStatus: () => true,
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: 'https://www.bseindia.com/markets/derivatives/DeriReports/BhavCopy.aspx',
          Accept: 'application/octet-stream, application/zip, */*',
        },
      });

      if (res.status !== 200) { console.log(`   [BSE] HTTP ${res.status} — trying next.`); continue; }

      const buf = Buffer.from(res.data);
      const preview = buf.toString('utf8', 0, 60);
      if (preview.includes('<!') || preview.includes('<html') || preview.includes('cloudflare')) {
        console.warn(`   [BSE] Cloudflare block on ${filename} — trying next.`);
        continue;
      }
      const csvBuf = extractCsvFromBuffer(buf, 'BSE-FO');
      if (csvBuf) return csvBuf;
    } catch (e) {
      console.warn(`   [BSE] Direct error: ${e.message}`);
    }
  }

  // ─── Attempt 2: Samco pwsh with auto-discovered BSE path ──────────────
  const { execSync } = require('child_process');
  let shell = null;
  try { execSync('pwsh -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'pwsh'; } catch (_) {
    try { execSync('powershell -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'powershell'; } catch (__) {}
  }

  if (shell) {
    ensureTmpDir();

    const discoveryScript = path.join(TMP_DIR, `samco_discover_${Date.now()}.ps1`);
    const discoveryOut = path.join(TMP_DIR, `samco_links_${Date.now()}.txt`);

    // Step 1: scrape the Samco bhavcopy page to find the real BSE download link
    const discoverPs = [
      '$session = $null',
      '$page = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
      '$links = ($page.Links | Where-Object { $_.href -like "*/datacopy/*" } | Select-Object -ExpandProperty href)',
      `$links | Out-File -FilePath "${discoveryOut}" -Encoding UTF8`,
    ].join('\n');

    let bseLinks = [];
    try {
      fs.writeFileSync(discoveryScript, discoverPs, 'utf8');
      execSync(`${shell} -ExecutionPolicy Bypass -File "${discoveryScript}"`, { stdio: 'pipe', timeout: 30000 });
      if (fs.existsSync(discoveryOut)) {
        const raw = fs.readFileSync(discoveryOut, 'utf8');
        bseLinks = raw.split('\n')
          .map(l => l.trim())
          .filter(l => l.includes('datacopy') && (
            l.toUpperCase().includes('BSE') || l.toUpperCase().includes('BFO')
          ));
        console.log(`   [BSE] Samco discovered ${bseLinks.length} BSE link(s)`);
      }
    } catch (e) {
      console.warn(`   [BSE] Samco link discovery failed: ${e.message}`);
    }
    try { fs.unlinkSync(discoveryScript); } catch (_) {}
    try { if (fs.existsSync(discoveryOut)) fs.unlinkSync(discoveryOut); } catch (_) {}

    // Step 2: download each discovered link using the same session
    for (const link of bseLinks) {
      const fullUrl = link.startsWith('http') ? link : `https://www.samco.in${link}`;
      const outPath = path.join(TMP_DIR, `samco_BSE_${yyyymmdd}_${Date.now()}.csv`);

      const dlScript = path.join(TMP_DIR, `samco_dl_BSE_${Date.now()}.ps1`);
      const dlPs = [
        '$session = $null',
        '$null = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
        `Invoke-WebRequest -Uri "${fullUrl}" -WebSession $session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -OutFile "${outPath}" -TimeoutSec 30`,
      ].join('\n');

      try {
        fs.writeFileSync(dlScript, dlPs, 'utf8');
        execSync(`${shell} -ExecutionPolicy Bypass -File "${dlScript}"`, { stdio: 'pipe', timeout: 60000 });
      } catch (_) {}
      try { fs.unlinkSync(dlScript); } catch (_) {}

      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch (_) {}
        if (buf.length > 500) {
          const preview = buf.toString('utf8', 0, 60);
          if (!preview.startsWith('<!') && !preview.startsWith('<html')) {
            console.log(`   [BSE] ✅ Samco BSE: ${(buf.length / 1024).toFixed(1)} KB from ${fullUrl}`);
            console.log(`   [BSE] 📌 Working Samco path: ${fullUrl}`);
            return extractCsvFromBuffer(buf, 'BSE-Samco');
          }
        }
        console.warn(`   [BSE] Samco returned ${buf.length}B for ${fullUrl}`);
      }
    }

    // Fallback: if page scraping found nothing, try hardcoded path candidates
    const samcoPathCandidates = [
      `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dateToDashed(date)}/${yyyymmdd}_BSE.csv`,
      `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dateToDashed(date)}/${yyyymmdd}_BSEFO.csv`,
      `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dateToDashed(date)}/${yyyymmdd}_BFO.csv`,
      `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dateToDashed(date)}/${yyyymmdd}_BSE_FO.csv`,
    ];

    for (const samcoPath of samcoPathCandidates) {
      const b64 = Buffer.from(samcoPath).toString('base64').replace(/=+$/, '');
      const dataUrl = `https://www.samco.in/bse_nse_mcx/datacopy/${b64}`;
      const outPath = path.join(TMP_DIR, `samco_BSE_${yyyymmdd}_${Date.now()}.csv`);

      console.log(`   [BSE] Trying Samco path: ${samcoPath.split('/').pop()}`);

      const psScript = path.join(TMP_DIR, `samco_dl_BSE_${Date.now()}.ps1`);
      const ps = [
        '$session = $null',
        '$null = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
        `Invoke-WebRequest -Uri "${dataUrl}" -WebSession $session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -OutFile "${outPath}" -TimeoutSec 30`,
      ].join('\n');

      try {
        fs.writeFileSync(psScript, ps, 'utf8');
        execSync(`${shell} -ExecutionPolicy Bypass -File "${psScript}"`, { stdio: 'pipe', timeout: 60000 });
      } catch (_) {}
      try { fs.unlinkSync(psScript); } catch (_) {}

      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch (_) {}
        if (buf.length > 500) {
          const preview = buf.toString('utf8', 0, 80);
          if (!preview.startsWith('<!') && !preview.startsWith('<html')) {
            console.log(`   [BSE] ✅ Samco ${shell}: ${(buf.length / 1024).toFixed(1)} KB`);
            console.log(`   [BSE] 📌 Working path pattern: ${samcoPath.split('/').pop()}`);
            return extractCsvFromBuffer(buf, 'BSE-Samco');
          }
        }
      }
    }

    // Debug: log all datacopy links on the page so we can find the right BSE pattern
    const debugScript = path.join(TMP_DIR, `samco_debug_${Date.now()}.ps1`);
    const debugOut = path.join(TMP_DIR, `samco_alllinks_${Date.now()}.txt`);
    const debugPs = [
      '$session = $null',
      '$page = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
      '$allLinks = ($page.Links | Select-Object -ExpandProperty href)',
      `$allLinks | Out-File -FilePath "${debugOut}" -Encoding UTF8`,
    ].join('\n');
    try {
      fs.writeFileSync(debugScript, debugPs, 'utf8');
      execSync(`${shell} -ExecutionPolicy Bypass -File "${debugScript}"`, { stdio: 'pipe', timeout: 30000 });
      if (fs.existsSync(debugOut)) {
        const allLinks = fs.readFileSync(debugOut, 'utf8');
        const datacopyLinks = allLinks.split('\n').filter(l => l.includes('datacopy'));
        console.log(`   [BSE] 🔍 All Samco datacopy links on page:\n${datacopyLinks.map(l => '      ' + l.trim()).join('\n')}`);
        fs.unlinkSync(debugOut);
      }
    } catch (_) {}
    try { fs.unlinkSync(debugScript); } catch (_) {}
  } else {
    console.log('   [BSE] No PowerShell available — skipping Samco fallback.');
  }

  return null;
}

async function fetchBseBhavcopy(date, instruments, closePriceMap, bfoAlreadyMatched = 0) {
  const bfoInstruments = instruments.filter(i => i.exchange === 'BFO');
  if (bfoInstruments.length === 0) {
    console.log('   [BSE] No BFO instruments in DB — skipping.');
    return { matched: 0 };
  }

  // Check which BFO instruments still don't have a price after NSE step
  const uncoveredBfo = bfoInstruments.filter(i => !closePriceMap[i.instrument_token.toString()]);

  if (uncoveredBfo.length === 0) {
    console.log(`   [BSE] All ${bfoInstruments.length} BFO instruments already covered by NSE bhavcopy — skipping BSE download.`);
    return { matched: bfoAlreadyMatched };
  }

  console.log(`   [BSE] ${uncoveredBfo.length}/${bfoInstruments.length} BFO instruments not yet covered — fetching BSE F&O bhavcopy...`);

  const csvBuf = await downloadBseFnO(date);
  if (!csvBuf) {
    console.warn(`   [BSE] ⚠️ No BSE F&O data available. ${bfoAlreadyMatched} BFO instruments covered via NSE.`);
    return { matched: bfoAlreadyMatched };
  }

  const csvText = csvBuf.toString('utf8');
  const bseMap = parseBseCSV(csvText);
  console.log(`   [BSE] Parsed ${bseMap.size} entries.`);

  const bulkOps = [];
  let matched = 0;

  for (const inst of uncoveredBfo) {
    const key = buildMatchKey(inst);
    if (!key) continue;
    const data = bseMap.get(key);
    if (data) {
      const t = inst.instrument_token.toString();
      closePriceMap[t] = data.settle_pr;
      bulkOps.push({
        updateOne: {
          filter: { instrument_token: t },
          update: { $set: {
            last_price: data.settle_pr,
            ohlc_open: data.open,
            ohlc_high: data.high,
            ohlc_low: data.low,
            ohlc_close: data.settle_pr,
          }},
        },
      });
      matched++;
    }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  const total = matched + bfoAlreadyMatched;
  console.log(`   [BSE] ✅ ${total} BFO matched (${bfoAlreadyMatched} via NSE + ${matched} via BSE direct).`);
  return { matched: total };
}

/**
 * Parse BSE F&O bhavcopy CSV.
 * BSE FO columns: SYMBOL, EXPIRY_DT, STRIKE_PR, OPTIONTYPE, OPEN, HIGH, LOW, CLOSE, SETTLE_PR, etc.
 */
function parseBseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });

  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 8) continue;

    const symbol = (c[col['SYMBOL']] || c[col['SC_CODE']] || '').trim().toUpperCase();
    const expiryRaw = (c[col['EXPIRY_DT']] || '').trim();
    const strikeRaw = parseFloat(c[col['STRIKE_PR']] || c[col['STRIKEPRICE']] || 0);
    const optType = (c[col['OPTIONTYPE']] || c[col['CP_FLAG']] || '').trim();
    const open = parseFloat(c[col['OPEN']] || 0);
    const high = parseFloat(c[col['HIGH']] || 0);
    const low = parseFloat(c[col['LOW']] || 0);
    const close = parseFloat(c[col['CLOSE']] || 0);
    const settlePr = parseFloat(c[col['SETTLE_PR']] || c[col['SETTLPRICE']] || close);
    const finType = (c[col['INSTRUMENTTYPE']] || c[col['SERIES']] || '').trim();

    if (!symbol || !expiryRaw || settlePr <= 0) continue;

    // Normalize expiry → YYYYMMDD
    let expiryNorm = expiryRaw.replace(/-/g, '');
    if (expiryNorm.length === 8 && expiryNorm.match(/^\d{8}$/)) {
      // Already YYYYMMDD — keep as-is
    } else if (expiryRaw.includes('-')) {
      const parts = expiryRaw.split('-');
      if (parts[0].length === 4) {
        expiryNorm = expiryRaw.replace(/-/g, ''); // YYYY-MM-DD → YYYYMMDD
      }
    }

    let instType;
    if (finType.includes('FUT') || finType === 'XX') instType = 'FUT';
    else if (optType === 'CE' || optType === 'C') instType = 'CE';
    else if (optType === 'PE' || optType === 'P') instType = 'PE';
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikeRaw));
    const key = `${symbol}|${expiryNorm}|${strike}|${instType}`;
    map.set(key, { open, high, low, close, settle_pr: settlePr });
  }

  return map;
}

function extractCsvFromBuffer(buf, label) {
  if (buf.slice(0, 4).toString('hex') === '504b0304') {
    try {
      const zip = new AdmZip(buf);
      const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.csv'));
      if (entry) {
        const csvBuf = entry.getData();
        console.log(`   [${label}] ✅ Extracted ${csvBuf.length} bytes CSV from ZIP.`);
        return csvBuf;
      }
    } catch (e) {
      console.warn(`   [${label}] ZIP extract error: ${e.message}`);
    }
    return null;
  }

  const text = buf.toString('utf8').substring(0, 200);

  // Debug: show what was actually received
  console.log(`   [${label}] Raw preview: ${text.substring(0, 150).replace(/\n/g, ' ')}`);

  if (text.includes('SYMBOL') || text.includes('TckrSymb') || (text.includes(',') && !text.startsWith('<'))) {
    console.log(`   [${label}] ✅ Direct CSV: ${buf.length} bytes.`);
    return buf;
  }

  console.warn(`   [${label}] Unknown format (${buf.length} bytes).`);
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. NSE F&O — session-based download from nsearchives.nseindia.com
// ═══════════════════════════════════════════════════════════════════════════

async function fetchNseBhavcopy(date, instruments, closePriceMap) {
  const dow = date.getDay();

  // Quick sanity checks before hitting NSE
  if (dow === 0 || dow === 6) {
    console.log(`   [NSE] ${dateToDashed(date)} is a weekend — skipping.`);
    return { matched: 0, unmatched: 0 };
  }

  // Known Indian exchange holidays (2026) — Format: 'MMDD'
  const KNOWN_HOLIDAYS_2026 = new Set([
    '0101', // New Year
    '0126', // Republic Day
    '0219', // Chhatrapati Shivaji Maharaj Jayanti
    '0225', // Mahashivratri
    '0303', // Holi
    '0331', // Id-Ul-Fitr (tentative)
    '0406', // Ram Navami (tentative)
    '0414', // Dr. Ambedkar Jayanti
    '0501', // Maharashtra Day
    '0815', // Independence Day
    '1002', // Gandhi Jayanti
    '1024', // Dussehra (tentative)
    '1114', // Diwali Laxmi Pujan (tentative)
    '1125', // Gurunanak Jayanti (tentative)
    '1225', // Christmas
  ]);

  const key = `${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  if (KNOWN_HOLIDAYS_2026.has(key)) {
    console.log(`   [NSE] ${dateToDashed(date)} is a known trading holiday — skipping download.`);
    return { matched: 0, unmatched: 0 };
  }

  console.log(`   [NSE] Fetching NSE F&O bhavcopy for ${dateToDashed(date)}...`);

  const zipBuf = await downloadNseSessionZip(date);

  if (!zipBuf) {
    console.warn(`   [NSE] ⚠️ Download failed (may be a trading holiday or session issue).`);
    return { matched: 0, unmatched: 0, bfoMatched: 0 };
  }

  let csvText;
  try {
    const zip = new AdmZip(zipBuf);
    const entry = zip.getEntries().find(e => e.entryName.endsWith('.csv'));
    if (!entry) throw new Error('No CSV in zip');
    csvText = entry.getData().toString('utf8');
  } catch (err) {
    console.error(`   [NSE] ❌ Extract failed: ${err.message}`);
    return { matched: 0, unmatched: 0, bfoMatched: 0 };
  }

  const bhavMap = parseNseUdiffCSV(csvText);
  console.log(`   [NSE] Parsed ${bhavMap.size} entries.`);

  // NFO and BFO both get prices from NSE bhavcopy — track them separately
  const nfoInstruments = instruments.filter(i => i.exchange === 'NFO' || (i.exchange === 'NSE' && i.instrument_type));
  const bfoInstruments = instruments.filter(i => i.exchange === 'BFO');

  const bulkOps = [];
  let matched = 0, unmatched = 0, bfoMatched = 0;

  for (const inst of [...nfoInstruments, ...bfoInstruments]) {
    const key = buildMatchKey(inst);
    if (!key) { unmatched++; continue; }
    const bhav = bhavMap.get(key);
    if (bhav) {
      const t = inst.instrument_token.toString();
      closePriceMap[t] = bhav.settle_pr;
      bulkOps.push({
        updateOne: {
          filter: { instrument_token: t },
          update: { $set: {
            last_price: bhav.settle_pr,
            ohlc_open: bhav.open,
            ohlc_high: bhav.high,
            ohlc_low: bhav.low,
            ohlc_close: bhav.settle_pr,
          } },
        },
      });
      if (inst.exchange === 'BFO') bfoMatched++;
      else matched++;
    } else {
      unmatched++;
    }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [NSE] ✅ NFO: ${matched} matched, BFO via NSE: ${bfoMatched} matched, ${unmatched} unmatched.`);
  return { matched, unmatched, bfoMatched };
}

function parseNseUdiffCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map(h => h.trim());
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(s => s.trim());
    if (c.length < 22) continue;
    const symbol = c[col.TckrSymb];
    const expiryNorm = (c[col.XpryDt] || '').replace(/-/g, '');
    const strikePr = parseFloat(c[col.StrkPric]) || 0;
    const finType = c[col.FinInstrmTp];
    const optnTp = c[col.OptnTp];
    const settlePr = parseFloat(c[col.SttlmPric]) || 0;
    if (!symbol || !expiryNorm || settlePr <= 0) continue;

    const instType = (finType === 'STF' || finType === 'IDF') ? 'FUT' : optnTp;
    if (!instType) continue;
    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    const key = `${symbol.toUpperCase()}|${expiryNorm}|${strike}|${instType}`;
    map.set(key, {
      open: parseFloat(c[col.OpnPric]) || 0,
      high: parseFloat(c[col.HghPric]) || 0,
      low: parseFloat(c[col.LwPric]) || 0,
      close: parseFloat(c[col.ClsPric]) || 0,
      settle_pr: settlePr,
    });
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. MCX — fallback chain: session → Playwright → Samco pwsh
// ═══════════════════════════════════════════════════════════════════════════

async function fetchMcxBhavcopy(date, instruments, closePriceMap) {
  console.log(`   [MCX] Fetching MCX settlement prices for ${dateToDashed(date)}...`);

  let csvBuf = null;

  // Try 1: MCX official with ViewState POST
  csvBuf = await downloadMcxSession(date);

  // Try 2: Playwright (handles JS-set cookies)
  if (!csvBuf) {
    csvBuf = await downloadMcxPlaywright(date);
  }

  // Try 3: Samco via pwsh (legacy fallback)
  if (!csvBuf) {
    csvBuf = await downloadMcxSamcoPwsh(date);
  }

  if (csvBuf && csvBuf.length > 100) {
    const csvText = csvBuf.toString('utf8');
    if (!csvText.startsWith('<!') && !csvText.startsWith('<html')) {
      const mcxMap = parseMcxCSV(csvText);
      console.log(`   [MCX] Parsed ${mcxMap.size} entries.`);

      const mcxInstruments = instruments.filter(i => i.exchange === 'MCX');
      const bulkOps = [];
      let matched = 0;

      for (const inst of mcxInstruments) {
        const key = buildMatchKey(inst);
        if (!key) continue;
        const data = mcxMap.get(key);
        if (data) {
          const t = inst.instrument_token.toString();
          closePriceMap[t] = data.settle_pr;
          bulkOps.push({
            updateOne: {
              filter: { instrument_token: t },
              update: { $set: {
                last_price: data.settle_pr,
                ohlc_open: data.open || 0,
                ohlc_high: data.high || 0,
                ohlc_low: data.low || 0,
                ohlc_close: data.settle_pr,
              } },
            },
          });
          matched++;
        }
      }

      if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
      console.log(`   [MCX] ✅ ${matched} matched out of ${mcxInstruments.length}.`);
      return { matched };
    }
  }

  console.warn(`   [MCX] ⚠️ No MCX data available (all download methods failed).`);
  return { matched: 0 };
}

function parseMcxCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 10) continue;
    const symbol = c[col.SYMBOL];
    const expiryRaw = c[col.EXPIRY_DATE];
    const optType = c[col.OPTIONTYPE];
    const strikePr = parseFloat(c[col.STRIKEPRICE]) || 0;
    const open = parseFloat(c[col.OPEN]) || 0;
    const high = parseFloat(c[col.HIGH]) || 0;
    const low = parseFloat(c[col.LOW]) || 0;
    const close = parseFloat(c[col.CLOSE]) || 0;
    const instName = c[col.INSTRUMENTNAME];
    if (!symbol || !expiryRaw || close <= 0) continue;

    const parts = expiryRaw.split(' ');
    if (parts.length !== 3) continue;
    const expiryNorm = `${parts[2]}${MONTHS[parts[1]] || '00'}${parts[0].padStart(2, '0')}`;

    let instType;
    if (instName && instName.startsWith('FUT')) instType = 'FUT';
    else if (optType === 'CE' || optType === 'PE') instType = optType;
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    map.set(`${symbol.toUpperCase()}|${expiryNorm}|${strike}|${instType}`, {
      open, high, low, close, settle_pr: close,
    });
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/** Build match key from a KiteInstrument doc: "SYMBOL|EXPIRY_YYYYMMDD|STRIKE|TYPE" */
function buildMatchKey(inst) {
  const symbol = (inst.raw_name || inst.name || '').toUpperCase().trim();
  const expiryNorm = dateToYYYYMMDD(inst.expiry);
  const instType = inst.instrument_type || '';
  if (!symbol || !expiryNorm || !instType) return null;
  const strike = instType === 'FUT' ? '0' : String(Math.round(inst.strike || 0));
  return `${symbol}|${expiryNorm}|${strike}|${instType}`;
}

/** Parse a CSV line handling quoted fields. */
function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cols.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndApplyBhavcopy(targetDate) {
  const date = targetDate || new Date('2026-04-30');
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  console.log(`📊 [Bhavcopy] Fetching settlement prices for ${dateToDashed(date)} (${dayNames[date.getDay()]})...`);

  const allInstruments = await KiteInstrument.find({
    is_active: true,
    instrument_token: { $not: /^9999/ },
    deleted_at: null,
  }).select('instrument_token name raw_name expiry strike instrument_type exchange segment').lean();
  console.log(`   📊 ${allInstruments.length} active instruments in DB.`);

  const closePriceMap = {};

  // 1. NSE F&O (also covers BFO)
  const nseResult = await fetchNseBhavcopy(date, allInstruments, closePriceMap);

  // 2. MCX
  const mcxResult = await fetchMcxBhavcopy(date, allInstruments, closePriceMap);

  // 3. BSE — only downloads if BFO instruments remain uncovered after NSE step
  const bseResult = await fetchBseBhavcopy(date, allInstruments, closePriceMap, nseResult.bfoMatched || 0);

  const total = Object.keys(closePriceMap).length;
  console.log(`   ✅ Total: ${total} prices (NSE: ${nseResult.matched}, MCX: ${mcxResult.matched}, BSE/BFO: ${bseResult.matched})`);

  // Broadcast settlement prices to connected Flutter clients
  if (total > 0) {
    try {
      const livePriceService = require('./livePriceService');
      if (livePriceService && livePriceService._broadcastToClients) {
        const ticks = [];
        for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
          if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();
          livePriceService._settlementPrices.set(tokenStr, closePrice);
          livePriceService.latestPrices.set(tokenStr, closePrice);
          livePriceService.latestPrices.set(parseInt(tokenStr), closePrice);

          ticks.push({
            instrument_token: tokenStr,
            last_price: closePrice,
            bid_price: closePrice,
            ask_price: closePrice,
            close: closePrice,
            is_settlement: true,
          });
        }

        if (ticks.length > 0) {
          livePriceService._broadcastToClients({ type: 'ticks', data: ticks });
          console.log(`   📡 Broadcast ${ticks.length} settlement prices to Flutter clients.`);
        }
      }
    } catch (e) {
      console.log(`   ℹ️ Broadcast skipped (standalone mode or no clients connected).`);
    }
  }

  return {
    closePriceMap,
    matched: nseResult.matched,
    unmatched: nseResult.unmatched,
    mcxFallback: mcxResult.matched,
    bseMatched: bseResult.matched,
  };
}

module.exports = { fetchAndApplyBhavcopy, getLastFriday };
