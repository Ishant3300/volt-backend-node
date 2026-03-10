const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Master = require('../models/Master');
const LoginHistory = require('../models/LoginHistory');

const _getClientIp = (req) => req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || req.connection?.socket?.remoteAddress || null;

const _logLogin = async (req, userId, userModel, username, name) => {
  try {
    await LoginHistory.create({
      userId,
      userModel,
      username,
      name: name || username,
      ip_address: _getClientIp(req),
      user_agent: req.headers['user-agent'] || null
    });
  } catch (e) {
    console.error('[LoginHistory] Failed to log:', e.message);
  }
};

// Generate JWT Token
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET);
};

// User Login
const userLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
        data: null
      });
    }

    const user = await User.findOne({ username });

    if (!user || user.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account is not active',
        data: null
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    // Generate new token (no expiration)
    const token = generateToken(user._id, 'user');

    // Update active_token, last_login, and IP address
    user.active_token = token;
    user.last_login = new Date();
    user.ip_address = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
    await user.save();

    await _logLogin(req, user._id, 'User', user.username, user.name);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: user.toJSON()
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

// Admin Login
const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
        data: null
      });
    }

    const admin = await Admin.findOne({ username });

    if (!admin || admin.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    // Generate new token (no expiration)
    const token = generateToken(admin._id, 'admin');

    // Update active_token to invalidate previous sessions
    admin.active_token = token;
    await admin.save();

    await _logLogin(req, admin._id, 'Admin', admin.username, admin.username);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        admin: admin.toJSON()
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

// User Logout
const userLogout = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Clear active token
    user.active_token = null;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Logout successful',
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

// Admin Logout
const adminLogout = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found',
        data: null
      });
    }

    // Clear active token
    admin.active_token = null;
    await admin.save();

    res.status(200).json({
      success: true,
      message: 'Logout successful',
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

// Master Login
const masterLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
        data: null
      });
    }

    const master = await Master.findOne({ username });

    if (!master || master.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    if (master.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account is not active',
        data: null
      });
    }

    const isPasswordValid = await bcrypt.compare(password, master.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    // Generate new token (no expiration)
    const token = generateToken(master._id, 'master');

    // Update active_token, last_login, and IP address
    master.active_token = token;
    master.last_login = new Date();
    master.ip_address = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
    await master.save();

    await _logLogin(req, master._id, 'Master', master.username, master.name);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        master: master.toJSON()
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

// Master Logout
const masterLogout = async (req, res) => {
  try {
    const master = await Master.findById(req.master.id);

    if (!master) {
      return res.status(404).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    // Clear active token
    master.active_token = null;
    await master.save();

    res.status(200).json({
      success: true,
      message: 'Logout successful',
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

// Universal Login
const universalLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
        data: null
      });
    }

    let userAccount = null;
    let roleType = null;

    console.log(`🔐 [LOGIN] Attempt: username="${username}", password length=${password.length}`);

    // Check Admin
    const admin = await Admin.findOne({ username });
    console.log(`🔐 [LOGIN] Admin lookup: found=${!!admin}, deleted=${admin?.deleted_at || 'N/A'}`);
    if (admin && !admin.deleted_at && await bcrypt.compare(password, admin.password)) {
      console.log(`🔐 [LOGIN] Admin password matched`);
      userAccount = admin;
      roleType = 'admin';
    }

    // Check Master
    if (!userAccount) {
      const master = await Master.findOne({ username });
      console.log(`🔐 [LOGIN] Master lookup: found=${!!master}, deleted=${master?.deleted_at || 'N/A'}`);
      if (master && !master.deleted_at && await bcrypt.compare(password, master.password)) {
        console.log(`🔐 [LOGIN] Master password matched`);
        if (master.status !== 'active') {
          return res.status(403).json({
            success: false,
            message: 'Account is not active',
            data: null
          });
        }
        userAccount = master;
        roleType = 'master';
      }
    }

    // Check User
    if (!userAccount) {
      const user = await User.findOne({ username });
      console.log(`🔐 [LOGIN] User lookup: found=${!!user}, deleted=${user?.deleted_at || 'N/A'}`);
      if (user && !user.deleted_at && await bcrypt.compare(password, user.password)) {
        console.log(`🔐 [LOGIN] User password matched`);
        if (user.status !== 'active') {
          return res.status(403).json({
            success: false,
            message: 'Account is not active',
            data: null
          });
        }
        userAccount = user;
        roleType = 'user';
      }
    }

    if (!userAccount) {
      console.log(`🔐 [LOGIN] No match found for username="${username}" in any collection`);
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        data: null
      });
    }

    // Generate new token (no expiration)
    const token = generateToken(userAccount._id, roleType);

    // Update active_token, last_login, and IP address
    userAccount.active_token = token;
    if (roleType !== 'admin') {
      userAccount.last_login = new Date();
      userAccount.ip_address = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
    }

    await userAccount.save();

    const modelName = roleType.charAt(0).toUpperCase() + roleType.slice(1); // 'user' -> 'User'
    await _logLogin(req, userAccount._id, modelName, userAccount.username, userAccount.name || userAccount.username);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        [roleType]: userAccount.toJSON(),
        role: roleType.toUpperCase()
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
  userLogin,
  adminLogin,
  masterLogin,
  userLogout,
  adminLogout,
  masterLogout,
  universalLogin
};
