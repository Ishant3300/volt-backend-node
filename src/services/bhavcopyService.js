/**
 * Bhavcopy Service — Simplified
 *
 * Fetches official settlement/close prices:
 *   1. NSE F&O → Direct download from nsearchives.nseindia.com/content/trdops/FNO_BC{DDMMYYYY}.DAT
 *   2. MCX     → Official mcxindia.com BhavCopy download via headless browser
 *
 * Main entry: fetchAndApplyBhavcopy(targetDate?)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const KiteInstrument = require('../models/KiteInstrument');
const {
  dateKey,
  previousTradingDay,
  resolveBhavcopyTradingDates,
  toIndiaDateOnly,
} = require('../utils/settlementDates');

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
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

function dateToDashed(d) {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function dateParts(d) {
  return {
    dd: pad(d.getUTCDate()),
    mm: pad(d.getUTCMonth() + 1),
    yyyy: String(d.getUTCFullYear()),
    yyyymmdd: dateToYYYYMMDD(d),
    ddmmyyyy: `${pad(d.getUTCDate())}${pad(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`,
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

function buildNseSettlementOperations(
  nseDate,
  instruments,
  bhavMap,
  closePriceMap,
  updatedAt = new Date()
) {
  const nfoInstruments = instruments.filter(instrument =>
    instrument.exchange === 'NFO' || (instrument.exchange === 'NSE' && instrument.instrument_type)
  );
  const bulkOps = [];
  let matched = 0;
  let unmatched = 0;

  for (const instrument of nfoInstruments) {
    const key = buildMatchKey(instrument);
    if (!key) {
      unmatched++;
      continue;
    }
    const bhav = bhavMap.get(key);
    if (!bhav) {
      unmatched++;
      continue;
    }

    const token = instrument.instrument_token.toString();
    // bhav.settle_pr IS bhav.close now (parseNseDatFile sets both from field
    // 13) — a prior version sourced this from field 25 believing it was the
    // official settlement price; confirmed via a real downloaded file that
    // field 25 is actually the day's last traded price (0 for an illiquid
    // contract with no trades, unlike field 13 which is always populated),
    // and that field 13 matches the real, independently-verified settlement
    // price. See parseNseDatFile's own comment for the full confirmation.
    closePriceMap[token] = bhav.settle_pr;
    const settlementFields = {
      settlement_price: bhav.settle_pr,
      settlement_price_date: new Date(nseDate),
      settlement_price_source: 'NSE_OFFICIAL_BHAVCOPY_SETTLEMENT',
      settlement_price_updated_at: updatedAt,
      ohlc_open: bhav.open,
      ohlc_high: bhav.high,
      ohlc_low: bhav.low,
      ohlc_close: bhav.settle_pr,
    };
    bulkOps.push({
      updateOne: {
        filter: { instrument_token: token },
        update: { $set: settlementFields },
      },
    });
    matched++;
  }

  return { bulkOps, matched, unmatched };
}

// ═══════════════════════════════════════════════════════════════════════════
// NSE — Direct download (no session needed)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchNseBhavcopy(date, instruments, closePriceMap, options = {}) {
  let nseDate = new Date(date);

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
      if (!options.allowPreviousDayFallback) {
        console.warn(`   [NSE] HTTP ${res.status} for exact target ${dateToDashed(nseDate)}. No fallback allowed.`);
        return { matched: 0, unmatched: 0, tradingDate: dateKey(nseDate) };
      }

      console.warn(`   [NSE] HTTP ${res.status} for FNO_BC${ddmmyyyy}.DAT — retrying previous trading day...`);
      nseDate = previousTradingDay(nseDate);
      const retryParts = dateParts(nseDate);
      const retryUrl = `https://nsearchives.nseindia.com/content/trdops/FNO_BC${retryParts.ddmmyyyy}.DAT`;
      console.log(`   [NSE] Retrying: FNO_BC${retryParts.ddmmyyyy}.DAT`);
      try {
        const retryRes = await axios.get(retryUrl, {
          responseType: 'arraybuffer', timeout: 60000,
          validateStatus: () => true, headers: { 'User-Agent': BROWSER_UA },
        });
        if (retryRes.status !== 200) {
          console.warn(`   [NSE] Retry also failed (HTTP ${retryRes.status}). No NSE data.`);
          return { matched: 0, unmatched: 0, tradingDate: dateKey(nseDate) };
        }
        buf = Buffer.from(retryRes.data);
        console.log(`   [NSE] Retry succeeded with ${dateToDashed(nseDate)}: ${(buf.length / 1024).toFixed(1)} KB.`);
      } catch (retryErr) {
        console.warn(`   [NSE] Retry download failed: ${retryErr.message}`);
        return { matched: 0, unmatched: 0, tradingDate: dateKey(nseDate) };
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

  const requestedDate = dateKey(nseDate);
  const sourceDates = bhavMap.sourceDates || new Set();
  if (sourceDates.size !== 1 || !sourceDates.has(requestedDate)) {
    console.warn(`   [NSE] Rejected bhavcopy: requested ${requestedDate}, source dates: ${[...sourceDates].join(', ') || 'missing'}.`);
    return {
      matched: 0,
      unmatched: 0,
      tradingDate: requestedDate,
      rejectedSourceDate: true,
      sourceDates: [...sourceDates],
    };
  }

  const { bulkOps, matched, unmatched } = buildNseSettlementOperations(
    nseDate,
    instruments,
    bhavMap,
    closePriceMap,
    new Date()
  );

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [NSE] ✅ ${matched} matched, ${unmatched} unmatched.`);
  return { matched, unmatched, tradingDate: dateKey(nseDate) };
}

/**
 * Parse FNO_BC DAT file from NSE (comma-delimited, no header row)
 * Fields: [0]TradingSymbol, [1]InstrumentType, [2]Underlying, [3]Expiry(DDMMYYYY),
 *         [4]StrikePrice, [5]OptionType, [6-8]flags, [9]PrevSettle,
 *         [10]Open, [11]High, [12]Low, [13]Close(=today's settlement)
 */
