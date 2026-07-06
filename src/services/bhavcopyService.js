/**
 * Bhavcopy Service — Simplified
 *
 * Fetches official settlement/close prices:
 *   1. NSE F&O → Direct download from nsearchives.nseindia.com/content/trdops/FNO_BC{DDMMYYYY}.DAT
 *   2. MCX     → Samco via pwsh
 *
 * Main entry: fetchAndApplyBhavcopy(targetDate?)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
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
  return {
    dd: pad(d.getDate()),
    mm: pad(d.getMonth() + 1),
    yyyy: String(d.getFullYear()),
    yyyymmdd: dateToYYYYMMDD(d),
    ddmmyyyy: `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`,
  };
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

/** Build match key from a KiteInstrument doc: "SYMBOL|EXPIRY_YYYYMMDD|STRIKE|TYPE" */
function buildMatchKey(inst) {
  const symbol = (inst.raw_name || inst.name || '').toUpperCase().trim();
  const expiryNorm = dateToYYYYMMDD(inst.expiry);
  const instType = inst.instrument_type || '';
  if (!symbol || !expiryNorm || !instType) return null;
  const strike = instType === 'FUT' ? '0' : String(Math.round(inst.strike || 0));
  return `${symbol}|${expiryNorm}|${strike}|${instType}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// NSE — Direct download (no session needed)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchNseBhavcopy(date, instruments, closePriceMap) {
  // If weekend, go back to Friday
  const nseDate = new Date(date);
  if (nseDate.getDay() === 0) nseDate.setDate(nseDate.getDate() - 2); // Sun → Fri
  if (nseDate.getDay() === 6) nseDate.setDate(nseDate.getDate() - 1); // Sat → Fri

  console.log(`   [NSE] Fetching NSE F&O bhavcopy for ${dateToDashed(nseDate)}...`);

  const { ddmmyyyy } = dateParts(nseDate);
  const url = `https://nsearchives.nseindia.com/content/trdops/FNO_BC${ddmmyyyy}.DAT`;

  console.log(`   [NSE] Trying direct (no session): FNO_BC${ddmmyyyy}.DAT`);

  let buf;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA },
    });

    if (res.status !== 200) {
      // Retry with previous trading day (bhavcopy might not be published yet for today)
      console.warn(`   [NSE] ⚠️ HTTP ${res.status} for FNO_BC${ddmmyyyy}.DAT — retrying previous trading day...`);
      nseDate.setDate(nseDate.getDate() - 1);
      if (nseDate.getDay() === 0) nseDate.setDate(nseDate.getDate() - 2);
      if (nseDate.getDay() === 6) nseDate.setDate(nseDate.getDate() - 1);
      const retryParts = dateParts(nseDate);
      const retryUrl = `https://nsearchives.nseindia.com/content/trdops/FNO_BC${retryParts.ddmmyyyy}.DAT`;
      console.log(`   [NSE] Retrying: FNO_BC${retryParts.ddmmyyyy}.DAT`);
      try {
        const retryRes = await axios.get(retryUrl, {
          responseType: 'arraybuffer', timeout: 60000,
          validateStatus: () => true, headers: { 'User-Agent': BROWSER_UA },
        });
        if (retryRes.status !== 200) {
          console.warn(`   [NSE] ⚠️ Retry also failed (HTTP ${retryRes.status}). No NSE data.`);
          return { matched: 0, unmatched: 0 };
        }
        buf = Buffer.from(retryRes.data);
        console.log(`   [NSE] ✅ Retry succeeded with ${dateToDashed(nseDate)}: ${(buf.length / 1024).toFixed(1)} KB.`);
      } catch (retryErr) {
        console.warn(`   [NSE] ⚠️ Retry download failed: ${retryErr.message}`);
        return { matched: 0, unmatched: 0 };
      }
    } else {
      buf = Buffer.from(res.data);
    }
    if (buf.length < 500) {
      console.warn(`   [NSE] ⚠️ Response too small (${buf.length}B).`);
      return { matched: 0, unmatched: 0 };
    }

    const preview = buf.toString('utf8', 0, 80);
    if (preview.startsWith('<!') || preview.startsWith('<html')) {
      console.warn(`   [NSE] ⚠️ Got HTML instead of data.`);
      return { matched: 0, unmatched: 0 };
    }

    console.log(`   [NSE] ✅ ${(buf.length / 1024).toFixed(1)} KB downloaded.`);
  } catch (e) {
    console.warn(`   [NSE] ⚠️ Download failed: ${e.message}`);
    return { matched: 0, unmatched: 0 };
  }

  // Parse the DAT file
  const csvText = buf.toString('utf8');
  const bhavMap = parseNseDatFile(csvText);
  console.log(`   [NSE] Parsed ${bhavMap.size} entries.`);

  const nfoInstruments = instruments.filter(i => i.exchange === 'NFO' || (i.exchange === 'NSE' && i.instrument_type));
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

