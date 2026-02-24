const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Master = require('../models/Master');
const Server = require('../models/Server');
const Message = require('../models/Message');
const Trade = require('../models/Trade');
const CreditTransaction = require('../models/CreditTransaction');

// Create User
const createUser = async (req, res) => {
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
      margin_square_off,
      change_pass_on_first_login,
      server_id,
      status
    } = req.body;

    // Validate required fields
    if (!name || !username || !password || !server_id || credits === undefined || !note || pnl_sharing === undefined || brokerage_sharing === undefined || !exchanges_allowed || !trade_limit) {
      return res.status(400).json({
        success: false,
        message: 'Name, username, password, credits, note, pnl_sharing, brokerage_sharing, exchanges_allowed, trade_limit, and server_id are required',
        data: null
      });
    }

    // Validate credits is a positive number
    if (credits < 0) {
      return res.status(400).json({
        success: false,
        message: 'Credits must be a positive number',
        data: null
      });
    }

    // Get parent master
    const parentMaster = await Master.findById(req.master.id);

    if (!parentMaster) {
      return res.status(404).json({
        success: false,
        message: 'Parent master not found',
        data: null
      });
    }

    // Check if parent master has sufficient credits
    if (parentMaster.credits < credits) {
      return res.status(400).json({
        success: false,
        message: `Insufficient credits. Available: ${parentMaster.credits}, Required: ${credits}`,
        data: null
      });
    }

    // Check if username already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
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

    // Validate exchanges_allowed structure
    if (!Array.isArray(exchanges_allowed)) {
      return res.status(400).json({
        success: false,
        message: 'exchanges_allowed must be an array',
        data: null
      });
    }

    for (const exchange of exchanges_allowed) {
      if (!exchange.exchange_name || exchange.turnover === undefined || exchange.lot === undefined || !exchange.group_name) {
        return res.status(400).json({
          success: false,
          message: 'Each exchange must have exchange_name, turnover, lot, and group_name',
          data: null
        });
      }
    }

    // Normalize exchange names to uppercase
    const normalizedExchangesAllowed = exchanges_allowed.map(ex => ({
      ...ex,
      exchange_name: ex.exchange_name.toUpperCase()
    }));

    // Normalize trade_limit to uppercase
    const normalizedTradeLimit = trade_limit.map(ex => ex.toUpperCase());

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      username,
      password: hashedPassword,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed: normalizedExchangesAllowed,
      trade_limit: normalizedTradeLimit,
      margin_square_off: margin_square_off || false,
      change_pass_on_first_login: change_pass_on_first_login || false,
      server_id,
      master_id: parentMaster._id,
      status: status || 'active'
    });

    // Deduct credits from parent master
    parentMaster.credits -= credits;
    await parentMaster.save();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        user: user.toJSON(),
        parent_master_remaining_credits: parentMaster.credits
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

// Get All Users
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, server_id } = req.query;

    const filter = {
      master_id: req.master.id, // Only users created by this master
      deleted_at: null
    };

    if (status) filter.status = status;
    if (server_id) filter.server_id = server_id;

    const users = await User.find(filter)
      .populate('server_id', 'name')
      .populate('master_id', 'name username')
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

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id, // Must be created by this master
      deleted_at: null
    })
      .populate('server_id', 'name')
      .populate('master_id', 'name username');

    if (!user) {
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

// Update User Details
const updateUserDetails = async (req, res) => {
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
      margin_square_off,
      change_pass_on_first_login,
      active_status,
      close_only,
      bet,
      fresh_stoploss
    } = req.body;

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
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

    // Update password if provided
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      user.password = hashedPassword;
    }

    // Validate percentages if provided
    if (pnl_sharing !== undefined) {
      if (pnl_sharing < 0 || pnl_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'P&L sharing must be between 0 and 100',
          data: null
        });
      }
      user.pnl_sharing = pnl_sharing;
    }

    if (brokerage_sharing !== undefined) {
      if (brokerage_sharing < 0 || brokerage_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'Brokerage sharing must be between 0 and 100',
          data: null
        });
      }
      user.brokerage_sharing = brokerage_sharing;
    }

    // Validate and normalize exchanges_allowed if provided
    if (exchanges_allowed) {
      if (!Array.isArray(exchanges_allowed)) {
        return res.status(400).json({
          success: false,
          message: 'exchanges_allowed must be an array',
          data: null
        });
      }

      for (const exchange of exchanges_allowed) {
        if (!exchange.exchange_name || exchange.turnover === undefined || exchange.lot === undefined) {
          return res.status(400).json({
            success: false,
            message: 'Each exchange must have exchange_name, turnover, and lot',
            data: null
          });
        }
      }

      // Normalize exchange names to uppercase
      user.exchanges_allowed = exchanges_allowed.map(ex => ({
        ...ex,
        exchange_name: ex.exchange_name.toUpperCase()
      }));
    }

    // Normalize trade_limit to uppercase if provided
    if (trade_limit) {
      user.trade_limit = trade_limit.map(ex => ex.toUpperCase());
    }

    if (name) user.name = name;
    if (credits !== undefined) user.credits = credits;
    if (note !== undefined) user.note = note;
    if (margin_square_off !== undefined) user.margin_square_off = margin_square_off;
    if (change_pass_on_first_login !== undefined) user.change_pass_on_first_login = change_pass_on_first_login;
    if (active_status !== undefined) user.active_status = active_status;
    if (close_only !== undefined) user.close_only = close_only;
    if (bet !== undefined) user.bet = bet;
    if (fresh_stoploss !== undefined) user.fresh_stoploss = fresh_stoploss;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User details updated successfully',
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

