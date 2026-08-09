const Master = require('../models/Master');
const User = require('../models/User');
const redisService = require('../services/redisService');

// Prefix for Redis reservation keys
const RESERVATION_PREFIX = 'username_reserve:';
// Reservation TTL in seconds (5 minutes)
const RESERVATION_TTL = 300;

/**
 * Generate a unique 6-digit username that does not exist in Master, User, or Redis reservations.
 */
exports.generateUsername = async (req, res) => {
  try {
    let generatedUsername = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      attempts++;
      // Generate a random 6-digit number (100000 to 999999)
      const potentialUsername = Math.floor(100000 + Math.random() * 900000).toString();

      // 1. Check Redis for existing reservation
      if (redisService.isAvailable()) {
        const client = redisService.getClient();
        const existsInRedis = await client.exists(`${RESERVATION_PREFIX}${potentialUsername}`);
        if (existsInRedis) {
          continue; // Try again
        }
      }

      // 2. Check MongoDB (Master and User collections)
      const existsInMaster = await Master.exists({ username: potentialUsername });
      if (existsInMaster) {
        continue;
      }

      const existsInUser = await User.exists({ username: potentialUsername });
      if (existsInUser) {
        continue;
      }

      // 3. We found a unique one! Reserve it in Redis if available
      if (redisService.isAvailable()) {
        const client = redisService.getClient();
        await client.setex(`${RESERVATION_PREFIX}${potentialUsername}`, RESERVATION_TTL, 'reserved');
      }

      generatedUsername = potentialUsername;
      break;
    }

    if (!generatedUsername) {
      return res.status(500).json({
        success: false,
        message: 'Could not generate a unique username after multiple attempts. Please try again.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Username generated and reserved successfully',
      data: { username: generatedUsername },
    });
  } catch (error) {
    console.error('Error generating username:', error);
    return res.status(500).json({ success: false, message: 'Server error generating username' });
  }
};

/**
 * Release a reserved username if the creation flow is aborted.
 */
exports.releaseUsername = async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required to release' });
    }

    if (redisService.isAvailable()) {
      const client = redisService.getClient();
      await client.del(`${RESERVATION_PREFIX}${username}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Username reservation released successfully',
    });
  } catch (error) {
    console.error('Error releasing username:', error);
    return res.status(500).json({ success: false, message: 'Server error releasing username' });
  }
};
