'use strict';

// Regression coverage for the multi-tier brokerage-sharing cascade bug: the caller's
// brokerage share only ever looked at the SINGLE topmost master below the caller,
// applying just that one master's own brokerage_sharing% to the entire spread and
// silently ignoring any different brokerage_sharing% configured on deeper
// intermediate masters. Correct by coincidence for 1- and 2-tier paths (nothing to
// ignore, or the ignored tier's own spread happened to be zero), wrong for 3+ tiers.
//
// Uses the same 3-user, 4-tier hierarchy (ADMIN -> newfix(90%) -> newfixsub(80%) ->
// newfix_subsubs(70%), with user1/user2/user3 at different depths) that surfaced the
// bug via an external reference script. No test previously existed for this file at
// all — that's how the bug shipped unnoticed.

const {
  _computeCallerBrkForUserBatched,
  _getPnlUnpassedMultiplierForUserBatched,
  _getBrkUnpassedMultiplierForUserBatched,
} = require('../src/controllers/weeklyAdminController')._private;

const masterMap = {
  '157459': { master_id: null, brokerage_sharing: 90, pnl_sharing: 90 },
  newfixsub: { master_id: '157459', brokerage_sharing: 80, pnl_sharing: 80 },
  newfix_subsubs: { master_id: 'newfixsub', brokerage_sharing: 70, pnl_sharing: 70 },
};

const kiteMap = { TOK: { lot_size: 1, segment: 'MCX-FUT', raw_name: 'TESTSCRIPT' } };
const callerRules = [{ script_name: 'TESTSCRIPT', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 200 }];

const tradesFor = (lots, rate) => [{ instrument_token: 'TOK', executed_price: rate, executed_quantity: lots }];

const user1 = { doc: { master_id: 'newfix_subsubs' }, lots: 12, rate: 800, totalBrk: 12 * 800 };
const user2 = { doc: { master_id: 'newfixsub' }, lots: 16, rate: 400, totalBrk: 16 * 400 };
const user3 = { doc: { master_id: '157459' }, lots: 18, rate: 800, totalBrk: 18 * 800 };

describe('_getBrkUnpassedMultiplierForUserBatched — per-tier brokerage_sharing cascade', () => {
  test('3 tiers deep (newfix_subsubs -> newfixsub -> newfix): multiplies ALL three, not just one', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u1', 'ADMIN', user1.doc, masterMap);
    expect(mult).toBeCloseTo(0.30 * 0.20 * 0.10, 10); // (1-.70)*(1-.80)*(1-.90) = 0.006
  });

  test('2 tiers deep (newfixsub -> newfix): multiplies both', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u2', 'ADMIN', user2.doc, masterMap);
    expect(mult).toBeCloseTo(0.20 * 0.10, 10); // (1-.80)*(1-.90) = 0.02
  });

  test('1 tier deep (direct child of newfix): just that tier', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u3', 'ADMIN', user3.doc, masterMap);
    expect(mult).toBeCloseTo(0.10, 10); // (1-.90) = 0.10
  });

  test('mirrors _getPnlUnpassedMultiplierForUserBatched\'s structure exactly (same shape, different field)', () => {
    const brkMult = _getBrkUnpassedMultiplierForUserBatched('u1', 'ADMIN', user1.doc, masterMap);
    const pnlMult = _getPnlUnpassedMultiplierForUserBatched('u1', 'ADMIN', user1.doc, masterMap);
    // Same masterMap has brokerage_sharing === pnl_sharing at every tier in this
    // fixture, so both cascades must produce an identical multiplier.
    expect(brkMult).toBeCloseTo(pnlMult, 10);
  });
});

