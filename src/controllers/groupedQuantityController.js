const GroupedQuantity = require('../models/GroupedQuantity');

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

    // Find all unique lot names for the given exchange
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

// Get all grouped quantities
const getAllGroupedQuantities = async (req, res) => {
  try {
    const { exchange_name, lot_name, page = 1, limit = 50 } = req.query;

    const filter = {
      deleted_at: null
    };

    if (exchange_name) filter.exchange_name = exchange_name.toUpperCase();
    if (lot_name) filter.lot_name = lot_name;

    const groupedQuantities = await GroupedQuantity.find(filter)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ created_at: -1 });

    const count = await GroupedQuantity.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Grouped quantities retrieved successfully',
      data: {
        grouped_quantities: groupedQuantities.map(gq => gq.toJSON()),
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / limit)
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

module.exports = {
  getLotNamesByExchange,
  getAllGroupedQuantities
};
