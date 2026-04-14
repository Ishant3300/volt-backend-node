const express = require('express');
const router = express.Router();
const { authenticateAdmin, authenticateAdminOrMaster, authenticateAny } = require('../middlewares/auth');

const {
  getAllServers,
  getServerById,
  createServer,
  updateServer,
  deleteServer
} = require('../controllers/serverController');

// Search servers by name (public — used by login page)
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) {
      return res.json({ success: true, data: [] });
    }
    const Server = require('../models/Server');
    const servers = await Server.find({
      name: { $regex: q.trim(), $options: 'i' }
    }).select('name').limit(10).lean();
    res.json({ success: true, data: servers.map(s => ({ id: s._id, name: s.name })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all servers (public — used by login page before auth)
router.get('/', getAllServers);

// Get server by ID (Admin and Master can view)
router.get('/:id', authenticateAdminOrMaster, getServerById);

// Create server (Admin only)
router.post('/', authenticateAdmin, createServer);

// Update server (Admin only)
router.put('/:id', authenticateAdmin, updateServer);

// Delete server (Admin only)
router.delete('/:id', authenticateAdmin, deleteServer);

module.exports = router;