describe('deep hierarchy (real deployments run 50-60+ tiers) — no depth limit, only cycle detection', () => {
  function buildChain(n, sharingPct) {
    const masterMap = {};
    for (let i = 0; i < n; i++) {
      masterMap['m' + i] = { master_id: i === 0 ? null : 'm' + (i - 1), brokerage_sharing: sharingPct, pnl_sharing: sharingPct };
    }
    return masterMap;
  }

  test('a 60-tier chain cascades through every tier, not just the first 10', () => {
    const N = 60;
    const masterMap = buildChain(N, 90);
    const userDoc = { master_id: 'm' + (N - 1) };
    const mult = _getBrkUnpassedMultiplierForUserBatched('user', 'ADMIN', userDoc, masterMap);
    const expected = Math.pow(0.10, N);
    // Relative comparison — at 1e-60 magnitude, exact equality can differ in the
    // last few bits of a double, but truncating at 10 tiers (the old bug) would be
    // off by 50 orders of magnitude (1e-10 vs 1e-60), not a rounding-error's worth.
    expect(Math.abs(mult - expected) / expected).toBeLessThan(1e-9);
  });

  test('a 15-tier chain (previously silently truncated at maxDepth=10) now cascades fully', () => {
    const N = 15;
    const masterMap = buildChain(N, 50);
    const userDoc = { master_id: 'm' + (N - 1) };
    const mult = _getBrkUnpassedMultiplierForUserBatched('user', 'ADMIN', userDoc, masterMap);
    const truncatedAt10 = Math.pow(0.5, 10);
    const fullCascade = Math.pow(0.5, N);
    expect(mult).toBeCloseTo(fullCascade, 10);
    expect(mult).not.toBeCloseTo(truncatedAt10, 6);
  });

  test('a 1000-tier chain still resolves correctly with no fixed ceiling', () => {
    const N = 1000;
    const masterMap = buildChain(N, 10);
    const userDoc = { master_id: 'm' + (N - 1) };
    const mult = _getBrkUnpassedMultiplierForUserBatched('user', 'ADMIN', userDoc, masterMap);
    expect(mult).toBeGreaterThan(0);
    expect(Number.isFinite(mult)).toBe(true);
  });

  test('a corrupted circular master_id reference terminates instead of hanging forever', () => {
    // In valid data this can never happen (master_id always points strictly
    // upward), but a bad row must not freeze the whole Node process — this
    // loop is synchronous, so an actual infinite loop here blocks every
    // other request on the server, not just this one.
    const cyclicMap = {
      a: { master_id: 'b', brokerage_sharing: 10 },
      b: { master_id: 'a', brokerage_sharing: 10 },
    };
    const start = Date.now();
    const mult = _getBrkUnpassedMultiplierForUserBatched('user', 'ADMIN', { master_id: 'a' }, cyclicMap);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(Number.isFinite(mult)).toBe(true);
  });

  test('P&L cascade is equally unaffected by depth', () => {
    const N = 60;
    const masterMap = buildChain(N, 90);
    const userDoc = { master_id: 'm' + (N - 1) };
    const mult = _getPnlUnpassedMultiplierForUserBatched('user', 'ADMIN', userDoc, masterMap);
    const expected = Math.pow(0.10, N);
    expect(Math.abs(mult - expected) / expected).toBeLessThan(1e-9);
  });
});

describe('_computeCallerBrkForUserBatched — admin\'s brokerage share for each user', () => {
  test('user1 (3 tiers): cascades through all three intermediate shares', () => {
    const trades = tradesFor(user1.lots, user1.rate);
    const callerBrk = _computeCallerBrkForUserBatched(
      'u1', 'ADMIN', 'admin', { u1: trades }, callerRules, kiteMap,
      masterMap, {}, [], user1.doc, user1.totalBrk,
    );
    // callerBaseClearance = 12*200 = 2400; spread = 9600-2400 = 7200;
    // unpassed = 7200 * 0.006 = 43.20; total = 2443.20
    expect(callerBrk).toBeCloseTo(2443.20, 2);
    // Must NOT equal the old buggy result, which only applied newfix's own 90%
    // (ignoring newfixsub's 80% and newfix_subsubs's own 70%): 2400 + 7200*0.10 = 3120.
    expect(callerBrk).not.toBeCloseTo(3120, 2);
  });

  test('user2 (2 tiers): cascades through both intermediate shares', () => {
    const trades = tradesFor(user2.lots, user2.rate);
    const callerBrk = _computeCallerBrkForUserBatched(
      'u2', 'ADMIN', 'admin', { u2: trades }, callerRules, kiteMap,
      masterMap, {}, [], user2.doc, user2.totalBrk,
    );
    // callerBaseClearance = 16*200 = 3200; spread = 6400-3200 = 3200;
    // unpassed = 3200 * 0.02 = 64; total = 3264.00
    expect(callerBrk).toBeCloseTo(3264.00, 2);
  });

  test('user3 (1 tier): single-tier case is unaffected by the fix', () => {
    const trades = tradesFor(user3.lots, user3.rate);
    const callerBrk = _computeCallerBrkForUserBatched(
      'u3', 'ADMIN', 'admin', { u3: trades }, callerRules, kiteMap,
      masterMap, {}, [], user3.doc, user3.totalBrk,
    );
    // callerBaseClearance = 18*200 = 3600; spread = 14400-3600 = 10800;
    // unpassed = 10800 * 0.10 = 1080; total = 4680.00
    expect(callerBrk).toBeCloseTo(4680.00, 2);
  });
});
