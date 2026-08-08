'use strict';

/**
 * walletService — the single choke point for every category-wallet balance
 * change (design §5 / §D1 / §12).
 *
 * Each User/Master stores `wallet.{NSE,MCX,GLOBAL}` = the *available* (spendable)
 * balance for that category. This number is the source of truth for the
 * affordability gate and for displayed equity. All mutations flow through the
 * helpers below so the never-negative and atomic guarantees hold everywhere:
 *
 *   - block()   opens/reserves margin via a single guarded atomic `$inc`. This
 *               is the one write-conflict point that makes concurrent opens
 *               race-free and never-negative (design §D1).
 *   - release() returns margin on close/reduce (never guarded; always allowed).
 *   - assign()  funds a target down the hierarchy (master transfer / admin grant).
 *   - withdraw() pulls funds back from a target (guarded on the target).
 *   - getAvailable() reads the current per-category balances.
 *   - reconcile()   recomputes blocked margin from open positions (drift audit).
 *
 * Every method is session-aware: pass the caller's Mongo transaction session so
 * wallet mutations commit/roll back atomically with the trade (or transfer)
 * write. `assign`/`withdraw` will open and own a transaction if none is passed.
 *
 * All amounts are rounded to 2-decimal money precision before they touch the DB.
 *
 * @module services/walletService
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Master = require('../models/Master');
const Transaction = require('../models/Transaction');
const Trade = require('../models/Trade');
const KiteInstrument = require('../models/KiteInstrument');
const { categoryForSegment } = require('../utils/walletCategory');

/** Error `code` thrown when a guarded balance move cannot be covered. */
const INSUFFICIENT_WALLET = 'INSUFFICIENT_WALLET';

/** Valid category pools (matches the wallet sub-schema on User/Master). */
const CATEGORIES = Object.freeze(['NSE', 'MCX', 'GLOBAL']);

/** Owner/target model discriminators that resolve to a Mongoose model. */
const OWNER_MODELS = Object.freeze({ User, Master });

/**
 * Round a value to 2-decimal money precision.
 *
 * Uses the `+ Number.EPSILON` nudge before scaling so values that are a hair
 * below a cent boundary in IEEE-754 (e.g. 1.005 stored as 1.00499999…) round
 * the way a human expects rather than truncating down. Defined locally on
 * purpose so walletService owns its own money rounding.
 *
 * @param {number} value
 * @returns {number} value rounded to 2 decimals
 */
function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve a `'User' | 'Master'` discriminator to its Mongoose model.
 * @param {'User'|'Master'} ownerModel
 * @returns {import('mongoose').Model<any>}
 */
function resolveModel(ownerModel) {
  const Model = OWNER_MODELS[ownerModel];
  if (!Model) {
    throw new Error(`walletService: unknown owner model "${ownerModel}" (expected 'User' or 'Master')`);
  }
  return Model;
}

/**
 * Validate a category pool name.
 * @param {'NSE'|'MCX'|'GLOBAL'} category
 */
function assertCategory(category) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`walletService: invalid category "${category}" (expected one of ${CATEGORIES.join(', ')})`);
  }
}

/**
 * Validate and round a money amount that must be strictly positive.
 * @param {number} amount
 * @returns {number} the rounded, validated amount
 */
function assertPositiveAmount(amount) {
  const rounded = roundMoney(amount);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new Error(`walletService: amount must be a positive number (got ${amount})`);
  }
  return rounded;
}

/** Normalise an id (string or ObjectId) to an ObjectId for aggregation `$match`. */
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return new mongoose.Types.ObjectId(String(id));
}

/** Build an INSUFFICIENT_WALLET error carrying the category + requested amount. */
function insufficientWalletError(category, requested) {
  const err = new Error(
    `${INSUFFICIENT_WALLET}: ${category} wallet cannot cover ${requested}`
  );
  err.code = INSUFFICIENT_WALLET;
  err.category = category;
  err.requested = requested;
  return err;
}

/**
 * Read a single owner's raw wallet sub-document (session-aware).
 * @returns {Promise<{NSE:number,MCX:number,GLOBAL:number}>}
 */
async function readWallet(Model, ownerId, session = null) {
  let query = Model.findById(ownerId).select('wallet');
  if (session) query = query.session(session);
  const doc = await query.lean();
  const wallet = (doc && doc.wallet) || {};
  return {
    NSE: Number(wallet.NSE) || 0,
    MCX: Number(wallet.MCX) || 0,
    GLOBAL: Number(wallet.GLOBAL) || 0,
  };
}

