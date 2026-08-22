const express = require('express');
const router = express.Router();
const { authenticateMaster } = require('../middlewares/auth');
const { rejectIfInvestor } = require('../middlewares/rejectIfInvestor');
const {
  getMessages,
  getMessageById,
  markMessageAsRead,
  deleteMessage
} = require('../controllers/messageController');

// All routes require master authentication
router.use(authenticateMaster);

// Message operations (read — allowed in investor mode)
router.get('/', getMessages);
router.get('/:id', getMessageById);
router.put('/:id/read', markMessageAsRead);

// Write — blocked in investor mode
router.delete('/:id', rejectIfInvestor, deleteMessage);

module.exports = router;
