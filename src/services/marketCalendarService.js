'use strict';

const axios = require('axios');
const {
  dateKey,
  getSettlementTradingDate,
  onOrBeforeTradingDay,
  toIndiaDateOnly,
} = require('../utils/settlementDates');

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NSE_HOLIDAY_URL = 'https://www.nseindia.com/api/holiday-master?type=trading';
const MCX_HOLIDAY_URL = 'https://www.mcxindia.com/market-operations/trading-surveillance/trading-holidays';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  Accept: 'application/json,text/html,text/plain,*/*',
};

// Verified against the official NSE holiday-master response and MCX trading
// holiday page. These are a resilience fallback for the currently deployed
// calendar year only; unknown years fail closed if the official source is down.
const VERIFIED_FALLBACKS = {
  'NSE:2026': [
    '2026-01-15', '2026-01-26', '2026-02-15', '2026-03-03', '2026-03-21',
    '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
    '2026-05-28', '2026-06-26', '2026-08-15', '2026-09-14', '2026-10-02',
    '2026-10-20', '2026-11-08', '2026-11-10', '2026-11-24', '2026-12-25',
  ],
  // Only full-day closures belong here. MCX dates with an open evening session
  // still produce an official daily settlement and are trading days.
  'MCX:2026': ['2026-01-26', '2026-04-03', '2026-10-02', '2026-12-25'],
};

const cache = new Map();

function parseNseDate(value) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(value || '').trim());
  if (!match || months[match[2]] === undefined) return null;
  return dateKey(new Date(Date.UTC(Number(match[3]), months[match[2]], Number(match[1]))));
}

function parseMcxFullDayHolidays(html, year) {
  const holidays = new Set();
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const dateMatch = row.match(/data-date=["'](\d{4}-\d{2}-\d{2})["']/i);
    if (!dateMatch || !dateMatch[1].startsWith(`${year}-`)) continue;
    const closedSessions = (row.match(/class=["']close-tag["']/gi) || []).length;
    if (closedSessions >= 2) holidays.add(dateMatch[1]);
  }
  return holidays;
}

async function fetchNseHolidays(year) {
  const response = await axios.get(NSE_HOLIDAY_URL, {
    timeout: 30_000,
    headers: { ...BROWSER_HEADERS, Referer: 'https://www.nseindia.com/resources/exchange-communication-holidays' },
  });
  const rows = response.data?.FO;
  if (!Array.isArray(rows)) throw new Error('NSE holiday response is missing the FO calendar');
  const holidays = new Set(rows.map(row => parseNseDate(row.tradingDate)).filter(key => key?.startsWith(`${year}-`)));
  if (holidays.size === 0) throw new Error(`NSE holiday response has no FO dates for ${year}`);
  return holidays;
}

async function fetchMcxHolidays(year) {
  const response = await axios.get(MCX_HOLIDAY_URL, { timeout: 30_000, headers: BROWSER_HEADERS });
  const holidays = parseMcxFullDayHolidays(response.data, year);
  if (!String(response.data || '').includes(`${year}-`)) {
    throw new Error(`MCX holiday response has no dates for ${year}`);
  }
  return holidays;
}

async function getHolidays(exchange, year, options = {}) {
  const normalizedExchange = String(exchange || '').toUpperCase();
  if (!['NSE', 'MCX'].includes(normalizedExchange)) throw new TypeError(`Unsupported exchange calendar: ${exchange}`);
  const key = `${normalizedExchange}:${year}`;
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return new Set(cached.holidays);

  try {
    const holidays = normalizedExchange === 'NSE'
      ? await fetchNseHolidays(year)
      : await fetchMcxHolidays(year);
    cache.set(key, { holidays: new Set(holidays), expiresAt: Date.now() + CACHE_TTL_MS });
    return holidays;
  } catch (error) {
    if (cached) {
      console.warn(`[MarketCalendar] ${normalizedExchange} refresh failed; using stale cache: ${error.message}`);
      return new Set(cached.holidays);
    }
    const fallback = VERIFIED_FALLBACKS[key];
    if (fallback) {
      console.warn(`[MarketCalendar] ${normalizedExchange} refresh failed; using verified ${year} fallback: ${error.message}`);
      return new Set(fallback);
    }
    throw new Error(`${normalizedExchange} trading calendar unavailable for ${year}: ${error.message}`);
  }
}

async function resolveSettlementPriceDates(periodDateValue, options = {}) {
  const periodDate = toIndiaDateOnly(periodDateValue);
  const year = periodDate.getUTCFullYear();
  const [nseHolidays, mcxHolidays] = await Promise.all([
    options.nseHolidays ? new Set(options.nseHolidays) : getHolidays('NSE', year, options),
    options.mcxHolidays ? new Set(options.mcxHolidays) : getHolidays('MCX', year, options),
  ]);

  return {
    periodDate,
    nseDate: onOrBeforeTradingDay(periodDate, nseHolidays),
    mcxDate: onOrBeforeTradingDay(periodDate, mcxHolidays),
  };
}

async function resolveSettlementDates(now = new Date(), options = {}) {
  return resolveSettlementPriceDates(getSettlementTradingDate(now), options);
}

function clearCache() {
  cache.clear();
}

module.exports = {
  getHolidays,
  resolveSettlementDates,
  resolveSettlementPriceDates,
  _private: {
    clearCache,
    parseMcxFullDayHolidays,
    parseNseDate,
  },
};