function parseNseSourceDate(rawValue) {
  const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const match = /^(\d{1,2})[\/-]([A-Z]{3})[\/-](\d{4})$/.exec(String(rawValue || '').trim().toUpperCase());
  if (!match || !months[match[2]]) return null;
  return `${match[3]}-${months[match[2]]}-${String(match[1]).padStart(2, '0')}`;
}

function parseNseDatFile(text) {
  const lines = text.trim().split('\n');
  const map = new Map();
  const sourceDates = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 50) continue;

    const c = line.split(',').map(s => s.trim());
    // FNO_BC layout: close (the real official settlement price) is field 13,
    // source trading date is field 21. Field 25 was previously (wrongly)
    // treated as "the official settlement price" — confirmed against a real
    // downloaded file this was actually the day's LAST TRADED PRICE, not the
    // settlement price: for an illiquid contract with zero trades that day,
    // field 25 is 0 (nothing traded) while field 13 still holds a real
    // theoretical closing/settlement value, exactly the pattern of an LTP
    // field vs. an always-populated settlement price. A real comparison also
    // confirmed field 13 matches the actual, independently-verified official
    // settlement price (e.g. COLPAL26AUGFUT: field 13 = 1892.50, the
    // confirmed-correct value; field 25 = 1895.50, the day's LTP).
    if (c.length < 26) continue;

    const instrument = c[1]; // FUTSTK, FUTIDX, OPTSTK, OPTIDX
    const underlying = c[2].trim().toUpperCase();
    const expiryRaw = c[3]; // DDMMYYYY
    const strikePr = parseFloat(c[4]) || 0;
    const optType = c[5].trim(); // CE, PE, or empty
    const open = parseFloat(c[10]) || 0;
    const high = parseFloat(c[11]) || 0;
    const low = parseFloat(c[12]) || 0;
    const close = parseFloat(c[13]) || 0;
    const sourceDate = parseNseSourceDate(c[21]);
    if (sourceDate) sourceDates.add(sourceDate);

    if (!underlying || !expiryRaw || close <= 0 || !sourceDate) continue;
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
    map.set(key, { open, high, low, close, settle_pr: close, sourceDate });
  }
  map.sourceDates = sourceDates;
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// BSE F&O — official bseindia.com UDiFF BhavCopy (direct download, no session)
// ═══════════════════════════════════════════════════════════════════════════

