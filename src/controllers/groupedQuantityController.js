const GroupedQuantity = require('../models/GroupedQuantity');
const KiteInstrument = require('../models/KiteInstrument');

// Get lot names by exchange
const getLotNamesByExchange = async (req, res) => {
  try {
    const { exchange_name } = req.params;

    if (!exchange_name) {
      return res.status(400).json({
        success: false,
        message: 'Exchange name is required',
        data: null
      });
    }

    const lotNames = await GroupedQuantity.distinct('lot_name', {
      exchange_name: exchange_name.toUpperCase(),
      deleted_at: null
    });

    res.status(200).json({
      success: true,
      message: 'Lot names retrieved successfully',
      data: lotNames
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * GET /api/admin/grouped-quantities/unique-raw-names/:segment
 * Returns all unique raw_name values from KiteInstrument for a given segment,
 * along with the lot_size from the first matching instrument.
 */
const getUniqueRawNamesBySegment = async (req, res) => {
  try {
    const { segment } = req.params;

    if (!segment) {
      return res.status(400).json({
        success: false,
        message: 'Segment is required',
        data: null
      });
    }

    const normalizedSegment = segment.toUpperCase();

    // Map segment to query filters
    let filter = { is_active: true };

    if (normalizedSegment === 'NFO-FUT') {
      filter.segment = 'NFO-FUT';
    } else if (normalizedSegment === 'NFO-OPT') {
      filter.segment = 'NFO-OPT';
    } else if (normalizedSegment === 'MCX-FUT') {
      filter.segment = 'MCX-FUT';
    } else if (normalizedSegment === 'MCX-OPT') {
      filter.segment = 'MCX-OPT';
    } else if (normalizedSegment === 'INDICES') {
      filter.segment = 'INDICES';
    } else if (normalizedSegment === 'NSE') {
      filter.exchange = 'NSE';
      filter.instrument_type = 'EQ';
    } else {
      // Generic fallback: try segment first, then exchange
      filter.segment = normalizedSegment;
    }

    // Aggregate unique raw_names with their lot_size
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$raw_name',
          lot_size: { $first: '$lot_size' },
          instrument_type: { $first: '$instrument_type' },
          segment: { $first: '$segment' },
          exchange: { $first: '$exchange' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const rawNames = results.map(r => ({
      raw_name: r._id,
      lot_size: r.lot_size || 1,
      instrument_type: r.instrument_type,
      segment: r.segment,
      exchange: r.exchange
    }));

    res.status(200).json({
      success: true,
      message: `Found ${rawNames.length} unique instruments for ${normalizedSegment}`,
      data: rawNames
    });
  } catch (error) {
    console.error('Error fetching unique raw names:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * POST /api/admin/grouped-quantities/bulk-create
 * Creates a group with all instruments (raw_names) for a segment.
 * Body: { exchange_name, lot_name, default_max_qty, default_break_qty }
 * Auto-populates all unique raw_names from KiteInstrument for that segment.
 */
const bulkCreateGroup = async (req, res) => {
  try {
    const { exchange_name, lot_name, default_max_qty, default_break_qty } = req.body;

    if (!exchange_name || !lot_name || default_max_qty === undefined || default_break_qty === undefined) {
      return res.status(400).json({
        success: false,
        message: 'exchange_name, lot_name, default_max_qty, and default_break_qty are required',
        data: null
      });
    }

    const normalizedExchange = exchange_name.toUpperCase();

    // Build filter for KiteInstrument
    let filter = { is_active: true };
    if (normalizedExchange === 'NFO-FUT') {
      filter.segment = 'NFO-FUT';
    } else if (normalizedExchange === 'NFO-OPT') {
      filter.segment = 'NFO-OPT';
    } else if (normalizedExchange === 'MCX-FUT') {
      filter.segment = 'MCX-FUT';
    } else if (normalizedExchange === 'MCX-OPT') {
      filter.segment = 'MCX-OPT';
    } else if (normalizedExchange === 'INDICES') {
      filter.segment = 'INDICES';
    } else if (normalizedExchange === 'NSE') {
      filter.exchange = 'NSE';
      filter.instrument_type = 'EQ';
    } else {
      filter.segment = normalizedExchange;
    }

    // Get unique raw_names with lot_size
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$raw_name',
          lot_size: { $first: '$lot_size' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No instruments found for segment ${normalizedExchange}`,
        data: null
      });
    }

    // Bulk upsert all instruments into GroupedQuantity
    const bulkOps = results.map(r => ({
      updateOne: {
        filter: {
          exchange_name: normalizedExchange,
          lot_name: lot_name,
          raw_name: r._id,
          deleted_at: null
        },
        update: {
          $setOnInsert: {
            exchange_name: normalizedExchange,
            lot_name: lot_name,
            raw_name: r._id,
            instrument_id: '',
            instrument_symbol: r._id,
            max_qty: default_max_qty,
            break_qty: default_break_qty,
            lot_size: r.lot_size || 1,
            created_at: new Date()
          },
          $set: {
            updated_at: new Date(),
            deleted_at: null
          }
        },
        upsert: true
      }
    }));

    const bulkResult = await GroupedQuantity.bulkWrite(bulkOps);

    res.status(201).json({
      success: true,
      message: `Group "${lot_name}" created with ${results.length} instruments for ${normalizedExchange}`,
      data: {
        exchange_name: normalizedExchange,
        lot_name: lot_name,
        total_instruments: results.length,
        inserted: bulkResult.upsertedCount,
        existing: results.length - bulkResult.upsertedCount
      }
    });
  } catch (error) {
    console.error('Error bulk creating group:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

/**
 * GET /api/admin/grouped-quantities/group/:exchange_name/:lot_name
 * Returns all instruments in a specific group (exchange + lot_name).
 */
const getGroupInstruments = async (req, res) => {
  try {
    const { exchange_name, lot_name } = req.params;
    const { page = 1, limit = 500 } = req.query;

    if (!exchange_name || !lot_name) {
      return res.status(400).json({
        success: false,
        message: 'exchange_name and lot_name are required',
        data: null
      });
    }

    const filter = {
      exchange_name: exchange_name.toUpperCase(),
      lot_name: lot_name,
      deleted_at: null
    };

    const instruments = await GroupedQuantity.find(filter)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .sort({ raw_name: 1 });

    const count = await GroupedQuantity.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Group instruments retrieved successfully',
      data: {
        instruments: instruments.map(i => i.toJSON()),
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// ============================================
// Shared helper: build KiteInstrument filter from segment name
// ============================================
function buildSegmentFilter(segment) {
  const normalized = segment.toUpperCase();
  let filter = { is_active: true };
  if (normalized === 'NFO-FUT') filter.segment = 'NFO-FUT';
  else if (normalized === 'NFO-OPT') filter.segment = 'NFO-OPT';
  else if (normalized === 'MCX-FUT') filter.segment = 'MCX-FUT';
  else if (normalized === 'MCX-OPT') filter.segment = 'MCX-OPT';
  else if (normalized === 'INDICES') filter.segment = 'INDICES';
  else if (normalized === 'NSE') { filter.exchange = 'NSE'; filter.instrument_type = 'EQ'; }
  else filter.segment = normalized;
  return filter;
}

// ============================================
// Brokerage Settings — Bulk Create & Get by Exchange
// ============================================
const BrokerageSettings = require('../models/BrokerageSettings');

/**
 * POST /api/admin/brokerage-settings/bulk-create
 * Body: { exchange_name, type, default_brk_value }
 */
const bulkCreateBrokerage = async (req, res) => {
  try {
    const { exchange_name, type, default_brk_value } = req.body;
    if (!exchange_name || !type || default_brk_value === undefined) {
      return res.status(400).json({ success: false, message: 'exchange_name, type, and default_brk_value are required', data: null });
    }
    const normalizedExchange = exchange_name.toUpperCase();
    const filter = buildSegmentFilter(normalizedExchange);
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      { $group: { _id: '$raw_name' } },
      { $sort: { _id: 1 } }
    ]);
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: `No instruments found for ${normalizedExchange}`, data: null });
    }
    const bulkOps = results.map(r => ({
      updateOne: {
        filter: { type: type.toUpperCase(), exchange_name: normalizedExchange, script_name: r._id, deleted_at: null },
        update: {
          $setOnInsert: { type: type.toUpperCase(), exchange_name: normalizedExchange, script_name: r._id, brk_value: default_brk_value, created_at: new Date() },
          $set: { updated_at: new Date(), deleted_at: null }
        },
        upsert: true
      }
    }));
    const bulkResult = await BrokerageSettings.bulkWrite(bulkOps);
    res.status(201).json({
      success: true,
      message: `Brokerage created for ${results.length} instruments`,
      data: { exchange_name: normalizedExchange, type, total: results.length, inserted: bulkResult.upsertedCount, existing: results.length - bulkResult.upsertedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * GET /api/admin/brokerage-settings/exchange/:exchange_name
 * Query: ?type=TURNOVER WISE&page=1&limit=500
 */
const getBrokerageByExchange = async (req, res) => {
  try {
    const { exchange_name } = req.params;
    const { type, page = 1, limit = 500 } = req.query;
    const filter = { exchange_name: exchange_name.toUpperCase(), deleted_at: null };
    if (type) filter.type = type.toUpperCase();
    const items = await BrokerageSettings.find(filter)
      .limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit)).sort({ script_name: 1 });
    const count = await BrokerageSettings.countDocuments(filter);
    res.status(200).json({
      success: true, data: { items: items.map(i => i.toJSON()), total: count, page: parseInt(page), pages: Math.ceil(count / parseInt(limit)) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// ============================================
// Trade Margin — Bulk Create & Get by Exchange
// ============================================
const TradeMargin = require('../models/TradeMargin');

/**
 * POST /api/admin/trade-margins/bulk-create
 * Body: { exchange_name, amount_type, default_trade_margin }
 */
const bulkCreateTradeMargin = async (req, res) => {
  try {
    const { exchange_name, amount_type, default_trade_margin } = req.body;
    if (!exchange_name || !amount_type || default_trade_margin === undefined) {
      return res.status(400).json({ success: false, message: 'exchange_name, amount_type, and default_trade_margin are required', data: null });
    }
    const normalizedExchange = exchange_name.toUpperCase();
    const filter = buildSegmentFilter(normalizedExchange);
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      { $group: { _id: '$raw_name' } },
      { $sort: { _id: 1 } }
    ]);
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: `No instruments found for ${normalizedExchange}`, data: null });
    }
    const bulkOps = results.map(r => ({
      updateOne: {
        filter: { exchange_name: normalizedExchange, script_name: r._id, amount_type: amount_type.toLowerCase(), deleted_at: null },
        update: {
          $setOnInsert: { exchange_name: normalizedExchange, script_name: r._id, amount_type: amount_type.toLowerCase(), trade_margin: default_trade_margin, created_at: new Date() },
          $set: { updated_at: new Date(), deleted_at: null }
        },
        upsert: true
      }
    }));
    const bulkResult = await TradeMargin.bulkWrite(bulkOps);
    res.status(201).json({
      success: true,
      message: `Trade margin created for ${results.length} instruments`,
      data: { exchange_name: normalizedExchange, amount_type, total: results.length, inserted: bulkResult.upsertedCount, existing: results.length - bulkResult.upsertedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * GET /api/admin/trade-margins/exchange/:exchange_name
 * Query: ?amount_type=amount&page=1&limit=500
 */
const getTradeMarginByExchange = async (req, res) => {
  try {
    const { exchange_name } = req.params;
    const { amount_type, page = 1, limit = 500 } = req.query;
    const filter = { exchange_name: exchange_name.toUpperCase(), deleted_at: null };
    if (amount_type) filter.amount_type = amount_type.toLowerCase();
    const items = await TradeMargin.find(filter)
      .limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit)).sort({ script_name: 1 });
    const count = await TradeMargin.countDocuments(filter);
    res.status(200).json({
      success: true, data: { items: items.map(i => i.toJSON()), total: count, page: parseInt(page), pages: Math.ceil(count / parseInt(limit)) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// ============================================
// Script Quantity — Bulk Create & Get by Exchange
// ============================================
const ScriptQuantity = require('../models/ScriptQuantity');

/**
 * POST /api/admin/script-quantities/bulk-create
 * Body: { exchange_name, default_max_qty, default_brk_qty }
 */
const bulkCreateScriptQuantity = async (req, res) => {
  try {
    const { exchange_name, default_max_qty, default_brk_qty, owner_id, owner_type } = req.body;
    if (!exchange_name || default_max_qty === undefined || default_brk_qty === undefined) {
      return res.status(400).json({ success: false, message: 'exchange_name, default_max_qty, and default_brk_qty are required', data: null });
    }
    const normalizedExchange = exchange_name.toUpperCase();
    const filter = buildSegmentFilter(normalizedExchange);
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      { $group: { _id: '$raw_name', lot_size: { $first: '$lot_size' } } },
      { $sort: { _id: 1 } }
    ]);
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: `No instruments found for ${normalizedExchange}`, data: null });
    }

    // Determine effective owner: use provided owner_id/owner_type, or fall back to the
    // calling admin so records always have a valid owner.
    const effectiveOwnerId = owner_id || (req.admin ? req.admin.id : req.master?.id);
    const effectiveOwnerType = owner_id ? (owner_type || 'Master') : (req.admin ? 'Admin' : 'Master');

    const baseFilter = { exchange_name: normalizedExchange, owner_id: effectiveOwnerId, owner_type: effectiveOwnerType, deleted_at: null };

    const bulkOps = results.map(r => ({
      updateOne: {
        filter: { ...baseFilter, script_name: r._id },
        update: {
          $setOnInsert: {
            exchange_name: normalizedExchange,
            script_name: r._id,
            lot_size: r.lot_size || 1,
            max_qty: default_max_qty,
            brk_qty: default_brk_qty,
            owner_id: effectiveOwnerId,
            owner_type: effectiveOwnerType,
            created_at: new Date(),
          },
          $set: { updated_at: new Date(), deleted_at: null }
        },
        upsert: true
      }
    }));
    const bulkResult = await ScriptQuantity.bulkWrite(bulkOps);

    // If updating a master's data, cascade to direct users
    if (effectiveOwnerType === 'Master') {
      const { cascadeToDirectUsers } = require('../services/scriptQuantityCopyService');
      for (const r of results) {
        await cascadeToDirectUsers(effectiveOwnerId, normalizedExchange, r._id, {
          max_qty: default_max_qty,
          brk_qty: default_brk_qty,
          lot_size: r.lot_size || 1,
        });
      }
    }

    // If Admin global bulk-create, cascade each script to all Masters and their users
    if (effectiveOwnerType === 'Admin') {
      const { cascadeNewScriptGlobally } = require('../services/scriptQuantityCopyService');
      for (const r of results) {
        await cascadeNewScriptGlobally(normalizedExchange, r._id, {
          lot_size: r.lot_size || 1,
          max_qty: default_max_qty,
          brk_qty: default_brk_qty,
        }, effectiveOwnerId);
      }
    }

    res.status(201).json({
      success: true,
      message: `Script quantity created for ${results.length} instruments`,
      data: { exchange_name: normalizedExchange, total: results.length, inserted: bulkResult.upsertedCount, existing: results.length - bulkResult.upsertedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * GET /api/admin/script-quantities/exchange/:exchange_name
 * Query: ?page=1&limit=500
 */
const getScriptQuantityByExchange = async (req, res) => {
  try {
    const { exchange_name } = req.params;
    const { page = 1, limit = 500, owner_id } = req.query;
    const upperName = exchange_name.toUpperCase();
    // Map GLOBAL → INDICES (same segment naming as brokerage/trade margin)
    const mappedName = upperName === 'GLOBAL' ? 'INDICES' : upperName;
    // Try exact match first, then base exchange (e.g. MCX-FUT → MCX)
    const baseExchange = mappedName.includes('-') ? mappedName.split('-')[0] : null;
    const exchangeFilter = baseExchange
      ? { $in: [mappedName, baseExchange] }
      : mappedName;
    const filter = { exchange_name: exchangeFilter, deleted_at: null };

    // If owner_id is provided, filter to that specific master/user's ScriptQuantity
    if (owner_id) {
      filter.owner_id = owner_id;
      const items = await ScriptQuantity.find(filter)
        .limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit)).sort({ script_name: 1 });
      const count = await ScriptQuantity.countDocuments(filter);
      return res.status(200).json({
        success: true, data: { items: items.map(i => i.toJSON()), total: count, page: parseInt(page), pages: Math.ceil(count / parseInt(limit)) }
      });
    }

    // Admin/Master viewing global list: deduplicate by script_name, prefer Admin-owned records
    // This avoids showing one entry per master/user for the same script
    const allItems = await ScriptQuantity.find(filter).sort({ owner_type: 1, script_name: 1 }).lean();

    // Deduplicate: keep one per script_name (prefer Admin > Master > User)
    const seen = new Map();
    for (const item of allItems) {
      const key = item.script_name;
      if (!seen.has(key)) {
        seen.set(key, item);
      } else {
        // Prefer Admin-owned, then Master, then User
        const existing = seen.get(key);
        const priority = { 'Admin': 0, 'Master': 1, 'User': 2 };
        if ((priority[item.owner_type] || 2) < (priority[existing.owner_type] || 2)) {
          seen.set(key, item);
        }
      }
    }

    const uniqueItems = Array.from(seen.values())
      .sort((a, b) => a.script_name.localeCompare(b.script_name));
    
    // Paginate
    const total = uniqueItems.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginatedItems = uniqueItems.slice(start, start + parseInt(limit));

    // Transform to match toJSON format
    const items = paginatedItems.map(item => {
      const ret = { ...item };
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    });

    res.status(200).json({
      success: true, data: { items, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

module.exports = {
  getLotNamesByExchange,
  getUniqueRawNamesBySegment,
  bulkCreateGroup,
  getGroupInstruments,
  bulkCreateBrokerage,
  getBrokerageByExchange,
  bulkCreateTradeMargin,
  getTradeMarginByExchange,
  bulkCreateScriptQuantity,
  getScriptQuantityByExchange
};
