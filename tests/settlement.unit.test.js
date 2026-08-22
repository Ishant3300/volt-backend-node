'use strict';

const fs = require('fs');
const path = require('path');
const {
  dateKey,
  getLatestDueSettlementFriday,
  getSettlementTradingDate,
  resolveBhavcopyTradingDates,
} = require('../src/utils/settlementDates');
const marketCalendarService = require('../src/services/marketCalendarService');
const bhavcopyService = require('../src/services/bhavcopyService');
const {
  buildInstrumentUpsertOperation,
} = require('../scripts/fetchInstruments');

const {
  buildMcxSettlementOperations,
  buildNseSettlementOperations,
  hasExactSourceDate,
  parseMcxBhavcopyCSV,
  parseNseDatFile,
} = bhavcopyService._private;

describe('settlement date resolution', () => {
  test.each([
    ['Saturday', '2026-08-01T02:00:00.000Z'],
    ['Sunday', '2026-08-02T02:00:00.000Z'],
  ])('%s resolves both exchanges and settlement period to Friday', (_label, instant) => {
    const now = new Date(instant);
    const dates = resolveBhavcopyTradingDates(undefined, now);
    expect(dateKey(dates.nseDate)).toBe('2026-07-31');
    expect(dateKey(dates.mcxDate)).toBe('2026-07-31');
    expect(dateKey(getSettlementTradingDate(now))).toBe('2026-07-31');
  });

  test.each([
    ['Monday', '2026-08-03T04:30:00.000Z', '2026-07-31'],
    ['Tuesday', '2026-08-04T04:30:00.000Z', '2026-07-31'],
    ['Friday before period completion', '2026-08-07T17:30:00.000Z', '2026-07-31'],
    ['following Saturday', '2026-08-08T02:00:00.000Z', '2026-08-07'],
  ])('%s resolves the latest fully due weekly Friday', (_label, instant, expected) => {
    expect(dateKey(getLatestDueSettlementFriday(new Date(instant)))).toBe(expected);
    expect(dateKey(getSettlementTradingDate(new Date(instant)))).toBe(expected);
  });

  test('Tuesday 01:00 IST resolves MCX to Monday', () => {
    const now = new Date('2026-08-03T19:30:00.000Z'); // 2026-08-04 01:00 IST
    const dates = resolveBhavcopyTradingDates(undefined, now);
    expect(dateKey(dates.mcxDate)).toBe('2026-08-03');
  });

  test('an explicit Friday never silently falls back to Thursday', () => {
    const dates = resolveBhavcopyTradingDates('2026-07-31', new Date('2026-08-01T02:00:00.000Z'));
    expect(dates.explicitTarget).toBe(true);
    expect(dateKey(dates.nseDate)).toBe('2026-07-31');
    expect(dateKey(dates.mcxDate)).toBe('2026-07-31');
  });

  test('official full-day holiday calendars resolve each exchange independently', async () => {
    const resolved = await marketCalendarService.resolveSettlementDates(
      new Date('2026-04-04T02:00:00.000Z'),
      {
        nseHolidays: new Set(['2026-04-03']),
        mcxHolidays: new Set(['2026-04-03']),
      }
    );
    expect(dateKey(resolved.periodDate)).toBe('2026-04-03');
    expect(dateKey(resolved.nseDate)).toBe('2026-04-02');
    expect(dateKey(resolved.mcxDate)).toBe('2026-04-02');
  });
});

