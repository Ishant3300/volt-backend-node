const Watchlist = require('../models/Watchlist');
const KiteInstrument = require('../models/KiteInstrument');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Get user's or admin's watchlist with populated instrument data.
 * Uses instrument_token as the reliable lookup key because kite_instrument_id
 * ObjectRefs can become stale when the KiteInstrument collection is re-seeded.
 */
const getWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const ownerType = req.admin ? 'Admin' : 'User';

    console.log('📋 Getting watchlist for:', { userId, ownerType });

    const filter = {
      owner_id: userId,
      owner_type: ownerType,
      deleted_at: null,
    };

    // Fetch watchlist docs without populate (we'll look up by instrument_token)
    const watchlist = await Watchlist.find(filter).sort({ order: 1 }).lean();

    console.log(`   Found ${watchlist.length} watchlist documents`);

    if (watchlist.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Found 0 watchlist items',
        data: [],
      });
    }

    // Collect all instrument_tokens from the watchlist
    const tokens = watchlist.map(w => w.instrument_token);

    // Bulk-fetch KiteInstrument docs by instrument_token (always up-to-date)
    const instruments = await KiteInstrument.find({
      instrument_token: { $in: tokens },
    }).lean();

    console.log(`   Found ${instruments.length} KiteInstrument matches by token`);

    // Build a map: instrument_token -> instrument doc
    const instrumentMap = {};
    for (const inst of instruments) {
      instrumentMap[inst.instrument_token] = inst;
    }

    // Self-heal: update any watchlist docs whose kite_instrument_id is stale
    const healPromises = [];
    for (const w of watchlist) {
      const inst = instrumentMap[w.instrument_token];
      if (inst) {
        const storedRef = w.kite_instrument_id?.toString();
        const currentId = inst._id.toString();
        if (storedRef !== currentId) {
          console.log(`   🔧 Healing stale ref for token ${w.instrument_token}: ${storedRef} -> ${currentId}`);
          healPromises.push(
            Watchlist.updateOne({ _id: w._id }, { kite_instrument_id: inst._id })
          );
        }
      }
    }
    if (healPromises.length > 0) {
      await Promise.all(healPromises);
      console.log(`   ✅ Healed ${healPromises.length} stale kite_instrument_id references`);
    }

    // Build response items — skip any where we couldn't find the instrument
    const items = watchlist
      .filter(w => instrumentMap[w.instrument_token])
      .map(w => ({
        id: w._id,
        instrument_token: w.instrument_token,
        order: w.order,
        instrument: instrumentMap[w.instrument_token],
        created_at: w.createdAt,
      }));

    console.log(`   Returning ${items.length} items`);

    res.status(200).json({
      success: true,
      message: `Found ${items.length} watchlist items`,
      data: items,
    });
  } catch (error) {
    console.error('Error getting watchlist:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null,
    });
  }
};

/**
 * Add instrument to watchlist.
 * Resolves the current kite_instrument_id from the KiteInstrument collection
 * by instrument_token to avoid storing stale ObjectIds.
 */
const addToWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const ownerType = req.admin ? 'Admin' : 'User';
    const { kite_instrument_id, instrument_token } = req.body;

    if (!instrument_token) {
      return res.status(400).json({
        success: false,
        message: 'instrument_token is required',
        data: null,
      });
    }

    // Always resolve the current ObjectId from DB by instrument_token
    const instrument = await KiteInstrument.findOne({ instrument_token }).lean();
    if (!instrument) {
      return res.status(404).json({
        success: false,
        message: `Instrument with token ${instrument_token} not found`,
        data: null,
      });
    }

    const resolvedInstrumentId = instrument._id;

    // Check if already in watchlist (by instrument_token to handle stale refs)
    const existing = await Watchlist.findOne({
      owner_id: userId,
      owner_type: ownerType,
      instrument_token,
      deleted_at: null,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Instrument already in watchlist',
        data: null,
      });
    }

    // Get next order number
    const lastItem = await Watchlist.findOne(
      { owner_id: userId, owner_type: ownerType, deleted_at: null }
    ).sort({ order: -1 });
    const nextOrder = lastItem ? lastItem.order + 1 : 1;

    const watchlistItem = await Watchlist.create({
      kite_instrument_id: resolvedInstrumentId,
      instrument_token,
      order: nextOrder,
      owner_id: userId,
      owner_type: ownerType,
    });

    res.status(201).json({
      success: true,
      message: 'Added to watchlist',
      data: {
        id: watchlistItem._id,
        instrument_token: watchlistItem.instrument_token,
        order: watchlistItem.order,
        instrument,
      },
    });
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null,
    });
  }
};

/**
 * Remove instrument from watchlist (soft delete)
 */
const removeFromWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const ownerType = req.admin ? 'Admin' : 'User';
    const { id } = req.params;

    const filter = {
      _id: id,
      owner_id: userId,
      owner_type: ownerType,
      deleted_at: null,
    };

    const item = await Watchlist.findOneAndUpdate(
      filter,
      { deleted_at: new Date() },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist item not found',
        data: null,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Removed from watchlist',
      data: null,
    });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null,
    });
  }
};

module.exports = {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
};
