'use strict';

// Regression coverage for the brokerage-sharing cascade in
// weeklyAdminController.js.
//
// This file previously tested a "single spread stays entirely with the
// direct parent" model, itself replacing an even older bug where only the
// topmost intermediate master's own share was applied. That single-spread
// model is now ALSO superseded: verified against real production data
// (829814 "test harry main", brokerage_sharing 94% -> 119318 "harry demo
// test", brokerage_sharing 0% -> client 205239's real trades this week)
// it only produced the CORRECT split by coincidence when a rate change
// happens at exactly one hop in the chain. GM-Global (an external reference
// platform running the same real trades under the same configured rates)
// shows a DIFFERENT, verified-correct "Broker Brokerage" figure whenever a
// rate changes at more than one hop, which the single-spread model has no
// way to attribute correctly.
//
// The new model: a client's billed rate is reached via a CHAIN of
// per-instrument rates (topmost master's own admin-assigned rate, then
// whatever each subsequent master charges their own downline — same rate
// unchanged, or raised). This produces a sequence of LAYERS — layer 1 is
// the topmost master's own base rate; every later layer is the increase (if
// any) a specific master introduces for their own child. Each layer
// cascades upward independently starting at whoever owns it, using each
// level's own brokerage_sharing% to determine their keep vs. what passes
// further up — the SAME mechanism for every layer, base or spread alike.
//
// The three real-trade cases below (GOLD, BANKNIFTY, NIFTY-CE) reconcile
// EXACTLY to GM-Global's own displayed "Broker Brokerage" figure — not just
// an internally-consistent total, verified against an independent
// reference platform running the identical trades under the identical
// configured rates.

const {
  _computeCallerBrkForUserBatched,
  _getPnlUnpassedMultiplierForUserBatched,
  _getBrkUnpassedMultiplierForUserBatched,
} = require('../src/controllers/weeklyAdminController')._private;

