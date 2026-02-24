const bcrypt = require('bcryptjs');
const Master = require('../models/Master');
const Server = require('../models/Server');
const Message = require('../models/Message');
const Trade = require('../models/Trade');
const CreditTransaction = require('../models/CreditTransaction');

// Create Child Master
const createChildMaster = async (req, res) => {
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

    // Determine if request is from Admin or Master
    const isAdmin = !!req.admin;
    const isMaster = !!req.master;

    let parentMaster = null;
    let adminId = null;

    if (isAdmin) {
      // Admin creating a master - no parent master, no credit deduction
      adminId = req.admin.id;
      console.log('👑 Admin creating master, adminId:', adminId);
    } else if (isMaster) {
      // Master creating a child master
      parentMaster = await Master.findById(req.master.id);

      if (!parentMaster) {
        return res.status(404).json({
          success: false,
          message: 'Parent master not found',
          data: null
        });
      }

      // Check if parent master has add_master permission
      if (!parentMaster.add_master) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to create child masters. You can only create users.',
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

      adminId = parentMaster.admin_id;
      console.log('👨‍💼 Master creating child master, parentId:', req.master.id, 'adminId:', adminId);
    } else {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
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

    // Validate sharing percentages against parent (only for master creating child master)
    if (isMaster && parentMaster) {
      // Check if parent has enough P&L sharing to give
      if (parentMaster.pnl_sharing < pnl_sharing) {
        return res.status(400).json({
          success: false,
          message: `Insufficient P&L sharing. Parent has: ${parentMaster.pnl_sharing}%, Requested: ${pnl_sharing}%`,
          data: null
        });
      }

      // Check if parent has enough brokerage sharing to give
      if (parentMaster.brokerage_sharing < brokerage_sharing) {
        return res.status(400).json({
          success: false,
          message: `Insufficient brokerage sharing. Parent has: ${parentMaster.brokerage_sharing}%, Requested: ${brokerage_sharing}%`,
          data: null
        });
      }
    }

    // Validate permissions inheritance (only for master creating child master)
    if (permissions && isMaster && parentMaster) {
      for (const [key, value] of Object.entries(permissions)) {
        if (value === true && parentMaster.permissions[key] !== true) {
          return res.status(403).json({
            success: false,
            message: `Cannot grant permission '${key}' - parent master doesn't have this permission`,
            data: null
          });
        }
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Normalize exchange names to uppercase
    const normalizedExchangesAllowed = exchanges_allowed.map(ex => ex.toUpperCase());
    const normalizedTradeLimit = trade_limit.map(ex => ex.toUpperCase());

    const childMaster = await Master.create({
      name,
      username,
      password: hashedPassword,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed: normalizedExchangesAllowed,
      trade_limit: normalizedTradeLimit,
      add_master: add_master || false,
      change_pass_on_first_login: change_pass_on_first_login || false,
      server_id,
      master_id: parentMaster ? parentMaster._id : null, // Set parent master if exists
      admin_id: adminId, // Use determined admin_id
      max_credit: max_credit || 0,
      status: status || 'active',
      active_status: active_status !== undefined ? active_status : true,
      last_due_bill: last_due_bill || null,
      exchanges: exchanges || [],
      permissions: permissions || {}
    });

    // Deduct credits and sharing percentages from parent master (only if master creating child master)
    if (parentMaster) {
      parentMaster.credits -= credits;
      parentMaster.pnl_sharing -= pnl_sharing;
      parentMaster.brokerage_sharing -= brokerage_sharing;
      await parentMaster.save();
      
      console.log('✅ Parent master updated:');
      console.log(`   Credits: ${parentMaster.credits + credits} -> ${parentMaster.credits}`);
      console.log(`   P&L Sharing: ${parentMaster.pnl_sharing + pnl_sharing}% -> ${parentMaster.pnl_sharing}%`);
      console.log(`   Brokerage Sharing: ${parentMaster.brokerage_sharing + brokerage_sharing}% -> ${parentMaster.brokerage_sharing}%`);
    }

    const responseData = {
      child_master: childMaster.toJSON()
    };

    // Add parent master remaining values if applicable
    if (parentMaster) {
      responseData.parent_master_remaining_credits = parentMaster.credits;
      responseData.parent_master_remaining_pnl_sharing = parentMaster.pnl_sharing;
      responseData.parent_master_remaining_brokerage_sharing = parentMaster.brokerage_sharing;
    }

    res.status(201).json({
      success: true,
      message: isAdmin ? 'Master created successfully' : 'Child master created successfully',
      data: responseData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Child Masters
const getAllChildMasters = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, server_id } = req.query;

    const filter = {
      master_id: req.master.id, // Only children of this master
      deleted_at: null
    };

    if (status) filter.status = status;
    if (server_id) filter.server_id = server_id;

    const masters = await Master.find(filter)
      .populate('server_id', 'name')
      .populate('master_id', 'name username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await Master.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Child masters retrieved successfully',
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

// Get Child Master by ID
const getChildMasterById = async (req, res) => {
  try {
    const { id } = req.params;

    const master = await Master.findOne({
      _id: id,
      master_id: req.master.id, // Must be child of this master
      deleted_at: null
    })
      .populate('server_id', 'name')
      .populate('master_id', 'name username');

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Child master retrieved successfully',
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

// Update Child Master Permissions
const updateChildMasterPermissions = async (req, res) => {
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

    const parentMaster = await Master.findById(req.master.id);
    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    // Validate permissions inheritance
    for (const [key, value] of Object.entries(permissions)) {
      if (value === true && parentMaster.permissions[key] !== true) {
        return res.status(403).json({
          success: false,
          message: `Cannot grant permission '${key}' - you don't have this permission`,
          data: null
        });
      }
    }

    // Update only provided permissions
    Object.keys(permissions).forEach(key => {
      if (childMaster.permissions[key] !== undefined) {
        childMaster.permissions[key] = permissions[key];
      }
    });

    await childMaster.save();

    res.status(200).json({
      success: true,
      message: 'Permissions updated successfully',
      data: {
        id: childMaster._id,
        username: childMaster.username,
        permissions: childMaster.permissions
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

// Update Child Master Details
const updateChildMasterDetails = async (req, res) => {
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

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== childMaster.username) {
      const existingMaster = await Master.findOne({ username });
      if (existingMaster) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists',
          data: null
        });
      }
      childMaster.username = username;
    }

    if (name) childMaster.name = name;
    if (credits !== undefined) childMaster.credits = credits;
    if (note) childMaster.note = note;
    if (exchanges_allowed) childMaster.exchanges_allowed = exchanges_allowed;
    if (trade_limit) childMaster.trade_limit = trade_limit;

    await childMaster.save();

    res.status(200).json({
      success: true,
      message: 'Child master details updated successfully',
      data: {
        id: childMaster._id,
        name: childMaster.name,
        username: childMaster.username,
        credits: childMaster.credits,
        note: childMaster.note,
        exchanges_allowed: childMaster.exchanges_allowed,
        trade_limit: childMaster.trade_limit,
        updated_at: childMaster.updatedAt
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

// Credit Child Master
const creditChildMaster = async (req, res) => {
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

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    const previousCredits = childMaster.credits;
    childMaster.credits += amount;
    await childMaster.save();

    // Create transaction record
    const transaction = await CreditTransaction.create({
      master_id: childMaster._id,
      admin_id: childMaster.admin_id,
      transaction_type: 'CREDIT',
      amount,
      previous_balance: previousCredits,
      new_balance: childMaster.credits,
      note: note || ''
    });

    res.status(200).json({
      success: true,
      message: 'Credit added successfully',
      data: {
        id: childMaster._id,
        username: childMaster.username,
        previous_credits: previousCredits,
        amount_credited: amount,
        current_credits: childMaster.credits,
        transaction_id: transaction._id,
        updated_at: childMaster.updatedAt
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

// Debit Child Master
const debitChildMaster = async (req, res) => {
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

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    if (childMaster.credits < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient credits',
        data: null
      });
    }

    const previousCredits = childMaster.credits;
    childMaster.credits -= amount;
    await childMaster.save();

    // Create transaction record
    const transaction = await CreditTransaction.create({
      master_id: childMaster._id,
      admin_id: childMaster.admin_id,
      transaction_type: 'DEBIT',
      amount,
      previous_balance: previousCredits,
      new_balance: childMaster.credits,
      note: note || ''
    });

    res.status(200).json({
      success: true,
      message: 'Amount debited successfully',
      data: {
        id: childMaster._id,
        username: childMaster.username,
        previous_credits: previousCredits,
        amount_debited: amount,
        current_credits: childMaster.credits,
        transaction_id: transaction._id,
        updated_at: childMaster.updatedAt
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

// Get Child Master Position
const getChildMasterPosition = async (req, res) => {
  try {
    const { id } = req.params;

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    // Calculate position from trades
    const positionData = await Trade.aggregate([
      {
        $match: {
          master_id: childMaster._id,
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
      credit: childMaster.credits,
      equity: childMaster.credits + position.realised_pnl,
      margin_used: 0,
      free_margin: childMaster.credits + position.realised_pnl
    };

    res.status(200).json({
      success: true,
      message: 'Child master position retrieved successfully',
      data: {
        master_id: childMaster._id,
        username: childMaster.username,
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

// Send Message to Child Master
const sendMessageToChildMaster = async (req, res) => {
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

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    const newMessage = await Message.create({
      sender_id: req.master.id,
      sender_type: 'Master',
      recipient_id: childMaster._id,
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

// Delete Child Master (Soft Delete)
const deleteChildMaster = async (req, res) => {
  try {
    const { id } = req.params;

    const childMaster = await Master.findOne({
      _id: id,
      master_id: req.master.id,
      deleted_at: null
    });

    if (!childMaster) {
      return res.status(404).json({
        success: false,
        message: 'Child master not found',
        data: null
      });
    }

    childMaster.deleted_at = new Date();
    await childMaster.save();

    res.status(200).json({
      success: true,
      message: 'Child master deleted successfully',
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
  createChildMaster,
  getAllChildMasters,
  getChildMasterById,
  updateChildMasterPermissions,
  updateChildMasterDetails,
  creditChildMaster,
  debitChildMaster,
  getChildMasterPosition,
  sendMessageToChildMaster,
  deleteChildMaster
};
