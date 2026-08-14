'use strict';

/**
 * Hierarchy Settlement Calculation Service
 *
 * Pure math functions for computing multi-tier brokerage revenue splits
 * and P&L sharing. These produce REPORT data only — no wallet/balance
 * modifications are made.
 *
 * Spec reference:
 * - Logic A: Brokerage Cascade Breakdown
 * - Logic B: Trading P&L Cascade Breakdown
 */

const BrokerageSettings = require('../models/BrokerageSettings');
const User = require('../models/User');
const Master = require('../models/Master');

/**
 * Compute the multi-tier brokerage revenue split for a given turnover amount.
 *
 * @param {object} params
 * @param {number} params.totalBrokerage - Total brokerage collected from client
 * @param {number} params.turnover - Total turnover (price × qty summed)
 * @param {number} params.clientRate - Client's brk_value (what they're charged)
 * @param {number} params.subMasterRate - Sub-Master's own rate (their base cost)
 * @param {number} params.mainMasterRate - Main Master's own rate
 * @param {number} params.adminRate - Admin's base rate (global)
 * @param {number} params.subMasterSharing - Sub-Master's brokerage_sharing % (e.g. 80)
 * @param {number} params.mainMasterSharing - Main Master's brokerage_sharing % (e.g. 90)
 * @param {string} params.brokerageType - 'TURNOVER WISE' or 'LOT WISE'
 * @param {number} [params.lots] - Number of lots (only needed for LOT WISE)
 * @returns {object} { subMasterKeeps, mainMasterKeeps, adminKeeps, passedFromSubToMain, passedFromMainToAdmin }
 */
function computeBrokerageSplit(params) {
  const {
    clientRate = 0,
    subMasterRate = 0,
    mainMasterRate = 0,
    adminRate = 0,
    subMasterSharing = 0,
    mainMasterSharing = 0,
    brokerageType = 'TURNOVER WISE',
    turnover = 0,
    lots = 0,
  } = params;

  let grossMargin, directMargin, adminBaseClearance;

  if (brokerageType === 'LOT WISE') {
    // Per-lot spread calculation
    // Gross Margin at Sub-Master = what client pays minus what Sub-Master's parent (Main Master) charges
    grossMargin = (clientRate - mainMasterRate) * lots;
    // Direct Margin at Main Master = what Main Master charges minus what Admin charges
    directMargin = (mainMasterRate - adminRate) * lots;
    // Admin base = admin's own rate
    adminBaseClearance = adminRate * lots;
  } else {
    // Turnover-based: rates are in paise units (brk_value / 10000 = percentage of turnover)
    // Gross Margin at Sub-Master = (Client Rate - Main Master Rate) applied to turnover
    grossMargin = (clientRate - mainMasterRate) * turnover / 10000;
    // Direct Margin at Main Master = (Main Master Rate - Admin Rate) applied to turnover
    directMargin = (mainMasterRate - adminRate) * turnover / 10000;
    // Admin base clearance = Admin Rate applied to turnover
    adminBaseClearance = adminRate * turnover / 10000;
  }

  // Ensure no negative margins (if hierarchy rates are misconfigured)
  grossMargin = Math.max(0, grossMargin);
  directMargin = Math.max(0, directMargin);
  adminBaseClearance = Math.max(0, adminBaseClearance);

  // Step 1: Sub-Master Level
  const subMasterKeeps = grossMargin * (subMasterSharing / 100);
  const passedFromSubToMain = grossMargin * ((100 - subMasterSharing) / 100);

  // Step 2: Main Master Level
  const totalPoolAtMain = directMargin + passedFromSubToMain;
  const mainMasterKeeps = totalPoolAtMain * (mainMasterSharing / 100);
  const passedFromMainToAdmin = totalPoolAtMain * ((100 - mainMasterSharing) / 100);

  // Step 3: Admin Level
  const adminKeeps = adminBaseClearance + passedFromMainToAdmin;

  return {
    subMasterKeeps: _r2(subMasterKeeps),
    mainMasterKeeps: _r2(mainMasterKeeps),
    adminKeeps: _r2(adminKeeps),
    passedFromSubToMain: _r2(passedFromSubToMain),
    passedFromMainToAdmin: _r2(passedFromMainToAdmin),
    grossMargin: _r2(grossMargin),
    directMargin: _r2(directMargin),
    adminBaseClearance: _r2(adminBaseClearance),
  };
}

