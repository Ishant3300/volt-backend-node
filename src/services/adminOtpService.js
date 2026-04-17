/**
 * Admin TOTP Service
 *
 * Uses speakeasy for TOTP generation/verification with authenticator apps
 * (Google Authenticator, Microsoft Authenticator, etc.)
 *
 * Flow:
 * 1. Admin enables TOTP → generate secret → show QR → admin scans → verifies first code → activated
 * 2. On login: if totp_enabled, ask for TOTP code → verify → issue JWT
 * 3. Reset: clear secret, disable TOTP → admin can re-setup
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const Admin = require('../models/Admin');

const ISSUER = 'APEX Trading';

/**
 * Generate a new TOTP secret and QR code data URL for an admin.
 * Saves the secret to DB (not yet activated — totp_enabled stays false until verify-setup).
 */
async function generateSecret(adminId) {
  const admin = await Admin.findById(adminId);
  if (!admin) throw new Error('Admin not found');

  const secret = speakeasy.generateSecret({
    name: `${ISSUER} (${admin.username})`,
    issuer: ISSUER,
    length: 20,
  });

  // Save secret (not activated yet)
  admin.totp_secret = secret.base32;
  await admin.save();

  // Generate QR code as data URL (base64 PNG)
  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

  return {
    qrDataUrl,
    secret: secret.base32, // for manual entry fallback
    otpauthUrl: secret.otpauth_url,
  };
}

/**
 * Verify the first TOTP code after QR scan — activates TOTP for the admin.
 */
async function verifySetup(adminId, token) {
  const admin = await Admin.findById(adminId).select('+totp_secret');
  if (!admin || !admin.totp_secret) throw new Error('No TOTP secret configured');

  const verified = speakeasy.totp.verify({
    secret: admin.totp_secret,
    encoding: 'base32',
    token,
    window: 1, // ±30 sec clock drift
  });

  if (!verified) return false;

  admin.totp_enabled = true;
  await admin.save();
  return true;
}

/**
 * Verify TOTP code during login.
 */
async function verifyLogin(adminId, token) {
  const admin = await Admin.findById(adminId).select('+totp_secret');
  if (!admin || !admin.totp_secret) return false;

  return speakeasy.totp.verify({
    secret: admin.totp_secret,
    encoding: 'base32',
    token,
    window: 1,
  });
}

/**
 * Reset TOTP — clears secret and disables TOTP.
 */
async function resetTotp(adminId) {
  await Admin.findByIdAndUpdate(adminId, {
    totp_secret: null,
    totp_enabled: false,
  });
}

/**
 * Toggle TOTP enabled/disabled for an admin.
 * If disabling, also clears the secret.
 */
async function toggleTotp(adminId, enabled) {
  if (!enabled) {
    await Admin.findByIdAndUpdate(adminId, {
      totp_enabled: false,
      totp_secret: null,
    });
  } else {
    await Admin.findByIdAndUpdate(adminId, {
      totp_enabled: true,
    });
  }
}

/**
 * Get TOTP status for an admin.
 */
async function getTotpStatus(adminId) {
  const admin = await Admin.findById(adminId).select('totp_enabled totp_secret');
  if (!admin) return null;
  return {
    enabled: admin.totp_enabled || false,
    configured: !!admin.totp_secret,
  };
}

module.exports = { generateSecret, verifySetup, verifyLogin, resetTotp, toggleTotp, getTotpStatus };