function buildBseSettlementOperations(
  bseDate,
  instruments,
  bhavMap,
  closePriceMap,
  updatedAt = new Date()
) {
  const bfoInstruments = instruments.filter(instrument =>
    instrument.exchange === 'BFO' || (instrument.exchange === 'BSE' && instrument.instrument_type)
  );
  const bulkOps = [];
  let matched = 0;
  let unmatched = 0;

  for (const instrument of bfoInstruments) {
    const key = buildMatchKey(instrument);
    if (!key) {
      unmatched++;
      continue;
    }
    const bhav = bhavMap.get(key);
    if (!bhav) {
      unmatched++;
      continue;
    }

    const token = instrument.instrument_token.toString();
    closePriceMap[token] = bhav.settle_pr;
    const settlementFields = {
      settlement_price: bhav.settle_pr,
      settlement_price_date: new Date(bseDate),
      settlement_price_source: 'BSE_OFFICIAL_BHAVCOPY_SETTLEMENT',
      settlement_price_updated_at: updatedAt,
      ohlc_open: bhav.open,
      ohlc_high: bhav.high,
      ohlc_low: bhav.low,
      ohlc_close: bhav.settle_pr,
    };
    bulkOps.push({
      updateOne: {
        filter: { instrument_token: token },
        update: { $set: settlementFields },
      },
    });
    matched++;
  }

  return { bulkOps, matched, unmatched };
}

/**
 * Parse BSE's UDiFF derivatives BhavCopy CSV (header row present, confirmed
 * against a real downloaded file). Relevant columns:
 *   TradDt (YYYY-MM-DD, the file's own trading date — validated the same way
 *   NSE's source date is), TckrSymb (underlying, e.g. "SENSEX"), XpryDt
 *   (YYYY-MM-DD), StrkPric (blank for a FUT row), OptnTp ("CE"/"PE", blank
 *   for FUT), OpnPric/HghPric/LwPric, SttlmPric (the official settlement
 *   price — NOT ClsPric, same open/settlement distinction NSE's own file
 *   makes between field 13 and field 25).
 */
function parseBseBhavcopyCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return new Map();

  const header = parseCsvLine(lines[0]).map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const iSymb = idx('TckrSymb');
  const iExpiry = idx('XpryDt');
  const iStrike = idx('StrkPric');
  const iOptType = idx('OptnTp');
  const iOpen = idx('OpnPric');
  const iHigh = idx('HghPric');
  const iLow = idx('LwPric');
  const iSettle = idx('SttlmPric');
  const iTradDt = idx('TradDt');

  const map = new Map();
  const sourceDates = new Set();
  if ([iSymb, iExpiry, iSettle, iTradDt].some(i => i === -1)) {
    // Header shape changed from the confirmed real format — fail closed
    // rather than silently parsing the wrong columns.
    return map;
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < header.length) continue;

    const underlying = (c[iSymb] || '').trim().toUpperCase();
    const expiryRaw = (c[iExpiry] || '').trim();
    const strikePr = parseFloat(c[iStrike]) || 0;
    const optType = (c[iOptType] || '').trim().toUpperCase();
    const open = parseFloat(c[iOpen]) || 0;
    const high = parseFloat(c[iHigh]) || 0;
    const low = parseFloat(c[iLow]) || 0;
    const settlePr = parseFloat(c[iSettle]) || 0;
    const tradDt = (c[iTradDt] || '').trim();

    if (tradDt) sourceDates.add(tradDt);
    if (!underlying || !expiryRaw || settlePr <= 0 || !tradDt) continue;

    // XpryDt is already YYYY-MM-DD — strip dashes to match buildMatchKey's
    // YYYYMMDD convention.
    const expiryNorm = expiryRaw.replace(/-/g, '');
    if (!/^\d{8}$/.test(expiryNorm)) continue;

    let instType;
    if (optType === 'CE') instType = 'CE';
    else if (optType === 'PE') instType = 'PE';
    else if (!optType) instType = 'FUT'; // OptnTp blank on a FUT row
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    const key = `${underlying}|${expiryNorm}|${strike}|${instType}`;
    map.set(key, { open, high, low, settle_pr: settlePr, sourceDate: tradDt });
  }
  map.sourceDates = sourceDates;
  return map;
}