// Credit User
const creditUser = async (req, res) => {
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

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Get the master
    const master = await Master.findById(req.master.id);
    
    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Check if master has sufficient credits
    if (master.credits < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient credits. Available: ${master.credits}, Required: ${amount}`,
        data: null
      });
    }

    const previousUserCredits = user.credits;
    const previousMasterCredits = master.credits;
    
    // Deduct from master and add to user
    master.credits -= amount;
    user.credits += amount;
    
    await master.save();
    await user.save();

    // Create credit transaction record for master (losing credits)
    await CreditTransaction.create({
      master_id: master._id,
      admin_id: req.master.id, // The master performing the action
      transaction_type: 'DEBIT', // Master is debiting (losing credits)
      amount: amount,
      previous_balance: previousMasterCredits,
      new_balance: master.credits,
      note: note || 'Credit to user'
    });

    // Create credit transaction record for user (gaining credits)
    await CreditTransaction.create({
      master_id: user.master_id,
      admin_id: req.master.id,
      transaction_type: 'CREDIT', // User is crediting (gaining credits)
      amount: amount,
      previous_balance: previousUserCredits,
      new_balance: user.credits,
      note: note || 'Credit from master'
    });

    res.status(200).json({
      success: true,
      message: 'Credit added successfully',
      data: {
        user: {
          id: user._id,
          username: user.username,
          previous_credits: previousUserCredits,
          current_credits: user.credits
        },
        master: {
          id: master._id,
          username: master.username,
          previous_credits: previousMasterCredits,
          current_credits: master.credits
        },
        amount_credited: amount,
        updated_at: user.updatedAt
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

// Debit User
const debitUser = async (req, res) => {
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

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    if (user.credits < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient credits',
        data: null
      });
    }

    // Get the master
    const master = await Master.findById(req.master.id);
    
    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    const previousUserCredits = user.credits;
    const previousMasterCredits = master.credits;
    
    // Deduct from user and add back to master
    user.credits -= amount;
    master.credits += amount;
    
    await user.save();
    await master.save();

    // Create credit transaction record for master (gaining credits)
    await CreditTransaction.create({
      master_id: master._id,
      admin_id: req.master.id, // The master performing the action
      transaction_type: 'CREDIT', // Master is crediting (gaining credits)
      amount: amount,
      previous_balance: previousMasterCredits,
      new_balance: master.credits,
      note: note || 'Debit from user'
    });

    // Create credit transaction record for user (losing credits)
    await CreditTransaction.create({
      master_id: user.master_id,
      admin_id: req.master.id,
      transaction_type: 'DEBIT', // User is debiting (losing credits)
      amount: amount,
      previous_balance: previousUserCredits,
      new_balance: user.credits,
      note: note || 'Debit to master'
    });

    res.status(200).json({
      success: true,
      message: 'Amount debited successfully',
      data: {
        user: {
          id: user._id,
          username: user.username,
          previous_credits: previousUserCredits,
          current_credits: user.credits
        },
        master: {
          id: master._id,
          username: master.username,
          previous_credits: previousMasterCredits,
          current_credits: master.credits
        },
        amount_debited: amount,
        updated_at: user.updatedAt
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

// Get User Position
const getUserPosition = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Calculate position from trades
    const positionData = await Trade.aggregate([
      {
        $match: {
          user_id: user._id,
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

    const mockPosition = {
      realised_pnl: position.realised_pnl,
      m2m_pnl: 0,
      credit: user.credits,
      equity: user.credits + position.realised_pnl
    };

    res.status(200).json({
      success: true,
      message: 'User position retrieved successfully',
      data: {
        user_id: user._id,
        username: user.username,
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

// Send Message to User
const sendMessageToUser = async (req, res) => {
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

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    const newMessage = await Message.create({
      sender_id: req.master.id,
      sender_type: 'Master',
      recipient_id: user._id,
      recipient_type: 'User',
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

// Delete User (Soft Delete)
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
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

// Update User Intraday Squareoff Settings
// Update User Intraday Squareoff Settings
const updateUserIntradaySquareoff = async (req, res) => {
  try {
    const { id } = req.params;
    const { intraday_squareoff } = req.body;

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Get allowed exchanges from user's exchanges_allowed array
    const allowedExchanges = user.exchanges_allowed.map(ex => ex.exchange_name);

    // Validate that all exchanges in intraday_squareoff are in exchanges_allowed
    if (intraday_squareoff && Array.isArray(intraday_squareoff)) {
      // Convert exchange names to uppercase for consistency
      const normalizedSettings = intraday_squareoff.map(setting => ({
        exchange_name: setting.exchange_name.toUpperCase(),
        enabled: setting.enabled
      }));

      for (const setting of normalizedSettings) {
        const allowedExchangesUpper = allowedExchanges.map(ex => ex.toUpperCase());
        if (!allowedExchangesUpper.includes(setting.exchange_name)) {
          return res.status(400).json({
            success: false,
            message: `Exchange ${setting.exchange_name} is not allowed for this user`,
            data: null
          });
        }
      }
      user.intraday_squareoff = normalizedSettings;
    }

    // Normalize existing exchange data to uppercase before saving
    user.exchanges_allowed = user.exchanges_allowed.map(ex => ({
      ...ex,
      exchange_name: ex.exchange_name.toUpperCase()
    }));
    user.trade_limit = user.trade_limit.map(ex => ex.toUpperCase());

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Intraday squareoff settings updated successfully',
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

// Update User Margin Squareoff Percentage
const updateUserMarginSquareoffPercentage = async (req, res) => {
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

    const user = await User.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    user.margin_square_off_percentage = margin_square_off_percentage;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Margin squareoff percentage updated successfully',
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

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUserDetails,
  updateUserIntradaySquareoff,
  updateUserMarginSquareoffPercentage,
  creditUser,
  debitUser,
  getUserPosition,
  sendMessageToUser,
  deleteUser
};
