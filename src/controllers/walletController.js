'use strict';

/**
 * walletController — HTTP surface for the category trade-wallet funding flow
 * (Requirements 5.1–5.7, design §9). These are thin controllers over the central
 * `walletService` (Task 4): they validate input, enforce hierarchy authorization,
 * delegate the actual money move to `walletService` (which owns its own Mongo
 * transaction + `Transaction` audit record), and shape the standard
 * `{ success, message, data }` response.
 *
 * The same handlers are mounted in two places with different auth:
 *   - `/api/master/wallet/*` via masterFlowRoutes (`authenticateAdminOrMaster`) —
 *     a MASTER funds/withdraws a DIRECT child from the master's own pool (a
 *     transfer: debit master + credit child). Admin may also hit these.
 *   - `/api/admin/wallet/*` via adminRoutes (`authenticateAdmin`) — ADMIN grants /
 *     removes funds for anyone (no admin debit), plus the `reconcile` drift audit.
 *
 * Actor resolution: `req.master` → a Master actor, else `req.admin` → an Admin
 * actor. `walletService.assign`/`withdraw` branch on `actor.type`:
 *   - Master → transfer (guarded debit of the master's own pool, then credit).
 *   - Admin  → grant/remove (credit/guarded-debit of the target only).
 *
 * @module controllers/walletController
 */

const User = require('../models/User');
const Master = require('../models/Master');
const walletService = require('../services/walletService');
const metricsEngine = require('../services/metricsEngine');

/** Valid owner/target discriminators for the wallet endpoints. */
const OWNER_TYPES = Object.freeze(['User', 'Master']);

/** Map an owner/target discriminator to its Mongoose model. */
const OWNER_MODELS = Object.freeze({ User, Master });

/**
 * Resolve the acting principal from the authenticated request. A master token
 * wins if both are somehow present (the master routes only ever set `req.master`,
 * the admin routes only `req.admin`).
 *
 * @param {import('express').Request} req
 * @returns {{type:'Master'|'Admin', id:string}|null} the actor, or null if unauthenticated
 */
function resolveActor(req) {
  if (req.master && req.master.id) return { type: 'Master', id: req.master.id };
  if (req.admin && req.admin.id) return { type: 'Admin', id: req.admin.id };
  return null;
}

/**
 * Build an Error carrying an HTTP `status`, so the handler catch blocks can map
 * an authorization failure to the right response code.
 *
 * @param {number} status
 * @param {string} message
 * @returns {Error & {status:number}}
 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Apply an inline `wallet` funding map to a freshly created / edited account
 * (Task 13, design §13.3). This is the shared helper wired into the user/master
 * Create and Edit controllers so that supplying an initial `wallet` map funds the
 * new account through the same audited, hierarchy-debited `walletService.assign`
 * path as the dedicated funding endpoints.
 *
 * Actor semantics (resolved from the authenticated request):
 *   - **Master** → each category funding is a TRANSFER: `walletService.assign`
 *     debits the master's OWN same-category pool then credits the target. If the
 *     master's pool cannot cover it, `assign` throws `INSUFFICIENT_WALLET`, which
 *     PROPAGATES to the caller (a master cannot fund a child beyond its own
 *     balance — Requirement 5.3).
 *   - **Admin** → each funding is a GRANT: credit the target only (no debit).
 *
 * For each category in `walletService.CATEGORIES` the map's amount is read; a
 * non-finite or `<= 0` amount is skipped (a create/edit only funds the categories
 * the caller actually specified). When a `session` is passed the funding runs
 * inside the caller's Mongo transaction so it commits/aborts atomically with the
 * account write; without one, `walletService.assign` opens its own transaction
 * per category.
 *
 * @param {object} params
 * @param {import('express').Request} params.req            - the authenticated request (actor source)
 * @param {'User'|'Master'} params.targetType               - the account being funded
 * @param {string|import('mongoose').Types.ObjectId} params.targetId
 * @param {{NSE?:number, MCX?:number, GLOBAL?:number}} [params.walletMap] - amounts per category
 * @param {import('mongoose').ClientSession|null} [params.session]        - caller transaction, if any
 * @returns {Promise<{funded: Array<{category:string, amount:number}>}>}   - summary of applied funding
 * @throws {Error & {status:number}} 401-style error when the request carries no actor
 * @throws error tagged `code:'INSUFFICIENT_WALLET'` (propagated from `walletService.assign`)
 *         when a master over-funds — the surrounding transaction should abort.
 */
