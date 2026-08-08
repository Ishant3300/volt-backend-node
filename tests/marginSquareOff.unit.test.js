'use strict';

// Validates: Requirements 7.1–7.3, 7.6 (boolean toggle → square off when the live
// M2M loss reaches the FULL credit, `m2m ≤ -credit`; OFF → never; replaces the old
// equity rule) and 8.1–8.3, 8.5, 8.6 (percentage → square off when the live M2M
// loss reaches pct% of credit, `m2m ≤ -(credit × pct/100)`; 0/unset → never; both
// active → whichever crosses first; replaces the old equity rule). The rule works
// identically for a User- OR Master-shaped OWNER (design §8).
//
// `shouldSquareOff` is a pure, synchronous function exported from the service.
// Requiring the service pulls in mongoose models, but that only registers schemas
// (no DB connection is opened), so we can call the pure function directly.

const { shouldSquareOff } = require('../src/services/marginSquareOffService');

describe('shouldSquareOff — M2M rule (design §8)', () => {
  describe('Requirement 7 — boolean toggle (credit ₹50,000, threshold m2m ≤ -50000)', () => {
    const owner = { username: 'u1', credits: 50000, margin_square_off: true };

    test('m2m = -50000 exactly (= -credit) → true (Req 7.2 boundary)', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -50000 })).toBe(true);
    });

    test('m2m = -49999.99 (loss just under credit) → false', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -49999.99 })).toBe(false);
    });

    test('m2m = -50000.01 (past the boundary) → true', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -50000.01 })).toBe(true);
    });

    test('m2m = 0 → false', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: 0 })).toBe(false);
    });

    test('m2m positive (profit) → false', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: 12345.67 })).toBe(false);
    });

    test('toggle OFF, no percentage → false regardless of m2m (Req 7.3)', () => {
      const off = { username: 'u1', credits: 50000, margin_square_off: false };
      expect(shouldSquareOff(off, { m2m_pnl: -999999 })).toBe(false);
    });
  });

  describe('Requirement 8 — percentage (toggle OFF, pct 30, credit ₹50,000, threshold m2m ≤ -15000)', () => {
    const owner = {
      username: 'u2',
      credits: 50000,
      margin_square_off: false,
      margin_square_off_percentage: 30,
    };

    test('m2m = -15000 exactly (= -(credit×30%)) → true (Req 8.2 boundary)', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -15000 })).toBe(true);
    });

    test('m2m = -14999.99 (loss just under threshold) → false', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -14999.99 })).toBe(false);
    });

    test('m2m = -15000.01 (past the threshold) → true', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -15000.01 })).toBe(true);
    });

    test('pct = 0 → false regardless of m2m (Req 8.3)', () => {
      const zero = { username: 'u2', credits: 50000, margin_square_off: false, margin_square_off_percentage: 0 };
      expect(shouldSquareOff(zero, { m2m_pnl: -50000 })).toBe(false);
    });

    test('pct unset → false regardless of m2m (Req 8.3)', () => {
      const unset = { username: 'u2', credits: 50000, margin_square_off: false };
      expect(shouldSquareOff(unset, { m2m_pnl: -50000 })).toBe(false);
    });

    test('credit = 0 with pct > 0 → false (guard credit > 0)', () => {
      const noCredit = { username: 'u2', credits: 0, margin_square_off: false, margin_square_off_percentage: 30 };
      expect(shouldSquareOff(noCredit, { m2m_pnl: -1 })).toBe(false);
      expect(shouldSquareOff(noCredit, { m2m_pnl: -100000 })).toBe(false);
    });
  });

  describe('Requirement 8.5 — both toggle AND percentage active (credit ₹50,000, pct 30)', () => {
    const owner = {
      username: 'u3',
      credits: 50000,
      margin_square_off: true,
      margin_square_off_percentage: 30,
    };

    test('loss of -15000 crosses the pct threshold (well before -credit) → true', () => {
      // -15000 does NOT reach -credit (-50000) but DOES reach -(credit×30%) = -15000.
      expect(shouldSquareOff(owner, { m2m_pnl: -15000 })).toBe(true);
    });

    test('small loss of -100 crosses neither threshold → false', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -100 })).toBe(false);
    });

    test('loss of -50000 crosses both thresholds → true', () => {
      expect(shouldSquareOff(owner, { m2m_pnl: -50000 })).toBe(true);
    });
  });

  describe('Requirements 7.4 / 8.4 — same rule works for a Master-shaped owner', () => {
    test('master toggle: m2m = -credit → true; just under → false', () => {
      const master = { username: 'master1', credits: 50000, margin_square_off: true };
      expect(shouldSquareOff(master, { m2m_pnl: -50000 })).toBe(true);
      expect(shouldSquareOff(master, { m2m_pnl: -49999.99 })).toBe(false);
    });

    test('master percentage: m2m = -(credit×30%) → true; just under → false', () => {
      const master = {
        username: 'master1',
        credits: 50000,
        margin_square_off: false,
        margin_square_off_percentage: 30,
      };
      expect(shouldSquareOff(master, { m2m_pnl: -15000 })).toBe(true);
      expect(shouldSquareOff(master, { m2m_pnl: -14999.99 })).toBe(false);
    });
  });

  describe('null / undefined guards → false', () => {
    test('null owner → false', () => {
      expect(shouldSquareOff(null, { m2m_pnl: -50000 })).toBe(false);
    });

    test('undefined owner → false', () => {
      expect(shouldSquareOff(undefined, { m2m_pnl: -50000 })).toBe(false);
    });

    test('null metrics → false', () => {
      expect(shouldSquareOff({ username: 'u1', credits: 50000, margin_square_off: true }, null)).toBe(false);
    });

    test('undefined metrics → false', () => {
      expect(shouldSquareOff({ username: 'u1', credits: 50000, margin_square_off: true }, undefined)).toBe(false);
    });

    test('metrics without m2m_pnl (treated as 0) → false under a live toggle', () => {
      expect(shouldSquareOff({ username: 'u1', credits: 50000, margin_square_off: true }, {})).toBe(false);
    });
  });
});
