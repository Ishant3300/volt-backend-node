'use strict';

// Validates: Requirements 1.1 (|quantity| × price), 1.2 (lot-based uses the
// same formula on the stored lots × lot_size quantity), 1.3 (no TradeMargin
// lookup — exchange/opts are ignored), 1.4 (entry notional at the given price).

const { calculateMargin } = require('../src/services/marginService');

describe('marginService.calculateMargin (notional)', () => {
  test('lot-based: 2 GOLD lots (lot size 100) @ ₹500 → 200 × 500 = 100000', async () => {
    // Quantity is already stored as lots × lot_size = 2 × 100 = 200.
    await expect(calculateMargin('MCX-FUT', 200, 500)).resolves.toBe(100000);
  });

  test('quantity-based: 1 @ ₹25000 → 25000', async () => {
    await expect(calculateMargin('NFO-FUT', 1, 25000)).resolves.toBe(25000);
  });

  test('quantity-based general: 10 @ ₹90 → 900', async () => {
    await expect(calculateMargin('NSE', 10, 90)).resolves.toBe(900);
  });

  test('uses absolute quantity for short positions: -3 @ ₹100 → 300', async () => {
    await expect(calculateMargin('NSE', -3, 100)).resolves.toBe(300);
  });

  test('zero quantity → 0', async () => {
    await expect(calculateMargin('X', 0, 100)).resolves.toBe(0);
  });

  test('zero price → 0', async () => {
    await expect(calculateMargin('X', 5, 0)).resolves.toBe(0);
  });

  test('nullish/NaN quantity or price guard → 0', async () => {
    await expect(calculateMargin('X', null, 100)).resolves.toBe(0);
    await expect(calculateMargin('X', undefined, 100)).resolves.toBe(0);
    await expect(calculateMargin('X', 5, null)).resolves.toBe(0);
    await expect(calculateMargin('X', 'abc', 100)).resolves.toBe(0);
    await expect(calculateMargin('X', 5, 'abc')).resolves.toBe(0);
  });

  test('coerces numeric strings', async () => {
    await expect(calculateMargin('X', '4', '250')).resolves.toBe(1000);
  });

  test('ignores exchange and opts (no per-instrument lookup)', async () => {
    // Same qty/price must yield the same notional regardless of exchange/opts,
    // proving the TradeMargin lookup path is gone (Requirement 1.3).
    const withOpts = await calculateMargin('MCX-FUT', 200, 500, {
      rawName: 'GOLD',
      instrumentToken: '12345',
      tradingsymbol: 'GOLD25AUGFUT',
    });
    const withoutOpts = await calculateMargin('ANYTHING', 200, 500);
    expect(withOpts).toBe(100000);
    expect(withoutOpts).toBe(100000);
  });
});