async function applyWalletFunding({ req, targetType, targetId, walletMap, session = null }) {
  const actor = resolveActor(req);
  if (!actor) {
    // Shouldn't happen on an authenticated route; guard so we never fund anonymously.
    throw httpError(401, 'Authentication required to fund a wallet');
  }

  const funded = [];
  for (const category of walletService.CATEGORIES) {
    const amount = Number(walletMap && walletMap[category]);
    // Only fund categories the caller explicitly specified with a positive amount;
    // skip missing/zero/negative/NaN entries.
    if (!Number.isFinite(amount) || amount <= 0) continue;

    // Master → transfer (guarded debit of the master's own pool); Admin → grant.
    // A master over-funding throws INSUFFICIENT_WALLET, which we let propagate so
    // a create transaction aborts (Requirement 5.3). Pass the session through so
    // the move is atomic with the account write when one is provided.
    await walletService.assign(actor, targetType, targetId, category, amount, session);
    funded.push({ category, amount });
  }

  return { funded };
}

/**
 * Authorize an actor against a funding/withdrawal target and return the loaded
 * target doc (Requirement 5.6).
 *
 * - **Admin** → allowed for anyone; 404 if the target does not exist.
 * - **Master** → the target must be a DIRECT CHILD the master owns:
 *     - a `User` target's owning master is `User.master_id`;
 *     - a sub-`Master` target's parent is `Master.master_id`.
 *   Both are compared against `actor.id`. 404 if missing, 403 if not a direct child.
 *
 * @param {{type:'Master'|'Admin', id:string}} actor
 * @param {'User'|'Master'} targetModel
 * @param {string} targetId
 * @returns {Promise<{master_id?:any}>} the loaded target doc
 * @throws {Error & {status:number}} 400/403/404 as above
 */
async function assertAuthorizedTarget(actor, targetModel, targetId) {
  const Model = OWNER_MODELS[targetModel];
  if (!Model) throw httpError(400, `Invalid target_type "${targetModel}"`);

  let target;
  try {
    target = await Model.findById(targetId).select('master_id').lean();
  } catch (_) {
    // A malformed id surfaces as a CastError — treat it as "not found".
    target = null;
  }
  if (!target) throw httpError(404, `${targetModel} not found`);

  if (actor.type === 'Admin') return target;

  // Master actor: only a direct child they own may be funded/withdrawn.
  if (String(target.master_id) !== String(actor.id)) {
    throw httpError(403, 'Not authorized: target is not a direct child you own');
  }
  return target;
}

/**
 * Validate a shared assign/withdraw request body. On invalid input this writes a
 * 400 response itself and returns `null`, so callers just `return` when it does.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {{target_id:string, target_type:'User'|'Master', category:string, amount:number}|null}
 */
function parseFundingBody(req, res) {
  const { target_id, target_type, category, amount } = req.body || {};

  if (!target_id) {
    res.status(400).json({ success: false, message: 'target_id is required', data: null });
    return null;
  }
  if (!OWNER_TYPES.includes(target_type)) {
    res.status(400).json({
      success: false,
      message: `target_type must be one of ${OWNER_TYPES.join(', ')}`,
      data: null,
    });
    return null;
  }
  if (!walletService.CATEGORIES.includes(category)) {
    res.status(400).json({
      success: false,
      message: `category must be one of ${walletService.CATEGORIES.join(', ')}`,
      data: null,
    });
    return null;
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ success: false, message: 'amount must be a positive number', data: null });
    return null;
  }

  return { target_id, target_type, category, amount: amt };
}

/**
 * POST `/wallet/assign` — fund a target's category pool.
 * Body: `{ target_id, target_type, category, amount }`.
 *
 * Master actor → transfer (debits the master's own same-category pool, then
 * credits the target). Admin actor → grant (credits the target only).
 * Requirements 5.1, 5.2, 5.3, 5.6.
 */
async function assign(req, res) {
  try {
    const parsed = parseFundingBody(req, res);
    if (!parsed) return; // 400 already sent

    const { target_id, target_type, category, amount } = parsed;

    const actor = resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: 'Authentication required', data: null });
    }

    await assertAuthorizedTarget(actor, target_type, target_id);

    // walletService owns its own transaction + audit when no session is passed.
    await walletService.assign(actor, target_type, target_id, category, amount);

    if (target_type === 'User') {
      await metricsEngine.onTradeExecuted(target_id).catch(e => console.error('Failed to update metrics cache:', e));
    }

    const wallet = await walletService.getAvailable(target_type, target_id);
    return res.status(200).json({
      success: true,
      message: `Assigned ₹${amount} to ${category} wallet`,
      data: { owner_type: target_type, owner_id: target_id, wallet },
    });
  } catch (err) {
    if (err && err.code === walletService.INSUFFICIENT_WALLET) {
      // Master pool could not cover the transfer (Requirement 5.3).
      return res.status(400).json({
        success: false,
        message: `Insufficient ${err.category} balance to assign (master pool too low).`,
        data: null,
      });
    }
    if (err && err.status) {
      return res.status(err.status).json({ success: false, message: err.message, data: null });
    }
    return res.status(500).json({ success: false, message: err.message, data: null });
  }
}

