/**
 * Calculate the margin required for a trade — notional model.
 *
 * Margin is the full traded notional: |quantity| × price. This is independent
 * of any per-instrument configuration, so the same formula applies to both
 * quantity-based and lot-based instruments (for lot-based instruments the
 * stored quantity already equals lots × lot_size).
 *
 * The `exchange` and `opts` parameters are retained for backward compatibility
 * with existing callers but are no longer used in the calculation.
 *
 * @param {string} exchange    - Exchange/segment name (unused; kept for signature compatibility)
 * @param {number} quantity    - Total stored quantity (for lots this is lots × lot_size)
 * @param {number} price       - Execution/entry price per unit
 * @param {object} [opts]      - Optional params (unused; kept for signature compatibility)
 * @returns {Promise<number>} margin amount = |quantity| × price
 */
const calculateMargin = async (exchange, quantity, price, opts = {}) => {
  return Math.abs(Number(quantity) || 0) * (Number(price) || 0);
};

module.exports = { calculateMargin };
