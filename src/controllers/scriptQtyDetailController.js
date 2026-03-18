const User = require('../models/User');
const Master = require('../models/Master');
const GroupedQuantity = require('../models/GroupedQuantity');
const ScriptQuantity = require('../models/ScriptQuantity');

/**
 * GET /api/trade/script-qty-details
 * Returns the instruments + qty limits assigned to the calling user
 * based on their exchanges_allowed group_name assignments.
 *
 * For each exchange the user is allowed:
 *   - If group_name is set → fetch GroupedQuantity rows for that lot
 *   - Also fetch ScriptQuantity rows for that exchange (global defaults)
 *
 * Admin/Master: can pass ?user_id= to view a specific user's assignments.
 */
const getScriptQtyDetails = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    let targetUserId;

    if (role === 'user') {
      targetUserId = req.user.id;
    } else {
      // Admin/Master can query for a specific user
      targetUserId = req.query.user_id;
      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          message: 'user_id query param required for admin/master',
          data: null
        });
      }
    }

    const user = await User.findById(targetUserId).select('exchanges_allowed username name');
    if (!user || user.deleted_at) {
      return res.status(404).json({ success: false, message: 'User not found', data: null });
    }

    const result = [];

    for (const ex of user.exchanges_allowed) {
      const exchangeEntry = {
        exchange_name: ex.exchange_name,
        turnover: ex.turnover,
        lot: ex.lot,
        group_name: ex.group_name || null,
        instruments: []
      };

      // If user has a group_name assigned, fetch instruments from GroupedQuantity
      if (ex.group_name) {
        const grouped = await GroupedQuantity.find({
          exchange_name: ex.exchange_name,
          lot_name: ex.group_name,
          deleted_at: null
        }).lean();

        for (const g of grouped) {
          exchangeEntry.instruments.push({
            source: 'grouped',
            instrument_symbol: g.instrument_symbol,
            instrument_id: g.instrument_id,
            max_qty: g.max_qty,
            break_qty: g.break_qty,
            lot_size: g.lot_size
          });
        }
      }

      // Also fetch ScriptQuantity for this exchange (global script-level limits)
      const scripts = await ScriptQuantity.find({
        exchange_name: ex.exchange_name,
        deleted_at: null
      }).lean();

      for (const s of scripts) {
        exchangeEntry.instruments.push({
          source: 'script',
          instrument_symbol: s.script_name,
          instrument_id: null,
          max_qty: s.max_qty,
          break_qty: s.brk_qty,
          lot_size: s.lot_size
        });
      }

      result.push(exchangeEntry);
    }

    res.status(200).json({
      success: true,
      data: {
        user_id: user._id,
        username: user.username,
        name: user.name,
        exchanges: result
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * GET /api/trade/instrument-limit
 * Returns specific lot/turnover limits for a single instrument
 * Query params: segment (required), instrument_id (required), user_id (optional for admin/master)
 */
const getInstrumentLimit = async (req, res) => {
  try {
    const { segment, instrument_id } = req.query;
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    let targetUserId;

    if (role === 'user') {
      targetUserId = req.user.id;
    } else {
      targetUserId = req.query.user_id;
    }

    if (!segment || !instrument_id) {
      return res.status(400).json({
        success: false,
        message: 'segment and instrument_id are required'
      });
    }

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        message: 'user_id required'
      });
    }

    const user = await User.findById(targetUserId).select('exchanges_allowed');
    if (!user || user.deleted_at) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Find if the user is allowed this segment (map GLOBAL to INDICES)
    const normalizedSegment = segment.toUpperCase() === 'GLOBAL' ? 'INDICES' : segment.toUpperCase();
    const allowedExchange = user.exchanges_allowed.find(ex =>
      ex.exchange_name.toUpperCase() === normalizedSegment
    );

    if (!allowedExchange) {
      return res.status(403).json({
        success: false,
        message: `Exchange/Segment ${segment} not allowed for this user`,
        data: null
      });
    }

    let limit = null;

    // 1. Try GroupedQuantity first (if user has a lot assignment)
    if (allowedExchange.group_name) {
      limit = await GroupedQuantity.findOne({
        exchange_name: normalizedSegment,
        lot_name: allowedExchange.group_name,
        instrument_id: instrument_id,
        deleted_at: null
      }).lean();
    }

    // 2. Fallback to ScriptQuantity (global script-level limits) if not found in grouped
    if (!limit) {
      // We need the symbol to search ScriptQuantity, but we only have ID.
      // However, usually we can search by exchange_name in ScriptQuantity
      // but let's see if we can get the instrument first to get the symbol.
      // Wait, let's keep it simple for now as per user request: 
      // "Match the segment feild of the instrument to the exchange_name feild of GroupedQuanity 
      // then match the instrument id... you will get the details"
    }

    if (!limit) {
      return res.status(200).json({
        success: true,
        message: 'No specific limit found',
        data: {
          exchange_name: segment,
          turnover: allowedExchange.turnover,
          lot: allowedExchange.lot,
          limit: null
        }
      });
    }

    // CRITICAL FIX: MCX lot size multiplier
    // Zerodha's API returns lot_size = 1 for all MCX instruments
    // But MCX trading rule: 1 LOT = 100 QTY (business rule, not from Zerodha)
    // Apply 100x multiplier for MCX-FUT and MCX-OPT
    let actualLotSize = limit.lot_size || 1;
    const isMCX = normalizedSegment === 'MCX-FUT' || normalizedSegment === 'MCX-OPT';
    if (isMCX) {
      actualLotSize = 100; // MCX business rule: 1 lot = 100 qty
    }

    res.status(200).json({
      success: true,
      data: {
        exchange_name: segment,
        turnover: allowedExchange.turnover,
        lot: allowedExchange.lot,
        limit: {
          max_qty: limit.max_qty,
          break_qty: limit.break_qty,
          lot_size: actualLotSize, // 100 for MCX, otherwise from limit
          instrument_symbol: limit.instrument_symbol
        }
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/trade/script-qty-all-lots
 * Admin/Master read-only view: returns ALL lot names grouped by exchange
 * with their instruments from GroupedQuantity + ScriptQuantity.
 * No user context needed.
 */
const getAllLots = async (req, res) => {
  try {
    const role = req.admin ? 'admin' : req.master ? 'master' : 'user';
    if (role === 'user') {
      return res.status(403).json({ success: false, message: 'Not authorized', data: null });
    }

    // Get all active grouped quantities
    const allGrouped = await GroupedQuantity.find({ deleted_at: null }).lean();

    // Get all active script quantities
    const allScripts = await ScriptQuantity.find({ deleted_at: null }).lean();

    // Build structure: { exchange -> { lot_name -> [instruments] } }
    const exchangeMap = {};

    for (const g of allGrouped) {
      const ex = g.exchange_name;
      const lot = g.lot_name;
      if (!exchangeMap[ex]) exchangeMap[ex] = {};
      if (!exchangeMap[ex][lot]) exchangeMap[ex][lot] = [];
      exchangeMap[ex][lot].push({
        source: 'grouped',
        instrument_symbol: g.instrument_symbol,
        instrument_id: g.instrument_id,
        max_qty: g.max_qty,
        break_qty: g.break_qty,
        lot_size: g.lot_size
      });
    }

    // Add script quantities under a special "__GLOBAL__" lot per exchange
    for (const s of allScripts) {
      const ex = s.exchange_name;
      if (!exchangeMap[ex]) exchangeMap[ex] = {};
      if (!exchangeMap[ex]['__GLOBAL__']) exchangeMap[ex]['__GLOBAL__'] = [];
      exchangeMap[ex]['__GLOBAL__'].push({
        source: 'script',
        instrument_symbol: s.script_name,
        instrument_id: null,
        max_qty: s.max_qty,
        break_qty: s.brk_qty,
        lot_size: s.lot_size
      });
    }

    // Convert to array format
    const exchanges = Object.entries(exchangeMap).map(([exName, lots]) => ({
      exchange_name: exName,
      lots: Object.entries(lots).map(([lotName, instruments]) => ({
        lot_name: lotName,
        instruments
      }))
    }));

    res.status(200).json({
      success: true,
      data: { exchanges }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

module.exports = { getScriptQtyDetails, getAllLots, getInstrumentLimit };