/**
 * POST `/wallet/withdraw` — pull funds back from a target's category pool.
 * Body: `{ target_id, target_type, category, amount }`.
 *
 * Guarded debit on the target; a master actor gets the amount credited back to
 * its own pool, an admin simply removes it. Requirements 5.4, 5.6.
 */
async function withdraw(req, res) {
  try {
    const parsed = parseFundingBody(req, res);
    if (!parsed) return; // 400 already sent

    const { target_id, target_type, category, amount } = parsed;

    const actor = resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: 'Authentication required', data: null });
    }

    await assertAuthorizedTarget(actor, target_type, target_id);

    await walletService.withdraw(actor, target_type, target_id, category, amount);

    if (target_type === 'User') {
      await metricsEngine.onTradeExecuted(target_id).catch(e => console.error('Failed to update metrics cache:', e));
    }

    const wallet = await walletService.getAvailable(target_type, target_id);
    return res.status(200).json({
      success: true,
      message: `Withdrew ₹${amount} from ${category} wallet`,
      data: { owner_type: target_type, owner_id: target_id, wallet },
    });
  } catch (err) {
    if (err && err.code === walletService.INSUFFICIENT_WALLET) {
      // Target pool could not cover the withdrawal (Requirement 5.4).
      return res.status(400).json({
        success: false,
        message: `Insufficient ${err.category} balance to withdraw from the target.`,
        data: null,
      });
    }
    if (err && err.status) {
      return res.status(err.status).json({ success: false, message: err.message, data: null });
    }
    return res.status(500).json({ success: false, message: err.message, data: null });
  }
}

/**
 * GET `/wallet?owner_id=&owner_type=` — read an owner's per-category available
 * balances.
 *
 * Admin may read anyone. A master may read only its OWN wallet or a direct
 * child's (Requirement 5.6); anything else is 403.
 */
async function getWallet(req, res) {
  try {
    const { owner_id, owner_type } = req.query || {};

    if (!owner_id) {
      return res.status(400).json({ success: false, message: 'owner_id is required', data: null });
    }
    if (!OWNER_TYPES.includes(owner_type)) {
      return res.status(400).json({
        success: false,
        message: `owner_type must be one of ${OWNER_TYPES.join(', ')}`,
        data: null,
      });
    }

    const actor = resolveActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, message: 'Authentication required', data: null });
    }

    if (actor.type === 'Master') {
      const isSelf = owner_type === 'Master' && String(owner_id) === String(actor.id);
      if (!isSelf) {
        // Non-self reads are only allowed for a direct child (throws 403/404).
        await assertAuthorizedTarget(actor, owner_type, owner_id);
      }
    }

    const wallet = await walletService.getAvailable(owner_type, owner_id);
    return res.status(200).json({
      success: true,
      message: 'Wallet balances',
      data: { owner_type, owner_id, wallet },
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ success: false, message: err.message, data: null });
    }
    return res.status(500).json({ success: false, message: err.message, data: null });
  }
}

/**
 * GET `/wallet/reconcile?owner_id=&owner_type=` — ADMIN-ONLY drift audit.
 *
 * The route is guarded by `authenticateAdmin`, so `req.admin` is guaranteed here.
 * Returns per-category `{ available, blocked, total }` where `blocked` is
 * recomputed from the owner's open positions (design §9).
 */
async function reconcile(req, res) {
  try {
    const { owner_id, owner_type } = req.query || {};

    if (!owner_id) {
      return res.status(400).json({ success: false, message: 'owner_id is required', data: null });
    }
    if (!OWNER_TYPES.includes(owner_type)) {
      return res.status(400).json({
        success: false,
        message: `owner_type must be one of ${OWNER_TYPES.join(', ')}`,
        data: null,
      });
    }

    const data = await walletService.reconcile(owner_type, owner_id);
    return res.status(200).json({ success: true, message: 'Wallet reconciliation', data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, data: null });
  }
}

module.exports = {
  assign,
  withdraw,
  getWallet,
  reconcile,
  // Shared inline create/edit funding helper (Task 13, design §13.3).
  applyWalletFunding,
  // Exposed for unit tests / reuse.
  resolveActor,
  assertAuthorizedTarget,
};
