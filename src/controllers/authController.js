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

// Change password for any role (user/admin/master)
const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
    }

    let account, Model;
    if (req.admin) {
      Model = Admin;
      account = await Admin.findById(req.admin.id);
    } else if (req.master) {
      Model = Master;
      account = await Master.findById(req.master.id);
    } else if (req.user) {
      Model = User;
      account = await User.findById(req.user.id);
    }

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const isMatch = await bcrypt.compare(current_password, account.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    account.password = await bcrypt.hash(new_password, 10);
    await account.save();

    return res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('❌ Change password error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get notification settings
const getNotificationSettings = async (req, res) => {
  try {
    let account;
    if (req.admin) account = await Admin.findById(req.admin.id);
    else if (req.master) account = await Master.findById(req.master.id);
    else if (req.user) account = await User.findById(req.user.id);

    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    const defaults = { market_order: false, pending_order: true, admin_order_execution: false, admin_order_deletion: true, trading_sound: false };
    const settings = account.notification_settings || defaults;

    return res.status(200).json({ success: true, data: { notification_settings: settings } });
  } catch (error) {
    console.error('❌ Get notification settings error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update notification settings
const updateNotificationSettings = async (req, res) => {
  try {
    const { notification_settings } = req.body;
    if (!notification_settings || typeof notification_settings !== 'object') {
      return res.status(400).json({ success: false, message: 'notification_settings object is required' });
    }

    let account;
    if (req.admin) account = await Admin.findById(req.admin.id);
    else if (req.master) account = await Master.findById(req.master.id);
    else if (req.user) account = await User.findById(req.user.id);

    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    const allowed = ['market_order', 'pending_order', 'admin_order_execution', 'admin_order_deletion', 'trading_sound'];
    for (const key of allowed) {
      if (notification_settings[key] !== undefined) {
        account.notification_settings[key] = !!notification_settings[key];
      }
    }
    account.markModified('notification_settings');
    await account.save();

    return res.status(200).json({ success: true, message: 'Notification settings updated', data: { notification_settings: account.notification_settings } });
  } catch (error) {
    console.error('❌ Update notification settings error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Register FCM token for push notifications
const registerFcmToken = async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) {
      return res.status(400).json({ success: false, message: 'fcm_token is required' });
    }

    let account;
    if (req.admin) account = await Admin.findById(req.admin.id);
    else if (req.master) account = await Master.findById(req.master.id);
    else if (req.user) account = await User.findById(req.user.id);

    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    // Add token if not already present
    if (!account.fcm_tokens) account.fcm_tokens = [];
    if (!account.fcm_tokens.includes(fcm_token)) {
      account.fcm_tokens.push(fcm_token);
      await account.save();
    }

    return res.status(200).json({ success: true, message: 'FCM token registered' });
  } catch (error) {
    console.error('❌ Register FCM token error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Remove FCM token (on logout or token refresh)
const removeFcmToken = async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) {
      return res.status(400).json({ success: false, message: 'fcm_token is required' });
    }

    let account;
    if (req.admin) account = await Admin.findById(req.admin.id);
    else if (req.master) account = await Master.findById(req.master.id);
    else if (req.user) account = await User.findById(req.user.id);

    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    account.fcm_tokens = (account.fcm_tokens || []).filter(t => t !== fcm_token);
    await account.save();

    return res.status(200).json({ success: true, message: 'FCM token removed' });
  } catch (error) {
    console.error('❌ Remove FCM token error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  userLogin,
  adminLogin,
  masterLogin,
  userLogout,
  adminLogout,
  masterLogout,
  universalLogin,
  changePassword,
  getNotificationSettings,
  updateNotificationSettings,
  registerFcmToken,
  removeFcmToken
};
