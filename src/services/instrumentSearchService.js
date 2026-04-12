/**
 * Smart Instrument Search Service (v3 — In-memory, no query cache)
 * 
 * Loads instruments into memory on server start (one-time ~10s).
 * Searches run in <1ms from memory.
 * Expired instruments excluded. Only nearest expiry per underlying shown.
 */

const KiteInstrument = require('../models/KiteInstrument');

// ── Alias map ──────────────────────────────────────────────
const ALIASES = {
  'fut': 'FUT', 'future': 'FUT', 'futures': 'FUT',
  'call': 'CE', 'ce': 'CE',
  'put': 'PE', 'pe': 'PE',
  'opt': ['CE', 'PE'], 'option': ['CE', 'PE'], 'options': ['CE', 'PE'],
  'eq': 'EQ', 'stock': 'EQ', 'index': 'IDX', 'idx': 'IDX',
  'nse': 'NSE', 'nfo': 'NFO', 'mcx': 'MCX', 'bse': 'BSE', 'sgx': 'SGX',
  'nifty': 'NIFTY', 'banknifty': 'BANKNIFTY', 'bank': 'BANKNIFTY',
  'sensex': 'SENSEX', 'finnifty': 'FINNIFTY', 'midcpnifty': 'MIDCPNIFTY',
  'gift': 'NIFTY',
};

