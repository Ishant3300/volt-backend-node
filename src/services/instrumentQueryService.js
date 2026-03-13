/**
 * Instrument Query Service
 * 
 * Handles instrument queries with expiry management:
 * - Nearest expiry filtering for search/dropdowns
 * - All expiries retrieval for admin/reporting
 * - Global indices queries
 */

const KiteInstrument = require('../models/KiteInstrument');

// Allowed exchanges for derivatives
const ALLOWED_EXCHANGES = ['BFO', 'NFO', 'MCX'];
const ALLOWED_INSTRUMENT_TYPES = ['FUT', 'CE', 'PE'];

class InstrumentQueryService {
  /**
   * Get instruments with nearest upcoming expiry only
   * Used for search, order entry, and dropdowns
   * 
   * For FUT: Returns one contract per symbol (nearest expiry)
   * For CE/PE: Returns all strikes but only nearest expiry per symbol
   */
  async getNearestExpiryInstruments(options = {}) {
    const {
      exchange = null,
      instrumentType = null,
      symbol = null,
      limit = 100
    } = options;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build match stage
    const matchStage = {
      instrument_type: { $in: instrumentType ? [instrumentType] : ALLOWED_INSTRUMENT_TYPES },
      exchange: { $in: exchange ? [exchange] : ALLOWED_EXCHANGES },
      expiry: { $gte: today }
    };

    if (symbol) {
      matchStage.name = { $regex: `^${symbol}`, $options: 'i' };
    }

    // For FUT: Group by symbol, get nearest expiry
    // For CE/PE: Group by symbol + strike, get nearest expiry
    const pipeline = [
      { $match: matchStage },
      { $sort: { expiry: 1 } },
      {
        $group: {
          _id: {
            name: '$name',
            instrument_type: '$instrument_type',
            // For options, include strike in grouping
            strike: { $cond: [{ $in: ['$instrument_type', ['CE', 'PE']] }, '$strike', null] }
          },
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { name: 1, strike: 1, instrument_type: 1 } },
      { $limit: limit }
    ];

    return KiteInstrument.aggregate(pipeline);
  }

  /**
   * Search instruments with nearest expiry filter
   * Returns only the nearest upcoming expiry contract per symbol
   */
  async searchWithNearestExpiry(query, options = {}) {
    const {
      exchange = null,
      instrumentType = null,
      limit = 50
    } = options;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build match stage
    const matchStage = {
      $or: [
        { tradingsymbol: { $regex: `^${escapedQuery}`, $options: 'i' } },
        { name: { $regex: `^${escapedQuery}`, $options: 'i' } },
        { display_name: { $regex: escapedQuery, $options: 'i' } }
      ],
      instrument_type: { $in: instrumentType ? [instrumentType] : ALLOWED_INSTRUMENT_TYPES },
      exchange: { $in: exchange ? [exchange] : ALLOWED_EXCHANGES },
      expiry: { $gte: today }
    };

    const pipeline = [
      { $match: matchStage },
      { $sort: { expiry: 1 } },
      {
        $group: {
          _id: {
            name: '$name',
            instrument_type: '$instrument_type',
            strike: { $cond: [{ $in: ['$instrument_type', ['CE', 'PE']] }, '$strike', null] }
          },
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { name: 1, strike: 1, instrument_type: 1 } },
      { $limit: limit }
    ];

    return KiteInstrument.aggregate(pipeline);
  }

  /**
   * Get all expiries for a symbol (admin/reporting use)
   * Returns all contracts including past expiries
   */
  async getAllExpiriesForSymbol(symbol, instrumentType = null) {
    const filter = {
      name: { $regex: `^${symbol}$`, $options: 'i' }
    };

    if (instrumentType) {
      filter.instrument_type = instrumentType;
    } else {
      filter.instrument_type = { $in: ALLOWED_INSTRUMENT_TYPES };
    }

    return KiteInstrument.find(filter)
      .sort({ expiry: 1, strike: 1, instrument_type: 1 })
      .lean();
  }

  /**
   * Get global indices
   */
  async getGlobalIndices() {
    return KiteInstrument.find({
      segment: 'INDICES'
    })
      .select('instrument_token tradingsymbol name display_name raw_name exchange segment')
      .sort({ display_name: 1 })
      .lean();
  }

  /**
   * Get instruments without upcoming expiry (for admin dashboard flagging)
   */
  async getInstrumentsWithoutUpcomingExpiry() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all unique symbols
    const allSymbols = await KiteInstrument.distinct('name', {
      instrument_type: { $in: ALLOWED_INSTRUMENT_TYPES },
      exchange: { $in: ALLOWED_EXCHANGES }
    });

    // Get symbols with upcoming expiry
    const symbolsWithExpiry = await KiteInstrument.distinct('name', {
      instrument_type: { $in: ALLOWED_INSTRUMENT_TYPES },
      exchange: { $in: ALLOWED_EXCHANGES },
      expiry: { $gte: today }
    });

    // Find symbols without upcoming expiry
    const symbolsWithoutExpiry = allSymbols.filter(s => !symbolsWithExpiry.includes(s));

    return symbolsWithoutExpiry;
  }

  /**
   * Get option chain for a symbol (nearest expiry)
   */
  async getOptionChain(symbol, options = {}) {
    const {
      exchange = 'NFO',
      expiry = null // If null, use nearest expiry
    } = options;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let targetExpiry = expiry;

    // If no expiry specified, find the nearest one
    if (!targetExpiry) {
      const nearestExpiry = await KiteInstrument.findOne({
        name: { $regex: `^${symbol}$`, $options: 'i' },
        instrument_type: { $in: ['CE', 'PE'] },
        exchange,
        expiry: { $gte: today }
      })
        .sort({ expiry: 1 })
        .select('expiry')
        .lean();

      if (!nearestExpiry) {
        return { calls: [], puts: [], expiry: null };
      }

      targetExpiry = nearestExpiry.expiry;
    }

    // Get all options for this expiry
    const [calls, puts] = await Promise.all([
      KiteInstrument.find({
        name: { $regex: `^${symbol}$`, $options: 'i' },
        instrument_type: 'CE',
        exchange,
        expiry: targetExpiry
      })
        .sort({ strike: 1 })
        .lean(),
      KiteInstrument.find({
        name: { $regex: `^${symbol}$`, $options: 'i' },
        instrument_type: 'PE',
        exchange,
        expiry: targetExpiry
      })
        .sort({ strike: 1 })
        .lean()
    ]);

    return {
      calls,
      puts,
      expiry: targetExpiry
    };
  }

  /**
   * Get available expiries for a symbol
   */
  async getAvailableExpiries(symbol, instrumentType = null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const filter = {
      name: { $regex: `^${symbol}$`, $options: 'i' },
      expiry: { $gte: today }
    };

    if (instrumentType) {
      filter.instrument_type = instrumentType;
    } else {
      filter.instrument_type = { $in: ALLOWED_INSTRUMENT_TYPES };
    }

    const expiries = await KiteInstrument.distinct('expiry', filter);
    return expiries.sort((a, b) => new Date(a) - new Date(b));
  }

  /**
   * Get instrument stats for admin dashboard
   */
  async getInstrumentStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalCount,
      derivativesCount,
      indicesCount,
      activeExpiriesCount,
      expiredCount,
      byExchange,
      byInstrumentType
    ] = await Promise.all([
      KiteInstrument.countDocuments(),
      KiteInstrument.countDocuments({ instrument_type: { $in: ALLOWED_INSTRUMENT_TYPES } }),
      KiteInstrument.countDocuments({ segment: 'INDICES' }),
      KiteInstrument.countDocuments({ expiry: { $gte: today } }),
      KiteInstrument.countDocuments({ expiry: { $lt: today, $ne: null } }),
      KiteInstrument.aggregate([
        { $group: { _id: '$exchange', count: { $sum: 1 } } }
      ]),
      KiteInstrument.aggregate([
        { $group: { _id: '$instrument_type', count: { $sum: 1 } } }
      ])
    ]);

    return {
      total: totalCount,
      derivatives: derivativesCount,
      indices: indicesCount,
      activeExpiries: activeExpiriesCount,
      expired: expiredCount,
      byExchange: byExchange.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      byInstrumentType: byInstrumentType.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {})
    };
  }
}

module.exports = new InstrumentQueryService();