/**
 * Parse FNO_BC DAT file from NSE (comma-delimited, no header row)
 * Fields: [0]TradingSymbol, [1]InstrumentType, [2]Underlying, [3]Expiry(DDMMYYYY),
 *         [4]StrikePrice, [5]OptionType, [6-8]flags, [9]PrevSettle,
 *         [10]Open, [11]High, [12]Low, [13]Close(=today's settlement)
 */
function parseNseDatFile(text) {
  const lines = text.trim().split('\n');
  const map = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 50) continue;

    const c = line.split(',').map(s => s.trim());
    if (c.length < 14) continue;

    const instrument = c[1]; // FUTSTK, FUTIDX, OPTSTK, OPTIDX
    const underlying = c[2].trim().toUpperCase();
    const expiryRaw = c[3]; // DDMMYYYY
    const strikePr = parseFloat(c[4]) || 0;
    const optType = c[5].trim(); // CE, PE, or empty
    const open = parseFloat(c[10]) || 0;
    const high = parseFloat(c[11]) || 0;
    const low = parseFloat(c[12]) || 0;
    const close = parseFloat(c[13]) || 0;
    const settlePr = close; // Close = today's settlement price

    if (!underlying || !expiryRaw || settlePr <= 0) continue;
    if (!instrument) continue;

    // Convert DDMMYYYY → YYYYMMDD
    let expiryNorm = null;
    if (/^\d{8}$/.test(expiryRaw)) {
      const dd = expiryRaw.substring(0, 2);
      const mm = expiryRaw.substring(2, 4);
      const yyyy = expiryRaw.substring(4, 8);
      expiryNorm = `${yyyy}${mm}${dd}`;
    }
    if (!expiryNorm) continue;

    let instType;
    if (instrument.includes('FUT')) instType = 'FUT';
    else if (optType === 'CE') instType = 'CE';
    else if (optType === 'PE') instType = 'PE';
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    const key = `${underlying}|${expiryNorm}|${strike}|${instType}`;
    map.set(key, { open, high, low, close, settle_pr: settlePr });
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// MCX — Samco via pwsh
// ═══════════════════════════════════════════════════════════════════════════

