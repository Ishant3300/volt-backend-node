const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Master = require('../models/Master');
const Server = require('../models/Server');
const GroupedQuantity = require('../models/GroupedQuantity');
const ScriptQuantity = require('../models/ScriptQuantity');
const TradeMargin = require('../models/TradeMargin');
const BrokerageSettings = require('../models/BrokerageSettings');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

// Create User
const createUser = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {
      username,
      password,
      server_id,
      master_id,
      credit,
      current_credit,
      balance,
      exchanges_support,
      status
    } = req.body;

    if (!username || !password || !server_id || !master_id) {
      return res.status(400).json({
        success: false,
        message: 'Username, password, server_id, and master_id are required',
        data: null
      });
    }

    let resultData;

    await session.withTransaction(async () => {
      // Check if username already exists
      const existingUser = await User.findOne({ username }).session(session);
      if (existingUser) throw new Error('Username already exists');

      // Verify server exists
      const server = await Server.findById(server_id).session(session);
      if (!server) throw new Error('Server not found');

      // Verify master exists
      const master = await Master.findById(master_id).session(session);
      if (!master) throw new Error('Master not found');

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      const initialCredit = credit || 0;

      const user = new User({
        username,
        password: hashedPassword,
        server_id,
        master_id,
        credits: initialCredit,
        current_credit: current_credit || 0,
        equity: balance !== undefined ? balance : initialCredit,
        exchanges_support: exchanges_support || [],
        status: status || 'active'
      });
      await user.save({ session });

      if (initialCredit > 0) {
        const tx = new Transaction({
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_U`,
          userId: user._id,
          userModel: 'User',
          type: 'CREDIT',
          status: 'SUCCESS',
          amount: initialCredit,
          referenceId: req.admin ? req.admin.id : null,
          referenceModel: 'Admin',
          balanceBefore: 0,
          balanceAfter: user.equity,
          metadata: { note: 'Admin created user with initial credit' }
        });
        await tx.save({ session });
      }

      resultData = user.toJSON();
    });

    session.endSession();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: resultData
    });
  } catch (error) {
    session.endSession();

    let statusCode = 500;
    if (error.message.includes('not found')) statusCode = 404;
    else if (error.message === 'Username already exists') statusCode = 400;

    res.status(statusCode).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Users
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, server_id, master_id } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (server_id) filter.server_id = server_id;
    if (master_id) filter.master_id = master_id;
    filter.deleted_at = null;

    const users = await User.find(filter)
      .populate('server_id', 'name')
      .populate('master_id', 'username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await User.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Users retrieved successfully',
      data: {
        users: users.map(user => user.toJSON()),
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

// Get User by ID
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .populate('server_id', 'name')
      .populate('master_id', 'username');

    if (!user || user.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'User retrieved successfully',
      data: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update User
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      username,
      password,
      server_id,
      master_id,
      credit,
      current_credit,
      balance,
      exchanges_support,
      status
    } = req.body;

    const user = await User.findById(id);

    if (!user || user.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists',
          data: null
        });
      }
      user.username = username;
    }

    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }

    if (server_id) {
      const server = await Server.findById(server_id);
      if (!server) {
        return res.status(404).json({
          success: false,
          message: 'Server not found',
          data: null
        });
      }
      user.server_id = server_id;
    }

    if (master_id) {
      const master = await Master.findById(master_id);
      if (!master) {
        return res.status(404).json({
          success: false,
          message: 'Master not found',
          data: null
        });
      }
      user.master_id = master_id;
    }

    if (credit !== undefined) user.credits = credit;
    if (current_credit !== undefined) user.current_credit = current_credit;
    if (balance !== undefined) user.equity = balance;
    if (exchanges_support) user.exchanges_support = exchanges_support;
    if (status) user.status = status;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete User (Soft Delete)
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);

    if (!user || user.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    user.deleted_at = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: 'User deleted successfully',
      data: null
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
// Credit / Debit User (Admin only)
// ============================================

const creditUserByAdmin = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number', data: null });
    }

    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(id).session(session);
      if (!user || user.deleted_at) throw new Error('User not found');

      const balanceBefore = user.equity;
      user.equity += amount;
      if (user.credits < user.equity) user.credits = user.equity;
      await user.save({ session });

      const tx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_AC`,
        userId: user._id,
        userModel: 'User',
        type: 'CREDIT',
        status: 'SUCCESS',
        amount,
        referenceId: req.admin ? req.admin.id : null,
        referenceModel: 'Admin',
        balanceBefore,
        balanceAfter: user.equity,
        metadata: { note: note || 'Admin credit', credited_by: req.admin?.username }
      });
      await tx.save({ session });
      result = { new_balance: user.equity, amount_credited: amount };
    });
    session.endSession();
    res.status(200).json({ success: true, message: 'Amount credited successfully', data: result });
  } catch (error) {
    session.endSession();
    res.status(error.message === 'User not found' ? 404 : 500).json({ success: false, message: error.message, data: null });
  }
};

