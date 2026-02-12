const Watchlist = require('../models/Watchlist');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Get user's or admin's watchlist with populated instrument data
 */
const getWatchlist = async (req, res) => {
  try {
    const userId = req.user?.id || req.admin?.id;
    const isAdmin = req.admin !== null;

    const filter = {
      deleted_at: null,
    };

    if (isAdmin) {
      filter.admin_id = userId;
    } else {
      filter.user_id = userId;
    }

    const watchlist = await Watchlist.find(filter)
      .populate('kite_instrument_id')
      .sort({ order: 1 });

    const items = watchlist
      .filter(item => item.kite_instrument_id)
      .map(item => ({
        id: item._id,
        instrument_token: item.instrument_token,
        order: item.order,
        instrument: item.kite_instrument_id,
        created_at: item.createdAt,
      }));

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
    const isAdmin = req.admin !== null;
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
      kite_instrument_id,
      deleted_at: null,
    };

    if (isAdmin) {
      filter.admin_id = userId;
    } else {
      filter.user_id = userId;
    }

    const existing = await Watchlist.findOne(filter);

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Instrument already in watchlist',
        data: null,
      });
    }

    let watchlistData = {
      kite_instrument_id,
      instrument_token,
    };

    if (isAdmin) {
      // Admin watchlist - use admin's ID for all fields
      const countFilter = { admin_id: userId, deleted_at: null };
      const lastItem = await Watchlist.findOne(countFilter).sort({ order: -1 });
      const nextOrder = lastItem ? lastItem.order + 1 : 1;

      watchlistData = {
        ...watchlistData,
        order: nextOrder,
        admin_id: userId,
        master_id: userId, // For admin, use same ID
        user_id: userId,   // For admin, use same ID
      };
    } else {
      // User watchlist - get master_id and admin_id from user
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          data: null,
        });
      }

      const master = await Master.findById(user.master_id);
      if (!master) {
        return res.status(404).json({
          success: false,
          message: 'Master not found',
          data: null,
        });
      }

      const countFilter = { user_id: userId, deleted_at: null };
      const lastItem = await Watchlist.findOne(countFilter).sort({ order: -1 });
      const nextOrder = lastItem ? lastItem.order + 1 : 1;

      watchlistData = {
        ...watchlistData,
        order: nextOrder,
        user_id: userId,
        master_id: user.master_id,
        admin_id: master.admin_id,
      };
    }

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
    const isAdmin = req.admin !== null;
    const { id } = req.params;

    const filter = {
      _id: id,
      deleted_at: null,
    };

    if (isAdmin) {
      filter.admin_id = userId;
    } else {
      filter.user_id = userId;
    }

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