/**
 * Compute multi-tier P&L sharing.
 * Client loss = hierarchy profit. Client profit = hierarchy liability.
 * The sharing percentages apply symmetrically in both directions.
 *
 * @param {object} params
 * @param {number} params.clientPnl - Client's P&L (negative = loss for client = profit for hierarchy)
 * @param {number} params.subMasterSharing - Sub-Master's pnl_sharing % (e.g. 80)
 * @param {number} params.mainMasterSharing - Main Master's pnl_sharing % (e.g. 90)
 * @returns {object} { subMasterPnl, mainMasterPnl, adminPnl }
 */
function computePnlSplit(params) {
  const {
    clientPnl = 0,
    subMasterSharing = 0,
    mainMasterSharing = 0,
  } = params;

  // Flip sign: client loss = platform profit
  const hierarchyProfit = -clientPnl;

  // Step 1: Sub-Master gets their share
  const subMasterPnl = hierarchyProfit * (subMasterSharing / 100);
  const passedUp = hierarchyProfit * ((100 - subMasterSharing) / 100);

  // Step 2: Main Master gets their share of what's passed up
  const mainMasterPnl = passedUp * (mainMasterSharing / 100);
  const passedToAdmin = passedUp * ((100 - mainMasterSharing) / 100);

  // Step 3: Admin gets the remainder
  const adminPnl = passedToAdmin;

  return {
    subMasterPnl: _r2(subMasterPnl),
    mainMasterPnl: _r2(mainMasterPnl),
    adminPnl: _r2(adminPnl),
    totalHierarchyPnl: _r2(subMasterPnl + mainMasterPnl + adminPnl),
  };
}

/**
 * Resolve the full hierarchy chain rates for a user.
 * Returns rates for each level: user (client), immediate master (sub-master),
 * parent master (main master), and admin (global).
 *
 * @param {string} userId - The end client's user ID
 * @param {string} exchangeName - e.g. 'NFO-FUT'
 * @param {string} scriptName - e.g. 'NIFTY'
 * @param {string} brokerageType - 'TURNOVER WISE' or 'LOT WISE'
 * @returns {object} { clientRate, subMasterRate, mainMasterRate, adminRate, subMasterSharing, mainMasterSharing, subMasterPnlSharing, mainMasterPnlSharing }
 */
async function resolveHierarchyRates(userId, exchangeName, scriptName, brokerageType) {
  const user = await User.findById(userId).select('master_id pnl_sharing brokerage_sharing').lean();
  if (!user) return null;

  const subMaster = user.master_id
    ? await Master.findById(user.master_id).select('master_id pnl_sharing brokerage_sharing').lean()
    : null;

  const mainMaster = subMaster?.master_id
    ? await Master.findById(subMaster.master_id).select('master_id pnl_sharing brokerage_sharing').lean()
    : null;

  // Helper to find rate for a given owner
  async function getRate(ownerId) {
    const filter = {
      user_id: ownerId,
      exchange_name: exchangeName.toUpperCase(),
      script_name: scriptName,
      type: brokerageType,
      deleted_at: null,
    };
    const rule = await BrokerageSettings.findOne(filter).lean();
    if (rule) return rule.brk_value;

    // Fallback: try exchange-only match (no script_name filter)
    const exchangeRule = await BrokerageSettings.findOne({
      user_id: ownerId,
      exchange_name: exchangeName.toUpperCase(),
      type: brokerageType,
      deleted_at: null,
    }).lean();
    return exchangeRule?.brk_value ?? 0;
  }

  const clientRate = await getRate(userId);
  const subMasterRate = subMaster ? await getRate(subMaster._id) : await getRate(null);
  const mainMasterRate = mainMaster ? await getRate(mainMaster._id) : await getRate(null);
  const adminRate = await getRate(null); // Global = admin level

  return {
    clientRate,
    subMasterRate,
    mainMasterRate,
    adminRate,
    // Brokerage sharing percentages
    subMasterSharing: subMaster?.brokerage_sharing ?? 0,
    mainMasterSharing: mainMaster?.brokerage_sharing ?? (subMaster?.brokerage_sharing ?? 0),
    // P&L sharing percentages
    subMasterPnlSharing: subMaster?.pnl_sharing ?? 0,
    mainMasterPnlSharing: mainMaster?.pnl_sharing ?? (subMaster?.pnl_sharing ?? 0),
  };
}

function _r2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  computeBrokerageSplit,
  computePnlSplit,
  resolveHierarchyRates,
};
