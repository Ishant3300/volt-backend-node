/**
 * Bhavcopy Service
 *
 * Fetches official settlement/close prices from 3 sources:
 *   1. NSE F&O  → nsearchives.nseindia.com UDiFF bhavcopy (zip)
 *   2. MCX      → Samco MCX bhavcopy CSV (via session cookie)
 *   3. BSE      → Samco BSE bhavcopy CSV (via session cookie)
 *
 * Main entry: fetchAndApplyBhavcopy(targetDate?)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const KiteInstrument = require('../models/KiteInstrument');

const TMP_DIR = path.join(__dirname, '../../scripts/downloads');

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function dateToYYYYMMDD(d) {
  if (!d) return null;
  const dt = new Date(d);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
}

function dateToDashed(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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
// DOWNLOAD HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Download a URL using Node.js https (cross-platform, no PowerShell). */
function downloadUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...headers,
    };
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: defaultHeaders,
      timeout: 30000,
    };
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location, headers).then(resolve);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

/** Download NSE bhavcopy zip (direct HTTPS). */
async function downloadNseZip(url) {
  console.log(`   [NSE] Downloading via HTTPS...`);
  const buf = await downloadUrl(url);
  if (!buf || buf.length < 100) return null;
  // Check if it's a valid zip (PK header)
  if (buf.slice(0, 4).toString('hex') !== '504b0304') {
    console.warn(`   [NSE] Response is not a zip (${buf.length} bytes, starts with: ${buf.slice(0, 20).toString('utf8').substring(0, 50)})`);
    return null;
  }
  return buf;
}

/** Download from Samco using PowerShell Core (pwsh) — cross-platform. */
async function downloadFromSamco(date, type) {
  ensureTmpDir();
  const yyyymmdd = dateToYYYYMMDD(date);
  const dd = dateToDashed(date);
  const filePath = `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dd}/${yyyymmdd}_${type}.csv`;
  const b64 = Buffer.from(filePath).toString('base64').replace(/=+$/, '');
  const outPath = path.join(TMP_DIR, `samco_${type}_${yyyymmdd}.csv`);
  const dataUrl = `https://www.samco.in/bse_nse_mcx/datacopy/${b64}`;

  console.log(`   [${type}] Samco download via pwsh...`);

  // Detect pwsh vs powershell
  const { execSync } = require('child_process');
  let shell = 'pwsh';
  try { execSync('pwsh -Version', { stdio: 'pipe', timeout: 5000 }); } catch (_) {
    try { execSync('powershell -Version', { stdio: 'pipe', timeout: 5000 }); shell = 'powershell'; } catch (__) {
      console.warn(`   [${type}] Neither pwsh nor powershell found. Skipping Samco.`);
      return null;
    }
  }

  const urlFile = path.join(TMP_DIR, `samco_url_${type}_${Date.now()}.txt`);
  fs.writeFileSync(urlFile, dataUrl, 'utf8');

  const psScript = path.join(TMP_DIR, `samco_dl_${type}_${Date.now()}.ps1`);
  const ps = [
    '$session = $null',
    '$null = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15',
    `$dataUrl = (Get-Content "${urlFile}" -Raw).Trim()`,
    `Invoke-WebRequest -Uri $dataUrl -WebSession $session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -OutFile "${outPath}" -TimeoutSec 30`,
  ].join('\n');

  try {
    fs.writeFileSync(psScript, ps, 'utf8');
    execSync(`${shell} -ExecutionPolicy Bypass -File "${psScript}"`, { stdio: 'pipe', timeout: 60000 });
  } catch (e) {
    console.warn(`   [${type}] pwsh script error: ${e.message?.substring(0, 100)}`);
  }
  try { fs.unlinkSync(psScript); } catch (_) {}
  try { fs.unlinkSync(urlFile); } catch (_) {}

  if (fs.existsSync(outPath)) {
    const buf = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch (_) {}
    if (buf.length > 100) {
      console.log(`   [${type}] Downloaded ${buf.length} bytes via ${shell}.`);
      return buf;
    }
  }
  console.warn(`   [${type}] Samco download failed via ${shell}.`);
  return null;
}