async function fetchMcxBhavcopy(date, instruments, closePriceMap) {
  // MCX market closes at 11:30 PM IST. Bhavcopy available next day.
  // Always fetch previous trading day's data.
  const mcxDate = new Date(date);
  mcxDate.setDate(mcxDate.getDate() - 1);
  if (mcxDate.getDay() === 0) mcxDate.setDate(mcxDate.getDate() - 2); // Sun → Fri
  if (mcxDate.getDay() === 6) mcxDate.setDate(mcxDate.getDate() - 1); // Sat → Fri

  console.log(`   [MCX] Fetching MCX settlement prices for ${dateToDashed(mcxDate)} (previous trading day)...`);

  let csvText = null;

  // Strategy 1: Puppeteer (headless browser) — MCX blocks direct HTTP requests
  try {
    csvText = await fetchMcxViaPuppeteer(mcxDate);
  } catch (e) {
    console.warn(`   [MCX] Puppeteer approach failed: ${e.message}`);
  }

  // Strategy 2: Samco fallback (legacy, may not work for all dates)
  if (!csvText) {
    try {
      const samcoBuf = await downloadMcxSamco(mcxDate);
      if (samcoBuf && samcoBuf.length > 100) {
        const text = samcoBuf.toString('utf8');
        if (!text.startsWith('<!') && !text.startsWith('<html')) {
          csvText = text;
          console.log(`   [MCX] ✅ Samco fallback succeeded.`);
        }
      }
    } catch (e) {
      console.warn(`   [MCX] Samco fallback also failed: ${e.message}`);
    }
  }

  if (!csvText || csvText.length < 200) {
    console.warn(`   [MCX] ⚠️ No MCX data available from any source.`);
    return { matched: 0 };
  }

  // Parse the CSV (same format whether from Puppeteer or Samco)
  const mcxMap = parseMcxBhavcopyCSV(csvText);
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
      closePriceMap[t] = data.close;
      bulkOps.push({
        updateOne: {
          filter: { instrument_token: t },
          update: { $set: {
            last_price: data.close,
            ohlc_open: data.open || 0,
            ohlc_high: data.high || 0,
            ohlc_low: data.low || 0,
            ohlc_close: data.close,
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

/**
 * Fetch MCX bhavcopy CSV via Puppeteer headless browser.
 * MCX India (mcxindia.com) blocks all direct HTTP requests via Akamai CDN.
 * This uses puppeteer-extra with stealth plugin to bypass it, then intercepts
 * the CSV blob generated when clicking the "Download CSV" button.
 */
async function fetchMcxViaPuppeteer(mcxDate) {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const dd = pad(mcxDate.getDate());
  const mm = pad(mcxDate.getMonth() + 1);
  const yyyy = mcxDate.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;

  console.log(`   [MCX] Launching Puppeteer for mcxindia.com (date: ${dateStr})...`);

  // Auto-detect Chrome executable path for different environments
  const { execSync } = require('child_process');
  let executablePath = undefined; // let Puppeteer use bundled Chromium by default
  try {
    // macOS: use system Chrome if bundled Chromium doesn't work
    if (process.platform === 'darwin') {
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (require('fs').existsSync(chromePath)) executablePath = chromePath;
    }
    // Linux: try google-chrome or chromium-browser
    if (process.platform === 'linux') {
      try { executablePath = execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf8', timeout: 5000 }).trim(); } catch (_) {}
    }
  } catch (_) {}

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

  let csvText = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto('https://www.mcxindia.com/market-data/BhavCopy', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Check for Akamai block
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 100));
    if (bodyText.includes('Access Denied') || bodyText.includes('403')) {
      throw new Error('Blocked by Akamai CDN');
    }

    // Wait for date input
    await page.waitForSelector('#bhavCopyDateWise', { timeout: 15000 });

    // Set the target date
    await page.evaluate((d) => {
      const input = document.getElementById('bhavCopyDateWise');
      if (input) { input.value = d; input.dispatchEvent(new Event('change', { bubbles: true })); }
      const hdn = document.getElementById('hdnUCDate');
      if (hdn) hdn.value = d;
    }, dateStr);

    // Wait for page to load data for the new date
    await new Promise(r => setTimeout(r, 3000));

    // Inject blob interceptors BEFORE clicking download
    await page.evaluate(() => {
      window.__mcxCsvData = null;
      window.__mcxCsvReady = false;

      const origCreateElement = document.createElement.bind(document);
      document.createElement = function(tagName) {
        const el = origCreateElement(tagName);
        if (tagName.toLowerCase() === 'a') {
          const origClick = el.click.bind(el);
          el.click = function() {
            if (el.href && el.href.startsWith('blob:')) {
              fetch(el.href).then(r => r.text()).then(text => {
                window.__mcxCsvData = text;
                window.__mcxCsvReady = true;
              }).catch(() => origClick());
            } else { origClick(); }
          };
        }
        return el;
      };

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

    // Click CSV download button
    const csvBtn = await page.$('#btnDateWiseCSV');
    if (!csvBtn) throw new Error('CSV button #btnDateWiseCSV not found');

    await csvBtn.click();

    // Wait for blob capture (up to 20 seconds)
    for (let i = 0; i < 40; i++) {
      const ready = await page.evaluate(() => window.__mcxCsvReady === true);
      if (ready) break;
      await new Promise(r => setTimeout(r, 500));
    }

    csvText = await page.evaluate(() => window.__mcxCsvData);
    if (csvText && csvText.length > 100) {
      console.log(`   [MCX] ✅ Puppeteer captured ${(csvText.length / 1024).toFixed(1)} KB CSV.`);
    } else {
      csvText = null;
      console.log(`   [MCX] ⚠️ Puppeteer blob capture returned empty/null.`);
    }

  } finally {
    await browser.close();
  }

  return csvText;
}

/**
 * Parse MCX bhavcopy CSV from mcxindia.com format.
 * Headers: Date, Instrument Name, Symbol, Expiry Date, Option Type, Strike Price,
 *          Open, High, Low, Close, Previous Close, Volume(Lots), ...
 * Returns Map<matchKey, { open, high, low, close }>
 */
function parseMcxBhavcopyCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();

  // First line is the header
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const col = {};
  headers.forEach((h, i) => { col[h.toLowerCase()] = i; });

  // Map header names (MCX uses these column names)
  const iSymbol = col['symbol'] ?? col['Symbol'];
  const iExpiry = col['expiry date'] ?? col['Expiry Date'] ?? col['expiry'];
  const iOptType = col['option type'] ?? col['Option Type'] ?? col['optiontype'];
  const iStrike = col['strike price'] ?? col['Strike Price'] ?? col['strikeprice'];
  const iOpen = col['open'] ?? col['Open'];
  const iHigh = col['high'] ?? col['High'];
  const iLow = col['low'] ?? col['Low'];
  const iClose = col['close'] ?? col['Close'];
  const iInstName = col['instrument name'] ?? col['Instrument Name'] ?? col['instrumentname'];

  const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(s => s.trim().replace(/"/g, '').trim());
    if (c.length < 10) continue;

    const symbol = (c[iSymbol] || '').trim().toUpperCase();
    const expiryRaw = (c[iExpiry] || '').trim(); // DDMMMYYYY like 31JUL2026
    const optType = (c[iOptType] || '').trim();
    const strikePr = parseFloat(c[iStrike]) || 0;
    const open = parseFloat(c[iOpen]) || 0;
    const high = parseFloat(c[iHigh]) || 0;
    const low = parseFloat(c[iLow]) || 0;
    const close = parseFloat(c[iClose]) || 0;
    const instName = (c[iInstName] || '').trim();

    if (!symbol || close <= 0) continue;

    // Parse expiry: "31JUL2026" → "20260731"
    let expiryNorm = null;
    const expiryMatch = expiryRaw.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
    if (expiryMatch) {
      const [, day, mon, year] = expiryMatch;
      const mm = MONTHS[mon.charAt(0).toUpperCase() + mon.slice(1).toLowerCase()];
      if (mm) expiryNorm = `${year}${mm}${day}`;
    }
    if (!expiryNorm) continue;

    // Determine instrument type
    let instType;
    if (instName.startsWith('FUT') || instName.includes('FUT')) instType = 'FUT';
    else if (optType === 'CE') instType = 'CE';
    else if (optType === 'PE') instType = 'PE';
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    const key = `${symbol}|${expiryNorm}|${strike}|${instType}`;
    map.set(key, { open, high, low, close });
  }

  return map;
}

async function downloadMcxSamco(date) {
  // Legacy Samco fallback — may not work for all dates.
  const { execSync } = require('child_process');
  let shell = null;
  try { execSync('pwsh -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'pwsh'; } catch (_) {
    try { execSync('powershell -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'powershell'; } catch (__) {}
  }
  if (!shell) return null;

  const yyyymmdd = dateToYYYYMMDD(date);
  const dd = dateToDashed(date);
  const filePath = `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dd}/${yyyymmdd}_MCX.csv`;
  const b64 = Buffer.from(filePath).toString('base64').replace(/=+$/, '');
  const dataUrl = `https://www.samco.in/bse_nse_mcx/datacopy/${b64}`;
  const outPath = path.join(TMP_DIR, `samco_MCX_${yyyymmdd}.csv`);

  ensureTmpDir();
  const psScript = path.join(TMP_DIR, `samco_dl_MCX_${Date.now()}.ps1`);
  const urlFile = path.join(TMP_DIR, `samco_url_MCX_${Date.now()}.txt`);
  fs.writeFileSync(urlFile, dataUrl, 'utf8');
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
    if (buf.length > 100) return buf;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndApplyBhavcopy(targetDate) {
  // Use IST date regardless of server timezone
  let date;
  if (targetDate) {
    date = new Date(targetDate);
  } else {
    const now = new Date();
    const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const istDate = new Date(istString);
    date = new Date(istDate.getFullYear(), istDate.getMonth(), istDate.getDate());
  }

  // Auto-rollback to the LAST TRADING DAY if today is a weekend.
  // Bhavcopy is only published for trading days (Mon-Fri).
  // If admin didn't pass a specific date, always use the most recent trading day.
  if (date.getDay() === 0) date.setDate(date.getDate() - 2);      // Sunday → Friday
  else if (date.getDay() === 6) date.setDate(date.getDate() - 1); // Saturday → Friday

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  console.log(`📊 [Bhavcopy] Fetching settlement prices for ${dateToDashed(date)} (${dayNames[date.getDay()]})...`);

  const allInstruments = await KiteInstrument.find({
    is_active: true,
    instrument_token: { $not: /^9999/ },
    deleted_at: null,
  }).select('instrument_token name raw_name expiry strike instrument_type exchange segment').lean();
  console.log(`   📊 ${allInstruments.length} active instruments in DB.`);

  const closePriceMap = {};

  // 1. NSE F&O
  const nseResult = await fetchNseBhavcopy(date, allInstruments, closePriceMap);

  // 2. MCX (previous day)
  const mcxResult = await fetchMcxBhavcopy(date, allInstruments, closePriceMap);

  const total = Object.keys(closePriceMap).length;
  console.log(`   ✅ Total: ${total} prices (NSE: ${nseResult.matched}, MCX: ${mcxResult.matched})`);

  // Broadcast settlement prices to connected Flutter clients (watchlist only)
  if (total > 0) {
    try {
      const livePriceService = require('./livePriceService');
      if (livePriceService && livePriceService._broadcastToClients) {
        // Update settlement prices map and latestPrices for watchlist display
        if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();

        const ticks = [];
        for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
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

  return { closePriceMap, nseMatched: nseResult.matched, mcxMatched: mcxResult.matched };
}

module.exports = { fetchAndApplyBhavcopy };
