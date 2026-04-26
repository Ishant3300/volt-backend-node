const settlementService = require('../services/settlementService');

/** GET /master/settlement-report — Settlement report (placeholder, was imported by masterFlowRoutes) */
const getSettlementReport = async (req, res) => {
  res.status(200).json({ success: true, message: 'Settlement report not yet implemented', data: null });
};

/** POST /admin/settlement/start — Trigger settlement */
const startSettlement = async (req, res) => {
  try {
    const result = await settlementService.runSettlement();
    res.status(result.success ? 200 : 409).json({ success: result.success, message: result.message, data: settlementService.getState() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/** GET /admin/settlement/status — Get current settlement progress */
const getSettlementStatus = async (req, res) => {
  try {
    const state = settlementService.getState();
    const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    res.status(200).json({ success: true, message: 'Settlement status', data: { ...state, percentage: pct } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

module.exports = { startSettlement, getSettlementStatus, getSettlementReport };