/** @deprecated — kept for reference, Samco datacopy links are single-use */
function buildSamcoUrl(date, type) {
  const dd = dateToDashed(date);
  const yyyymmdd = dateToYYYYMMDD(date);
  const filePath = `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${dd}/${yyyymmdd}_${type}.csv`;
  return `https://www.samco.in/bse_nse_mcx/datacopy/${Buffer.from(filePath).toString('base64').replace(/=+$/, '')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. NSE F&O — from nsearchives.nseindia.com UDiFF
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch NSE F&O settlement prices from UDiFF bhavcopy.
 * Matches NFO/BFO instruments in DB by symbol+expiry+strike+type.
 * @returns {{ matched, unmatched, closePriceMap }}
 */
async function fetchNseBhavcopy(date, instruments, closePriceMap) {
  const yyyymmdd = dateToYYYYMMDD(date);
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const url = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${yyyymmdd}_F_0000.csv.zip`;
  console.log(`   [NSE] URL: ${url}`);

  ensureTmpDir();
  const zipBuf = await downloadNseZip(url);

  if (!zipBuf) {
    console.warn(`   [NSE] ⚠️ Download failed.`);
    return { matched: 0, unmatched: 0 };
  }

  // Extract CSV
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
  const nfoInstruments = instruments.filter(i => i.exchange === 'NFO' || i.exchange === 'BFO' || (i.exchange === 'NSE' && i.instrument_type));
  const bulkOps = [];
  let matched = 0, unmatched = 0;

  for (const inst of nfoInstruments) {
    const key = buildMatchKey(inst);
    if (!key) { unmatched++; continue; }
    const bhav = bhavMap.get(key);
    if (bhav) {
      const t = inst.instrument_token.toString();
      closePriceMap[t] = bhav.settle_pr;
      bulkOps.push({ updateOne: { filter: { instrument_token: t }, update: { $set: { last_price: bhav.settle_pr, ohlc_open: bhav.open, ohlc_high: bhav.high, ohlc_low: bhav.low, ohlc_close: bhav.settle_pr } } } });
      matched++;
    } else { unmatched++; }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [NSE] ✅ ${matched} matched, ${unmatched} unmatched.`);
  return { matched, unmatched };
}

function parseNseUdiffCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map(h => h.trim());
  const col = {}; headers.forEach((h, i) => { col[h] = i; });
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
// 2. MCX — from Samco MCX bhavcopy CSV
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch MCX settlement prices from Samco MCX bhavcopy.
 * @returns {{ matched }}
 */
async function fetchMcxBhavcopy(date, instruments, closePriceMap) {
  console.log(`   [MCX] Fetching from Samco...`);

  const csvBuf = await downloadFromSamco(date, 'MCX');
  
  // If Samco download succeeded, parse the CSV
  if (csvBuf && csvBuf.length > 100) {
    const csvText = csvBuf.toString('utf8');
    if (!csvText.startsWith('<!') && !csvText.startsWith('<html') && !csvText.includes('No file available')) {
      const mcxMap = parseSamcoMcxCSV(csvText);
      console.log(`   [MCX] Parsed ${mcxMap.size} entries from Samco.`);

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
          bulkOps.push({ updateOne: { filter: { instrument_token: t }, update: { $set: { last_price: data.settle_pr, ohlc_open: data.open, ohlc_high: data.high, ohlc_low: data.low, ohlc_close: data.settle_pr } } } });
          matched++;
        }
      }

      if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
      console.log(`   [MCX] ✅ ${matched} matched out of ${mcxInstruments.length} via Samco.`);
      return { matched };
    }
  }

  // Fallback: use Kite OHLC API for MCX instruments (same approach as BSE)
  console.log(`   [MCX] Samco failed — falling back to Kite OHLC API...`);
  const mcxInstruments = instruments.filter(i => i.exchange === 'MCX');
  if (mcxInstruments.length === 0) return { matched: 0 };

  const kiteService = require('./kiteService');
  const instDocs = await KiteInstrument.find({
    instrument_token: { $in: mcxInstruments.map(i => i.instrument_token.toString()) },
    is_active: true,
  }).select('instrument_token tradingsymbol exchange').lean();

  const keyToToken = new Map();
  const keys = instDocs.map(i => {
    const key = `${i.exchange}:${i.tradingsymbol.trim()}`;
    keyToToken.set(key, i.instrument_token.toString());
    return key;
  });

  const bulkOps = [];
  let matched = 0;
  const BATCH = 200;

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    try {
      const data = await kiteService.getMarketQuotes(batch, 'ohlc');
      for (const [instKey, quote] of Object.entries(data || {})) {
        const tokenStr = keyToToken.get(instKey);
        if (!tokenStr || !quote) continue;
        const ohlc = quote.ohlc || {};
        const close = ohlc.close;
        if (!close || close <= 0) continue;
        closePriceMap[tokenStr] = close;
        bulkOps.push({ updateOne: { filter: { instrument_token: tokenStr }, update: { $set: { last_price: close, ohlc_open: ohlc.open || 0, ohlc_high: ohlc.high || 0, ohlc_low: ohlc.low || 0, ohlc_close: close } } } });
        matched++;
      }
    } catch (err) {
      console.warn(`      MCX OHLC batch error: ${err.message}`);
    }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [MCX] ✅ ${matched} matched out of ${mcxInstruments.length} via Kite OHLC fallback.`);
  return { matched };
}

function parseSamcoMcxCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const col = {}; headers.forEach((h, i) => { col[h] = i; });
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
    map.set(`${symbol.toUpperCase()}|${expiryNorm}|${strike}|${instType}`, { open, high, low, close, settle_pr: close });
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. BSE — from Samco BSE bhavcopy CSV
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch BSE close prices from Samco BSE bhavcopy.
 * BSE CSV is equity (cash), columns: SC_CODE, SC_NAME, ..., OPEN, HIGH, LOW, CLOSE, ...
 * We match by SC_NAME against KiteInstrument.raw_name for BFO instruments.
 * @returns {{ matched }}
 */
