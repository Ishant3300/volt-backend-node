const express = require('express');
const router = express.Router();
const { authenticateMaster } = require('../middlewares/auth');
const {
  getMessages,
  getMessageById,
  markMessageAsRead,
  deleteMessage
} = require('../controllers/messageController');

// All routes require master authentication
router.use(authenticateMaster);

// Message operations
router.get('/', getMessages);
router.get('/:id', getMessageById);
router.put('/:id/read', markMessageAsRead);
router.delete('/:id', deleteMessage);

module.exports = router;
