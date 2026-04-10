const FreshStoplossLimit = require('../models/FreshStoplossLimit');
const KiteInstrument = require('../models/KiteInstrument');

/**
 * GET /admin/fresh-stoploss-limits
 * List all limits, optionally filtered by exchange_name
 */
const getAllFreshStoplossLimits = async (req, res) => {
  try {
    const { exchange_name, limit = 500 } = req.query;
    const filter = { deleted_at: null };
    if (exchange_name) filter.exchange_name = exchange_name.toUpperCase();

    const docs = await FreshStoplossLimit.find(filter)
      .sort({ raw_name: 1 })
      .limit(parseInt(limit))
      .lean();

    res.status(200).json({ success: true, data: docs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /admin/fresh-stoploss-limits/bulk-create
 * Bulk create/update limits for all raw_names in a segment.
 * Body: { exchange_name, time_minutes, price_offset }
 * Fetches all unique raw_names from KiteInstrument for that segment and creates entries.
 */
const bulkCreateFreshStoplossLimits = async (req, res) => {
  try {
    const { exchange_name, time_minutes, price_offset } = req.body;
    if (!exchange_name) {
      return res.status(400).json({ success: false, message: 'exchange_name is required' });
    }

    const seg = exchange_name.toUpperCase();

    // Build filter matching the same logic as getUniqueRawNamesBySegment
    let filter = { is_active: true };
    if (seg === 'INDICES' || seg === 'GLOBAL') {
      filter.segment = 'INDICES';
    } else if (seg === 'NSE') {
      filter.exchange = 'NSE';
      filter.instrument_type = 'EQ';
    } else {
      filter.segment = seg;
    }

    // Get all unique raw_names for this segment
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      { $group: { _id: '$raw_name' } },
      { $sort: { _id: 1 } }
    ]);
    const rawNames = results.map(r => r._id).filter(n => n && n.length > 0);

    // Store using the actual segment name (INDICES for GLOBAL)
    const storeSeg = (seg === 'GLOBAL') ? 'INDICES' : seg;

    if (rawNames.length === 0) {
      return res.status(400).json({ success: false, message: `No instruments found for segment ${seg}` });
    }

    let created = 0, updated = 0;

    for (const rawName of rawNames) {
      if (!rawName) continue;
      const existing = await FreshStoplossLimit.findOne({
        exchange_name: storeSeg,
        raw_name: rawName,
        deleted_at: null
      });

      if (existing) {
        existing.time_minutes = time_minutes ?? existing.time_minutes;
        existing.price_offset = price_offset ?? existing.price_offset;
        await existing.save();
        updated++;
      } else {
        await FreshStoplossLimit.create({
          exchange_name: storeSeg,
          raw_name: rawName,
          time_minutes: time_minutes || 0,
          price_offset: price_offset || 0,
        });
        created++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Created ${created}, updated ${updated} limits for ${seg}`,
      data: { created, updated, total: rawNames.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /admin/fresh-stoploss-limits/:id
 * Update a single limit entry
 */
const updateFreshStoplossLimit = async (req, res) => {
  try {
    const { id } = req.params;
    const { time_minutes, price_offset } = req.body;

    const doc = await FreshStoplossLimit.findOne({ _id: id, deleted_at: null });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    if (time_minutes !== undefined) doc.time_minutes = time_minutes;
    if (price_offset !== undefined) doc.price_offset = price_offset;
    await doc.save();

    res.status(200).json({ success: true, message: 'Updated', data: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /admin/fresh-stoploss-limits/:id
 * Soft delete
 */
const deleteFreshStoplossLimit = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await FreshStoplossLimit.findOne({ _id: id, deleted_at: null });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    doc.deleted_at = new Date();
    await doc.save();

    res.status(200).json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /admin/fresh-stoploss-limits/bulk-update
 * Bulk update time_minutes and/or price_offset for all entries in a segment.
 * Body: { exchange_name, time_minutes?, price_offset? }
 */
const bulkUpdateFreshStoplossLimits = async (req, res) => {
  try {
    const { exchange_name, time_minutes, price_offset } = req.body;
    if (!exchange_name) {
      return res.status(400).json({ success: false, message: 'exchange_name is required' });
    }

    const update = {};
    if (time_minutes !== undefined) update.time_minutes = time_minutes;
    if (price_offset !== undefined) update.price_offset = price_offset;
    update.updated_at = new Date();

    const result = await FreshStoplossLimit.updateMany(
      { exchange_name: exchange_name.toUpperCase(), deleted_at: null },
      { $set: update }
    );

    res.status(200).json({
      success: true,
      message: `Updated ${result.modifiedCount} limits`,
      data: { modified: result.modifiedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getAllFreshStoplossLimits,
  bulkCreateFreshStoplossLimits,
  updateFreshStoplossLimit,
  deleteFreshStoplossLimit,
  bulkUpdateFreshStoplossLimits,
};