async function fetchBseBhavcopy(date, instruments, closePriceMap, options = {}) {
  const bseDate = new Date(date);
  console.log(`   [BSE] Fetching BSE F&O bhavcopy for ${dateToDashed(bseDate)}...`);

  const { yyyymmdd } = dateParts(bseDate);
  const url = `https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_${yyyymmdd}_F_0000.CSV`;

  let buf;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (res.status !== 200) {
      console.warn(`   [BSE] HTTP ${res.status} for ${dateToDashed(bseDate)}. No BSE data.`);
      return { matched: 0, unmatched: 0, tradingDate: dateKey(bseDate) };
    }
    buf = Buffer.from(res.data);
    if (buf.length < 200) {
      console.warn(`   [BSE] ⚠️ Response too small (${buf.length}B).`);
      return { matched: 0, unmatched: 0, tradingDate: dateKey(bseDate) };
    }
    const preview = buf.toString('utf8', 0, 80);
    if (preview.startsWith('<!') || preview.startsWith('<html')) {
      console.warn('   [BSE] ⚠️ Got HTML instead of data.');
      return { matched: 0, unmatched: 0, tradingDate: dateKey(bseDate) };
    }
    console.log(`   [BSE] ✅ ${(buf.length / 1024).toFixed(1)} KB downloaded.`);
  } catch (e) {
    console.warn(`   [BSE] ⚠️ Download failed: ${e.message}`);
    return { matched: 0, unmatched: 0, tradingDate: dateKey(bseDate) };
  }

  const bhavMap = parseBseBhavcopyCsv(buf.toString('utf8'));
  console.log(`   [BSE] Parsed ${bhavMap.size} entries.`);

  const requestedDate = dateKey(bseDate);
  const sourceDates = bhavMap.sourceDates || new Set();
  if (sourceDates.size !== 1 || !sourceDates.has(requestedDate)) {
    console.warn(`   [BSE] Rejected bhavcopy: requested ${requestedDate}, source dates: ${[...sourceDates].join(', ') || 'missing'}.`);
    return {
      matched: 0,
      unmatched: 0,
      tradingDate: requestedDate,
      rejectedSourceDate: true,
      sourceDates: [...sourceDates],
    };
  }

  const { bulkOps, matched, unmatched } = buildBseSettlementOperations(
    bseDate,
    instruments,
    bhavMap,
    closePriceMap,
    new Date()
  );

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [BSE] ✅ ${matched} matched, ${unmatched} unmatched.`);
  return { matched, unmatched, tradingDate: requestedDate };
}

// ═══════════════════════════════════════════════════════════════════════════
// MCX — official mcxindia.com BhavCopy
// ═══════════════════════════════════════════════════════════════════════════

function hasExactSourceDate(parsedMap, requestedDate) {
  const sourceDates = parsedMap?.sourceDates || new Set();
  return !parsedMap?.invalidSchema
    && sourceDates.size === 1
    && sourceDates.has(dateKey(requestedDate));
}

function buildMcxSettlementOperations(
  mcxDate,
  instruments,
  mcxMap,
  closePriceMap,
  updatedAt = new Date(),
  provenance = {}
) {
  const mcxInstruments = instruments.filter(instrument => instrument.exchange === 'MCX');
  const bulkOps = [];
  let matched = 0;

  // Parsing proves shape/date, not provenance. Only a CSV obtained directly
  // from MCX may populate fields consumed by financial settlement.
  if (provenance.provider !== 'MCX' || provenance.authority !== 'official') {
    return {
      bulkOps,
      matched,
      instrumentCount: mcxInstruments.length,
      rejectedAuthority: true,
    };
  }

  for (const instrument of mcxInstruments) {
    const key = buildMatchKey(instrument);
    if (!key || mcxMap.ambiguousKeys?.has(key)) continue;
    const data = mcxMap.get(key);
    if (!data) continue;

    const token = instrument.instrument_token.toString();
    const settlementPrice = data.settlementPrice;
    closePriceMap[token] = settlementPrice;
    const settlementFields = {
      settlement_price: settlementPrice,
      settlement_price_date: new Date(mcxDate),
      settlement_price_source: `MCX_OFFICIAL_BHAVCOPY_${mcxMap.priceField || 'CLOSE'}`,
      settlement_price_updated_at: updatedAt,
      ohlc_open: data.open || 0,
      ohlc_high: data.high || 0,
      ohlc_low: data.low || 0,
      ohlc_close: settlementPrice,
    };
    bulkOps.push({
      updateOne: {
        filter: { instrument_token: token },
        update: { $set: settlementFields },
      },
    });
    matched++;
  }

  return { bulkOps, matched, instrumentCount: mcxInstruments.length };
}

async function fetchMcxBhavcopy(date, instruments, closePriceMap, options = {}) {
  const mcxDate = new Date(date);
  console.log(`   [MCX] Fetching MCX settlement prices for exact trading date ${dateToDashed(mcxDate)}...`);

  let csvText = null;
  try {
    csvText = await fetchMcxViaPuppeteer(mcxDate);
  } catch (e) {
    console.warn(`   [MCX] Puppeteer approach failed: ${e.message}`);
  }

  const requestedDate = dateKey(mcxDate);
  if (!csvText || csvText.length < 200) {
    console.warn('   [MCX] ⚠️ Official MCX bhavcopy unavailable; financial settlement remains blocked.');
    return {
      matched: 0,
      tradingDate: requestedDate,
      sourceAvailable: false,
      authoritative: false,
      source: 'MCX_OFFICIAL',
    };
  }

  const mcxMap = parseMcxBhavcopyCSV(csvText);
  console.log(`   [MCX] Parsed ${mcxMap.size} exact contract entries using ${mcxMap.priceField || 'unknown'} price field.`);

  const sourceDates = mcxMap.sourceDates || new Set();
  if (!hasExactSourceDate(mcxMap, mcxDate)) {
    console.warn(`   [MCX] Rejected bhavcopy: requested ${requestedDate}, source dates: ${[...sourceDates].join(', ') || 'missing'}.`);
    return {
      matched: 0,
      tradingDate: requestedDate,
      rejectedSourceDate: true,
      sourceDates: [...sourceDates],
    };
  }

  // Financial settlement requires exact symbol + expiry day + strike + type.
  // Instrument-master disagreement fails closed; no month-level fallback exists.
  const { bulkOps, matched, instrumentCount } = buildMcxSettlementOperations(
    mcxDate,
    instruments,
    mcxMap,
    closePriceMap,
    new Date(),
    {
      provider: 'MCX',
      authority: 'official',
      artifact: 'mcxindia.com/market-data/BhavCopy',
    }
  );

  if (bulkOps.length > 0) await KiteInstrument.bulkWrite(bulkOps, { ordered: false });
  console.log(`   [MCX] ✅ ${matched} exact matches out of ${instrumentCount}.`);
  return {
    matched,
    tradingDate: requestedDate,
    sourceAvailable: true,
    authoritative: true,
    source: 'MCX_OFFICIAL',
    ambiguousContracts: mcxMap.ambiguousKeys?.size || 0,
    priceField: mcxMap.priceField,
  };
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

  const dd = pad(mcxDate.getUTCDate());
  const mm = pad(mcxDate.getUTCMonth() + 1);
  const yyyy = mcxDate.getUTCFullYear();
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

function parseMcxSourceDate(rawValue) {
  const raw = String(rawValue || '').trim().replace(/"/g, '').toUpperCase();
  if (!raw) return null;
  const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

  let match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(raw);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(raw);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;

  match = /^(\d{2})[-\s]?([A-Z]{3})[-\s]?(\d{4})$/.exec(raw);
  if (match && months[match[2]]) return `${match[3]}-${months[match[2]]}-${match[1]}`;
  return null;
}

/**
 * Parse MCX bhavcopy CSV from mcxindia.com format.
 * Headers: Date, Instrument Name, Symbol, Expiry Date, Option Type, Strike Price,
 *          Open, High, Low, Close, Previous Close, Volume(Lots), ...
 * Returns Map<matchKey, { open, high, low, close }>
 */
function parseMcxBhavcopyCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return new Map();

  const normalizeHeader = value => String(value || '').trim().replace(/"/g, '').toLowerCase().replace(/[_\s]+/g, ' ');
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const col = {};
  headers.forEach((header, index) => { col[header] = index; });
  const column = (...names) => names.map(normalizeHeader).find(name => col[name] !== undefined);
  const indexOf = (...names) => {
    const name = column(...names);
    return name === undefined ? undefined : col[name];
  };

  const iDate = indexOf('date', 'trading date', 'trade date');
  const iSymbol = indexOf('symbol');
  const iExpiry = indexOf('expiry date', 'expiry');
  const iOptType = indexOf('option type', 'optiontype');
  const iStrike = indexOf('strike price', 'strikeprice');
  const iOpen = indexOf('open');
  const iHigh = indexOf('high');
  const iLow = indexOf('low');
  const iClose = indexOf('close', 'closing price');
  const iSettlement = indexOf('settlement price', 'settle price', 'settlementprice', 'settle pr');
  const iInstName = indexOf('instrument name', 'instrumentname');

  const required = [iDate, iSymbol, iExpiry, iOptType, iStrike, iOpen, iHigh, iLow, iClose, iInstName];
  if (required.some(index => index === undefined)) {
    const map = new Map();
    map.sourceDates = new Set();
    map.invalidSchema = true;
    return map;
  }

  const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const map = new Map();
  const sourceDates = new Set();
  const ambiguousKeys = new Set();

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]).map(value => value.trim());
    if (c.length < headers.length) continue;

    const sourceDate = parseMcxSourceDate(c[iDate]);
    if (sourceDate) sourceDates.add(sourceDate);

    const symbol = (c[iSymbol] || '').trim().toUpperCase();
    const expiryRaw = (c[iExpiry] || '').trim();
    const optType = (c[iOptType] || '').trim().toUpperCase();
    const strikePr = parseFloat(c[iStrike]) || 0;
    const open = parseFloat(c[iOpen]) || 0;
    const high = parseFloat(c[iHigh]) || 0;
    const low = parseFloat(c[iLow]) || 0;
    const close = parseFloat(c[iClose]) || 0;
    // The official MCX daily bhavcopy currently labels its daily settlement as
    // CLOSE. If a dedicated settlement column is present, it takes precedence.
    const settlementPrice = iSettlement === undefined ? close : (parseFloat(c[iSettlement]) || 0);
    const instName = (c[iInstName] || '').trim().toUpperCase();

    if (!sourceDate || !symbol || settlementPrice <= 0) continue;

    let expiryNorm = null;
    const expiryMatch = expiryRaw.toUpperCase().match(/^(\d{1,2})[-\s]?([A-Z]{3})[-\s]?(\d{4})$/);
    if (expiryMatch) {
      const [, rawDay, mon, year] = expiryMatch;
      const normalizedMonth = mon.charAt(0).toUpperCase() + mon.slice(1).toLowerCase();
      const mm = MONTHS[normalizedMonth];
      if (mm) expiryNorm = `${year}${mm}${String(rawDay).padStart(2, '0')}`;
    }
    if (!expiryNorm) continue;

    let instType;
    if (instName.includes('FUT')) instType = 'FUT';
    else if (optType === 'CE') instType = 'CE';
    else if (optType === 'PE') instType = 'PE';
    else continue;

    const strike = instType === 'FUT' ? '0' : String(Math.round(strikePr));
    const key = `${symbol}|${expiryNorm}|${strike}|${instType}`;
    const data = { open, high, low, close, settlementPrice, sourceDate };
    const existing = map.get(key);
    if (existing && Math.abs(existing.settlementPrice - settlementPrice) >= 0.005) {
      ambiguousKeys.add(key);
      map.delete(key);
      continue;
    }
    if (!ambiguousKeys.has(key)) map.set(key, data);
  }

  map.sourceDates = sourceDates;
  map.ambiguousKeys = ambiguousKeys;
  map.priceField = iSettlement === undefined ? 'CLOSE' : headers[iSettlement];
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndApplyBhavcopy(targetDate, options = {}) {
  const dates = options.exchangeDates
    ? {
      nseDate: toIndiaDateOnly(options.exchangeDates.nse),
      mcxDate: toIndiaDateOnly(options.exchangeDates.mcx),
      explicitTarget: true,
    }
    : resolveBhavcopyTradingDates(targetDate, options.now || new Date());
  console.log(`[Bhavcopy] NSE trading date ${dateKey(dates.nseDate)}; MCX trading date ${dateKey(dates.mcxDate)}.`);

  const allInstruments = await KiteInstrument.find({
    is_active: true,
    instrument_token: { $not: /^9999/ },
    deleted_at: null,
  }).select('instrument_token name raw_name expiry strike instrument_type exchange segment').lean();
  console.log(`   ${allInstruments.length} active instruments in DB.`);

  const closePriceMap = {};
  const applyToLivePrices = options.applyToLivePrices !== false;
  const nseFetcher = options._fetchNseBhavcopy || fetchNseBhavcopy;
  const mcxFetcher = options._fetchMcxBhavcopy || fetchMcxBhavcopy;
  // BSE follows the same trading calendar as NSE (identical holidays), so
  // there's no separate date-resolution path for it — reuse dates.nseDate.
  const bseFetcher = options._fetchBseBhavcopy || fetchBseBhavcopy;
  const nseResult = await nseFetcher(dates.nseDate, allInstruments, closePriceMap, {
    allowPreviousDayFallback: !dates.explicitTarget,
    applyToLivePrices,
  });
  const bseResult = await bseFetcher(dates.nseDate, allInstruments, closePriceMap, {
    applyToLivePrices,
  });
  const mcxResult = await mcxFetcher(dates.mcxDate, allInstruments, closePriceMap, {
    applyToLivePrices,
  });

  const total = Object.keys(closePriceMap).length;
  console.log(`   Total: ${total} prices (NSE: ${nseResult.matched}, BSE: ${bseResult.matched}, MCX: ${mcxResult.matched})`);

  if (total > 0 && applyToLivePrices) {
    try {
      const livePriceService = require('./livePriceService');
      if (livePriceService && livePriceService._broadcastToClients) {
        if (!livePriceService._settlementPrices) livePriceService._settlementPrices = new Map();

        // metricsEngine keeps its OWN price cache (_ltpMap/_bidMap/_askMap),
        // independent of livePriceService.latestPrices — it's what drives the
        // mobile app's live Position tab (getFreshMetrics/getCachedMetrics),
        // fed only by real Kite ticks via onTick(). Without this call, this
        // job updated the client's own tick cache (and therefore the Live
        // M2M PDF's "LIVE" row, reconstructed client-side from that cache)
        // with the official settlement price, but left metricsEngine frozen
        // on whatever the last live tick was before market close — the
        // Position tab and the PDF would silently show two different CMPs
        // for the same instrument after every close.
        const metricsEngine = require('./metricsEngine');

        const ticks = [];
        for (const [tokenStr, closePrice] of Object.entries(closePriceMap)) {
          livePriceService._settlementPrices.set(tokenStr, closePrice);
          livePriceService.latestPrices.set(tokenStr, closePrice);
          livePriceService.latestPrices.set(Number(tokenStr), closePrice);
          metricsEngine.onTick(tokenStr, closePrice, closePrice, closePrice);
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
          console.log(`   Broadcast ${ticks.length} settlement prices to Flutter clients.`);
        }
      }
    } catch (_) {
      console.log('   Broadcast skipped (standalone mode or no clients connected).');
    }
  }

  return {
    closePriceMap,
    nseMatched: nseResult.matched,
    bseMatched: bseResult.matched,
    mcxMatched: mcxResult.matched,
    nseTradingDate: nseResult.tradingDate || dateKey(dates.nseDate),
    bseTradingDate: bseResult.tradingDate || dateKey(dates.nseDate),
    mcxTradingDate: mcxResult.tradingDate || dateKey(dates.mcxDate),
  };
}

module.exports = {
  fetchAndApplyBhavcopy,
  _private: {
    buildMatchKey,
    buildBseSettlementOperations,
    buildMcxSettlementOperations,
    buildNseSettlementOperations,
    fetchBseBhavcopy,
    fetchMcxBhavcopy,
    fetchNseBhavcopy,
    hasExactSourceDate,
    parseBseBhavcopyCsv,
    parseMcxBhavcopyCSV,
    parseMcxSourceDate,
    parseNseDatFile,
    parseNseSourceDate,
  },
};
