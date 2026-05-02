/**
 * Bhavcopy Service
 *
 * Fetches official settlement/close prices from exchange bhavcopy CSVs:
 *   1. NSE F&O  → nsearchives.nseindia.com (session-based, cookie jar)
 *   2. MCX      → mcxindia.com (session-based) → Playwright fallback → Samco pwsh fallback
 *   3. BSE F&O  → covered by NSE bhavcopy on trading days
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
// NSE SESSION-BASED DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════
// NSE requires:
//   1. Visit nseindia.com  → sets nsit cookie
//   2. Hit any API route   → upgrades session
//   3. Download archive    → now accepted

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
    },
    validateStatus: () => true, // Don't throw on 4xx
  }));

  console.log('   [NSE] Establishing session...');

  // Step 1: land on homepage — sets nsit + nseappid cookies
  await client.get('https://www.nseindia.com/', {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });

  // Step 2: hit a JSON API — NSE uses this to fingerprint legit sessions
  await client.get('https://www.nseindia.com/api/marketStatus', {
    headers: { Referer: 'https://www.nseindia.com/' },
  });

  console.log('   [NSE] Session ready.');
  return client;
}

/**
 * Download NSE F&O bhavcopy zip using session-based approach.
 * Tries both new (2024+) and old URL patterns.
 * @returns {Buffer|null} ZIP buffer or null
 */
async function downloadNseSessionZip(date) {
  const { dd, yyyy, mon, yyyymmdd } = dateParts(date);

  const urls = [
    // New format (2024+)
    `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyymmdd}_F_0000.csv.zip`,
    // Old format (pre-2024 fallback)
    `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${yyyy}/${mon}/fo${dd}${mon}${yyyy}bhav.csv.zip`,
  ];

  let client;
  try {
    client = await buildNSEClient();
  } catch (e) {
    console.warn(`   [NSE] Session setup failed: ${e.message}`);
    return null;
  }

  for (const url of urls) {
    const filename = url.split('/').pop();
    console.log(`   [NSE] Trying: ${filename}`);

    try {
      const res = await client.get(url, {
        responseType: 'arraybuffer',
        headers: {
          Accept: 'application/octet-stream,*/*',
          Referer: 'https://www.nseindia.com/',
        },
      });

      if (res.status === 404) {
        console.log(`   [NSE] 404 — trying next URL pattern...`);
        continue;
      }
      if (res.status !== 200) {
        console.log(`   [NSE] HTTP ${res.status} — skipping.`);
        continue;
      }

      const buf = Buffer.from(res.data);
      if (buf.length < 100) {
        console.log(`   [NSE] Response too small (${buf.length} bytes) — likely blocked.`);
        continue;
      }

      // Verify it's actually a ZIP (not HTML error page)
      if (buf.slice(0, 4).toString('hex') !== '504b0304') {
        const preview = buf.toString('utf8').substring(0, 50);
        console.log(`   [NSE] Not a ZIP (${buf.length} bytes, starts with: ${preview.substring(0, 30)})`);
        continue;
      }

      console.log(`   [NSE] ✅ Downloaded ${(buf.length / 1024).toFixed(1)} KB`);
      return buf;
    } catch (e) {
      console.warn(`   [NSE] Download error for ${filename}: ${e.message}`);
      continue;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MCX SESSION-BASED DOWNLOAD + FALLBACKS
// ═══════════════════════════════════════════════════════════════════════════
// mcxindia.com now needs JS cookies. Fallback chain:
//   1. mcxindia.com with session (axios + cookie jar)
//   2. mcxindia.com via Playwright (handles JS cookies)
//   3. Samco via pwsh (legacy fallback)

/**
 * Try MCX direct download with session cookies.
 * @returns {Buffer|null} CSV buffer or null
 */
async function downloadMcxSession(date) {
  const { ddmmyyyy } = dateParts(date);

  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: { 'User-Agent': BROWSER_UA },
    validateStatus: () => true,
  }));

  console.log('   [MCX] Establishing session on mcxindia.com...');

  try {
    // Step 1: visit homepage
    await client.get('https://www.mcxindia.com/', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });

    // Step 2: visit bhavcopy page to set session context
    await client.get('https://www.mcxindia.com/market-data/bhavcopy', {
      headers: { Referer: 'https://www.mcxindia.com/' },
    });

    const url = `https://www.mcxindia.com/BackPage.aspx?cat=bhavcopyarchive&date=${ddmmyyyy}`;
    console.log(`   [MCX] Downloading: ${url}`);

    const res = await client.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Referer: 'https://www.mcxindia.com/market-data/bhavcopy',
        Accept: 'application/octet-stream,*/*',
      },
    });

    if (res.status !== 200) {
      console.warn(`   [MCX] Session download HTTP ${res.status}`);
      return null;
    }

    const buf = Buffer.from(res.data);
    if (buf.length < 500) {
      console.warn(`   [MCX] Session download too small (${buf.length} bytes) — cookie not accepted.`);
      return null;
    }

    // Extract CSV from ZIP if needed
    return extractCsvFromBuffer(buf, 'MCX-Session');
  } catch (e) {
    console.warn(`   [MCX] Session download failed: ${e.message}`);
    return null;
  }
}

