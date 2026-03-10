/**
 * Smart Instrument Search Service (Optimized v2)
 * 
 * Fixes applied:
 * 1. Two-stage candidate filtering (pre-filter + hard cap before scoring)
 * 2. Tiered prefix index (byUnderlying + bySymbolPrefix)
 * 3. Background cache warming (refresh 30s before TTL expiry)
 * 4. MongoDB streaming cursor with lean projection
 * 5. Score short-circuit + top-K heap
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
const MONTHS = new Set(['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']);

// ── Category filters ───────────────────────────────────────
const CATEGORIES = {
  'NSE-FUT': { label: 'NSE Futures', match: i => i.segment === 'NFO-FUT' && i.instrument_type === 'FUT' },
  'MCX-FUT': { label: 'MCX Futures', match: i => i.exchange === 'MCX' && i.instrument_type === 'FUT' },
  'NSE-OPT': { label: 'NSE Options', match: i => i.segment === 'NFO-OPT' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') },
  'MCX-OPT': { label: 'MCX Options', match: i => i.exchange === 'MCX' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') },
  'NSEIX':   { label: 'NSE Indices', match: i => i.segment === 'INDICES' && i.exchange === 'NSE' },
  'OTHERS':  { label: 'International', match: i => i.exchange === 'SGX' || i.exchange === 'CDS' },
};

// ── Lean projection — only fields the UI needs ─────────────
const LEAN_PROJECTION = {
  instrument_token: 1, tradingsymbol: 1, name: 1,
  instrument_type: 1, exchange: 1, segment: 1,
  strike: 1, expiry: 1, lot_size: 1, _id: 0,
};

// ── Cache state ────────────────────────────────────────────
let instrumentList = null;       // flat array of lean docs
let byUnderlying = null;         // Map<underlying, Set<index>>  (FIX 2 — Tier 1)
let bySymbolPrefix = null;       // Map<prefix6-12, Set<index>>  (FIX 2 — Tier 2)
let categoryBuckets = null;      // Map<categoryKey, Set<index>>
let cacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_WARM_AT = 4.5 * 60 * 1000; // FIX 3 — warm 30s before expiry
let warmingInProgress = false;

// Query result cache
const queryCache = new Map();
const QUERY_CACHE_TTL = 60 * 1000;
const MAX_QUERY_CACHE_SIZE = 200;

// ── Underlying extraction ──────────────────────────────────
const RE_EXPIRY1 = /\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{0,4}/gi;
const RE_EXPIRY2 = /\d{2}[A-Z]{3}\d{2,4}/gi;
const RE_SUFFIX  = /(?:FUT|CE|PE)$/i;
const RE_TRAIL   = /\d+$/g;

const extractUnderlying = (sym) => {
  return sym
    .replace(RE_EXPIRY1, '')
    .replace(RE_EXPIRY2, '')
    .replace(RE_SUFFIX, '')
    .replace(RE_TRAIL, '')
    .trim();
};

// ── FIX 2: Build tiered indexes ────────────────────────────
const buildIndexes = (instruments) => {
  const uIdx = new Map();       // Tier 1: underlying name → Set<index>
  const spIdx = new Map();      // Tier 2: symbol prefix (6-12 chars) → Set<index>
  const cBuckets = new Map();

  for (const key of Object.keys(CATEGORIES)) {
    cBuckets.set(key, new Set());
  }

  for (let i = 0; i < instruments.length; i++) {
    const inst = instruments[i];
    const sym = inst.tradingsymbol.toUpperCase();
    const name = (inst.name || '').toUpperCase();
    const underlying = extractUnderlying(sym);

    // Store computed fields for scoring
    inst._underlying = underlying;
    inst._symUpper = sym;
    inst._nameUpper = name;

    // Tier 1: underlying index (exact name + extracted underlying)
    for (const key of [underlying, name]) {
      if (key) {
        let set = uIdx.get(key);
        if (!set) { set = new Set(); uIdx.set(key, set); }
        set.add(i);
      }
    }

    // Tier 2: symbol prefix index — only prefixes length 5-12
    // Avoids massive buckets from short prefixes (N, NI, NIF...)
    const maxLen = Math.min(sym.length, 12);
    for (let l = 5; l <= maxLen; l++) {
      const prefix = sym.substring(0, l);
      let set = spIdx.get(prefix);
      if (!set) { set = new Set(); spIdx.set(prefix, set); }
      set.add(i);
    }

    // Also index short underlying prefixes (3-6 chars) for typed queries
    if (underlying && underlying.length >= 3) {
      const uMaxLen = Math.min(underlying.length, 6);
      for (let l = 3; l <= uMaxLen; l++) {
        const prefix = underlying.substring(0, l);
        let set = spIdx.get(prefix);
        if (!set) { set = new Set(); spIdx.set(prefix, set); }
        set.add(i);
      }
    }

    // Category buckets
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      if (cat.match(inst)) {
        cBuckets.get(key).add(i);
      }
    }
  }

  return { uIdx, spIdx, cBuckets };
};

// ── FIX 4: Load with streaming cursor ──────────────────────
const loadInstrumentCache = async () => {
  const now = Date.now();

  // FIX 3: Trigger background warm if approaching expiry
  if (instrumentList && cacheTimestamp && (now - cacheTimestamp) > CACHE_WARM_AT && !warmingInProgress) {
    warmingInProgress = true;
    _warmCacheInBackground().finally(() => { warmingInProgress = false; });
  }

  // Return existing cache if still valid
  if (instrumentList && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
    return;
  }

  // Cold start — build synchronously
  await _buildAndSetCache();
};

const _buildAndSetCache = async () => {
  console.log('📦 Loading instruments into memory cache...');
  const startMs = Date.now();

  const instruments = [];
  const cursor = KiteInstrument.find({
    $or: [
      { instrument_type: { $in: ['FUT', 'CE', 'PE'] } },
      { segment: 'INDICES' },
      { exchange: { $in: ['SGX', 'CDS'] } }
    ]
  }, LEAN_PROJECTION).lean().cursor({ batchSize: 10000 });

  for await (const doc of cursor) {
    instruments.push(doc);
  }

  instrumentList = instruments;
  const indexes = buildIndexes(instruments);
  byUnderlying = indexes.uIdx;
  bySymbolPrefix = indexes.spIdx;
  categoryBuckets = indexes.cBuckets;
  cacheTimestamp = Date.now();

  console.log(`   ✅ Cached ${instruments.length} instruments, ${bySymbolPrefix.size} symbol-prefix entries, ${byUnderlying.size} underlying entries (${Date.now() - startMs}ms)`);
};

// FIX 3: Background cache warming
const _warmCacheInBackground = async () => {
  try {
    await _buildAndSetCache();
    console.log('   🔄 Background cache warm complete');
  } catch (err) {
    console.error('[InstrumentSearch] Background cache warm failed:', err.message);
  }
};

// ── Tokenize & resolve ─────────────────────────────────────
const resolveQuery = (query) => {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(t => t.length > 0);
  const resolved = {
    underlying: [], instrumentTypes: [], exchanges: [],
    strikes: [], expiry: [], otherTokens: []
  };

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      resolved.strikes.push(parseInt(token));
      continue;
    }
    if (MONTHS.has(token.toUpperCase())) {
      resolved.expiry.push(token.toUpperCase());
      continue;
    }
    const alias = ALIASES[token];
    if (alias) {
      if (Array.isArray(alias)) {
        resolved.instrumentTypes.push(...alias);
      } else if (INSTRUMENT_TYPES.has(alias)) {
        resolved.instrumentTypes.push(alias);
      } else if (EXCHANGES.has(alias)) {
        resolved.exchanges.push(alias);
      } else {
        resolved.underlying.push(alias);
      }
    } else {
      resolved.otherTokens.push(token.toUpperCase());
    }
  }
  return resolved;
};

// ── FIX 1 + FIX 2: Candidate gathering with tiered lookup + pre-filter + hard cap ──
const gatherCandidates = (resolved, category, rawQuery) => {
  const fullUpper = rawQuery.toUpperCase().replace(/\s+/g, '');
  let candidateSet = null;

  // Start with category bucket if specified
  if (category !== 'ALL' && categoryBuckets.has(category)) {
    candidateSet = new Set(categoryBuckets.get(category));
  }

  // FIX 2: Tiered lookup strategy
  const searchTerms = [...resolved.underlying, ...resolved.otherTokens];

  // Strategy A: If fullUpper >= 5 chars with no spaces → use symbol prefix (most specific)
  if (fullUpper.length >= 5) {
    const lookupKey = fullUpper.substring(0, Math.min(fullUpper.length, 12));
    const hits = bySymbolPrefix.get(lookupKey);
    if (hits && hits.size > 0) {
      const symCandidates = new Set(hits);
      if (candidateSet) {
        // Intersect with category
        const intersected = new Set();
        for (const idx of symCandidates) {
          if (candidateSet.has(idx)) intersected.add(idx);
        }
        candidateSet = intersected.size > 0 ? intersected : symCandidates;
      } else {
        candidateSet = symCandidates;
      }
    }
  }

  // Strategy B: If no symbol prefix hits or short query, use underlying index
  if (!candidateSet || candidateSet.size === 0) {
    const termSets = [];
    for (const term of searchTerms) {
      const termCandidates = new Set();

      // Check underlying index (exact)
      const underlyingHits = byUnderlying.get(term);
      if (underlyingHits) {
        for (const idx of underlyingHits) termCandidates.add(idx);
      }

      // Check symbol prefix index
      const prefixKey = term.substring(0, Math.min(term.length, 12));
      const prefixHits = bySymbolPrefix.get(prefixKey);
      if (prefixHits) {
        for (const idx of prefixHits) termCandidates.add(idx);
      }

      if (termCandidates.size > 0) termSets.push(termCandidates);
    }

    if (termSets.length > 0) {
      const unionSet = new Set();
      for (const s of termSets) {
        for (const idx of s) unionSet.add(idx);
      }

      if (candidateSet && candidateSet.size > 0) {
        const intersected = new Set();
        for (const idx of unionSet) {
          if (candidateSet.has(idx)) intersected.add(idx);
        }
        candidateSet = intersected.size > 0 ? intersected : unionSet;
      } else {
        candidateSet = unionSet;
      }
    }
  }

  // Direct tradingsymbol startsWith refinement for long queries
  if (fullUpper.length > 6 && candidateSet && candidateSet.size > 200) {
    const refined = new Set();
    for (const idx of candidateSet) {
      if (instrumentList[idx]._symUpper.startsWith(fullUpper)) {
        refined.add(idx);
      }
    }
    if (refined.size > 0) candidateSet = refined;
  }

  // FIX 1: Pre-filter by strikes before scoring
  if (resolved.strikes.length > 0 && candidateSet && candidateSet.size > 500) {
    const strikeStrs = resolved.strikes.map(String);
    const filtered = new Set();
    for (const idx of candidateSet) {
      const inst = instrumentList[idx];
      if (strikeStrs.some(s => inst._symUpper.includes(s) || inst.strike === resolved.strikes[0])) {
        filtered.add(idx);
      }
    }
    if (filtered.size > 0) candidateSet = filtered;
  }

  // FIX 1: Pre-filter by expiry
  if (resolved.expiry.length > 0 && candidateSet && candidateSet.size > 500) {
    const filtered = new Set();
    for (const idx of candidateSet) {
      if (resolved.expiry.some(e => instrumentList[idx]._symUpper.includes(e))) {
        filtered.add(idx);
      }
    }
    if (filtered.size > 0) candidateSet = filtered;
  }

  // FIX 1: Pre-filter by instrument type
  if (resolved.instrumentTypes.length > 0 && candidateSet && candidateSet.size > 500) {
    const filtered = new Set();
    for (const idx of candidateSet) {
      if (resolved.instrumentTypes.includes(instrumentList[idx].instrument_type)) {
        filtered.add(idx);
      }
    }
    if (filtered.size > 0) candidateSet = filtered;
  }

  // FIX 1: Hard cap — never score more than 500 candidates
  if (candidateSet && candidateSet.size > 500) {
    const primaryUnderlying = resolved.underlying[0] || '';
    const arr = [...candidateSet];
    // Sort: exact underlying matches first
    arr.sort((a, b) => {
      const aExact = instrumentList[a]._nameUpper === primaryUnderlying ? 0 : 1;
      const bExact = instrumentList[b]._nameUpper === primaryUnderlying ? 0 : 1;
      return aExact - bExact;
    });
    candidateSet = new Set(arr.slice(0, 500));
  }

  // Fallback: if nothing found, use category or all
  if (!candidateSet || candidateSet.size === 0) {
    if (category !== 'ALL' && categoryBuckets.has(category)) {
      candidateSet = new Set(categoryBuckets.get(category));
    } else {
      candidateSet = new Set();
      const max = Math.min(instrumentList.length, 500);
      for (let i = 0; i < max; i++) candidateSet.add(i);
    }
  }

  return candidateSet;
};

// ── Scoring (unchanged logic, runs on much smaller candidate set now) ──
const scoreInstrument = (inst, resolved, rawQuery) => {
  let score = 0;
  const sym = inst._symUpper;
  const underlying = inst._underlying;
  const name = inst._nameUpper;

  const fullUpper = rawQuery.toUpperCase().replace(/\s+/g, '');
  if (fullUpper.length > 3 && sym.startsWith(fullUpper)) {
    score += 25;
    if (sym === fullUpper) score += 15;
  }

  for (const u of resolved.underlying) {
    if (underlying === u) score += 15;
    else if (underlying.includes(u)) score += 10;
  }

  for (const token of resolved.otherTokens) {
    if (underlying === token) score += 15;
    else if (sym.startsWith(token)) score += 12;
    else if (underlying.startsWith(token)) score += 10;
    else if (sym.includes(token)) score += 6;
    else if (name.includes(token)) score += 4;
  }

  if (resolved.instrumentTypes.length > 0) {
    if (resolved.instrumentTypes.includes(inst.instrument_type)) score += 8;
    else score -= 5;
  }

  if (resolved.exchanges.length > 0) {
    if (resolved.exchanges.includes(inst.exchange)) score += 5;
    else if (resolved.exchanges.includes('NFO') && inst.segment && inst.segment.startsWith('NFO')) score += 5;
    else score -= 3;
  }

  if (resolved.strikes.length > 0) {
    for (const strike of resolved.strikes) {
      if (inst.strike === strike) score += 10;
      else if (Math.abs(inst.strike - strike) < 100) score += 3;
    }
  }

  if (resolved.expiry.length > 0) {
    for (const month of resolved.expiry) {
      if (sym.includes(month)) score += 6;
    }
  }

  const fullQuery = [...resolved.underlying, ...resolved.otherTokens].join('');
  if (sym === fullQuery) score += 20;

  return score;
};

// ── FIX 5: Score short-circuit + top-K heap ────────────────
const scoreAndRank = (candidateSet, resolved, rawQuery, topK) => {
  const results = [];
  const heapSize = topK * 3; // keep 3x buffer for grouping diversity
  let perfectFound = false;

  for (const idx of candidateSet) {
    // Short-circuit: if we found a perfect match and have enough results, stop
    if (perfectFound && results.length >= heapSize) break;

    const inst = instrumentList[idx];
    const score = scoreInstrument(inst, resolved, rawQuery);
    if (score <= 0) continue;

    if (score >= 50) perfectFound = true;

    // Maintain top-K heap
    if (results.length < heapSize) {
      results.push({ idx, score });
    } else {
      // Find min score in results and replace if current is better
      let minIdx = 0;
      for (let j = 1; j < results.length; j++) {
        if (results[j].score < results[minIdx].score) minIdx = j;
      }
      if (score > results[minIdx].score) {
        results[minIdx] = { idx, score };
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
};

// ── Group results ──────────────────────────────────────────
const groupResults = (instruments) => {
  const groups = {
    'Index': [], 'Futures': [], 'Call Options (CE)': [],
    'Put Options (PE)': [], 'Equity': [], 'Other': []
  };

  for (const inst of instruments) {
    if (inst.segment === 'INDICES' || inst.instrument_type === 'IDX') groups['Index'].push(inst);
    else if (inst.instrument_type === 'FUT') groups['Futures'].push(inst);
    else if (inst.instrument_type === 'CE') groups['Call Options (CE)'].push(inst);
    else if (inst.instrument_type === 'PE') groups['Put Options (PE)'].push(inst);
    else if (inst.instrument_type === 'EQ') groups['Equity'].push(inst);
    else groups['Other'].push(inst);
  }

  return Object.entries(groups)
    .filter(([_, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
};

// ── Main search entry point ────────────────────────────────
const smartSearch = async (query, category = 'ALL', limit = 50) => {
  if (!query || query.trim().length === 0) {
    return { groups: [], total: 0, query: '' };
  }

  // Check query cache
  const cacheKey = `${query.toLowerCase()}_${category}_${limit}`;
  const cached = queryCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < QUERY_CACHE_TTL) {
    return cached.result;
  }

  await loadInstrumentCache();

  const resolved = resolveQuery(query);
  const candidateSet = gatherCandidates(resolved, category, query);

  // FIX 5: Use scoreAndRank with short-circuit instead of scoring all + sorting all
  const ranked = scoreAndRank(candidateSet, resolved, query, limit);

  // Strip internal fields
  const topResults = ranked.map(r => {
    const { _underlying, _symUpper, _nameUpper, ...clean } = instrumentList[r.idx];
    return clean;
  });

  const groups = groupResults(topResults);
  const result = { groups, total: topResults.length, query };

  // Cache result
  if (queryCache.size >= MAX_QUERY_CACHE_SIZE) {
    const firstKey = queryCache.keys().next().value;
    queryCache.delete(firstKey);
  }
  queryCache.set(cacheKey, { result, timestamp: Date.now() });

  return result;
};

const getCategories = () => {
  return Object.entries(CATEGORIES).map(([key, value]) => ({
    key, label: value.label
  }));
};

const clearCache = () => {
  instrumentList = null;
  byUnderlying = null;
  bySymbolPrefix = null;
  categoryBuckets = null;
  cacheTimestamp = null;
  queryCache.clear();
  console.log('🗑️  Instrument search cache cleared');
};

module.exports = { smartSearch, getCategories, clearCache, loadInstrumentCache };