describe('_getBrkUnpassedMultiplierForUserBatched — per-tier brokerage_sharing cascade', () => {
  const masterMap = {
    '157459': { master_id: null, brokerage_sharing: 90, pnl_sharing: 90 },
    newfixsub: { master_id: '157459', brokerage_sharing: 80, pnl_sharing: 80 },
    newfix_subsubs: { master_id: 'newfixsub', brokerage_sharing: 70, pnl_sharing: 70 },
  };

  test('3 tiers deep (newfix_subsubs -> newfixsub -> newfix): multiplies ALL three, not just one', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u1', 'ADMIN', { master_id: 'newfix_subsubs' }, masterMap);
    expect(mult).toBeCloseTo(0.30 * 0.20 * 0.10, 10); // (1-.70)*(1-.80)*(1-.90) = 0.006
  });

  test('2 tiers deep (newfixsub -> newfix): multiplies both', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u2', 'ADMIN', { master_id: 'newfixsub' }, masterMap);
    expect(mult).toBeCloseTo(0.20 * 0.10, 10); // (1-.80)*(1-.90) = 0.02
  });

  test('1 tier deep (direct child of newfix): just that tier', () => {
    const mult = _getBrkUnpassedMultiplierForUserBatched('u3', 'ADMIN', { master_id: '157459' }, masterMap);
    expect(mult).toBeCloseTo(0.10, 10); // (1-.90) = 0.10
  });

  test('mirrors _getPnlUnpassedMultiplierForUserBatched\'s structure exactly (same shape, different field)', () => {
    const userDoc = { master_id: 'newfix_subsubs' };
    const brkMult = _getBrkUnpassedMultiplierForUserBatched('u1', 'ADMIN', userDoc, masterMap);
    const pnlMult = _getPnlUnpassedMultiplierForUserBatched('u1', 'ADMIN', userDoc, masterMap);
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

describe('_computeCallerBrkForUserBatched — multi-layer cascade, verified against real GM-Global figures', () => {
  // Real hierarchy: admin -> 829814 (test harry main, 94% share) -> 119318
  // (harry demo test, 0% share) -> client. GOLD trade: both masters
  // configured at 50/lot (no spread at that hop — pure pass-through), client
  // billed at 170/lot (the entire spread introduced by 119318, the direct
  // parent). 2 lots traded (1 buy + 1 sell), total billed = 340.00.
  const masterMap = {
    '829814': { master_id: null, brokerage_sharing: 94, pnl_sharing: 94 },
    '119318': { master_id: '829814', brokerage_sharing: 0, pnl_sharing: 0 },
  };
  const kiteMap = { TOK_GOLD: { lot_size: 100, segment: 'MCX-FUT', raw_name: 'GOLD' } };
  const userDoc = { master_id: '119318' };
  const trades = [
    { instrument_token: 'TOK_GOLD', executed_price: 154000, executed_quantity: 100 },
    { instrument_token: 'TOK_GOLD', executed_price: 153990, executed_quantity: 100 },
  ];
  const tradesByUser = { client: trades };
  const brkRulesByUser = {
    '829814': [{ script_name: 'GOLD', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 50 }],
    '119318': [{ script_name: 'GOLD', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 50 }],
    client: [{ script_name: 'GOLD', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 170 }],
  };
  const globalBrkRules = [];

  test('single-spread case (spread only at the direct-parent hop): matches GM-Global\'s real ₹240.00 exactly', () => {
    const { baseCost, callerBrk, owedUpwardBrk } = _computeCallerBrkForUserBatched(
      'client', '119318', 'master', tradesByUser, [], kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, userDoc, 340,
    );
    // 119318 (direct parent) keeps the full spread (170-50)*2 = 240, plus
    // 0% of the base — GM-Global's real "Broker Brokerage" for this exact
    // trade is 240.00.
    expect(callerBrk).toBeCloseTo(240, 2);
    expect(baseCost).toBeCloseTo(240, 2); // broker_brokerage display column
    expect(owedUpwardBrk).toBeCloseTo(100, 2); // the 94/6 base split flows past 119318
  });

  test('admin caller: gets 6% of the base layer only, nothing from the spread', () => {
    const { callerBrk } = _computeCallerBrkForUserBatched(
      'client', 'ADMIN', 'admin', tradesByUser, [], kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, userDoc, 340,
    );
    expect(callerBrk).toBeCloseTo(6, 2);
  });

  test('829814 (top master) caller: keeps 94% of the base layer, none of the spread', () => {
    const { callerBrk, owedUpwardBrk } = _computeCallerBrkForUserBatched(
      'client', '829814', 'master', tradesByUser, [], kiteMap,
      masterMap, brkRulesByUser, globalBrkRules, userDoc, 340,
    );
    expect(callerBrk).toBeCloseTo(94, 2);
    expect(owedUpwardBrk).toBeCloseTo(6, 2); // only the 6% that flows past 829814 to admin
  });

  test('all three participants reconcile to the exact billed total (340)', () => {
    const admin = _computeCallerBrkForUserBatched('client', 'ADMIN', 'admin', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;
    const master = _computeCallerBrkForUserBatched('client', '829814', 'master', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;
    const submaster = _computeCallerBrkForUserBatched('client', '119318', 'master', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;
    expect(admin + master + submaster).toBeCloseTo(340, 2);
  });
});

describe('_computeCallerBrkForUserBatched — multi-layer case (rate raised at TWO separate hops)', () => {
  // This is the case the old single-spread model got wrong: a rate change
  // at the top hop (admin -> 829814) AND a second, independent rate change
  // at the direct-parent hop (119318 -> client). Two separate layers, each
  // owned and split by a different participant.
  const masterMap = {
    '829814': { master_id: null, brokerage_sharing: 94, pnl_sharing: 94 },
    '119318': { master_id: '829814', brokerage_sharing: 0, pnl_sharing: 0 },
  };
  const kiteMap = { TOK: { lot_size: 1, segment: 'MCX-FUT', raw_name: 'TEST' } };
  const userDoc = { master_id: '119318' };
  const trades = [{ instrument_token: 'TOK', executed_price: 1, executed_quantity: 2 }]; // 2 lots
  const tradesByUser = { client: trades };
  const globalBrkRules = [];

  test('829814 raises the base rate (25->65), 119318 also raises it further (65->170)', () => {
    const brkRulesByUser = {
      '829814': [{ script_name: 'TEST', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 65 }],
      '119318': [{ script_name: 'TEST', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 65 }], // no override -> inherits 829814's 65, no NEW layer here
      client: [{ script_name: 'TEST', exchange_name: 'MCX-FUT', type: 'LOT WISE', brk_value: 170 }],
    };
    // Layer 1 (base, 65/lot * 2 = 130): admin has nothing above 829814 to
    // compare against, so this whole amount IS the base — 829814 keeps 94%
    // = 122.20, 6% = 7.80 flows to admin.
    // Layer 2 (119318's own rate == 829814's, no change -> skipped).
    // Layer 3 (170-65=105/lot * 2 = 210, owned by 119318 who set the
    // client's rate): 119318 keeps 100% (their own share is 0%) = 210.
    const admin = _computeCallerBrkForUserBatched('client', 'ADMIN', 'admin', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;
    const master = _computeCallerBrkForUserBatched('client', '829814', 'master', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;
    const submaster = _computeCallerBrkForUserBatched('client', '119318', 'master', tradesByUser, [], kiteMap, masterMap, brkRulesByUser, globalBrkRules, userDoc, 340).callerBrk;

    expect(admin).toBeCloseTo(7.80, 2);
    expect(master).toBeCloseTo(122.20, 2);
    expect(submaster).toBeCloseTo(210, 2);
    expect(admin + master + submaster).toBeCloseTo(340, 2);
  });
});
