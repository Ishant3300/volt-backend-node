const Announcement = require('../models/Announcement');

/** Admin: create/update the active announcement */
const setAnnouncement = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    // Deactivate all existing announcements
    await Announcement.updateMany({ is_active: true }, { $set: { is_active: false } });
    // Create new active announcement
    const announcement = await Announcement.create({
      message: message.trim(),
      is_active: true,
      created_by: req.admin?.id,
    });
    res.status(201).json({ success: true, message: 'Announcement set', data: announcement });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Admin: clear the active announcement */
const clearAnnouncement = async (req, res) => {
  try {
    await Announcement.updateMany({ is_active: true }, { $set: { is_active: false } });
    res.status(200).json({ success: true, message: 'Announcement cleared' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Any role: get the current active announcement */
const getActiveAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
    res.status(200).json({
      success: true,
      data: announcement ? { id: announcement._id, message: announcement.message, created_at: announcement.createdAt } : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { setAnnouncement, clearAnnouncement, getActiveAnnouncement };
