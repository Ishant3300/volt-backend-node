const Server = require('../models/Server');

// Get All Servers
const getAllServers = async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query;

    const filter = {};

    const servers = await Server.find(filter)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ name: 1 });

    const count = await Server.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Servers retrieved successfully',
      data: {
        // servers: servers.map(server => server.toJSON()),
        servers: [],
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

// Get Server by ID
const getServerById = async (req, res) => {
  try {
    const { id } = req.params;

    const server = await Server.findById(id);

    if (!server) {
      return res.status(404).json({
        success: false,
        message: 'Server not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Server retrieved successfully',
      data: server.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Create Server
const createServer = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Server name is required',
        data: null
      });
    }

    // Check if server already exists
    const existingServer = await Server.findOne({ name });
    if (existingServer) {
      return res.status(400).json({
        success: false,
        message: 'Server name already exists',
        data: null
      });
    }

    const server = await Server.create({ name });

    res.status(201).json({
      success: true,
      message: 'Server created successfully',
      data: server.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update Server
const updateServer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    const server = await Server.findById(id);

    if (!server) {
      return res.status(404).json({
        success: false,
        message: 'Server not found',
        data: null
      });
    }

    // Check if new name already exists
    if (name && name !== server.name) {
      const existingServer = await Server.findOne({ name });
      if (existingServer) {
        return res.status(400).json({
          success: false,
          message: 'Server name already exists',
          data: null
        });
      }
      server.name = name;
    }

    await server.save();

    res.status(200).json({
      success: true,
      message: 'Server updated successfully',
      data: server.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete Server
const deleteServer = async (req, res) => {
  try {
    const { id } = req.params;

    const server = await Server.findById(id);

    if (!server) {
      return res.status(404).json({
        success: false,
        message: 'Server not found',
        data: null
      });
    }

    await server.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Server deleted successfully',
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
  getAllServers,
  getServerById,
  createServer,
  updateServer,
  deleteServer
};
