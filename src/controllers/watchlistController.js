const Watchlist = require('../models/Watchlist');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Get user's or admin's watchlist with populated instrument data
 */
const getWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const ownerType = req.admin ? 'Admin' : 'User';

    console.log('📋 Getting watchlist for:', {
      userId,
      ownerType
    });

    const filter = {
      owner_id: userId,
      owner_type: ownerType,
      deleted_at: null,
    };

    console.log('   Query filter:', filter);

    const watchlist = await Watchlist.find(filter)
      .populate('kite_instrument_id')
      .sort({ order: 1 });

    console.log(`   Found ${watchlist.length} documents before filtering`);
    
    // Log each item to see if kite_instrument_id is populated
    watchlist.forEach((item, index) => {
      console.log(`   Item ${index + 1}:`, {
        id: item._id,
        instrument_token: item.instrument_token,
        kite_instrument_id: item.kite_instrument_id ? 'POPULATED' : 'NULL',
        kite_instrument_exists: !!item.kite_instrument_id
      });
    });

    const items = watchlist
      .filter(item => item.kite_instrument_id)
      .map(item => ({
        id: item._id,
        instrument_token: item.instrument_token,
        order: item.order,
        instrument: item.kite_instrument_id,
        created_at: item.createdAt,
      }));

    console.log(`   Returning ${items.length} items after filtering`);

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
 * Add instrument to watchlist
 */
const addToWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const ownerType = req.admin ? 'Admin' : 'User';
    const { kite_instrument_id, instrument_token } = req.body;

    if (!kite_instrument_id || !instrument_token) {
      return res.status(400).json({
        success: false,
        message: 'kite_instrument_id and instrument_token are required',
        data: null,
      });
    }

    // Check if already in watchlist
    const filter = {
      owner_id: userId,
      owner_type: ownerType,
      kite_instrument_id,
      deleted_at: null,
    };

    const existing = await Watchlist.findOne(filter);

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Instrument already in watchlist',
        data: null,
      });
    }

    // Get next order number
    const countFilter = { owner_id: userId, owner_type: ownerType, deleted_at: null };
    const lastItem = await Watchlist.findOne(countFilter).sort({ order: -1 });
    const nextOrder = lastItem ? lastItem.order + 1 : 1;

    const watchlistData = {
      kite_instrument_id,
      instrument_token,
      order: nextOrder,
      owner_id: userId,
      owner_type: ownerType,
    };

    const watchlistItem = await Watchlist.create(watchlistData);

    // Populate instrument data before returning
    await watchlistItem.populate('kite_instrument_id');

    res.status(201).json({
      success: true,
      message: 'Added to watchlist',
      data: {
        id: watchlistItem._id,
        instrument_token: watchlistItem.instrument_token,
        order: watchlistItem.order,
        instrument: watchlistItem.kite_instrument_id,
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