/**
 * Run `fn(session)` inside the caller's session, or open and own a transaction
 * when no session is supplied. Used by `assign`/`withdraw` so their two wallet
 * mutations + audit write are always atomic (both-or-neither).
 *
 * @param {import('mongoose').ClientSession|null} session
 * @param {(session: import('mongoose').ClientSession) => Promise<any>} fn
 */
async function withOptionalSession(session, fn) {
  if (session) return fn(session);

  const ownSession = await mongoose.startSession();
  try {
    let result;
    await ownSession.withTransaction(async () => {
      result = await fn(ownSession);
    });
    return result;
  } finally {
    ownSession.endSession();
  }
}

/**
 * Reserve (block) margin from a category pool via a single guarded atomic
 * update. Decrements only when the balance can still cover `amount`, so
 * concurrent opens can never drive the pool below 0 or lose a write.
 *
 * @param {'User'|'Master'} ownerModel   - owner discriminator
 * @param {string|import('mongoose').Types.ObjectId} ownerId
 * @param {'NSE'|'MCX'|'GLOBAL'} category
 * @param {number} amount                - notional to reserve (rounded internally)
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<{category:string, amount:number}>}
 * @throws error tagged `code: 'INSUFFICIENT_WALLET'` (with `.category`, `.requested`)
 *         when the pool cannot cover the amount.
 */
async function block(ownerModel, ownerId, category, amount, session = null) {
  assertCategory(category);
  const rounded = assertPositiveAmount(amount);
  const Model = resolveModel(ownerModel);
  const field = `wallet.${category}`;
  const options = session ? { session } : {};

  const result = await Model.updateOne(
    { _id: ownerId, [field]: { $gte: rounded } },
    { $inc: { [field]: -rounded } },
    options
  );

  const matched = result && (result.matchedCount != null ? result.matchedCount : result.n);
  if (!matched) {
    // Either the pool was short, or the owner does not exist. Both mean "this
    // move cannot be applied" — surface as INSUFFICIENT_WALLET for the caller.
    throw insufficientWalletError(category, rounded);
  }

  return { category, amount: rounded };
}

/**
 * Return (release) margin to a category pool. Never guarded — releasing margin
 * on a close/reduce is always allowed and can only increase the balance.
 *
 * @param {'User'|'Master'} ownerModel
 * @param {string|import('mongoose').Types.ObjectId} ownerId
 * @param {'NSE'|'MCX'|'GLOBAL'} category
 * @param {number} amount               - entry notional to return (rounded internally)
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<{category:string, amount:number}>}
 */
async function release(ownerModel, ownerId, category, amount, session = null) {
  assertCategory(category);
  const rounded = assertPositiveAmount(amount);
  const Model = resolveModel(ownerModel);
  const field = `wallet.${category}`;
  const options = session ? { session } : {};

  await Model.updateOne(
    { _id: ownerId },
    { $inc: { [field]: rounded } },
    options
  );

  return { category, amount: rounded };
}

/**
 * Write a wallet-funding audit record (design §5, Requirement 5.5). Captures the
 * actor, target, category, amount, direction and before/after balances so every
 * assign/withdraw is fully traceable.
 *
 * @param {object} params
 * @param {'WALLET_ASSIGN'|'WALLET_WITHDRAW'} params.type
 * @param {'ASSIGN'|'WITHDRAW'} params.direction
 * @param {{type:string, id?:any}} params.actor
 * @param {'User'|'Master'} params.targetModel
 * @param {any} params.targetId
 * @param {string} params.category
 * @param {number} params.amount
 * @param {number} params.targetBefore
 * @param {number} params.targetAfter
 * @param {number|null} params.actorBefore
 * @param {number|null} params.actorAfter
 * @param {import('mongoose').ClientSession|null} params.session
 */
