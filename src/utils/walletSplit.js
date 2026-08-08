'use strict';

/**
 * Wallet open/close split helper.
 *
 * Splits an order into the portion that CLOSES the current net position and the
 * portion that OPENS/INCREASES it. This drives the category-wallet release/block
 * on trade execution (design §6.1/§6.2, Requirements 3.1–3.3): the closing
 * portion releases its entry notional, the opening portion blocks new notional.
 *
 * Mirrors the FIFO close logic already used for realised P&L:
 *   - A SELL reduces a long  (prevNetQty > 0): closes min(qty, prevNetQty).
 *   - A BUY  reduces a short (prevNetQty < 0): closes min(qty, |prevNetQty|).
 *   - Any remaining quantity (same-direction, or the excess of a reversal) opens.
 *
 * Pure function of its inputs (no DB / no rounding), so it is unit-testable in
 * isolation and is the single source of truth for the open/close split. Shared
 * by `tradeController.placeTrade` (Task 5) and the pending-fill services
 * `priceQueueService` / `orderExecutionService` (Task 6). Lives in utils rather
 * than a controller so services can import it without pulling in controller
 * dependencies (avoids service→controller circular imports).
 *
 * @param {number} prevNetQty       - net position before this order (+long / -short / 0 flat)
 * @param {'BUY'|'SELL'} transactionType
 * @param {number} quantity         - this order's quantity (treated as absolute)
 * @returns {{closingQty:number, openingQty:number}}
 */
function computeWalletSplit(prevNetQty, transactionType, quantity) {
  const qty = Math.abs(Number(quantity) || 0);
  const prevNet = Number(prevNetQty) || 0;

  let closingQty = 0;
  if (transactionType === 'SELL' && prevNet > 0) {
    closingQty = Math.min(qty, prevNet);            // SELL closes/reduces a long
  } else if (transactionType === 'BUY' && prevNet < 0) {
    closingQty = Math.min(qty, Math.abs(prevNet));  // BUY closes/reduces a short
  }

  const openingQty = qty - closingQty;              // remainder opens/increases (reversal-safe)
  return { closingQty, openingQty };
}

module.exports = { computeWalletSplit };