/**
 * Try MCX download via Playwright (handles JS-set cookies).
 * @returns {Buffer|null} CSV buffer or null
 */
async function downloadMcxPlaywright(date) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.warn('   [MCX] Playwright not installed — skipping.');
    return null;
  }

  const { ddmmyyyy, yyyymmdd } = dateParts(date);
  const url = `https://www.mcxindia.com/BackPage.aspx?cat=bhavcopyarchive&date=${ddmmyyyy}`;
  ensureTmpDir();
  const zipPath = path.join(TMP_DIR, `MCX_${yyyymmdd}.zip`);

  console.log('   [MCX] Trying Playwright...');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    const page = await context.newPage();

    await page.goto('https://www.mcxindia.com/market-data/bhavcopy', {
      waitUntil: 'networkidle', timeout: 30000,
    });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.goto(url),
    ]);

    await download.saveAs(zipPath);
    const stat = fs.statSync(zipPath);
    if (stat.size < 500) {
      console.warn(`   [MCX] Playwright download too small: ${stat.size} bytes`);
      try { fs.unlinkSync(zipPath); } catch (_) {}
      return null;
    }

    console.log(`   [MCX] ✅ Playwright downloaded ${(stat.size / 1024).toFixed(1)} KB`);
    const buf = fs.readFileSync(zipPath);
    try { fs.unlinkSync(zipPath); } catch (_) {}
    return extractCsvFromBuffer(buf, 'MCX-Playwright');
  } catch (e) {
    console.warn(`   [MCX] Playwright failed: ${e.message}`);
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Try MCX download via Samco pwsh (legacy fallback — works on Windows production).
 * @returns {Buffer|null} CSV buffer or null
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

/**
 * Extract CSV from a buffer that might be a ZIP or direct CSV.
 * @returns {Buffer|null}
 */
function extractCsvFromBuffer(buf, label) {
  // Check if ZIP
  if (buf.slice(0, 4).toString('hex') === '504b0304') {
    try {
      const zip = new AdmZip(buf);
      const entry = zip.getEntries().find(e =>
        e.entryName.toLowerCase().endsWith('.csv')
      );
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

  // Maybe direct CSV
  const text = buf.toString('utf8').substring(0, 200);
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

/**
 * Fetch NSE F&O settlement prices from UDiFF bhavcopy.
 * Uses session-based download (cookie jar) to bypass NSE's bot protection.
 * Matches NFO/BFO instruments in DB by symbol+expiry+strike+type.
 * @returns {{ matched, unmatched }}
 */
async function fetchNseBhavcopy(date, instruments, closePriceMap) {
  const yyyymmdd = dateToYYYYMMDD(date);
  console.log(`   [NSE] Fetching NSE F&O bhavcopy for ${dateToDashed(date)}...`);

  const zipBuf = await downloadNseSessionZip(date);

  if (!zipBuf) {
    console.warn(`   [NSE] ⚠️ Download failed (may be a trading holiday or session issue).`);
    return { matched: 0, unmatched: 0 };
  }

  // Extract CSV from ZIP
  let csvText;
  try {
    const zip = new AdmZip(zipBuf);
    const entry = zip.getEntries().find(e => e.entryName.endsWith('.csv'));
    if (!entry) throw new Error('No CSV in zip');
    csvText = entry.getData().toString('utf8');
  } catch (err) {
    console.error(`   [NSE] ❌ Extract failed: ${err.message}`);
    return { matched: 0, unmatched: 0 };
  }

  // Parse UDiFF CSV → lookup map
  const bhavMap = parseNseUdiffCSV(csvText);
  console.log(`   [NSE] Parsed ${bhavMap.size} entries.`);

  // Match against DB instruments (NFO/BFO only)
  const nfoInstruments = instruments.filter(i =>
    i.exchange === 'NFO' || i.exchange === 'BFO' || (i.exchange === 'NSE' && i.instrument_type)
  );
  const bulkOps = [];
  let matched = 0, unmatched = 0;

  for (const inst of nfoInstruments) {
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
      matched++;
    } else {
      unmatched++;
    }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [NSE] ✅ ${matched} matched, ${unmatched} unmatched.`);
  return { matched, unmatched };
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

/**
 * Fetch MCX settlement prices.
 * Tries: 1) mcxindia.com with session, 2) Playwright, 3) Samco pwsh
 * @returns {{ matched }}
 */
async function fetchMcxBhavcopy(date, instruments, closePriceMap) {
  console.log(`   [MCX] Fetching MCX settlement prices for ${dateToDashed(date)}...`);

  let csvBuf = null;

  // Try 1: MCX official with session cookies
  csvBuf = await downloadMcxSession(date);

  // Try 2: Playwright (handles JS-set cookies)
  if (!csvBuf) {
    csvBuf = await downloadMcxPlaywright(date);
  }

  // Try 3: Samco via pwsh (legacy fallback — works on Windows production)
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

/**
 * Parse MCX bhavcopy CSV (works for both mcxindia.com and Samco MCX format).
 * Columns: SYMBOL, EXPIRY_DATE, OPTIONTYPE, STRIKEPRICE, OPEN, HIGH, LOW, CLOSE, INSTRUMENTNAME, ...
 */
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
// 3. BSE — covered by NSE bhavcopy on trading days
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBseBhavcopy(date, instruments, closePriceMap) {
  const bfoInstruments = instruments.filter(i => i.exchange === 'BFO');
  if (bfoInstruments.length === 0) {
    console.log(`   [BSE] No BFO instruments.`);
    return { matched: 0 };
  }
  console.log(`   [BSE] ${bfoInstruments.length} BFO instruments — covered by NSE bhavcopy on trading days.`);
  return { matched: 0 };
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

/**
 * Fetch settlement prices from all sources and update DB.
 * @param {Date} [targetDate] - Defaults to last Friday.
 * @returns {{ closePriceMap, matched, unmatched, mcxFallback, bseMatched }}
 */
async function fetchAndApplyBhavcopy(targetDate) {
  const date = targetDate || getLastFriday();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  console.log(`📊 [Bhavcopy] Fetching settlement prices for ${dateToDashed(date)} (${dayNames[date.getDay()]})...`);

  // Load all active instruments from DB
  const allInstruments = await KiteInstrument.find({
    is_active: true,
    instrument_token: { $not: /^9999/ },
    deleted_at: null,
  }).select('instrument_token name raw_name expiry strike instrument_type exchange segment').lean();
  console.log(`   📊 ${allInstruments.length} active instruments in DB.`);

  const closePriceMap = {};

  // 1. NSE F&O
  const nseResult = await fetchNseBhavcopy(date, allInstruments, closePriceMap);

  // 2. MCX
  const mcxResult = await fetchMcxBhavcopy(date, allInstruments, closePriceMap);

  // 3. BSE — covered by NSE bhavcopy on trading days
  const bseResult = await fetchBseBhavcopy(date, allInstruments, closePriceMap);

  const total = Object.keys(closePriceMap).length;
  console.log(`   ✅ Total: ${total} prices (NSE: ${nseResult.matched}, MCX: ${mcxResult.matched}, BSE: ${bseResult.matched})`);

  // Broadcast settlement prices to connected Flutter clients (if running inside server)
  if (total > 0) {
    try {
      const livePriceService = require('./livePriceService');
      if (livePriceService && livePriceService._broadcastToClients) {
        const ticks = [];
        for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
          // Store in settlement prices map (separate from live prices)
          if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();
          livePriceService._settlementPrices.set(tokenStr, closePrice);

          // Also update latestPrices for API fallback reads
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