async function fetchBseBhavcopy(date, instruments, closePriceMap) {
  // BSE derivatives (SENSEX FUT/OPT) are not available in any free bhavcopy CSV.
  // Samco BSE CSV is equity cash only. Use Kite OHLC API (batch of 200) instead.
  const bfoInstruments = instruments.filter(i => i.exchange === 'BFO');
  if (bfoInstruments.length === 0) {
    console.log(`   [BSE] No BFO instruments in DB.`);
    return { matched: 0 };
  }

  console.log(`   [BSE] Fetching ${bfoInstruments.length} BFO instruments via Kite OHLC API...`);

  const kiteService = require('./kiteService');
  const instDocs = await KiteInstrument.find({
    instrument_token: { $in: bfoInstruments.map(i => i.instrument_token.toString()) },
    is_active: true,
  }).select('instrument_token tradingsymbol exchange').lean();

  const keyToToken = new Map();
  const keys = instDocs.map(i => {
    const key = `${i.exchange}:${i.tradingsymbol.trim()}`;
    keyToToken.set(key, i.instrument_token.toString());
    return key;
  });

  const bulkOps = [];
  let matched = 0;
  const BATCH = 200;

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    try {
      const data = await kiteService.getMarketQuotes(batch, 'ohlc');
      for (const [instKey, quote] of Object.entries(data || {})) {
        const tokenStr = keyToToken.get(instKey);
        if (!tokenStr || !quote) continue;
        const ohlc = quote.ohlc || {};
        const close = ohlc.close;
        if (!close || close <= 0) continue;
        closePriceMap[tokenStr] = close;
        bulkOps.push({ updateOne: { filter: { instrument_token: tokenStr }, update: { $set: { last_price: close, ohlc_open: ohlc.open || 0, ohlc_high: ohlc.high || 0, ohlc_low: ohlc.low || 0, ohlc_close: close } } } });
        matched++;
      }
    } catch (err) {
      console.warn(`      BSE OHLC batch error: ${err.message}`);
    }
  }

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [BSE] ✅ ${matched} matched out of ${bfoInstruments.length} via Kite OHLC.`);
  return { matched };
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
 * @returns {{ closePriceMap, nseMatched, mcxMatched, bseMatched, unmatched }}
 */
async function fetchAndApplyBhavcopy(targetDate) {
  const date = targetDate || getLastFriday();
  console.log(`📊 [Bhavcopy] Fetching settlement prices for ${dateToDashed(date)} (Friday)...`);

  // Load all active instruments from DB
  const allInstruments = await KiteInstrument.find({
    is_active: true, instrument_token: { $not: /^9999/ }, deleted_at: null,
  }).select('instrument_token name raw_name expiry strike instrument_type exchange segment').lean();
  console.log(`   📊 ${allInstruments.length} active instruments in DB.`);

  const closePriceMap = {};

  // 1. NSE F&O
  const nseResult = await fetchNseBhavcopy(date, allInstruments, closePriceMap);

  // 2. MCX
  const mcxResult = await fetchMcxBhavcopy(date, allInstruments, closePriceMap);

  // 3. BSE
  const bseResult = await fetchBseBhavcopy(date, allInstruments, closePriceMap);

  const total = Object.keys(closePriceMap).length;
  console.log(`   ✅ Total: ${total} prices (NSE: ${nseResult.matched}, MCX: ${mcxResult.matched}, BSE: ${bseResult.matched})`);

  // Broadcast settlement prices to all connected Flutter clients via WebSocket
  // During closed market hours, this makes watchlist show the close price as bid/ask
  if (total > 0) {
    try {
      const livePriceService = require('./livePriceService');
      const metricsEngine = require('./metricsEngine');

      const ticks = [];
      for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
        // Update in-memory price maps so metricsEngine uses settlement prices
        livePriceService.latestPrices.set(tokenStr, closePrice);
        livePriceService.latestPrices.set(parseInt(tokenStr), closePrice);

        // Update metricsEngine LTP, bid, ask maps with settlement price
        metricsEngine._ltpMap?.set(tokenStr, closePrice);
        metricsEngine._bidMap?.set(tokenStr, closePrice);
        metricsEngine._askMap?.set(tokenStr, closePrice);

        ticks.push({
          instrument_token: tokenStr,
          last_price: closePrice,
          bid_price: closePrice,
          ask_price: closePrice,
          close: closePrice,
        });
      }

      // Broadcast to all Flutter clients
      if (ticks.length > 0) {
        livePriceService._broadcastToClients({ type: 'ticks', data: ticks });
        console.log(`   📡 Broadcast ${ticks.length} settlement prices to Flutter clients.`);
      }
    } catch (e) {
      console.warn(`   ⚠️ Broadcast error: ${e.message}`);
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
