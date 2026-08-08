'use strict';

// Validates: Requirement 2.2 (segment -> category mapping) and the
// allowedCategories derivation used by migration / metrics / wallet funding.

const {
  CATEGORY,
  categoryForSegment,
  allowedCategories,
} = require('../src/utils/walletCategory');

describe('categoryForSegment', () => {
  test.each([
    ['NFO-FUT', 'NSE'],
    ['NFO-OPT', 'NSE'],
    ['MCX-FUT', 'MCX'],
    ['MCX-OPT', 'MCX'],
    // "everything else" -> GLOBAL
    ['SGX', 'GLOBAL'],
    ['INDICES', 'GLOBAL'],
    ['GLOBAL', 'GLOBAL'],
    ['BFO-FUT', 'GLOBAL'],
    ['BFO-OPT', 'GLOBAL'],
    ['NSE', 'GLOBAL'],
    ['NFO', 'GLOBAL'],
    ['OTHERS', 'GLOBAL'],
  ])('maps %s -> %s', (segment, expected) => {
    expect(categoryForSegment(segment)).toBe(expected);
  });

  test('is case-insensitive and trims surrounding whitespace', () => {
    expect(categoryForSegment('nfo-fut')).toBe('NSE');
    expect(categoryForSegment('  mcx-opt  ')).toBe('MCX');
    expect(categoryForSegment('Nfo-Opt')).toBe('NSE');
  });

  test('defaults unknown / empty / nullish input to GLOBAL', () => {
    expect(categoryForSegment('')).toBe('GLOBAL');
    expect(categoryForSegment()).toBe('GLOBAL');
    expect(categoryForSegment(null)).toBe('GLOBAL');
    expect(categoryForSegment('SOMETHING-NEW')).toBe('GLOBAL');
  });

  test('exposes the canonical category constants', () => {
    expect(CATEGORY).toEqual({ NSE: 'NSE', MCX: 'MCX', GLOBAL: 'GLOBAL' });
  });
});

describe('allowedCategories', () => {
  test('derives distinct categories from the Master shape (array of strings)', () => {
    expect(allowedCategories(['NFO-FUT', 'MCX-FUT', 'SGX'])).toEqual(['NSE', 'MCX', 'GLOBAL']);
  });

  test('derives distinct categories from the User shape (array of objects)', () => {
    const exchangesAllowed = [
      { exchange_name: 'NFO-OPT', turnover: false, lot: true, group_name: '' },
      { exchange_name: 'MCX-OPT', turnover: false, lot: true, group_name: '' },
    ];
    expect(allowedCategories(exchangesAllowed)).toEqual(['NSE', 'MCX']);
  });

  test('deduplicates categories that share a mapping', () => {
    expect(allowedCategories(['NFO-FUT', 'NFO-OPT'])).toEqual(['NSE']);
    expect(allowedCategories(['MCX-FUT', 'MCX-OPT'])).toEqual(['MCX']);
  });

  test('returns categories in canonical order regardless of input order', () => {
    expect(allowedCategories(['SGX', 'MCX-FUT', 'NFO-FUT'])).toEqual(['NSE', 'MCX', 'GLOBAL']);
  });

  test('ignores blank, null and malformed entries', () => {
    expect(allowedCategories(['NFO-FUT', '', null, {}, { exchange_name: '  ' }])).toEqual(['NSE']);
  });

  test('is case-insensitive for entry names', () => {
    expect(allowedCategories(['nfo-fut', { exchange_name: 'mcx-opt' }])).toEqual(['NSE', 'MCX']);
  });

  test('returns an empty array for empty or non-array input', () => {
    expect(allowedCategories([])).toEqual([]);
    expect(allowedCategories()).toEqual([]);
    expect(allowedCategories(null)).toEqual([]);
    expect(allowedCategories('NFO-FUT')).toEqual([]);
  });
});
