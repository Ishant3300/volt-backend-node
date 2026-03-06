const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Master = require('../models/Master');

// Middleware to authenticate user tokens only
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
        data: null
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User role required',
        data: null
      });
    }

    // Verify token matches active session
    const user = await User.findById(decoded.id);

    if (!user || user.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    if (user.active_token !== token) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again',
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

    req.user = decoded;
    req.admin = null;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      data: null
    });
  }
};

// Middleware to authenticate admin tokens only
const authenticateAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
        data: null
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin role required',
        data: null
      });
    }

    // Verify token matches active session
    const admin = await Admin.findById(decoded.id);

    if (!admin || admin.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'Admin not found',
        data: null
      });
    }

    if (admin.active_token !== token) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again',
        data: null
      });
    }

    req.user = null;
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      data: null
    });
  }
};

// Middleware to authenticate both user and admin tokens
const authenticateAny = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
        data: null
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'user' && decoded.role !== 'admin' && decoded.role !== 'master') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Invalid role',
        data: null
      });
    }

    if (decoded.role === 'user') {
      const user = await User.findById(decoded.id);

      if (!user || user.deleted_at) {
        return res.status(401).json({
          success: false,
          message: 'User not found',
          data: null
        });
      }

      if (user.active_token !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again',
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

      req.user = decoded;
      req.admin = null;
      req.master = null;
    } else if (decoded.role === 'admin') {
      const admin = await Admin.findById(decoded.id);

      if (!admin || admin.deleted_at) {
        return res.status(401).json({
          success: false,
          message: 'Admin not found',
          data: null
        });
      }

      if (admin.active_token !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again',
          data: null
        });
      }

      req.user = null;
      req.admin = decoded;
      req.master = null;
    } else {
      // role === 'master'
      const master = await Master.findById(decoded.id);

      if (!master || master.deleted_at) {
        return res.status(401).json({
          success: false,
          message: 'Master not found',
          data: null
        });
      }

      if (master.active_token !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again',
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

      req.user = null;
      req.admin = null;
      req.master = decoded;
    }
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      data: null
    });
  }
};

// Middleware for optional authentication (doesn't fail if no token)
const authenticateOptional = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      req.user = null;
      req.admin = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role === 'user') {
      const user = await User.findById(decoded.id);

      if (user && !user.deleted_at && user.active_token === token && user.status === 'active') {
        req.user = decoded;
        req.admin = null;
      } else {
        req.user = null;
        req.admin = null;
      }
    } else if (decoded.role === 'admin') {
      const admin = await Admin.findById(decoded.id);

      if (admin && !admin.deleted_at && admin.active_token === token) {
        req.user = null;
        req.admin = decoded;
      } else {
        req.user = null;
        req.admin = null;
      }
    } else {
      req.user = null;
      req.admin = null;
    }

    next();
  } catch (error) {
    req.user = null;
    req.admin = null;
    next();
  }
};

// Middleware to authenticate master tokens only
const authenticateMaster = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
        data: null
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'master') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Master role required',
        data: null
      });
    }

    // Verify token matches active session
    const master = await Master.findById(decoded.id);

    if (!master || master.deleted_at) {
      return res.status(401).json({
        success: false,
        message: 'Master not found',
        data: null
      });
    }

    if (master.active_token !== token) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again',
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

    req.user = null;
    req.admin = null;
    req.master = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      data: null
    });
  }
};

// Middleware to authenticate either admin or master tokens
const authenticateAdminOrMaster = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
        data: null
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin' && decoded.role !== 'master') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin or Master role required',
        data: null
      });
    }

    if (decoded.role === 'admin') {
      const admin = await Admin.findById(decoded.id);

      if (!admin || admin.deleted_at) {
        return res.status(401).json({
          success: false,
          message: 'Admin not found',
          data: null
        });
      }

      if (admin.active_token !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again',
          data: null
        });
      }

      req.user = null;
      req.admin = decoded;
      req.master = null;
    } else {
      // role === 'master'
      const master = await Master.findById(decoded.id);

      if (!master || master.deleted_at) {
        return res.status(401).json({
          success: false,
          message: 'Master not found',
          data: null
        });
      }

      if (master.active_token !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again',
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

      req.user = null;
      req.admin = null;
      req.master = decoded;
    }
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      data: null
    });
  }
};

module.exports = {
  authenticateUser,
  authenticateAdmin,
  authenticateMaster,
  authenticateAny,
  authenticateOptional,
  authenticateAdminOrMaster
};
