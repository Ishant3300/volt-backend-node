const Message = require('../models/Message');

// Get Messages (Inbox)
const getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 20, unread } = req.query;
    
    // Determine recipient based on role
    const recipientId = req.master ? req.master.id : req.user.id;
    const recipientType = req.master ? 'Master' : 'User';

    const filter = {
      recipient_id: recipientId,
      recipient_type: recipientType,
      deleted_at: null
    };

    if (unread === 'true') {
      filter.read = false;
    }

    const messages = await Message.find(filter)
      .populate('sender_id', 'username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await Message.countDocuments(filter);
    const unreadCount = await Message.countDocuments({
      recipient_id: recipientId,
      recipient_type: recipientType,
      read: false,
      deleted_at: null
    });

    res.status(200).json({
      success: true,
      message: 'Messages retrieved successfully',
      data: {
        messages: messages.map(msg => msg.toJSON()),
        total: count,
        unread_count: unreadCount,
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

// Get Message by ID
const getMessageById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const recipientId = req.master ? req.master.id : req.user.id;
    const recipientType = req.master ? 'Master' : 'User';

    const message = await Message.findOne({
      _id: id,
      recipient_id: recipientId,
      recipient_type: recipientType,
      deleted_at: null
    }).populate('sender_id', 'username');

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message retrieved successfully',
      data: message.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Mark Message as Read
const markMessageAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    
    const recipientId = req.master ? req.master.id : req.user.id;
    const recipientType = req.master ? 'Master' : 'User';

    const message = await Message.findOne({
      _id: id,
      recipient_id: recipientId,
      recipient_type: recipientType,
      deleted_at: null
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
        data: null
      });
    }

    if (!message.read) {
      message.read = true;
      message.read_at = new Date();
      await message.save();
    }

    res.status(200).json({
      success: true,
      message: 'Message marked as read',
      data: {
        id: message._id,
        read: message.read,
        read_at: message.read_at
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

// Delete Message (Soft Delete)
const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    
    const recipientId = req.master ? req.master.id : req.user.id;
    const recipientType = req.master ? 'Master' : 'User';

    const message = await Message.findOne({
      _id: id,
      recipient_id: recipientId,
      recipient_type: recipientType,
      deleted_at: null
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
        data: null
      });
    }

    message.deleted_at = new Date();
    await message.save();

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully',
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
  getMessages,
  getMessageById,
  markMessageAsRead,
  deleteMessage
};
