const settlementService = require('../services/settlementService');
const User = require('../models/User');
const Master = require('../models/Master');
const { buildSettlementReport } = require('../services/settlementReportService');
const { sanitizeErrorMessage } = require('../utils/sanitizeError');

/**
 * GET /master/settlement-report
 * Query: from, to (YYYY-MM-DD, required), target_id (a User or Master id
 * within the caller's own hierarchy; defaults to the caller's own master
 * account when the caller is a master), with_opening ('true'/'false').
 *
 * Was a placeholder ({data: null}) — see settlementReportService.js for the
 * actual calculation. This function only resolves + authorizes the target;
 * all computation lives in that separate, self-contained service.
 */
const getSettlementReport = async (req, res) => {
  try {
    const { from, to, target_id, with_opening } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to are required', data: null });
    }
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid from/to date', data: null });
    }
    const withOpening = with_opening === 'true' || with_opening === '1';

    // Per-admin master-visibility restriction, resolved once and reused
    // below wherever a target needs checking against it.
    const { resolveHiddenMasterIds } = require('../utils/adminVisibility');
    const hiddenMasterIds = await resolveHiddenMasterIds(req);

    // Resolve + authorize the target. Admin may view anyone (default: the
    // top-level masters list); a master may only view their own account or
    // something in their own full subtree (same getAllSubMasterIds scope
    // used for every other sensitive endpoint fixed on this platform —
    // never a caller-supplied id trusted without an ownership check).
    let targetType = null;
    let targetDoc = null;

    if (!target_id) {
      if (req.admin) {
        targetType = 'Admin';
        targetDoc = null;
      } else {
        targetType = 'Master';
        targetDoc = await Master.findOne({ _id: req.master.id, deleted_at: null }).lean();
      }
    } else {
      if (req.master) {
        const { getAllSubMasterIds } = require('../services/masterHierarchyService');
        const allowedMasterIds = await getAllSubMasterIds(req.master.id);
        const isOwnMaster = target_id === req.master.id || allowedMasterIds.includes(target_id);
        const targetUser = await User.findOne({ _id: target_id, deleted_at: null }).lean();
        if (targetUser) {
          if (!allowedMasterIds.includes(targetUser.master_id?.toString())) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this account', data: null });
          }
          targetType = 'User';
          targetDoc = targetUser;
        } else if (isOwnMaster) {
          targetType = 'Master';
          targetDoc = await Master.findOne({ _id: target_id, deleted_at: null }).lean();
        } else {
          return res.status(403).json({ success: false, message: 'Not authorized to view this account', data: null });
        }
      } else {
        // Admin: any User or Master, except a hidden master (or a hidden
        // master's user).
        const targetUser = await User.findOne({ _id: target_id, deleted_at: null }).lean();
        if (targetUser) {
          if (hiddenMasterIds && hiddenMasterIds.has(targetUser.master_id?.toString())) {
            return res.status(404).json({ success: false, message: 'Account not found', data: null });
          }
          targetType = 'User';
          targetDoc = targetUser;
        } else {
          if (hiddenMasterIds && hiddenMasterIds.has(target_id.toString())) {
            return res.status(404).json({ success: false, message: 'Account not found', data: null });
          }
          targetType = 'Master';
          targetDoc = await Master.findOne({ _id: target_id, deleted_at: null }).lean();
        }
      }
    }

    if (!targetDoc && targetType !== 'Admin') {
      return res.status(404).json({ success: false, message: 'Account not found', data: null });
    }

    // Caller identity — needed so each row can also show what the CALLER
    // themselves nets from it (their own share, after their own parent's
    // cut), alongside that row's own raw P&L/brokerage/total.
    const callerRole = req.admin ? 'admin' : 'master';
    const callerId = req.admin?.id || req.master?.id;

    const report = await buildSettlementReport(targetType, targetDoc, fromDate, toDate, withOpening, hiddenMasterIds, callerId, callerRole);
    res.status(200).json({ success: true, message: 'Settlement report', data: report });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
  }
};

/** POST /admin/settlement/start — Trigger settlement */
const startSettlement = async (req, res) => {
  try {
    const result = await settlementService.runSettlement({ trigger: 'manual' });
    res.status(result.success ? 200 : 409).json({ success: result.success, message: result.message, data: { ...settlementService.getState(), run_id: result.runId, period_key: result.periodKey, already_completed: result.alreadyCompleted || false } });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
  }
};

/** GET /admin/settlement/status — Get current settlement progress */
const getSettlementStatus = async (req, res) => {
  try {
    const state = await settlementService.getStatus();
    const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    res.status(200).json({ success: true, message: 'Settlement status', data: { ...state, percentage: pct } });
  } catch (error) {
    res.status(500).json({ success: false, message: sanitizeErrorMessage(error), data: null });
  }
};

module.exports = { startSettlement, getSettlementStatus, getSettlementReport };