const INSTRUMENT_TYPES = new Set(['FUT', 'CE', 'PE', 'EQ', 'IDX']);
const EXCHANGES = new Set(['NSE', 'NFO', 'MCX', 'BSE', 'SGX', 'CDS']);
const MONTHS = new Set(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

// ── Category filters ───────────────────────────────────────
const CATEGORIES = {
  'NFO-FUT': { label: 'NFO Futures', match: i => i.segment === 'NFO-FUT' && i.instrument_type === 'FUT' },
  'MCX-FUT': { label: 'MCX Futures', match: i => i.exchange === 'MCX' && i.instrument_type === 'FUT' },
  'NFO-OPT': { label: 'NFO Options', match: i => i.segment === 'NFO-OPT' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') },
  'MCX-OPT': { label: 'MCX Options', match: i => i.exchange === 'MCX' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') },
  'GLOBAL': { label: 'Global Indices', match: i => i.segment === 'INDICES' || i.exchange === 'SGX' || i.exchange === 'GLOBAL' },
};

const LEAN_PROJECTION = {
  instrument_token: 1, tradingsymbol: 1, name: 1,
  instrument_type: 1, exchange: 1, segment: 1,
  strike: 1, expiry: 1, lot_size: 1, tick_size: 1,
  raw_name: 1, display_name: 1, _id: 0,
};

// ── Cache state (loaded once on server start) ──────────────
let instrumentList = null;
let byUnderlying = null;
let bySymbolPrefix = null;
let categoryBuckets = null;
let cacheTimestamp = null;
let cacheLoadingPromise = null; // prevents duplicate loads
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Edit distance for fuzzy matching ───────────────────────
const getEditDistance = (a, b) => {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp = Array.from({ length: la + 1 }, (_, i) => i);
  for (let j = 1; j <= lb; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= la; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[la];
};

// ── Extract underlying from tradingsymbol ──────────────────
const extractUnderlying = (sym) => {
  const m = sym.match(/^([A-Z]+)/);
  return m ? m[1] : sym;
};

// ── Build indexes from instrument list ─────────────────────
const buildIndexes = (instruments) => {
  const uIdx = new Map();
  const spIdx = new Map();
  const cBuckets = new Map();

  for (let i = 0; i < instruments.length; i++) {
    const inst = instruments[i];
    const sym = inst.tradingsymbol || '';
    const name = (inst.name || '').toUpperCase();
    const underlying = name || extractUnderlying(sym.toUpperCase());

    inst._symUpper = sym.toUpperCase();
    inst._nameUpper = name;
    inst._underlying = underlying;

    // Underlying index
    if (!uIdx.has(underlying)) uIdx.set(underlying, new Set());
    uIdx.get(underlying).add(i);

    // Symbol prefix index (3-12 char prefixes)
    const symUp = inst._symUpper;
    for (let len = 3; len <= Math.min(symUp.length, 12); len++) {
      const prefix = symUp.substring(0, len);
      if (!spIdx.has(prefix)) spIdx.set(prefix, new Set());
      spIdx.get(prefix).add(i);
    }

    // Category buckets
    for (const [catKey, catDef] of Object.entries(CATEGORIES)) {
      if (catDef.match(inst)) {
        if (!cBuckets.has(catKey)) cBuckets.set(catKey, new Set());
        cBuckets.get(catKey).add(i);
      }
    }
  }

  return { uIdx, spIdx, cBuckets };
};

// ── Load instruments into memory ───────────────────────────
const loadInstrumentCache = async () => {
  if (instrumentList && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL) return;
  // If already loading, wait for the existing promise instead of starting a new one
  if (cacheLoadingPromise) return cacheLoadingPromise;
  cacheLoadingPromise = _buildAndSetCache().finally(() => { cacheLoadingPromise = null; });
  return cacheLoadingPromise;
};

const _buildAndSetCache = async () => {
  console.log('📦 [Search] Loading instruments into memory...');
  const startMs = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Single optimized query: only active, non-expired derivatives + indices + global
  const rawInstruments = await KiteInstrument.find({
    is_active: true,
    $or: [
      // Derivatives: only non-expired
      { instrument_type: { $in: ['FUT', 'CE', 'PE'] }, expiry: { $gte: today } },
      // Indices (no expiry)
      { segment: 'INDICES' },
      // Global/SGX
      { exchange: { $in: ['SGX', 'GLOBAL'] } },
    ]
  }, LEAN_PROJECTION).lean();

  // Keep only the nearest expiry per (raw_name + instrument_type) combination.
  // This ensures SILVER, SILVERM, SILVERMIC all show with their closest expiry,
  // even if they expire in different months.
  const nearestMap = new Map(); // key: "raw_name|instrument_type" → instrument with nearest expiry
  for (const inst of rawInstruments) {
    if (!inst.expiry || inst.segment === 'INDICES') {
      // Non-expiring instruments (indices, etc.) — always include
      const key = `${inst.instrument_token}`;
      nearestMap.set(key, inst);
      continue;
    }
    const rawName = inst.raw_name || inst.name || '';
    const type = inst.instrument_type || '';
    // For options, include strike in the key so each strike is separate
    const strikeKey = (type === 'CE' || type === 'PE') ? `|${inst.strike}` : '';
    const key = `${rawName}|${type}${strikeKey}`;
    const existing = nearestMap.get(key);
    if (!existing) {
      nearestMap.set(key, inst);
    } else {
      const existingExpiry = new Date(existing.expiry).getTime();
      const newExpiry = new Date(inst.expiry).getTime();
      if (newExpiry < existingExpiry) {
        nearestMap.set(key, inst);
      }
    }
  }
  const instruments = [...nearestMap.values()];

  instrumentList = instruments;
  const indexes = buildIndexes(instruments);
  byUnderlying = indexes.uIdx;
  bySymbolPrefix = indexes.spIdx;
  categoryBuckets = indexes.cBuckets;
  cacheTimestamp = Date.now();

  console.log(`   ✅ [Search] ${instruments.length} instruments ready (from ${rawInstruments.length} non-expired) in ${Date.now() - startMs}ms`);
};

// ── Query resolution ───────────────────────────────────────
const resolveQuery = (query) => {
  const tokens = query.trim().toUpperCase().split(/\s+/);
  const underlying = [];
  const instrumentTypes = [];
  const strikes = [];
  const expiry = [];
  const otherTokens = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const alias = ALIASES[lower];
    if (alias) {
      if (Array.isArray(alias)) instrumentTypes.push(...alias);
      else if (INSTRUMENT_TYPES.has(alias)) instrumentTypes.push(alias);
      else underlying.push(alias);
    } else if (INSTRUMENT_TYPES.has(token)) {
      instrumentTypes.push(token);
    } else if (/^\d+$/.test(token) && token.length >= 3) {
      strikes.push(parseInt(token));
    } else if (MONTHS.has(token)) {
      expiry.push(token);
    } else if (token.length >= 2) {
      underlying.push(token);
    }
  }

  return { underlying, instrumentTypes, strikes, expiry, otherTokens };
};

// ── Candidate gathering ────────────────────────────────────
const gatherCandidates = (resolved, category, rawQuery) => {
  const fullUpper = rawQuery.toUpperCase().replace(/\s+/g, '');
  let candidateSet = null;
  let categorySet = null;

  if (category !== 'ALL' && categoryBuckets.has(category)) {
    categorySet = categoryBuckets.get(category);
  }

  const searchTerms = [...resolved.underlying, ...resolved.otherTokens];

  // Strategy 1: Symbol prefix lookup (works for any length >= 3)
  if (fullUpper.length >= 3) {
    const lookupKey = fullUpper.substring(0, Math.min(fullUpper.length, 12));
    const hits = bySymbolPrefix.get(lookupKey);
    if (hits && hits.size > 0) {
      candidateSet = new Set(hits);
    }
  }

  // Strategy 2: Underlying index lookup
  if (!candidateSet || candidateSet.size === 0) {
    for (const term of searchTerms) {
      const termCandidates = new Set();

      // Exact underlying match
      const underlyingHits = byUnderlying.get(term);
      if (underlyingHits) for (const idx of underlyingHits) termCandidates.add(idx);

      // Symbol prefix match
      const prefixKey = term.substring(0, Math.min(term.length, 12));
      const prefixHits = bySymbolPrefix.get(prefixKey);
      if (prefixHits) for (const idx of prefixHits) termCandidates.add(idx);

      // Fuzzy only for longer terms with no hits
      if (term.length >= 5 && termCandidates.size === 0) {
        const maxTypos = term.length >= 6 ? 2 : 1;
        for (const u of byUnderlying.keys()) {
          if (u.length >= 3 && getEditDistance(term, u.substring(0, term.length)) <= maxTypos) {
            const fuzzyHits = byUnderlying.get(u);
            if (fuzzyHits) for (const idx of fuzzyHits) termCandidates.add(idx);
          }
        }
      }

      // Also match all underlyings that START WITH the search term
      // e.g. "SILVER" matches "SILVER", "SILVERM", "SILVERMIC"
      if (term.length >= 3) {
        for (const [u, idxSet] of byUnderlying) {
          if (u.startsWith(term) && u !== term) {
            for (const idx of idxSet) termCandidates.add(idx);
          }
        }
      }

      if (termCandidates.size > 0) {
        if (!candidateSet) candidateSet = new Set();
        for (const idx of termCandidates) candidateSet.add(idx);
      }
    }
  }

  // Intersect with category if both exist
  if (candidateSet && candidateSet.size > 0 && categorySet) {
    const intersected = new Set();
    for (const idx of candidateSet) {
      if (categorySet.has(idx)) intersected.add(idx);
    }
    if (intersected.size > 0) candidateSet = intersected;
  }

  // Pre-filter by instrument type
  if (resolved.instrumentTypes.length > 0 && candidateSet && candidateSet.size > 0) {
    const filtered = new Set();
    for (const idx of candidateSet) {
      if (resolved.instrumentTypes.includes(instrumentList[idx].instrument_type)) filtered.add(idx);
    }
    if (filtered.size > 0) candidateSet = filtered;
  }

  // Pre-filter by strike
  if (resolved.strikes.length > 0 && candidateSet && candidateSet.size > 50) {
    const filtered = new Set();
    for (const idx of candidateSet) {
      if (resolved.strikes.includes(instrumentList[idx].strike)) filtered.add(idx);
    }
    if (filtered.size > 0) candidateSet = filtered;
  }

  // Hard cap
  if (candidateSet && candidateSet.size > 500) {
    const primary = resolved.underlying[0] || '';
    const arr = [...candidateSet];
    arr.sort((a, b) => {
      const aExact = instrumentList[a]._nameUpper === primary ? 0 : 1;
      const bExact = instrumentList[b]._nameUpper === primary ? 0 : 1;
      return aExact - bExact;
    });
    candidateSet = new Set(arr.slice(0, 500));
  }

  if (!candidateSet || candidateSet.size === 0) {
    candidateSet = new Set();
  }

  return candidateSet;
};

// ── Scoring ────────────────────────────────────────────────
const scoreInstrument = (inst, resolved, rawQuery) => {
  let score = 0;
  const nameUp = inst._nameUpper;
  const symUp = inst._symUpper;
  const queryUp = rawQuery.toUpperCase().replace(/\s+/g, '');

  // Exact name match
  if (resolved.underlying.length > 0) {
    if (nameUp === resolved.underlying[0]) score += 100;
    else if (nameUp.startsWith(resolved.underlying[0])) score += 60;
  }

  // Symbol prefix match
  if (symUp.startsWith(queryUp)) score += 80;
  else if (symUp.includes(queryUp)) score += 30;

  // Type match bonus
  if (resolved.instrumentTypes.length > 0 && resolved.instrumentTypes.includes(inst.instrument_type)) score += 40;

  // FUT bonus (futures are usually more relevant)
  if (inst.instrument_type === 'FUT') score += 20;

  // Index bonus
  if (inst.segment === 'INDICES') score += 15;

  return score;
};

const scoreAndRank = (candidateSet, resolved, rawQuery, topK) => {
  const scored = [];
  for (const idx of candidateSet) {
    const score = scoreInstrument(instrumentList[idx], resolved, rawQuery);
    scored.push({ idx, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
};

// ── Group results for display ──────────────────────────────
const groupResults = (instruments) => {
  const groups = {};
  const groupOrder = ['Index', 'Futures', 'Call Options (CE)', 'Put Options (PE)', 'MCX-OPT', 'Other'];

  for (const inst of instruments) {
    const type = inst.instrument_type || '';
    const segment = inst.segment || '';
    const exchange = inst.exchange || '';
    let label;
    if (segment === 'INDICES' || type === 'IDX') label = 'Index';
    else if (type === 'FUT') label = 'Futures';
    else if (segment === 'MCX-OPT' || (exchange === 'MCX' && (type === 'CE' || type === 'PE'))) label = 'MCX-OPT';
    else if (type === 'CE') label = 'Call Options (CE)';
    else if (type === 'PE') label = 'Put Options (PE)';
    else label = 'Other';

    if (!groups[label]) groups[label] = [];
    groups[label].push(inst);
  }

  const result = [];
  for (const key of groupOrder) {
    if (groups[key] && groups[key].length > 0) {
      result.push({ label: key, items: groups[key] });
    }
  }
  return result;
};

// ── Main search ────────────────────────────────────────────
const smartSearch = async (query, category = 'ALL', limit = 10, page = 1) => {
  if (!query || query.trim().length === 0) {
    return { groups: [], total: 0, query: '', page, hasMore: false };
  }

  // If cache not ready, return empty instead of blocking the request
  if (!instrumentList) {
    // Trigger load in background if not already loading
    loadInstrumentCache();
    return { groups: [], total: 0, query, page, hasMore: false, loading: true };
  }

  const resolved = resolveQuery(query);
  const candidateSet = gatherCandidates(resolved, category, query);
  const ranked = scoreAndRank(candidateSet, resolved, query, 200);

  const allResults = ranked.map(r => {
    const { _underlying, _symUpper, _nameUpper, ...clean } = instrumentList[r.idx];
    return clean;
  });

  // Sort: nearest expiry first
  allResults.sort((a, b) => {
    const aExp = a.expiry ? new Date(a.expiry) : null;
    const bExp = b.expiry ? new Date(b.expiry) : null;
    if (!aExp && bExp) return -1;
    if (aExp && !bExp) return 1;
    if (aExp && bExp) return aExp - bExp;
    return 0;
  });

  const start = (page - 1) * limit;
  const pageResults = allResults.slice(start, start + limit);
  const hasMore = start + limit < allResults.length;
  const groups = groupResults(pageResults);

  return { groups, total: allResults.length, query, page, hasMore };
};

const getCategories = () => Object.keys(CATEGORIES);
const clearCache = () => { instrumentList = null; cacheTimestamp = null; };

module.exports = { smartSearch, loadInstrumentCache, clearCache, getCategories, groupResults };