async function writeFundingAudit(params) {
  const {
    type, direction, actor, targetModel, targetId, category, amount,
    targetBefore, targetAfter, actorBefore, actorAfter, session,
  } = params;

  const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_W`;

  const doc = {
    transactionId,
    userId: targetId,
    userModel: targetModel,
    type,
    status: 'SUCCESS',
    amount,
    referenceId: actor && actor.id ? actor.id : undefined,
    referenceModel: actor && (actor.type === 'Master' || actor.type === 'Admin') ? actor.type : undefined,
    balanceBefore: roundMoney(targetBefore),
    balanceAfter: roundMoney(targetAfter),
    metadata: {
      category,
      direction,
      actor: { type: actor ? actor.type : null, id: actor && actor.id ? actor.id : null },
      target: { type: targetModel, id: targetId },
      targetBalanceBefore: roundMoney(targetBefore),
      targetBalanceAfter: roundMoney(targetAfter),
      actorBalanceBefore: actorBefore == null ? null : roundMoney(actorBefore),
      actorBalanceAfter: actorAfter == null ? null : roundMoney(actorAfter),
    },
  };

  await Transaction.create([doc], session ? { session } : {});
}

/**
 * Fund a target's category pool.
 *
 * - **Master actor** → a transfer: atomic guarded `block` on the master's own
 *   pool (rejected if it would go below 0) followed by `release` on the target.
 *   Because the block runs first, a failed debit never credits the target.
 * - **Admin actor** → a grant: `release` on the target only (admin is the root
 *   of funds, so there is no debit source).
 *
 * Runs inside the caller's `session` when provided, otherwise opens and owns a
 * transaction so the debit + credit + audit are atomic.
 *
 * @param {{type:'Master'|'Admin', id?:any}} actor   - who is funding
 * @param {'User'|'Master'} targetModel              - target discriminator
 * @param {string|import('mongoose').Types.ObjectId} targetId
 * @param {'NSE'|'MCX'|'GLOBAL'} category
 * @param {number} amount
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<{category:string, amount:number, actor:string, targetModel:string}>}
 */
async function assign(actor, targetModel, targetId, category, amount, session = null) {
  if (!actor || (actor.type !== 'Master' && actor.type !== 'Admin')) {
    throw new Error(`walletService.assign: actor.type must be 'Master' or 'Admin'`);
  }
  assertCategory(category);
  const rounded = assertPositiveAmount(amount);
  resolveModel(targetModel); // validate early

  return withOptionalSession(session, async (s) => {
    const targetBefore = (await readWallet(resolveModel(targetModel), targetId, s))[category];

    let actorBefore = null;
    let actorAfter = null;

    if (actor.type === 'Master') {
      actorBefore = (await readWallet(Master, actor.id, s))[category];
      // Debit the master first — throws INSUFFICIENT_WALLET (and aborts the
      // transaction) before the target is ever credited.
      await block('Master', actor.id, category, rounded, s);
      actorAfter = roundMoney(actorBefore - rounded);
    }

    // Credit the target (grant for admin, transfer leg for master).
    await release(targetModel, targetId, category, rounded, s);
    const targetAfter = roundMoney(targetBefore + rounded);

    await writeFundingAudit({
      type: 'WALLET_ASSIGN',
      direction: 'ASSIGN',
      actor,
      targetModel,
      targetId,
      category,
      amount: rounded,
      targetBefore,
      targetAfter,
      actorBefore,
      actorAfter,
      session: s,
    });

    return { category, amount: rounded, actor: actor.type, targetModel };
  });
}

/**
 * Pull funds back from a target's category pool.
 *
 * Guarded `block` on the **target** (rejected if it would drive the target
 * below 0). When the actor is a **Master**, the withdrawn amount is `release`d
 * back to the master's own pool; for an **Admin** the funds simply leave the
 * system (no destination).
 *
 * Runs inside the caller's `session` when provided, otherwise opens and owns a
 * transaction so the debit + credit + audit are atomic.
 *
 * @param {{type:'Master'|'Admin', id?:any}} actor
 * @param {'User'|'Master'} targetModel
 * @param {string|import('mongoose').Types.ObjectId} targetId
 * @param {'NSE'|'MCX'|'GLOBAL'} category
 * @param {number} amount
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<{category:string, amount:number, actor:string, targetModel:string}>}
 * @throws error tagged `code: 'INSUFFICIENT_WALLET'` when the target cannot cover it.
 */
async function withdraw(actor, targetModel, targetId, category, amount, session = null) {
  if (!actor || (actor.type !== 'Master' && actor.type !== 'Admin')) {
    throw new Error(`walletService.withdraw: actor.type must be 'Master' or 'Admin'`);
  }
  assertCategory(category);
  const rounded = assertPositiveAmount(amount);
  resolveModel(targetModel); // validate early

  return withOptionalSession(session, async (s) => {
    const targetBefore = (await readWallet(resolveModel(targetModel), targetId, s))[category];

    // Debit the target first (guarded) — rejects an over-withdrawal before the
    // actor is credited.
    await block(targetModel, targetId, category, rounded, s);
    const targetAfter = roundMoney(targetBefore - rounded);

    let actorBefore = null;
    let actorAfter = null;
    if (actor.type === 'Master') {
      actorBefore = (await readWallet(Master, actor.id, s))[category];
      await release('Master', actor.id, category, rounded, s);
      actorAfter = roundMoney(actorBefore + rounded);
    }

    await writeFundingAudit({
      type: 'WALLET_WITHDRAW',
      direction: 'WITHDRAW',
      actor,
      targetModel,
      targetId,
      category,
      amount: rounded,
      targetBefore,
      targetAfter,
      actorBefore,
      actorAfter,
      session: s,
    });

    return { category, amount: rounded, actor: actor.type, targetModel };
  });
}

/**
 * Read an owner's current available balances for all three pools.
 *
 * @param {'User'|'Master'} ownerModel
 * @param {string|import('mongoose').Types.ObjectId} ownerId
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<{NSE:number, MCX:number, GLOBAL:number}>}
 */
async function getAvailable(ownerModel, ownerId, session = null) {
  const Model = resolveModel(ownerModel);
  const wallet = await readWallet(Model, ownerId, session);
  return {
    NSE: roundMoney(wallet.NSE),
    MCX: roundMoney(wallet.MCX),
    GLOBAL: roundMoney(wallet.GLOBAL),
  };
}

/**
 * Drift audit (admin-only usage; endpoint auth arrives in Task 12).
 *
 * Recomputes the margin that *should* be blocked from the owner's open
 * positions — `Σ |net_qty| × avgEntry` per category, where `avgEntry` is the
 * average buy price for a long net position and the average sell price for a
 * short one (design §D3) — and reports it alongside the stored available
 * balance. `available + blocked` reconstructs the originally-funded amount, so a
 * caller can compare it against the expected funding to detect drift.
 *
 * @param {'User'|'Master'} ownerModel
 * @param {string|import('mongoose').Types.ObjectId} ownerId
 * @returns {Promise<{ownerModel:string, ownerId:string, categories:Object}>}
 */
async function reconcile(ownerModel, ownerId) {
  resolveModel(ownerModel); // validate discriminator
  const ownerField = ownerModel === 'User' ? 'user_id' : 'master_id';

  const positions = await Trade.aggregate([
    { $match: { [ownerField]: toObjectId(ownerId), status: 'completed', deleted_at: null } },
    {
      $group: {
        _id: '$instrument_token',
        total_buy_qty: {
          $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] },
        },
        total_sell_qty: {
          $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] },
        },
        total_buy_value: {
          $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] },
        },
        total_sell_value: {
          $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] },
        },
      },
    },
  ]);

  const openPositions = [];
  for (const p of positions) {
    const buyQty = p.total_buy_qty || 0;
    const sellQty = p.total_sell_qty || 0;
    const netQty = buyQty - sellQty;
    if (netQty === 0) continue;
    const avgBuy = buyQty > 0 ? p.total_buy_value / buyQty : 0;
    const avgSell = sellQty > 0 ? p.total_sell_value / sellQty : 0;
    const avgEntry = netQty > 0 ? avgBuy : avgSell;
    openPositions.push({ token: p._id, notional: Math.abs(netQty) * avgEntry });
  }

  // Resolve each open instrument's segment → category.
  const tokens = openPositions.map((p) => p.token);
  const instruments = tokens.length
    ? await KiteInstrument.find({ instrument_token: { $in: tokens } }).select('instrument_token segment').lean()
    : [];
  const segmentByToken = {};
  instruments.forEach((i) => { segmentByToken[i.instrument_token] = i.segment || ''; });

  const blocked = { NSE: 0, MCX: 0, GLOBAL: 0 };
  for (const pos of openPositions) {
    const category = categoryForSegment(segmentByToken[pos.token] || '');
    blocked[category] += pos.notional;
  }

  const available = await getAvailable(ownerModel, ownerId);
  const categories = {};
  for (const cat of CATEGORIES) {
    const avail = roundMoney(available[cat] || 0);
    const blk = roundMoney(blocked[cat] || 0);
    categories[cat] = { available: avail, blocked: blk, total: roundMoney(avail + blk) };
  }

  return { ownerModel, ownerId: String(ownerId), categories };
}

module.exports = {
  block,
  release,
  assign,
  withdraw,
  getAvailable,
  reconcile,
  // Exposed for callers that need to branch on the guarded-move failure.
  INSUFFICIENT_WALLET,
  CATEGORIES,
};
