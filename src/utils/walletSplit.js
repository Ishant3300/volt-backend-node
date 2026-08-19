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

/**
 * Average-cost position state for the CURRENTLY open position only — walks a
 * chronologically-sorted trade list and resets the running buy/sell totals
 * whenever net quantity crosses or lands on 0, instead of summing every
 * completed trade since last settlement regardless of whether the position
 * was fully closed and reopened in between.
 *
 * Real bug this fixes: an account that closes and reopens the same
 * contract more than once within a settlement week — completely normal
 * for an active trader — got its average entry price silently blended
 * with an earlier, already-closed round trip. Confirmed against a real
 * trade: BUY 30 @ 57562.60 -> SELL 30 @ 57810.00 showed P&L +3171.00
 * instead of the correct 7422.00, only explainable by a stale prior
 * fill leaking into the average.
 *
 * A PARTIAL close (order smaller than the open position, so net qty
 * changes sign-preserving without crossing/landing on zero) must
 * decrement the closed side's own totals by the qty actually matched —
 * not accumulate the closing trade into the opposite side's totals, and
 * not leave the closed side's totals untouched either, since further
 * opens on the same side after a partial close would then average
 * against the ORIGINAL (pre-partial-close) qty instead of what's truly
 * still open. Confirmed with a worked example: BUY 50@100, partial SELL
 * 20 (still long 30), BUY 30@120 (now long 60) should average to
 * (30*100 + 30*120)/60 = 110; without decrementing on the partial close
 * it computed 107.5 against a phantom 80-qty position.
 *
 * Also handles a same-trade flip (one fill larger than the current net
 * position, closing it AND opening the opposite side in one row — this
 * platform allows that in general; order size is only capped at the
 * current position when an admin has disabled the instrument) by seeding
 * the new side's average from just the excess beyond the close, at that
 * trade's own price, since net quantity can jump straight past zero
 * without ever landing on it exactly.
 *
 * This is the single shared implementation backing the equivalent logic
 * already independently verified in priceQueueService.js
 * (positionStateSinceLastFlat) and orderExecutionService.js — pulled out
 * here for tradeController.js's four separate call sites (immediate-fill
 * P&L, floating P&L, the FSL profit check, and deleteTrade's wallet
 * reversal) rather than re-implementing it a fourth, fifth, sixth and
 * seventh time inline.
 *
 * @param {Array<{transaction_type: 'BUY'|'SELL', executed_quantity: number, executed_price: number}>} trades - chronologically sorted, oldest first
 * @returns {{netQty: number, totalBuyQty: number, totalSellQty: number, totalBuyValue: number, totalSellValue: number}}
 */
function computeFlatResetState(trades) {
  let netQty = 0;
  let totalBuyQty = 0, totalSellQty = 0, totalBuyValue = 0, totalSellValue = 0;

  for (const t of trades) {
    const isBuy = t.transaction_type === 'BUY';
    const qty = Number(t.executed_quantity) || 0;
    const price = Number(t.executed_price) || 0;
    const prevNet = netQty;
    const afterNet = prevNet + (isBuy ? qty : -qty);
    const isClosing = (isBuy && prevNet < 0) || (!isBuy && prevNet > 0);

    if (isClosing) {
      const closingQty = Math.min(qty, Math.abs(prevNet));
      if (isBuy) {
        // BUY closes/reduces a short — decrement the short side by the qty matched.
        const avgSell = totalSellQty > 0 ? totalSellValue / totalSellQty : 0;
        totalSellQty -= closingQty;
        totalSellValue -= closingQty * avgSell;
      } else {
        // SELL closes/reduces a long — decrement the long side by the qty matched.
        const avgBuy = totalBuyQty > 0 ? totalBuyValue / totalBuyQty : 0;
        totalBuyQty -= closingQty;
        totalBuyValue -= closingQty * avgBuy;
      }

      const excessQty = qty - closingQty;
      if (excessQty > 0) {
        // Same-trade flip — the excess beyond the close opens a fresh
        // position on this trade's own side, at this trade's own price.
        // The closed side is already at zero from the decrement above.
        if (isBuy) { totalBuyQty += excessQty; totalBuyValue += excessQty * price; }
        else { totalSellQty += excessQty; totalSellValue += excessQty * price; }
      }
    } else if (isBuy) {
      totalBuyQty += qty;
      totalBuyValue += qty * price;
    } else {
      totalSellQty += qty;
      totalSellValue += qty * price;
    }

    netQty = afterNet;
  }

  return { netQty, totalBuyQty, totalSellQty, totalBuyValue, totalSellValue };
}

module.exports = { computeWalletSplit, computeFlatResetState };
