'use strict';

/**
 * Wallet category helpers.
 *
 * Every user/master trade wallet is split into three category pools: NSE, MCX
 * and GLOBAL. A trade's segment — and an account's allowed exchanges — map into
 * exactly one of these categories via a fixed rule:
 *
 *   NFO-FUT, NFO-OPT  -> NSE
 *   MCX-FUT, MCX-OPT  -> MCX
 *   everything else   -> GLOBAL   (SGX, INDICES, GLOBAL, BFO-FUT, BFO-OPT,
 *                                  NSE, NFO, OTHERS, ...)
 *
 * This is the single source of truth for the mapping, mirrored in the Flutter
 * client for display only.
 */

const CATEGORY = Object.freeze({ NSE: 'NSE', MCX: 'MCX', GLOBAL: 'GLOBAL' });

// Canonical order used when returning a distinct set of categories, so callers
// (and tests) get a deterministic result regardless of input ordering.
const CATEGORY_ORDER = Object.freeze([CATEGORY.NSE, CATEGORY.MCX, CATEGORY.GLOBAL]);

/**
 * Map a segment / exchange name to its wallet category.
 * Case-insensitive; anything unrecognised falls back to GLOBAL.
 *
 * @param {string} [segment] - e.g. 'NFO-FUT', 'MCX-OPT', 'SGX'
 * @returns {'NSE'|'MCX'|'GLOBAL'}
 */
function categoryForSegment(segment = '') {
  const s = String(segment == null ? '' : segment).trim().toUpperCase();
  if (s === 'NFO-FUT' || s === 'NFO-OPT') return CATEGORY.NSE;
  if (s === 'MCX-FUT' || s === 'MCX-OPT') return CATEGORY.MCX;
  return CATEGORY.GLOBAL;
}

/**
 * Distinct wallet categories an account can trade, derived from its
 * `exchanges_allowed`.
 *
 * Handles both persisted shapes:
 *   - Master: array of strings                -> ['NFO-FUT', 'MCX', ...]
 *   - User:   array of { exchange_name, ... }  -> [{ exchange_name: 'NFO-FUT' }]
 *
 * Blank/empty/malformed entries are ignored. Result is returned in canonical
 * order (NSE, MCX, GLOBAL) with duplicates removed.
 *
 * @param {Array<string|{exchange_name?: string}>} [exchangesAllowed]
 * @returns {Array<'NSE'|'MCX'|'GLOBAL'>}
 */
function allowedCategories(exchangesAllowed = []) {
  if (!Array.isArray(exchangesAllowed)) return [];

  const found = new Set();
  for (const entry of exchangesAllowed) {
    if (entry == null) continue;
    const name = typeof entry === 'string' ? entry : entry.exchange_name;
    if (name == null || String(name).trim() === '') continue;
    found.add(categoryForSegment(name));
  }

  return CATEGORY_ORDER.filter((category) => found.has(category));
}

module.exports = {
  CATEGORY,
  categoryForSegment,
  allowedCategories,
};
