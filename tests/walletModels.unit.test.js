'use strict';

// Validates: Requirements 2.1 (wallet on User & Master), 7.4 / 8.4 (master
// margin_square_off toggle parity with User).
//
// Confirms the schema-level contract for the new wallet field and the master
// square-off toggle: category defaults, the `min: 0` never-negative guard, and
// that `wallet` (and the toggle) survive each model's toJSON transform.
// These checks run offline — instantiating a document and calling
// validateSync/toJSON does not require a Mongo connection.

const User = require('../src/models/User');
const Master = require('../src/models/Master');

describe('User wallet schema', () => {
  test('defaults to zero balances in every category', () => {
    const u = new User();
    expect(u.wallet.NSE).toBe(0);
    expect(u.wallet.MCX).toBe(0);
    expect(u.wallet.GLOBAL).toBe(0);
  });

  test('exposes wallet in toJSON output', () => {
    const json = new User().toJSON();
    expect(json).toHaveProperty('wallet');
    expect(json.wallet).toEqual({ NSE: 0, MCX: 0, GLOBAL: 0 });
  });

  test('rejects a negative category balance (min: 0 guard)', () => {
    const u = new User();
    u.wallet.NSE = -1;
    const err = u.validateSync(['wallet.NSE']);
    expect(err).toBeDefined();
    expect(err.errors['wallet.NSE']).toBeDefined();
  });
});

describe('Master wallet schema + margin_square_off toggle', () => {
  test('defaults to zero balances in every category', () => {
    const m = new Master();
    expect(m.wallet.NSE).toBe(0);
    expect(m.wallet.MCX).toBe(0);
    expect(m.wallet.GLOBAL).toBe(0);
  });

  test('exposes wallet in toJSON output', () => {
    const json = new Master().toJSON();
    expect(json).toHaveProperty('wallet');
    expect(json.wallet).toEqual({ NSE: 0, MCX: 0, GLOBAL: 0 });
  });

  test('adds a first-class margin_square_off boolean defaulting to false', () => {
    const m = new Master();
    expect(m.margin_square_off).toBe(false);
    expect(m.toJSON()).toHaveProperty('margin_square_off', false);
  });

  test('rejects a negative category balance (min: 0 guard)', () => {
    const m = new Master();
    m.wallet.MCX = -0.01;
    const err = m.validateSync(['wallet.MCX']);
    expect(err).toBeDefined();
    expect(err.errors['wallet.MCX']).toBeDefined();
  });
});