describe('official bhavcopy parsing and exact authority', () => {
  const nseFuturesLine = [
    'ABB26AUGFUT', 'FUTSTK', 'ABB', '25082026', '0000000.00', '', '00', 'N', 'W',
    '00007322.00', '00007384.00', '00007519.00', '00007187.50', '00007283.50', '',
    '1257625', '9283217812.50', '0002242750', '0000199875', '000.00', '000.00',
    '31/JUL/2026', '7288', '00007891.50', '00006651.00', '00007240.00',
  ].join(',');

  test('NSE uses the official settlement field (close, field 13), not field 25 (LTP), and validates source date', () => {
    // Confirmed via a real downloaded NSE bhavcopy file: field 25 is the
    // day's last traded price (0 for an illiquid contract with no trades
    // that day), NOT the official settlement price — field 13 ("close") is
    // always populated and matches the real, independently-verified
    // settlement price. A prior version of this test (and the code)
    // believed field 25 was authoritative; both were wrong.
    const parsed = parseNseDatFile(nseFuturesLine);
    const row = [...parsed.values()][0];
    expect([...parsed.sourceDates]).toEqual(['2026-07-31']);
    expect(row.close).toBe(7283.5);
    expect(row.settle_pr).toBe(7283.5);
    expect(row.settle_pr).toBe(row.close);
    expect(hasExactSourceDate(parsed, new Date('2026-07-31T00:00:00.000Z'))).toBe(true);
    expect(hasExactSourceDate(parsed, new Date('2026-07-30T00:00:00.000Z'))).toBe(false);
  });

  test('NSE rows without a source date are not authoritative', () => {
    const fields = nseFuturesLine.split(',');
    fields[21] = '';
    const parsed = parseNseDatFile(fields.join(','));
    expect(parsed.size).toBe(0);
    expect(hasExactSourceDate(parsed, new Date('2026-07-31T00:00:00.000Z'))).toBe(false);
  });

  test('weekday NSE persistence updates official fields without replacing last_price', () => {
    const parsed = parseNseDatFile(nseFuturesLine);
    const closePriceMap = {};
    const updatedAt = new Date('2026-08-03T04:30:00.000Z');
    const result = buildNseSettlementOperations(
      new Date('2026-07-31T00:00:00.000Z'),
      [{
        instrument_token: '2001',
        raw_name: 'ABB',
        name: 'ABB',
        expiry: new Date('2026-08-25T00:00:00.000Z'),
        strike: 0,
        instrument_type: 'FUT',
        exchange: 'NFO',
      }],
      parsed,
      closePriceMap,
      updatedAt
    );

    expect(result).toMatchObject({ matched: 1, unmatched: 0 });
    expect(closePriceMap).toEqual({ '2001': 7283.5 });
    expect(result.bulkOps[0].updateOne.update.$set).toMatchObject({
      settlement_price: 7283.5,
      settlement_price_date: new Date('2026-07-31T00:00:00.000Z'),
      settlement_price_source: 'NSE_OFFICIAL_BHAVCOPY_SETTLEMENT',
      settlement_price_updated_at: updatedAt,
      ohlc_close: 7283.5,
    });
    expect(result.bulkOps[0].updateOne.update.$set).not.toHaveProperty('last_price');
  });

  test('MCX prefers a dedicated settlement column and emits exact-date metadata', () => {
    const csv = [
      'DATE,INSTRUMENTNAME,SYMBOL,EXPIRY_DATE,OPTIONTYPE,STRIKEPRICE,OPEN,HIGH,LOW,CLOSE,SETTLEMENT_PRICE',
      '"31 Jul 2026",FUTCOM,GOLD,"31 Jul 2026",-,0,100,110,90,105,101',
    ].join('\n');
    const parsed = parseMcxBhavcopyCSV(csv);
    expect([...parsed.sourceDates]).toEqual(['2026-07-31']);
    expect(parsed.priceField).toBe('settlement price');
    expect(hasExactSourceDate(parsed, new Date('2026-07-31T00:00:00.000Z'))).toBe(true);
    expect(hasExactSourceDate(parsed, new Date('2026-07-30T00:00:00.000Z'))).toBe(false);

    const closePriceMap = {};
    const exact = {
      instrument_token: '1001',
      raw_name: 'GOLD',
      name: 'GOLD',
      expiry: new Date('2026-07-31T00:00:00.000Z'),
      strike: 0,
      instrument_type: 'FUT',
      exchange: 'MCX',
    };
    const sameMonthWrongContract = {
      ...exact,
      instrument_token: '1002',
      expiry: new Date('2026-07-30T00:00:00.000Z'),
    };
    const updatedAt = new Date('2026-08-01T00:00:00.000Z');
    const result = buildMcxSettlementOperations(
      new Date('2026-07-31T00:00:00.000Z'),
      [exact, sameMonthWrongContract],
      parsed,
      closePriceMap,
      updatedAt,
      { provider: 'MCX', authority: 'official' }
    );

    expect(result.matched).toBe(1);
    expect(closePriceMap).toEqual({ '1001': 101 });
    expect(result.bulkOps).toHaveLength(1);
    expect(result.bulkOps[0].updateOne.update.$set).toMatchObject({
      settlement_price: 101,
      settlement_price_date: new Date('2026-07-31T00:00:00.000Z'),
      settlement_price_source: 'MCX_OFFICIAL_BHAVCOPY_settlement price',
      settlement_price_updated_at: updatedAt,
      ohlc_close: 101,
    });
    expect(result.bulkOps[0].updateOne.update.$set).not.toHaveProperty('last_price');
  });

  test('exact-date third-party MCX data cannot become settlement authority', () => {
    const csv = [
      'DATE,INSTRUMENTNAME,SYMBOL,EXPIRY_DATE,OPTIONTYPE,STRIKEPRICE,OPEN,HIGH,LOW,CLOSE',
      '31 Jul 2026,FUTCOM,GOLD,31 Jul 2026,-,0,100,110,90,105',
    ].join('\n');
    const parsed = parseMcxBhavcopyCSV(csv);
    const closePriceMap = {};
    const result = buildMcxSettlementOperations(
      new Date('2026-07-31T00:00:00.000Z'),
      [{
        instrument_token: '1001',
        raw_name: 'GOLD',
        name: 'GOLD',
        expiry: new Date('2026-07-31T00:00:00.000Z'),
        strike: 0,
        instrument_type: 'FUT',
        exchange: 'MCX',
      }],
      parsed,
      closePriceMap,
      new Date(),
      { provider: 'SAMCO', authority: 'third_party' }
    );

    expect(result).toMatchObject({ matched: 0, rejectedAuthority: true });
    expect(result.bulkOps).toEqual([]);
    expect(closePriceMap).toEqual({});
  });

  test('cached real MCX report has one exact source date and substantial coverage', () => {
    const fixture = fs.readFileSync(path.join(__dirname, '../scripts/downloads/test_mcx.csv'), 'utf8');
    const parsed = parseMcxBhavcopyCSV(fixture);
    expect(parsed.size).toBeGreaterThan(1000);
    expect([...parsed.sourceDates]).toEqual(['2026-04-24']);
    expect(parsed.priceField).toBe('CLOSE');
  });
});

describe('daily Kite instrument import', () => {
  test('never places CSV last_price into $set or $setOnInsert', () => {
    const operation = buildInstrumentUpsertOperation({
      instrument_token: '999',
      exchange_token: '111',
      tradingsymbol: 'TEST26AUGFUT',
      name: 'TEST',
      raw_name: 'TEST',
      display_name: 'TEST FUT',
      last_price: 0,
      lot_size: 25,
      instrument_type: 'FUT',
      segment: 'NFO-FUT',
      exchange: 'NFO',
    });

    expect(operation.updateOne.filter).toEqual({ instrument_token: '999' });
    expect(operation.updateOne.update.$set).not.toHaveProperty('last_price');
    expect(operation.updateOne.update.$setOnInsert).not.toHaveProperty('last_price');
    expect(operation.updateOne.update.$set.lot_size).toBe(25);
  });
});
