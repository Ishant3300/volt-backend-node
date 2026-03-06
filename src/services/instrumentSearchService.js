/**
 * Smart Instrument Search Service (Optimized)
 * 
 * Uses pre-built in-memory indexes for O(1) prefix lookups
 * instead of scoring every instrument on each search.
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

// ── Projection: only the fields the UI needs ───────────────
const LEAN_PROJECTION = {
  instrument_token: 1, tradingsymbol: 1, name: 1,
  instrument_type: 1, exchange: 1, segment: 1,
  strike: 1, expiry: 1, lot_size: 1, _id: 1,
};

// ── Cache state ────────────────────────────────────────────
let instrumentList = null;       // flat array of lean docs
let prefixIndex = null;          // Map<prefix, Set<arrayIndex>>
let underlyingIndex = null;      // Map<underlying, Set<arrayIndex>>
let categoryBuckets = null;      // Map<categoryKey, Set<arrayIndex>>
let cacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000;

// Query result cache
const queryCache = new Map();
const QUERY_CACHE_TTL = 60 * 1000;
const MAX_QUERY_CACHE_SIZE = 200;

// ── Underlying extraction (pre-compiled regex) ─────────────
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

// ── Build in-memory indexes ────────────────────────────────
const buildIndexes = (instruments) => {
  const pIdx = new Map();   // prefix -> Set<index>
  const uIdx = new Map();   // underlying -> Set<index>
  const cBuckets = new Map();

  // Pre-init category buckets
  for (const key of Object.keys(CATEGORIES)) {
    cBuckets.set(key, new Set());
  }

  for (let i = 0; i < instruments.length; i++) {
    const inst = instruments[i];
    const sym = inst.tradingsymbol.toUpperCase();
    const name = (inst.name || '').toUpperCase();
    const underlying = extractUnderlying(sym);

    // Store computed underlying on the object for scoring
    inst._underlying = underlying;
    inst._symUpper = sym;
    inst._nameUpper = name;

    // Build prefix index (1-char through 6-char prefixes of symbol & underlying)
    const sources = [sym, underlying];
    if (name && name !== sym) sources.push(name);

    for (const src of sources) {
      const maxLen = Math.min(src.length, 6);
      for (let len = 1; len <= maxLen; len++) {
        const prefix = src.substring(0, len);
        let set = pIdx.get(prefix);
        if (!set) { set = new Set(); pIdx.set(prefix, set); }
        set.add(i);
      }
    }

    // Build underlying index
    if (underlying) {
      let set = uIdx.get(underlying);
      if (!set) { set = new Set(); uIdx.set(underlying, set); }
      set.add(i);
    }

    // Assign to category buckets
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      if (cat.match(inst)) {
        cBuckets.get(key).add(i);
      }
    }
  }

  return { pIdx, uIdx, cBuckets };
};

// ── Load & index instruments ───────────────────────────────
const loadInstrumentCache = async () => {
  const now = Date.now();
  if (instrumentList && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
    return;
  }

  console.log('📦 Loading instruments into memory cache...');

  const instruments = await KiteInstrument.find({
    $or: [
      { instrument_type: { $in: ['FUT', 'CE', 'PE'] } },
      { segment: 'INDICES' },
      { exchange: { $in: ['SGX', 'CDS'] } }
    ]
  }, LEAN_PROJECTION).lean();

  instrumentList = instruments;
  const indexes = buildIndexes(instruments);
  prefixIndex = indexes.pIdx;
  underlyingIndex = indexes.uIdx;
  categoryBuckets = indexes.cBuckets;
  cacheTimestamp = now;

  console.log(`   ✅ Cached ${instruments.length} instruments, ${prefixIndex.size} prefix entries`);
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

// ── Candidate gathering (index-accelerated) ────────────────
const gatherCandidates = (resolved, category) => {
  // Start with category bucket if specified
  let candidateSet = null;

  if (category !== 'ALL' && categoryBuckets.has(category)) {
    candidateSet = new Set(categoryBuckets.get(category));
  }

  // Gather candidates from prefix/underlying indexes
  const searchTerms = [...resolved.underlying, ...resolved.otherTokens];

  if (searchTerms.length > 0) {
    // For each search term, find matching indexes via prefix lookup
    const termSets = [];
    for (const term of searchTerms) {
      const termCandidates = new Set();

      // Try prefix lookup (up to 6 chars)
      const lookupKey = term.substring(0, Math.min(term.length, 6));
      const prefixHits = prefixIndex.get(lookupKey);
      if (prefixHits) {
        for (const idx of prefixHits) termCandidates.add(idx);
      }

      // Also check underlying index for exact match
      const underlyingHits = underlyingIndex.get(term);
      if (underlyingHits) {
        for (const idx of underlyingHits) termCandidates.add(idx);
      }

      if (termCandidates.size > 0) {
        termSets.push(termCandidates);
      }
    }

    // Union all term candidates (OR logic — match any term)
    if (termSets.length > 0) {
      const unionSet = new Set();
      for (const s of termSets) {
        for (const idx of s) unionSet.add(idx);
      }

      if (candidateSet) {
        // Intersect with category bucket
        const intersected = new Set();
        for (const idx of unionSet) {
          if (candidateSet.has(idx)) intersected.add(idx);
        }
        candidateSet = intersected;
      } else {
        candidateSet = unionSet;
      }
    }
  }

  // If no text terms but we have type/exchange filters, use full category or all
  if (!candidateSet) {
    if (category !== 'ALL' && categoryBuckets.has(category)) {
      candidateSet = new Set(categoryBuckets.get(category));
    } else {
      // Fallback: all instruments
      candidateSet = new Set();
      for (let i = 0; i < instrumentList.length; i++) candidateSet.add(i);
    }
  }

  return candidateSet;
};

// ── Scoring (only runs on candidates, not all instruments) ─
const scoreInstrument = (inst, resolved) => {
  let score = 0;
  const sym = inst._symUpper;
  const underlying = inst._underlying;
  const name = inst._nameUpper;

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

  // Ensure cache is loaded
  await loadInstrumentCache();

  const resolved = resolveQuery(query);

  // Gather candidates using indexes (fast)
  const candidateSet = gatherCandidates(resolved, category);

  // Score only the candidates (not all instruments)
  const scored = [];
  for (const idx of candidateSet) {
    const inst = instrumentList[idx];
    const score = scoreInstrument(inst, resolved);
    if (score > 0) {
      scored.push({ instrument: inst, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top results and strip internal fields before sending
  const topResults = scored.slice(0, limit).map(s => {
    const { _underlying, _symUpper, _nameUpper, ...clean } = s.instrument;
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
  prefixIndex = null;
  underlyingIndex = null;
  categoryBuckets = null;
  cacheTimestamp = null;
  queryCache.clear();
  console.log('🗑️  Instrument search cache cleared');
};

module.exports = { smartSearch, getCategories, clearCache, loadInstrumentCache };
