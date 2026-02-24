const bcrypt = require('bcryptjs');
const Master = require('../models/Master');
const Server = require('../models/Server');
const Message = require('../models/Message');
const Trade = require('../models/Trade');
const CreditTransaction = require('../models/CreditTransaction');
const User = require('../models/User');

// Create Master
const createMaster = async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed,
      trade_limit,
      add_master,
      change_pass_on_first_login,
      server_id,
      max_credit,
      status,
      active_status,
      last_due_bill,
      exchanges,
      permissions
    } = req.body;

    if (!name || !username || !password || !server_id || credits === undefined || !note || pnl_sharing === undefined || brokerage_sharing === undefined || !exchanges_allowed || !trade_limit) {
      return res.status(400).json({
        success: false,
        message: 'Name, username, password, credits, note, pnl_sharing, brokerage_sharing, exchanges_allowed, trade_limit, and server_id are required',
        data: null
      });
    }

    // Check if username already exists
    const existingMaster = await Master.findOne({ username });
    if (existingMaster) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists',
        data: null
      });
    }

    // Verify server exists
    const server = await Server.findById(server_id);
    if (!server) {
      return res.status(404).json({
        success: false,
        message: 'Server not found',
        data: null
      });
    }

    // Validate percentages
    if (pnl_sharing < 0 || pnl_sharing > 100) {
      return res.status(400).json({
        success: false,
        message: 'P&L sharing must be between 0 and 100',
        data: null
      });
    }

    if (brokerage_sharing < 0 || brokerage_sharing > 100) {
      return res.status(400).json({
        success: false,
        message: 'Brokerage sharing must be between 0 and 100',
        data: null
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const master = await Master.create({
      name,
      username,
      password: hashedPassword,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed,
      trade_limit,
      add_master: add_master !== undefined ? add_master : false,
      change_pass_on_first_login: change_pass_on_first_login !== undefined ? change_pass_on_first_login : false,
      server_id,
      admin_id: req.admin.id,
      max_credit: max_credit || 0,
      status: status || 'active',
      active_status: active_status !== undefined ? active_status : true,
      last_due_bill: last_due_bill || null,
      exchanges: exchanges || [],
      permissions: permissions || {}
    });

    res.status(201).json({
      success: true,
      message: 'Master created successfully',
      data: master.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Masters
const getAllMasters = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, server_id } = req.query;

    const filter = {
      admin_id: req.admin.id,
      deleted_at: null
    };

    if (status) filter.status = status;
    if (server_id) filter.server_id = server_id;

    const masters = await Master.find(filter)
      .populate('server_id', 'name')
      .populate('admin_id', 'username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await Master.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Masters retrieved successfully',
      data: {
        masters: masters.map(master => master.toJSON()),
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

// Get Master by ID
const getMasterById = async (req, res) => {
  try {
    const { id } = req.params;

    // Build query based on who is requesting
    let query = {
      _id: id,
      deleted_at: null
    };

    // If admin is requesting, filter by admin_id
    if (req.admin) {
      query.admin_id = req.admin.id;
    }
    // If master is requesting their own profile, allow it
    else if (req.master && req.master.id === id) {
      // Master can view their own profile - no additional filter needed
      delete query.admin_id;
    }
    // If master is requesting another master's profile, filter by master_id
    else if (req.master) {
      query.master_id = req.master.id;
    }

    const master = await Master.findOne(query)
      .populate('server_id', '_id name')
      .populate('admin_id', '_id username');

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Master retrieved successfully',
      data: master.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Master
const updateMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      username,
      password,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed,
      trade_limit,
      add_master,
      change_pass_on_first_login,
      server_id,
      max_credit,
      credit,
      status,
      active_status,
      pnl_share_percentage,
      last_due_bill
    } = req.body;

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== master.username) {
      const existingMaster = await Master.findOne({ username });
      if (existingMaster) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists',
          data: null
        });
      }
      master.username = username;
    }

    if (name) master.name = name;
    if (note !== undefined) master.note = note;
    if (credits !== undefined) master.credits = credits;
    
    if (pnl_sharing !== undefined) {
      if (pnl_sharing < 0 || pnl_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'P&L sharing must be between 0 and 100',
          data: null
        });
      }
      master.pnl_sharing = pnl_sharing;
    }
    
    if (brokerage_sharing !== undefined) {
      if (brokerage_sharing < 0 || brokerage_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'Brokerage sharing must be between 0 and 100',
          data: null
        });
      }
      master.brokerage_sharing = brokerage_sharing;
    }
    
    if (exchanges_allowed !== undefined) master.exchanges_allowed = exchanges_allowed;
    if (trade_limit !== undefined) master.trade_limit = trade_limit;
    if (add_master !== undefined) master.add_master = add_master;
    if (change_pass_on_first_login !== undefined) master.change_pass_on_first_login = change_pass_on_first_login;

    if (password) {
      master.password = await bcrypt.hash(password, 10);
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
      master.server_id = server_id;
    }

    if (max_credit !== undefined) master.max_credit = max_credit;
    if (credit !== undefined) master.credit = credit;
    if (status) master.status = status;
    if (active_status !== undefined) master.active_status = active_status;
    
    if (pnl_share_percentage !== undefined) {
      if (pnl_share_percentage < 0 || pnl_share_percentage > 100) {
        return res.status(400).json({
          success: false,
          message: 'P&L share percentage must be between 0 and 100',
          data: null
        });
      }
      master.pnl_share_percentage = pnl_share_percentage;
    }
    
    if (last_due_bill !== undefined) master.last_due_bill = last_due_bill;

    await master.save();

    res.status(200).json({
      success: true,
      message: 'Master updated successfully',
      data: master.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Master Status
const updateMasterStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      last_due_bill,
      active_status,
      credit,
      pnl_share_percentage
    } = req.body;

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    if (last_due_bill !== undefined) master.last_due_bill = last_due_bill;
    if (active_status !== undefined) master.active_status = active_status;
    if (credit !== undefined) master.credit = credit;
    
    if (pnl_share_percentage !== undefined) {
      if (pnl_share_percentage < 0 || pnl_share_percentage > 100) {
        return res.status(400).json({
          success: false,
          message: 'P&L share percentage must be between 0 and 100',
          data: null
        });
      }
      master.pnl_share_percentage = pnl_share_percentage;
    }

    await master.save();

    res.status(200).json({
      success: true,
      message: 'Master status updated successfully',
      data: master.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Master Permissions
const updateMasterPermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Permissions object is required',
        data: null
      });
    }

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Update only provided permissions
    Object.keys(permissions).forEach(key => {
      if (master.permissions[key] !== undefined) {
        master.permissions[key] = permissions[key];
      }
    });

    await master.save();

    res.status(200).json({
      success: true,
      message: 'Permissions updated successfully',
      data: {
        id: master._id,
        username: master.username,
        permissions: master.permissions
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

// Delete Master (Soft Delete)
const deleteMaster = async (req, res) => {
  try {
    const { id } = req.params;

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    master.deleted_at = new Date();
    await master.save();

    res.status(200).json({
      success: true,
      message: 'Master deleted successfully',
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

// Credit Master Account
const creditMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required',
        data: null
      });
    }

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    const previousCredits = master.credits;
    master.credits += amount;
    await master.save();

    // Create transaction record
    const transaction = await CreditTransaction.create({
      master_id: master._id,
      admin_id: req.admin.id,
      transaction_type: 'CREDIT',
      amount,
      previous_balance: previousCredits,
      new_balance: master.credits,
      note: note || ''
    });

    res.status(200).json({
      success: true,
      message: 'Credit added successfully',
      data: {
        id: master._id,
        username: master.username,
        previous_credits: previousCredits,
        amount_credited: amount,
        current_credits: master.credits,
        transaction_id: transaction._id,
        updated_at: master.updatedAt
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

// Debit Master Account
const debitMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required',
        data: null
      });
    }

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    if (master.credits < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient credits',
        data: null
      });
    }

    const previousCredits = master.credits;
    master.credits -= amount;
    await master.save();

    // Create transaction record
    const transaction = await CreditTransaction.create({
      master_id: master._id,
      admin_id: req.admin.id,
      transaction_type: 'DEBIT',
      amount,
      previous_balance: previousCredits,
      new_balance: master.credits,
      note: note || ''
    });

    res.status(200).json({
      success: true,
      message: 'Amount debited successfully',
      data: {
        id: master._id,
        username: master.username,
        previous_credits: previousCredits,
        amount_debited: amount,
        current_credits: master.credits,
        transaction_id: transaction._id,
        updated_at: master.updatedAt
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

// Get All Trades
const getAllTrades = async (req, res) => {
  try {
    const { master_id, user_id, page = 1, limit = 50, date_from, date_to, status } = req.query;

    const filter = {
      admin_id: req.admin.id,
      deleted_at: null
    };

    if (master_id) filter.master_id = master_id;
    if (user_id) filter.user_id = user_id;
    if (status) filter.status = status;
    if (date_from || date_to) {
      filter.created_at = {};
      if (date_from) filter.created_at.$gte = new Date(date_from);
      if (date_to) filter.created_at.$lte = new Date(date_to);
    }

    const trades = await Trade.find(filter)
      .populate('user_id', 'name username')
      .populate('master_id', 'name username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ created_at: -1 });

    const count = await Trade.countDocuments(filter);

    // Calculate summary
    const summary = await Trade.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total_trades: { $sum: 1 },
          total_pnl: { $sum: '$pnl' },
          total_brokerage: { $sum: '$brokerage' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      message: 'Trades retrieved successfully',
      data: {
        trades: trades.map(trade => trade.toJSON()),
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / limit),
        summary: summary[0] || { total_trades: 0, total_pnl: 0, total_brokerage: 0 }
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

// Get Master Position
const getMasterPosition = async (req, res) => {
  try {
    const { id } = req.params;

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Calculate position from trades
    const positionData = await Trade.aggregate([
      {
        $match: {
          master_id: master._id,
          status: 'completed',
          deleted_at: null
        }
      },
      {
        $group: {
          _id: null,
          realised_pnl: { $sum: '$pnl' },
          total_brokerage: { $sum: '$brokerage' }
        }
      }
    ]);

    const position = positionData[0] || { realised_pnl: 0, total_brokerage: 0 };

    // Mock M2M P&L, equity, margin data (in real implementation, this would come from broker API)
    const mockPosition = {
      realised_pnl: position.realised_pnl,
      m2m_pnl: 0, // Would be calculated from open positions
      credit: master.credits,
      equity: master.credits + position.realised_pnl,
      margin_used: 0, // Would be calculated from open positions
      free_margin: master.credits + position.realised_pnl
    };

    res.status(200).json({
      success: true,
      message: 'Master position retrieved successfully',
      data: {
        master_id: master._id,
        username: master.username,
        position: mockPosition,
        last_updated: new Date().toISOString()
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

// Update Master Details
const updateMasterDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      username,
      credits,
      note,
      exchanges_allowed,
      trade_limit
    } = req.body;

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== master.username) {
      const existingMaster = await Master.findOne({ username });
      if (existingMaster) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists',
          data: null
        });
      }
      master.username = username;
    }

    if (name) master.name = name;
    if (credits !== undefined) master.credits = credits;
    if (note) master.note = note;
    if (exchanges_allowed) master.exchanges_allowed = exchanges_allowed;
    if (trade_limit) master.trade_limit = trade_limit;

    await master.save();

    res.status(200).json({
      success: true,
      message: 'Master details updated successfully',
      data: {
        id: master._id,
        name: master.name,
        username: master.username,
        credits: master.credits,
        note: master.note,
        exchanges_allowed: master.exchanges_allowed,
        trade_limit: master.trade_limit,
        updated_at: master.updatedAt
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

// Send Message to Master
const sendMessageToMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
        data: null
      });
    }

    const master = await Master.findOne({
      _id: id,
      admin_id: req.admin.id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    const newMessage = await Message.create({
      sender_id: req.admin.id,
      sender_type: 'Admin',
      recipient_id: master._id,
      recipient_type: 'Master',
      subject: subject || '',
      message
    });

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: newMessage.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Master Intraday Squareoff Settings
const updateMasterIntradaySquareoff = async (req, res) => {
  try {
    const { id } = req.params;
    const { intraday_squareoff } = req.body;

    const master = await Master.findOne({
      _id: id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Validate that all exchanges in intraday_squareoff are in exchanges_allowed
    if (intraday_squareoff && Array.isArray(intraday_squareoff)) {
      // Convert exchange names to uppercase for consistency
      const normalizedSettings = intraday_squareoff.map(setting => ({
        exchange_name: setting.exchange_name.toUpperCase(),
        enabled: setting.enabled
      }));

      for (const setting of normalizedSettings) {
        const masterExchangesUpper = master.exchanges_allowed.map(ex => ex.toUpperCase());
        if (!masterExchangesUpper.includes(setting.exchange_name)) {
          return res.status(400).json({
            success: false,
            message: `Exchange ${setting.exchange_name} is not allowed for this master`,
            data: null
          });
        }
      }
      master.intraday_squareoff = normalizedSettings;
    }

    // Normalize existing exchange data to uppercase before saving
    master.exchanges_allowed = master.exchanges_allowed.map(ex => ex.toUpperCase());
    master.trade_limit = master.trade_limit.map(ex => ex.toUpperCase());

    await master.save();

    res.status(200).json({
      success: true,
      message: 'Intraday squareoff settings updated successfully',
      data: master.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Master Margin Squareoff Percentage
const updateMasterMarginSquareoffPercentage = async (req, res) => {
  try {
    const { id } = req.params;
    const { margin_square_off_percentage } = req.body;

    if (margin_square_off_percentage === undefined || margin_square_off_percentage === null) {
      return res.status(400).json({
        success: false,
        message: 'Margin square off percentage is required',
        data: null
      });
    }

    if (margin_square_off_percentage < 0 || margin_square_off_percentage > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage must be between 0 and 100',
        data: null
      });
    }

    const master = await Master.findOne({
      _id: id,
      deleted_at: null
    });

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    master.margin_square_off_percentage = margin_square_off_percentage;
    await master.save();

    res.status(200).json({
      success: true,
      message: 'Margin squareoff percentage updated successfully',
      data: master.toJSON()
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
  createMaster,
  getAllMasters,
  getMasterById,
  updateMaster,
  updateMasterStatus,
  updateMasterPermissions,
  updateMasterDetails,
  updateMasterIntradaySquareoff,
  updateMasterMarginSquareoffPercentage,
  deleteMaster,
  creditMaster,
  debitMaster,
  getAllTrades,
  getMasterPosition,
  sendMessageToMaster
};
