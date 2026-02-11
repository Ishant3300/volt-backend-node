const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Master = require('../models/Master');
const Server = require('../models/Server');

// Create User
const createUser = async (req, res) => {
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

    // Verify master exists
    const master = await Master.findById(master_id);
    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      password: hashedPassword,
      server_id,
      master_id,
      credit: credit || 0,
      current_credit: current_credit || 0,
      balance: balance || 0,
      exchanges_support: exchanges_support || [],
      status: status || 'active'
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
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

    if (credit !== undefined) user.credit = credit;
    if (current_credit !== undefined) user.current_credit = current_credit;
    if (balance !== undefined) user.balance = balance;
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

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser
};
