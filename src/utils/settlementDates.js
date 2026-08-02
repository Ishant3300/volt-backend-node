'use strict';

const INDIA_TIME_ZONE = 'Asia/Kolkata';
const NSE_BHAVCOPY_READY_MINUTE = (17 * 60) + 30;
const INDIA_OFFSET_MS = (5 * 60 * 60 * 1000) + (30 * 60 * 1000);

const indiaDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: INDIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function getIndiaDateTimeParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`);

  const parts = {};
  for (const part of indiaDateTimeFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function toIndiaDateOnly(value = new Date()) {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (match) {
      const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
        throw new TypeError(`Invalid date: ${value}`);
      }
      return date;
    }
  }

  const parts = getIndiaDateTimeParts(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function addUtcDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalizeHolidayKeys(holidays) {
  if (!holidays) return new Set();
  if (holidays instanceof Set) return holidays;
  return new Set(Array.from(holidays, value => typeof value === 'string' ? value : dateKey(value)));
}

function isWeekendDate(value) {
  const day = value.getUTCDay();
  return day === 0 || day === 6;
}

function isTradingDay(value, holidays) {
  return !isWeekendDate(value) && !normalizeHolidayKeys(holidays).has(dateKey(value));
}

function onOrBeforeTradingDay(value, holidays) {
  let result = new Date(value);
  const holidayKeys = normalizeHolidayKeys(holidays);
  while (!isTradingDay(result, holidayKeys)) result = addUtcDays(result, -1);
  return result;
}

function previousTradingDay(value, holidays) {
  return onOrBeforeTradingDay(addUtcDays(value, -1), holidays);
}

function dateRange(value) {
  const start = toIndiaDateOnly(value);
  return { start, end: addUtcDays(start, 1) };
}

/** Absolute UTC instants spanning one India calendar date. */
function indiaDayRangeUtc(value) {
  const logicalDate = toIndiaDateOnly(value);
  const start = new Date(logicalDate.getTime() - INDIA_OFFSET_MS);
  return { start, end: new Date(start.getTime() + (24 * 60 * 60 * 1000)) };
}

/**
 * Resolve independently because NSE's same-day file is available after 17:30 IST,
 * while MCX's file is available the next calendar day. An explicit target means
 * both exchanges must use that exact weekday date. Exchange-holiday resolution is
 * performed by marketCalendarService before this helper is called.
 */
function resolveBhavcopyTradingDates(targetDate, now = new Date()) {
  if (targetDate !== undefined && targetDate !== null) {
    const exactDate = onOrBeforeTradingDay(toIndiaDateOnly(targetDate));
    return { nseDate: exactDate, mcxDate: new Date(exactDate), explicitTarget: true };
  }

  const today = toIndiaDateOnly(now);
  const localParts = getIndiaDateTimeParts(now);
  const weekend = isWeekendDate(today);
  const minuteOfDay = (localParts.hour * 60) + localParts.minute;

  const nseDate = weekend
    ? onOrBeforeTradingDay(today)
    : (minuteOfDay >= NSE_BHAVCOPY_READY_MINUTE ? today : previousTradingDay(today));

  const mcxDate = weekend ? onOrBeforeTradingDay(today) : previousTradingDay(today);
  return { nseDate, mcxDate, explicitTarget: false };
}

/**
 * Latest fully completed weekly settlement period.
 *
 * A settlement period ends at midnight after Friday in India. Therefore every
 * instant from Saturday through the following Friday maps to the preceding
 * Friday; the current Friday is not due until it has fully closed.
 */
function getLatestDueSettlementFriday(now = new Date()) {
  const today = toIndiaDateOnly(now);
  const day = today.getUTCDay();
  const daysSinceFriday = (day + 2) % 7;
  const mostRecentFriday = addUtcDays(today, -daysSinceFriday);
  return day === 5 ? addUtcDays(mostRecentFriday, -7) : mostRecentFriday;
}

/** Backward-compatible name for the weekly logical period-end date. */
function getSettlementTradingDate(now = new Date()) {
  return getLatestDueSettlementFriday(now);
}

function isWeekendInIndia(now = new Date()) {
  return isWeekendDate(toIndiaDateOnly(now));
}

module.exports = {
  INDIA_TIME_ZONE,
  addUtcDays,
  dateKey,
  dateRange,
  getIndiaDateTimeParts,
  getLatestDueSettlementFriday,
  getSettlementTradingDate,
  indiaDayRangeUtc,
  isTradingDay,
  isWeekendInIndia,
  onOrBeforeTradingDay,
  previousTradingDay,
  resolveBhavcopyTradingDates,
  toIndiaDateOnly,
};