const debitUserByAdmin = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number', data: null });
    }

    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(id).session(session);
      if (!user || user.deleted_at) throw new Error('User not found');

      const balanceBefore = user.equity;
      user.equity -= amount;
      await user.save({ session });

      const tx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_AD`,
        userId: user._id,
        userModel: 'User',
        type: 'DEBIT',
        status: 'SUCCESS',
        amount,
        referenceId: req.admin ? req.admin.id : null,
        referenceModel: 'Admin',
        balanceBefore,
        balanceAfter: user.equity,
        metadata: { note: note || 'Admin debit', debited_by: req.admin?.username }
      });
      await tx.save({ session });
      result = { new_balance: user.equity, amount_debited: amount };
    });
    session.endSession();
    res.status(200).json({ success: true, message: 'Amount debited successfully', data: result });
  } catch (error) {
    session.endSession();
    res.status(error.message === 'User not found' ? 404 : 500).json({ success: false, message: error.message, data: null });
  }
};



// ============================================
// Grouped Quantity CRUD Operations
// ============================================

// Create Grouped Quantity
const createGroupedQuantity = async (req, res) => {
  try {
    const { exchange_name, lot_name, instrument_id, instrument_symbol, raw_name, max_qty, break_qty, lot_size } = req.body;

    console.log('📥 Creating grouped quantity:', {
      exchange_name,
      lot_name,
      raw_name,
      instrument_id,
      instrument_symbol,
      max_qty,
      break_qty,
      lot_size
    });

    if (!exchange_name || !lot_name || max_qty === undefined || break_qty === undefined || lot_size === undefined) {
      console.log('❌ Validation failed - missing required fields');
      return res.status(400).json({
        success: false,
        message: 'exchange_name, lot_name, max_qty, break_qty, and lot_size are required',
        data: null
      });
    }

    // Use raw_name as the primary key for matching; fall back to instrument_symbol
    const matchRawName = raw_name || instrument_symbol || '';

    const groupedQty = await GroupedQuantity.findOneAndUpdate(
      { exchange_name, lot_name, raw_name: matchRawName, deleted_at: null },
      {
        exchange_name,
        lot_name,
        raw_name: matchRawName,
        instrument_id: instrument_id || '',
        instrument_symbol: instrument_symbol || matchRawName,
        max_qty,
        break_qty,
        lot_size,
        deleted_at: null
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log('✅ Grouped quantity upserted:', groupedQty._id);

    res.status(201).json({
      success: true,
      message: 'Grouped quantity saved successfully',
      data: groupedQty.toJSON()
    });
  } catch (error) {
    console.error('❌ Error creating grouped quantity:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Grouped Quantities
const getAllGroupedQuantities = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const filter = { deleted_at: null };

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

// Get Grouped Quantity by ID
const getGroupedQuantityById = async (req, res) => {
  try {
    const { id } = req.params;

    const groupedQty = await GroupedQuantity.findById(id);

    if (!groupedQty || groupedQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Grouped quantity not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Grouped quantity retrieved successfully',
      data: groupedQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Grouped Quantity
const updateGroupedQuantity = async (req, res) => {
  try {
    const { id } = req.params;
    const { exchange_name, lot_name, instrument_id, instrument_symbol, max_qty, break_qty, lot_size } = req.body;

    const groupedQty = await GroupedQuantity.findById(id);

    if (!groupedQty || groupedQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Grouped quantity not found',
        data: null
      });
    }

    if (exchange_name) groupedQty.exchange_name = exchange_name;
    if (lot_name) groupedQty.lot_name = lot_name;
    if (instrument_id) groupedQty.instrument_id = instrument_id;
    if (instrument_symbol) groupedQty.instrument_symbol = instrument_symbol;
    if (max_qty !== undefined) groupedQty.max_qty = max_qty;
    if (break_qty !== undefined) groupedQty.break_qty = break_qty;
    if (lot_size !== undefined) groupedQty.lot_size = lot_size;

    await groupedQty.save();

    res.status(200).json({
      success: true,
      message: 'Grouped quantity updated successfully',
      data: groupedQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete Grouped Quantity (Soft Delete)
const deleteGroupedQuantity = async (req, res) => {
  try {
    const { id } = req.params;

    const groupedQty = await GroupedQuantity.findById(id);

    if (!groupedQty || groupedQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Grouped quantity not found',
        data: null
      });
    }

    groupedQty.deleted_at = new Date();
    await groupedQty.save();

    res.status(200).json({
      success: true,
      message: 'Grouped quantity deleted successfully',
      data: null
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
// Script Quantity CRUD Operations
// ============================================

// Create Script Quantity
const createScriptQuantity = async (req, res) => {
  try {
    const { exchange_name, script_name, lot_size, max_qty, brk_qty } = req.body;

    if (!exchange_name || !script_name || lot_size === undefined || max_qty === undefined || brk_qty === undefined) {
      return res.status(400).json({
        success: false,
        message: 'exchange_name, script_name, lot_size, max_qty, and brk_qty are required',
        data: null
      });
    }

    const scriptQty = await ScriptQuantity.findOneAndUpdate(
      { exchange_name, script_name, deleted_at: null },
      { exchange_name, script_name, lot_size, max_qty, brk_qty, deleted_at: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
      success: true,
      message: 'Script quantity saved successfully',
      data: scriptQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Script Quantities
const getAllScriptQuantities = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const filter = { deleted_at: null };

    const scriptQuantities = await ScriptQuantity.find(filter)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ created_at: -1 });

    const count = await ScriptQuantity.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Script quantities retrieved successfully',
      data: {
        script_quantities: scriptQuantities.map(sq => sq.toJSON()),
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

// Get Script Quantity by ID
const getScriptQuantityById = async (req, res) => {
  try {
    const { id } = req.params;

    const scriptQty = await ScriptQuantity.findById(id);

    if (!scriptQty || scriptQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Script quantity not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Script quantity retrieved successfully',
      data: scriptQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Script Quantity
const updateScriptQuantity = async (req, res) => {
  try {
    const { id } = req.params;
    const { exchange_name, script_name, lot_size, max_qty, brk_qty } = req.body;

    const scriptQty = await ScriptQuantity.findById(id);

    if (!scriptQty || scriptQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Script quantity not found',
        data: null
      });
    }

    if (exchange_name) scriptQty.exchange_name = exchange_name;
    if (script_name) scriptQty.script_name = script_name;
    if (lot_size !== undefined) scriptQty.lot_size = lot_size;
    if (max_qty !== undefined) scriptQty.max_qty = max_qty;
    if (brk_qty !== undefined) scriptQty.brk_qty = brk_qty;

    await scriptQty.save();

    res.status(200).json({
      success: true,
      message: 'Script quantity updated successfully',
      data: scriptQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete Script Quantity (Soft Delete)
const deleteScriptQuantity = async (req, res) => {
  try {
    const { id } = req.params;

    const scriptQty = await ScriptQuantity.findById(id);

    if (!scriptQty || scriptQty.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Script quantity not found',
        data: null
      });
    }

    scriptQty.deleted_at = new Date();
    await scriptQty.save();

    res.status(200).json({
      success: true,
      message: 'Script quantity deleted successfully',
      data: null
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
// Trade Margin CRUD Operations
// ============================================

// Create Trade Margin
const createTradeMargin = async (req, res) => {
  try {
    const { exchange_name, script_name, amount_type, trade_margin } = req.body;

    if (!exchange_name || !script_name || !amount_type || trade_margin === undefined) {
      return res.status(400).json({
        success: false,
        message: 'exchange_name, script_name, amount_type, and trade_margin are required',
        data: null
      });
    }

    const tradeMarginDoc = await TradeMargin.findOneAndUpdate(
      { exchange_name, script_name, amount_type, deleted_at: null },
      { exchange_name, script_name, amount_type, trade_margin, deleted_at: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
      success: true,
      message: 'Trade margin saved successfully',
      data: tradeMarginDoc.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Trade Margins
const getAllTradeMargins = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const filter = { deleted_at: null };

    const tradeMargins = await TradeMargin.find(filter)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ created_at: -1 });

    const count = await TradeMargin.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Trade margins retrieved successfully',
      data: {
        trade_margins: tradeMargins.map(tm => tm.toJSON()),
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

// Get Trade Margin by ID
const getTradeMarginById = async (req, res) => {
  try {
    const { id } = req.params;

    const tradeMargin = await TradeMargin.findById(id);

    if (!tradeMargin || tradeMargin.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Trade margin not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Trade margin retrieved successfully',
      data: tradeMargin.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Trade Margin
const updateTradeMargin = async (req, res) => {
  try {
    const { id } = req.params;
    const { exchange_name, script_name, amount_type, trade_margin } = req.body;

    const tradeMargin = await TradeMargin.findById(id);

    if (!tradeMargin || tradeMargin.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Trade margin not found',
        data: null
      });
    }

    if (exchange_name) tradeMargin.exchange_name = exchange_name;
    if (script_name) tradeMargin.script_name = script_name;
    if (amount_type) tradeMargin.amount_type = amount_type;
    if (trade_margin !== undefined) tradeMargin.trade_margin = trade_margin;

    await tradeMargin.save();

    res.status(200).json({
      success: true,
      message: 'Trade margin updated successfully',
      data: tradeMargin.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete Trade Margin (Soft Delete)
const deleteTradeMargin = async (req, res) => {
  try {
    const { id } = req.params;

    const tradeMargin = await TradeMargin.findById(id);

    if (!tradeMargin || tradeMargin.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Trade margin not found',
        data: null
      });
    }

    tradeMargin.deleted_at = new Date();
    await tradeMargin.save();

    res.status(200).json({
      success: true,
      message: 'Trade margin deleted successfully',
      data: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// ==================== BROKERAGE SETTINGS ====================

// Create Brokerage Settings
const createBrokerageSettings = async (req, res) => {
  try {
    const { type, exchange_name, script_name, brk_value } = req.body;

    if (!type || !exchange_name || !script_name || brk_value === undefined) {
      return res.status(400).json({
        success: false,
        message: 'type, exchange_name, script_name, and brk_value are required',
        data: null
      });
    }

    const newBrokerageSettings = await BrokerageSettings.findOneAndUpdate(
      { type, exchange_name, script_name, deleted_at: null },
      { type, exchange_name, script_name, brk_value, deleted_at: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
      success: true,
      message: 'Brokerage settings saved successfully',
      data: newBrokerageSettings.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Brokerage Settings
const getAllBrokerageSettings = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const filter = { deleted_at: null };

    const brokerageSettings = await BrokerageSettings.find(filter)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ created_at: -1 });

    const count = await BrokerageSettings.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Brokerage settings retrieved successfully',
      data: {
        brokerage_settings: brokerageSettings.map(bs => bs.toJSON()),
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

// Get Brokerage Settings by ID
const getBrokerageSettingsById = async (req, res) => {
  try {
    const { id } = req.params;

    const brokerageSettings = await BrokerageSettings.findById(id);

    if (!brokerageSettings || brokerageSettings.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Brokerage settings not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Brokerage settings retrieved successfully',
      data: brokerageSettings.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Brokerage Settings
const updateBrokerageSettings = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, exchange_name, script_name, brk_value } = req.body;

    const brokerageSettings = await BrokerageSettings.findById(id);

    if (!brokerageSettings || brokerageSettings.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Brokerage settings not found',
        data: null
      });
    }

    if (type) brokerageSettings.type = type;
    if (exchange_name) brokerageSettings.exchange_name = exchange_name;
    if (script_name) brokerageSettings.script_name = script_name;
    if (brk_value !== undefined) brokerageSettings.brk_value = brk_value;

    await brokerageSettings.save();

    res.status(200).json({
      success: true,
      message: 'Brokerage settings updated successfully',
      data: brokerageSettings.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete Brokerage Settings (Soft Delete)
const deleteBrokerageSettings = async (req, res) => {
  try {
    const { id } = req.params;

    const brokerageSettings = await BrokerageSettings.findById(id);

    if (!brokerageSettings || brokerageSettings.deleted_at) {
      return res.status(404).json({
        success: false,
        message: 'Brokerage settings not found',
        data: null
      });
    }

    brokerageSettings.deleted_at = new Date();
    await brokerageSettings.save();

    res.status(200).json({
      success: true,
      message: 'Brokerage settings deleted successfully',
      data: null
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
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  creditUserByAdmin,
  debitUserByAdmin,
  // Grouped Quantity
  createGroupedQuantity,
  getAllGroupedQuantities,
  getGroupedQuantityById,
  updateGroupedQuantity,
  deleteGroupedQuantity,
  // Script Quantity
  createScriptQuantity,
  getAllScriptQuantities,
  getScriptQuantityById,
  updateScriptQuantity,
  deleteScriptQuantity,
  // Trade Margin
  createTradeMargin,
  getAllTradeMargins,
  getTradeMarginById,
  updateTradeMargin,
  deleteTradeMargin,
  // Brokerage Settings
  createBrokerageSettings,
  getAllBrokerageSettings,
  getBrokerageSettingsById,
  updateBrokerageSettings,
  deleteBrokerageSettings
};
