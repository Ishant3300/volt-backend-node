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
  const dow = date.getDay();
  if (dow === 0 || dow === 6) {
    console.log(`   [NSE] ${dateToDashed(date)} is a weekend — skipping.`);
    return { matched: 0, unmatched: 0 };
  }

  console.log(`   [NSE] Fetching NSE F&O bhavcopy for ${dateToDashed(date)}...`);

  const { ddmmyyyy } = dateParts(date);
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
      console.warn(`   [NSE] ⚠️ HTTP ${res.status} — file not available yet.`);
      return { matched: 0, unmatched: 0 };
    }

    buf = Buffer.from(res.data);
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

  const csvBuf = await downloadMcxSamco(mcxDate);

  if (!csvBuf || csvBuf.length < 100) {
    console.warn(`   [MCX] ⚠️ No MCX data available.`);
    return { matched: 0 };
  }

  const csvText = csvBuf.toString('utf8');
  if (csvText.startsWith('<!') || csvText.startsWith('<html')) {
    console.warn(`   [MCX] ⚠️ Got HTML instead of CSV.`);
    return { matched: 0 };
  }

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

async function downloadMcxSamco(date) {
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
    console.log('   [MCX] No PowerShell available — skipping.');
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
  console.warn(`   [MCX] Samco download failed.`);
  return null;
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
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndApplyBhavcopy(targetDate) {
  // Use IST date regardless of server timezone
  let date;
  if (targetDate) {
    date = targetDate;
  } else {
    const now = new Date();
    const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const istDate = new Date(istString);
    date = new Date(istDate.getFullYear(), istDate.getMonth(), istDate.getDate());
  }

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

  // Broadcast settlement prices to connected Flutter clients
  if (total > 0) {
    try {
      const livePriceService = require('./livePriceService');
      if (livePriceService && livePriceService._broadcastToClients) {
        // Clear ALL stale live prices
        livePriceService.latestPrices.clear();
        if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();
        livePriceService._settlementPrices.clear();

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

        // Clear metricsEngine bid/ask/ltp maps and repopulate with settlement
        try {
          const metricsEngine = require('./metricsEngine');
          if (metricsEngine._bidMap) metricsEngine._bidMap.clear();
          if (metricsEngine._askMap) metricsEngine._askMap.clear();
          if (metricsEngine._ltpMap) metricsEngine._ltpMap.clear();
          for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
            metricsEngine._ltpMap.set(tokenStr, closePrice);
            metricsEngine._bidMap.set(tokenStr, closePrice);
            metricsEngine._askMap.set(tokenStr, closePrice);
          }
        } catch (_) {}

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
