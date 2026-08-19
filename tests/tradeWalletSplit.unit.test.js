'use strict';

// Validates: Requirements 3.1 (open/increase blocks), 3.2 (close/reduce releases),
// 3.3 (reversal releases the closed portion AND opens the remainder). This unit-tests
// the pure open/close split (`computeWalletSplit`) that drives the category-wallet
// release/block on trade execution in tradeController.placeTrade (Task 5).
//
// The full placeTrade block/release wiring (release = closingQty × avgEntry,
// block = openingQty × executedPrice, inside the trade transaction) needs a live
// replica-set Mongo and is covered by the integration suite (Tasks 19/20). Here we
// isolate and exhaustively test the split maths, which is the core decision logic.

const { computeWalletSplit } = require('../src/controllers/tradeController');
const { computeFlatResetState } = require('../src/utils/walletSplit');

describe('computeWalletSplit — open/close split vs current net position', () => {
  describe('pure open (flat book, prevNet = 0)', () => {
    test('BUY opens the whole quantity', () => {
      expect(computeWalletSplit(0, 'BUY', 10)).toEqual({ closingQty: 0, openingQty: 10 });
    });
    test('SELL opens the whole quantity (fresh short)', () => {
      expect(computeWalletSplit(0, 'SELL', 7)).toEqual({ closingQty: 0, openingQty: 7 });
    });
  });

  describe('increase in the same direction (no close)', () => {
    test('BUY while already long adds entirely to the open side', () => {
      expect(computeWalletSplit(5, 'BUY', 3)).toEqual({ closingQty: 0, openingQty: 3 });
    });
    test('SELL while already short adds entirely to the open side', () => {
      expect(computeWalletSplit(-5, 'SELL', 4)).toEqual({ closingQty: 0, openingQty: 4 });
    });
  });

  describe('full / exact close', () => {
    test('SELL exactly closing a long releases all, opens nothing', () => {
      expect(computeWalletSplit(10, 'SELL', 10)).toEqual({ closingQty: 10, openingQty: 0 });
    });
    test('BUY exactly closing a short releases all, opens nothing', () => {
      expect(computeWalletSplit(-8, 'BUY', 8)).toEqual({ closingQty: 8, openingQty: 0 });
    });
  });

  describe('partial close (order smaller than net position)', () => {
    test('SELL partially closing a long', () => {
      expect(computeWalletSplit(10, 'SELL', 4)).toEqual({ closingQty: 4, openingQty: 0 });
    });
    test('BUY partially closing a short', () => {
      expect(computeWalletSplit(-10, 'BUY', 6)).toEqual({ closingQty: 6, openingQty: 0 });
    });
  });

  describe('reversal (order larger than net position, opposite direction)', () => {
    test('SELL through a long: closes the long, opens the short remainder', () => {
      // long 6, SELL 10 → close 6 (release), open 4 short (block)
      expect(computeWalletSplit(6, 'SELL', 10)).toEqual({ closingQty: 6, openingQty: 4 });
    });
    test('BUY through a short: closes the short, opens the long remainder', () => {
      // short 6, BUY 15 → close 6 (release), open 9 long (block)
      expect(computeWalletSplit(-6, 'BUY', 15)).toEqual({ closingQty: 6, openingQty: 9 });
    });
  });

  describe('input hygiene', () => {
    test('treats quantity as absolute', () => {
      expect(computeWalletSplit(10, 'SELL', -4)).toEqual({ closingQty: 4, openingQty: 0 });
    });
    test('nullish / NaN inputs degrade to zeros', () => {
      expect(computeWalletSplit(undefined, 'BUY', undefined)).toEqual({ closingQty: 0, openingQty: 0 });
      expect(computeWalletSplit(null, 'SELL', null)).toEqual({ closingQty: 0, openingQty: 0 });
      expect(computeWalletSplit('abc', 'BUY', 'xyz')).toEqual({ closingQty: 0, openingQty: 0 });
    });
    test('an unrecognised transaction type never closes (opens the full quantity)', () => {
      expect(computeWalletSplit(10, 'FOO', 3)).toEqual({ closingQty: 0, openingQty: 3 });
    });
    test('closingQty + openingQty always equals the absolute order quantity', () => {
      const cases = [
        [0, 'BUY', 10], [5, 'BUY', 3], [-5, 'SELL', 4],
        [10, 'SELL', 10], [-8, 'BUY', 8], [10, 'SELL', 4],
        [-10, 'BUY', 6], [6, 'SELL', 10], [-6, 'BUY', 15],
      ];
      for (const [prevNet, type, qty] of cases) {
        const { closingQty, openingQty } = computeWalletSplit(prevNet, type, qty);
        expect(closingQty + openingQty).toBe(Math.abs(qty));
        expect(closingQty).toBeGreaterThanOrEqual(0);
        expect(openingQty).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

// Regression coverage for computeFlatResetState — previously untested, which is how a
// real bug (partial closes folding into the WRONG side's totals instead of decrementing
// the closed side) shipped to production undetected. Confirmed against a real trade
// history (chitra56, Aug 2026): a script closed across several fills, then reopened,
// showed a materially wrong average entry price because the partial closes were never
// subtracted from the open side's running totals.
const t = (type, qty, price) => ({ transaction_type: type, executed_quantity: qty, executed_price: price });

describe('computeFlatResetState — average-cost position tracking for the open position', () => {
  test('a single opening buy', () => {
    expect(computeFlatResetState([t('BUY', 50, 100)])).toEqual({
      netQty: 50, totalBuyQty: 50, totalSellQty: 0, totalBuyValue: 5000, totalSellValue: 0,
    });
  });

  test('partial close (SELL smaller than the open long) decrements the buy side, not the sell side', () => {
    const state = computeFlatResetState([t('BUY', 50, 100), t('SELL', 20, 105)]);
    // Remaining 30 units still carry the original avg entry of 100 — a proportional
    // partial reduction doesn't change the average of what's left.
    expect(state).toEqual({ netQty: 30, totalBuyQty: 30, totalSellQty: 0, totalBuyValue: 3000, totalSellValue: 0 });
  });

  test('partial close followed by a further same-side open averages against the TRUE remaining qty, not the original', () => {
    // BUY 50@100, partial SELL 20 (still long 30 @ avg 100), BUY 30@120 (now long 60).
    // True average: (30*100 + 30*120) / 60 = 110. Buggy version folded the partial
    // close into totalSellQty and left totalBuyQty at 80, giving avg 107.5.
    const state = computeFlatResetState([t('BUY', 50, 100), t('SELL', 20, 105), t('BUY', 30, 120)]);
    expect(state.netQty).toBe(60);
    expect(state.totalBuyQty).toBe(60);
    expect(state.totalBuyValue / state.totalBuyQty).toBeCloseTo(110, 6);
  });

  test('multiple partial closes on a short, then reopening long, keep totals consistent with netQty', () => {
    // SELL 100@500 (short 100), BUY 40@480 (partial close, short 60), BUY 60@490 (exact close, flat),
    // BUY 20@495 SELL 20@498 (fresh round trip).
    const state = computeFlatResetState([
      t('SELL', 100, 500), t('BUY', 40, 480), t('BUY', 60, 490), t('BUY', 20, 495), t('SELL', 20, 498),
    ]);
    expect(state.netQty).toBe(0);
    expect(state.totalBuyQty - state.totalSellQty).toBe(state.netQty);
    expect(state.totalBuyQty).toBe(0);
    expect(state.totalSellQty).toBe(0);
  });

  test('same-trade flip (one fill both closes the old side and opens the opposite side)', () => {
    // Long 50 @100, then SELL 80 in one fill: closes the 50 long, flips to short 30 @ this trade's price.
    const state = computeFlatResetState([t('BUY', 50, 100), t('SELL', 80, 110)]);
    expect(state).toEqual({ netQty: -30, totalBuyQty: 0, totalSellQty: 30, totalBuyValue: 0, totalSellValue: 30 * 110 });
  });

  test('totalBuyQty - totalSellQty always equals netQty, across a mixed random-ish sequence', () => {
    const state = computeFlatResetState([
      t('BUY', 30, 100), t('BUY', 20, 105), t('SELL', 15, 110), t('SELL', 25, 108),
      t('BUY', 40, 95), t('SELL', 10, 120), t('BUY', 5, 130),
    ]);
    expect(state.totalBuyQty - state.totalSellQty).toBe(state.netQty);
  });
});
