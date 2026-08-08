'use strict';

// Validates: Requirements 6.1 (metrics `equity` = Σ available wallet balances across
// the user's ALLOWED categories), 6.3 (non-allowed categories excluded from the sum
// AND the breakdown), 6.4 (the pushed payload carries the per-category wallet
// breakdown) and design D2 (free_margin === equity; margin_used remains for display
// only and does NOT reduce free_margin).
//
// metricsEngine exports a singleton, so we populate its in-memory `_userCache`
// directly and call the pure, synchronous `_computeUserMetrics(userId)` — no live DB,
// ticks or WebSocket required. `_ltpMap`/`_bidMap`/`_askMap` are Maps initialised on
// the singleton in its constructor.

const metricsEngine = require('../src/services/metricsEngine');

describe('metricsEngine._computeUserMetrics — wallet equity (D2)', () => {
  const seededUsers = [];
  const seededTokens = [];

  function seedUser(userId, cache) {
    seededUsers.push(userId);
    metricsEngine._userCache.set(userId, cache);
  }

  // Keep the shared singleton clean so state never leaks into other test files/cases.
  afterEach(() => {
    for (const id of seededUsers) metricsEngine._userCache.delete(id);
    for (const token of seededTokens) {
      metricsEngine._ltpMap.delete(token);
      metricsEngine._bidMap.delete(token);
      metricsEngine._askMap.delete(token);
    }
    seededUsers.length = 0;
    seededTokens.length = 0;
  });

  test('equity = Σ wallet[allowed]; GLOBAL excluded when not allowed; free_margin === equity', () => {
    seedUser('t9-u1', {
      credit: 50000,
      settledPnl: 0,
      masterId: null,
      fifoPnl: 0,
      brokerage: 0,
      openPositions: [],
      wallet: { NSE: 75000, MCX: 30000, GLOBAL: 999 },
      allowedCategories: ['NSE', 'MCX'],
    });

    const metrics = metricsEngine._computeUserMetrics('t9-u1');

    expect(metrics).not.toBeNull();
    // 75000 + 30000 = 105000; GLOBAL (999) excluded — it is not an allowed category.
    expect(metrics.equity).toBe(105000);
    // available already excludes blocked margin, so free_margin equals equity.
    expect(metrics.free_margin).toBe(105000);
    expect(metrics.free_margin).toBe(metrics.equity);
    // The "i" breakdown carries only the allowed pools (GLOBAL excluded).
    expect(metrics.wallet).toEqual({ NSE: 75000, MCX: 30000 });
    // No open positions → nothing blocked.
    expect(metrics.margin_used).toBe(0);
    // Credit is still reported unchanged in the payload.
    expect(metrics.credit).toBe(50000);
  });

  test('margin_used is still computed (|net_qty| × avgEntry) and does NOT reduce free_margin', () => {
    const token = 't9-tok-1';
    seededTokens.push(token);
    // Long 10 @ entry 100. LTP == entry price so floating P&L is 0, isolating margin_used.
    metricsEngine._ltpMap.set(token, 100);

    seedUser('t9-u2', {
      credit: 50000,
      settledPnl: 0,
      masterId: null,
      fifoPnl: 0,
      brokerage: 0,
      openPositions: [{
        token,
        exchange: 'NFO',
        tradingsymbol: 'NIFTY-FUT',
        netQty: 10,
        avgBuy: 100,
        avgSell: 0,
        segment: 'NFO-FUT',
        rawName: 'NIFTY',
        lotSize: 1,
      }],
      wallet: { NSE: 75000, MCX: 30000, GLOBAL: 0 },
      allowedCategories: ['NSE', 'MCX'],
    });

    const metrics = metricsEngine._computeUserMetrics('t9-u2');

    // margin_used = |net_qty| × avgEntry = 10 × 100 = 1000 (entry notional, display only).
    expect(metrics.margin_used).toBe(1000);
    // equity is still the wallet sum; margin_used does NOT subtract from it.
    expect(metrics.equity).toBe(105000);
    expect(metrics.free_margin).toBe(105000);
    // Key invariant of D2: free_margin === equity regardless of margin_used.
    expect(metrics.free_margin).toBe(metrics.equity);
  });

  test('no allowed categories → equity 0 and empty wallet breakdown (6.3)', () => {
    seedUser('t9-u3', {
      credit: 50000,
      settledPnl: 0,
      masterId: null,
      fifoPnl: 0,
      brokerage: 0,
      openPositions: [],
      // Funded wallet but the account maps to no allowed category.
      wallet: { NSE: 75000, MCX: 30000, GLOBAL: 999 },
      allowedCategories: [],
    });

    const metrics = metricsEngine._computeUserMetrics('t9-u3');

    expect(metrics.equity).toBe(0);
    expect(metrics.free_margin).toBe(0);
    expect(metrics.wallet).toEqual({});
  });

  test('funded wallet with no open positions still reports equity = wallet sum', () => {
    // A user with a funded wallet but a flat book must still report the full sum.
    seedUser('t9-u4', {
      credit: 0,
      settledPnl: 0,
      masterId: null,
      fifoPnl: 0,
      brokerage: 0,
      openPositions: [],
      wallet: { NSE: 100000, MCX: 0, GLOBAL: 0 },
      allowedCategories: ['NSE'],
    });

    const metrics = metricsEngine._computeUserMetrics('t9-u4');

    expect(metrics.equity).toBe(100000);
    expect(metrics.free_margin).toBe(100000);
    expect(metrics.wallet).toEqual({ NSE: 100000 });
    expect(metrics.margin_used).toBe(0);
  });
});
