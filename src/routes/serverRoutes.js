const express = require('express');
const router = express.Router();
const { authenticateAdmin, authenticateAdminOrMaster } = require('../middlewares/auth');

const {
  getAllServers,
  getServerById,
  createServer,
  updateServer,
  deleteServer
} = require('../controllers/serverController');

// Get all servers (Admin and Master can view)
router.get('/', authenticateAdminOrMaster, getAllServers);

// Get server by ID (Admin and Master can view)
router.get('/:id', authenticateAdminOrMaster, getServerById);

// Create server (Admin only)
router.post('/', authenticateAdmin, createServer);

// Update server (Admin only)
router.put('/:id', authenticateAdmin, updateServer);

// Delete server (Admin only)
router.delete('/:id', authenticateAdmin, deleteServer);

module.exports = router;
