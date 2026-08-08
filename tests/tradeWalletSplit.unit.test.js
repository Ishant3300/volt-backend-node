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
