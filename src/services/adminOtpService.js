/**
 * Admin OTP Service
 *
 * Generates and verifies OTPs for admin login without DB storage.
 * Uses HMAC signing: hash(adminId + otp + expiry) → sent to client as opaque token.
 * Client sends back (otp + token) → server re-hashes and compares.
 *
 * OTP is sent via Firebase Admin SDK to the admin's registered phone number.
 */

const crypto = require('crypto');

const OTP_SECRET = process.env.JWT_SECRET + '_OTP_SALT';
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Hardcoded admin → phone mapping
const ADMIN_PHONES = {
  'admin': '+917990638761',
  'Ishantapex33': '+918780804062',
  'nisheetapex97': '+919173380394',
};

/**
 * Generate a 6-digit OTP and a signed verification token.
 * @returns {{ otp: string, otpToken: string, expiresAt: number }}
 */
function generateOtp(adminId) {
  const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiresAt = Date.now() + OTP_EXPIRY_MS;
  const payload = `${adminId}:${otp}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', OTP_SECRET).update(payload).digest('hex');
  const otpToken = `${hmac}:${expiresAt}`;
  return { otp, otpToken, expiresAt };
}

/**
 * Verify an OTP against the signed token.
 * @returns {boolean}
 */
function verifyOtp(adminId, otp, otpToken) {
  if (!otpToken || !otp) return false;
  const parts = otpToken.split(':');
  if (parts.length !== 2) return false;

  const [receivedHmac, expiresAtStr] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);

  // Check expiry
  if (Date.now() > expiresAt) return false;

  // Recompute HMAC
  const payload = `${adminId}:${otp}:${expiresAt}`;
  const expectedHmac = crypto.createHmac('sha256', OTP_SECRET).update(payload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac));
}

/**
 * Send OTP to admin's phone via Firebase Cloud Messaging.
 * Since we can't send SMS directly via Firebase Admin SDK,
 * we send a push notification with the OTP to the admin's device.
 */
async function sendOtp(username, otp, requestFcmToken) {
  const phone = ADMIN_PHONES[username];
  if (!phone) {
    console.warn(`[AdminOTP] No phone configured for admin: ${username}`);
    return false;
  }

  try {
    const firebaseService = require('./firebaseService');
    const Admin = require('../models/Admin');

    // If the requesting device sent its FCM token, send OTP directly to it
    if (requestFcmToken) {
      try {
        await firebaseService.sendRawNotification(requestFcmToken, {
          title: 'APEX Login OTP',
          body: `Your OTP is: ${otp}. Valid for 5 minutes.`,
        });
        console.log(`[AdminOTP] OTP sent via FCM to ${username} (requesting device)`);
        return true;
      } catch (err) {
        console.warn(`[AdminOTP] Requesting device token failed: ${err.message}`);
        // Don't return — fall through to stored tokens
      }
    }

    // Fallback: try all stored FCM tokens, remove stale ones
    const admin = await Admin.findOne({ username }).select('fcm_tokens').lean();
    const fcmTokens = admin?.fcm_tokens || [];

    if (fcmTokens.length === 0) {
      console.log(`[AdminOTP] ⚠️ No FCM tokens for ${username}. OTP: ${otp} (phone: ${phone})`);
      return true;
    }

    let sentCount = 0;
    const staleTokens = [];

    for (const token of fcmTokens) {
      try {
        await firebaseService.sendRawNotification(token, {
          title: 'APEX Login OTP',
          body: `Your OTP is: ${otp}. Valid for 5 minutes.`,
        });
        sentCount++;
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('NotRegistered') || msg.includes('not found') || msg.includes('UNREGISTERED')) {
          staleTokens.push(token);
        }
      }
    }

    // Clean up stale tokens from DB
    if (staleTokens.length > 0) {
      await Admin.updateOne({ username }, { $pull: { fcm_tokens: { $in: staleTokens } } });
      console.log(`[AdminOTP] 🧹 Removed ${staleTokens.length} stale FCM token(s) for ${username}`);
    }

    if (sentCount > 0) {
      console.log(`[AdminOTP] OTP sent via FCM to ${username} (${sentCount}/${fcmTokens.length} device(s))`);
    } else {
      console.log(`[AdminOTP] ⚠️ All FCM tokens failed for ${username}. OTP: ${otp} (phone: ${phone})`);
    }

    return true;
  } catch (err) {
    console.error(`[AdminOTP] Error sending OTP: ${err.message}`);
    console.log(`[AdminOTP] FALLBACK — OTP for ${username}: ${otp}`);
    return true;
  }
}

/**
 * Get the phone number for an admin (masked for display).
 */
function getMaskedPhone(username) {
  const phone = ADMIN_PHONES[username];
  if (!phone) return null;
  // Show last 4 digits: +91 ****3984
  return phone.slice(0, 4) + '****' + phone.slice(-4);
}

module.exports = { generateOtp, verifyOtp, sendOtp, getMaskedPhone, ADMIN_PHONES };
