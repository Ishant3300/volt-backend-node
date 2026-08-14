const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Master = require('../models/Master');
const Server = require('../models/Server');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Message = require('../models/Message');
const Trade = require('../models/Trade');
const CreditTransaction = require('../models/CreditTransaction');
const KiteInstrument = require('../models/KiteInstrument');
const { beginTradeWrite } = require('../services/tradeWriteFenceService');
const walletService = require('../services/walletService');
const { categoryForSegment } = require('../utils/walletCategory');
const { applyWalletFunding } = require('./walletController');
const { calculateBrokerage } = require('../services/brokerageService');

/**
 * Square off all open positions for a user in the given segments.
 * Uses bid/ask from metricsEngine (same as orders page CMP).
 * Returns the number of positions squared off.
 */
async function _squareOffUserSegments(userId, segments, options = {}) {
  const metricsEngine = require('../services/metricsEngine');
  let lease = null;
  let session = null;
  let squaredOff = 0;

  try {
    lease = await beginTradeWrite('intraday_square_off');
    const startSession = options.startSession || (() => mongoose.startSession());
    session = await startSession();
    // The lease is deliberately acquired before every mutable position/price
    // read so settlement cannot commit between this snapshot and our writes.
    const [metrics, user] = await Promise.all([
      metricsEngine.getFreshMetrics(userId),
      User.findById(userId).select('master_id admin_id').lean(),
    ]);
    if (!user || !metrics?.positions?.length) return 0;

    const segmentsUpper = segments.map(segment => segment.toUpperCase());
    const tradesToCreate = [];
    const releasesToApply = [];
    for (const pos of metrics.positions) {
      if (pos.net_qty === 0) continue;

      const posSeg = (pos.segment || '').toUpperCase();
      const posExchange = (pos.exchange || '').toUpperCase();
      const matches = segmentsUpper.some(segment =>
        segment === posSeg || segment === posExchange
        || (segment === 'INDICES' && (posSeg === 'INDICES' || posExchange === 'GLOBAL'))
        || (segment === 'GLOBAL' && (posSeg === 'INDICES' || posExchange === 'GLOBAL'))
      );
      if (!matches) continue;

      const closeSide = pos.net_qty > 0 ? 'SELL' : 'BUY';
      const absQty = Math.abs(pos.net_qty);
      const closePrice = closeSide === 'SELL'
        ? (metricsEngine._bidMap?.get(pos.instrument_token) || pos.ltp || pos.cmp)
        : (metricsEngine._askMap?.get(pos.instrument_token) || pos.ltp || pos.cmp);
      if (!closePrice || closePrice <= 0) continue;

      const avgEntry = pos.net_qty > 0 ? pos.avg_buy_price : pos.avg_sell_price;
      const closingPnl = pos.net_qty > 0
        ? (closePrice - avgEntry) * absQty
        : (avgEntry - closePrice) * absQty;
      const newTradeObj = {
        user_id: userId,
        master_id: user.master_id,
        admin_id: user.admin_id || null,
        instrument_token: pos.instrument_token,
        tradingsymbol: pos.tradingsymbol,
        exchange: pos.exchange,
        transaction_type: closeSide,
        quantity: absQty,
        price: closePrice,
        order_type: 'MARKET',
        placed_by: 'SYSTEM',
        trade_type: 'margin_square_off',
        status: 'completed',
        executed_at: new Date(),
        executed_price: closePrice,
        executed_quantity: absQty,
        pnl: Math.round(closingPnl * 100) / 100,
        remarks: `Intraday square-off: ${pos.segment} segment closed by admin`,
      };
      
      const sessionBrokerage = await calculateBrokerage(newTradeObj, session);
      newTradeObj.brokerage = sessionBrokerage;
      newTradeObj.net_amount = newTradeObj.pnl - sessionBrokerage;
      
      tradesToCreate.push(newTradeObj);

      // Requirement 3.2 / 7.5: collect the closed position's ENTRY notional to
      // release back to its category wallet. Prefer the SEGMENT over the base
      // exchange so 'NFO-FUT'→NSE / 'MCX-FUT'→MCX (exchange alone would be wrong).
      const releaseAmount = absQty * avgEntry;
      if (releaseAmount > 0) {
        releasesToApply.push({
          category: categoryForSegment(pos.segment || pos.exchange || ''),
          amount: releaseAmount,
        });
      }
    }

    if (tradesToCreate.length === 0) return 0;
    await session.withTransaction(async () => {
      await lease.assertActive({ session });
      await Trade.insertMany(tradesToCreate, { session, ordered: true });
      // Requirement 3.2 / 7.5: release each closed position's ENTRY notional
      // back to its category wallet inside the same transaction as the close
      // writes, so the releases commit atomically with the square-off trades.
      for (const r of releasesToApply) {
        await walletService.release('User', userId, r.category, r.amount, session);
      }
      await lease.assertActive({ session });
    });
    squaredOff = tradesToCreate.length;
  } finally {
    try {
      if (session) await session.endSession();
    } finally {
      await lease?.release();
    }
  }

  if (squaredOff > 0) await metricsEngine.onTradeExecuted(userId);
  return squaredOff;
}

// Create User
const createUser = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {
      name,
      username,
      password,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed,
      trade_limit,
      margin_square_off,
      change_pass_on_first_login,
      server_id,
      status
    } = req.body;

    // Validate required fields
    if (!name || !username || !password || !server_id || credits === undefined || pnl_sharing === undefined || brokerage_sharing === undefined || !exchanges_allowed || !trade_limit) {
      return res.status(400).json({
        success: false,
        message: 'Name, username, password, credits, pnl_sharing, brokerage_sharing, exchanges_allowed, trade_limit, and server_id are required',
        data: null
      });
    }

    if (credits < 0) {
      return res.status(400).json({
        success: false,
        message: 'Credits must be a positive number',
        data: null
      });
    }

    if (pnl_sharing < 0 || pnl_sharing > 100) {
      return res.status(400).json({
        success: false,
        message: 'P&L sharing must be between 0 and 100',
        data: null
      });
    }

    if (brokerage_sharing < 0 || brokerage_sharing > 100) {
      return res.status(400).json({
        success: false,
        message: 'Brokerage sharing must be between 0 and 100',
        data: null
      });
    }

    if (!Array.isArray(exchanges_allowed)) {
      return res.status(400).json({
        success: false,
        message: 'exchanges_allowed must be an array',
        data: null
      });
    }

    for (const exchange of exchanges_allowed) {
      if (!exchange.exchange_name || exchange.turnover === undefined || exchange.lot === undefined || !exchange.group_name) {
        return res.status(400).json({
          success: false,
          message: 'Each exchange must have exchange_name, turnover, lot, and group_name',
          data: null
        });
      }
    }

    const normalizedExchangesAllowed = exchanges_allowed.map(ex => {
      let name = ex.exchange_name.toUpperCase();
      if (name === 'GLOBAL') name = 'INDICES';
      return {
        ...ex,
        exchange_name: name
      };
    });

    const normalizedTradeLimit = trade_limit.map(ex => {
      let name = ex.toUpperCase();
      if (name === 'GLOBAL') name = 'INDICES';
      return name;
    });

    let resultData;

    await session.withTransaction(async () => {
      // Get parent master
      const parentMaster = await Master.findById(req.master.id).session(session);

      if (!parentMaster) {
        throw new Error('Parent master not found');
      }

      // Account limit enforcement
      if (parentMaster.account_limit && parentMaster.account_limit.enabled) {
        const usersCreated = await User.countDocuments({ master_id: parentMaster._id, deleted_at: null }).session(session);
        if (usersCreated >= parentMaster.account_limit.max_users) {
          throw new Error(`Account limit reached. Maximum ${parentMaster.account_limit.max_users} users allowed.`);
        }
      }

      // Check if parent master has sufficient balance
      if (parentMaster.equity < credits) {
        throw new Error(`Insufficient balance. Available: ${parentMaster.equity}, Required: ${credits}`);
      }

      // Check if username already exists
      const existingUser = await User.findOne({ username }).session(session);
      if (existingUser) {
        throw new Error('Username already exists');
      }

      // Verify server exists
      const server = await Server.findById(server_id).session(session);
      if (!server) {
        throw new Error('Server not found');
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      const user = new User({
        name,
        username,
        password: hashedPassword,
        credits,
        equity: credits,
        note,
        pnl_sharing,
        brokerage_sharing,
        exchanges_allowed: normalizedExchangesAllowed,
        trade_limit: normalizedTradeLimit,
        margin_square_off: margin_square_off || false,
        change_pass_on_first_login: change_pass_on_first_login || false,
        server_id,
        master_id: parentMaster._id,
        status: status || 'active'
      });
      await user.save({ session });

      const prevMasterBalance = parentMaster.equity;
      parentMaster.equity -= credits;
      await parentMaster.save({ session });

      // Create transaction record for Master (Debit)
      const masterTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_M`,
        userId: parentMaster._id,
        userModel: 'Master',
        type: 'DEBIT',
        status: 'SUCCESS',
        amount: credits,
        referenceId: user._id,
        referenceModel: 'User',
        balanceBefore: prevMasterBalance,
        balanceAfter: parentMaster.equity,
        metadata: { note: note || 'Deducted balance for new user creation' }
      });
      await masterTx.save({ session });

      // Create transaction record for User (Credit)
      const userTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_U`,
        userId: user._id,
        userModel: 'User',
        type: 'CREDIT',
        status: 'SUCCESS',
        amount: credits,
        referenceId: parentMaster._id,
        referenceModel: 'Master',
        balanceBefore: 0,
        balanceAfter: credits,
        metadata: { note: note || 'Initial account creation funding' }
      });
      await userTx.save({ session });

      // Copy master's ScriptQuantity data to the new user
      const { copyFromMasterToUser } = require('../services/scriptQuantityCopyService');
      await copyFromMasterToUser(parentMaster._id.toString(), user._id.toString(), session);

      // Copy master's brokerage rates to the new user
      const { copyBrokerageFromParent } = require('../services/brokerageCopyService');
      await copyBrokerageFromParent(parentMaster._id.toString(), user._id.toString(), session);

      // Task 13 / design §13.3: apply any inline initial wallet funding. Because
      // createUser is a master route, this is a TRANSFER — the master's OWN
      // category pool is debited and the new user credited via walletService.assign.
      // It runs inside this same transaction (session passed through) so a master
      // over-funding throws INSUFFICIENT_WALLET and aborts the ENTIRE user creation
      // (Requirement 5.3 — "rejected"). This wallet pool is independent of the
      // credits/equity debit above. No-op when req.body.wallet is absent.
      if (req.body.wallet) {
        await applyWalletFunding({ req, targetType: 'User', targetId: user._id, walletMap: req.body.wallet, session });
      }

      resultData = {
        user: user.toJSON(),
        parent_master_remaining_balance: parentMaster.equity
      };
    });

    session.endSession();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: resultData
    });
  } catch (error) {
    session.endSession();

    let statusCode = 500;
    if (error.message === 'Parent master not found' || error.message === 'Server not found') statusCode = 404;
    else if (error.message.includes('Insufficient balance') || error.message.includes('Username already exists') || error.message.includes('Account limit reached')) statusCode = 400;
    // Task 13: an inline wallet transfer that the master's pool can't cover
    // aborts the create — surface it as a clear 400 naming the category.
    else if (error.code === 'INSUFFICIENT_WALLET') {
      statusCode = 400;
      error.message = `Insufficient ${error.category} wallet balance to fund the new account.`;
    }

    res.status(statusCode).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get All Users
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, server_id, search } = req.query;

    // Only return DIRECT child users of this master (not sub-masters' users)
    const filter = {
      master_id: req.master.id,
      deleted_at: null
    };

    if (status) filter.status = status;
    if (server_id) filter.server_id = server_id;

    // Search by username or name
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(filter)
      .populate('server_id', 'name')
      .populate('master_id', 'name username')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await User.countDocuments(filter);

    res.status(200).json({
      success: true,
      message: 'Users retrieved successfully',
      data: {
        users: users.map(user => user.toJSON()),
        total: count,
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

// Get User by ID
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    // Don't filter by deleted_at — master/admin should see deleted users' data
    const query = { _id: id };
    if (req.master) query.master_id = req.master.id;

    const user = await User.findOne(query)
      .populate('server_id', 'name')
      .populate('master_id', 'name username');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    res.status(200).json({
      success: true,
      message: 'User retrieved successfully',
      data: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update User Details
const updateUserDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      username,
      password,
      credits,
      note,
      pnl_sharing,
      brokerage_sharing,
      exchanges_allowed,
      trade_limit,
      margin_square_off,
      change_pass_on_first_login,
      active_status,
      close_only,
      bet,
      fresh_stoploss
    } = req.body;

    const query = { _id: id };
    if (req.master) query.master_id = req.master.id;

    const user = await User.findOne(query);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists',
          data: null
        });
      }
      user.username = username;
    }

    // Update password if provided
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      user.password = hashedPassword;
    }

    // Validate percentages if provided
    if (pnl_sharing !== undefined) {
      if (pnl_sharing < 0 || pnl_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'P&L sharing must be between 0 and 100',
          data: null
        });
      }
      user.pnl_sharing = pnl_sharing;
    }

    if (brokerage_sharing !== undefined) {
      if (brokerage_sharing < 0 || brokerage_sharing > 100) {
        return res.status(400).json({
          success: false,
          message: 'Brokerage sharing must be between 0 and 100',
          data: null
        });
      }
      user.brokerage_sharing = brokerage_sharing;
    }

    // Validate and normalize exchanges_allowed if provided
    if (exchanges_allowed) {
      if (!Array.isArray(exchanges_allowed)) {
        return res.status(400).json({
          success: false,
          message: 'exchanges_allowed must be an array',
          data: null
        });
      }

      for (const exchange of exchanges_allowed) {
        if (!exchange.exchange_name || exchange.turnover === undefined || exchange.lot === undefined) {
          return res.status(400).json({
            success: false,
            message: 'Each exchange must have exchange_name, turnover, and lot',
            data: null
          });
        }
      }

      // Normalize exchange names to uppercase and map GLOBAL to INDICES
      user.exchanges_allowed = exchanges_allowed.map(ex => {
        let name = ex.exchange_name.toUpperCase();
        if (name === 'GLOBAL') name = 'INDICES';
        return {
          ...ex,
          exchange_name: name
        };
      });
    }

    // Normalize trade_limit to uppercase and map GLOBAL to INDICES if provided
    if (trade_limit) {
      user.trade_limit = trade_limit.map(ex => {
        let name = ex.toUpperCase();
        if (name === 'GLOBAL') name = 'INDICES';
        return name;
      });
    }

    if (name) user.name = name;
    if (credits !== undefined) user.credits = credits;
    if (note !== undefined) user.note = note;
    if (margin_square_off !== undefined) user.margin_square_off = margin_square_off;
    if (change_pass_on_first_login !== undefined) user.change_pass_on_first_login = change_pass_on_first_login;
    if (active_status !== undefined) user.active_status = active_status;
    if (close_only !== undefined) user.close_only = close_only;
    if (bet !== undefined) user.bet = bet;
    if (fresh_stoploss !== undefined) user.fresh_stoploss = fresh_stoploss;

    await user.save();

    // Task 13 / design §13.3: inline wallet on EDIT is an ADDITIVE top-up applied
    // via walletService.assign (master transfer / admin grant). REDUCTIONS use the
    // dedicated wallet withdraw endpoint (Task 12), never this path. There is no
    // transaction here (the profile save already committed), so walletService opens
    // its own transaction per category; a funding failure surfaces as a 400 below.
    if (req.body.wallet) {
      await applyWalletFunding({ req, targetType: 'User', targetId: user._id, walletMap: req.body.wallet });
    }

    // If margin_square_off was just toggled ON, immediately check if user needs square-off
    if (margin_square_off === true) {
      try {
        const metricsEngine = require('../services/metricsEngine');
        const marginSquareOffService = require('../services/marginSquareOffService');
        // Force a fresh rebuild so we get current LTP-based equity
        await metricsEngine.onTradeExecuted(user._id.toString());
        const metrics = metricsEngine.getCachedMetrics(user._id.toString());
        if (metrics) {
          await marginSquareOffService.checkUser(user._id.toString(), metrics);
        }
      } catch (e) {
        console.error('[MarginSquareOff] Immediate check after toggle failed:', e.message);
      }
    }

    res.status(200).json({
      success: true,
      message: 'User details updated successfully',
      data: user.toJSON()
    });
  } catch (error) {
    // Task 13: an inline wallet top-up the master's pool can't cover → 400 with a
    // clear message. The profile fields were already saved; only funding failed.
    if (error.code === 'INSUFFICIENT_WALLET') {
      return res.status(400).json({
        success: false,
        message: `Insufficient ${error.category} wallet balance to fund the account.`,
        data: null
      });
    }
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Credit User
const creditUser = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { amount, note } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required',
        data: null
      });
    }

    let resultData;

    await session.withTransaction(async () => {
      const user = await User.findOne({
        _id: id,
        master_id: req.master.id,
        deleted_at: null
      }).session(session);

      if (!user) throw new Error('User not found');

      const master = await Master.findById(req.master.id).session(session);

      if (!master) throw new Error('Master not found');

      // Check if master has sufficient working balance
      if (master.equity < amount) {
        throw new Error(`Insufficient balance. Available: ${master.equity}, Required: ${amount}`);
      }

      const previousUserCredits = user.credits;
      const previousUserBalance = user.equity;
      const previousMasterCredits = master.credits;
      const previousMasterBalance = master.equity;

      // Master pays from balance
      master.equity -= amount;

      // User receives in credits
      user.credits += amount;

      await master.save({ session });
      await user.save({ session });

      // Create credit transaction record for master (losing balance)
      const masterTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_M`,
        userId: master._id,
        userModel: 'Master',
        type: 'DEBIT',
        status: 'SUCCESS',
        amount,
        referenceId: user._id,
        referenceModel: 'User',
        balanceBefore: previousMasterBalance,
        balanceAfter: master.equity,
        metadata: { note: note || 'Credit to user' }
      });
      await masterTx.save({ session });

      // Create credit transaction record for user (gaining balance & credit)
      const userTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_U`,
        userId: user._id,
        userModel: 'User',
        type: 'CREDIT',
        status: 'SUCCESS',
        amount,
        referenceId: master._id,
        referenceModel: 'Master',
        balanceBefore: previousUserBalance,
        balanceAfter: user.equity,
        metadata: { note: note || 'Credit from master' }
      });
      await userTx.save({ session });

      // Legacy tracking for backwards compatibility
      await CreditTransaction.create([{
        master_id: master._id,
        admin_id: req.master.id,
        transaction_type: 'DEBIT',
        amount,
        previous_balance: previousMasterCredits,
        new_balance: master.credits,
        note: note || 'Credit to user'
      }, {
        master_id: user.master_id,
        admin_id: req.master.id,
        transaction_type: 'CREDIT',
        amount,
        previous_balance: previousUserCredits,
        new_balance: user.credits,
        note: note || 'Credit from master'
      }], { session, ordered: true });

      resultData = {
        user: {
          id: user._id,
          username: user.username,
          previous_credits: previousUserCredits,
          current_credits: user.credits,
          current_balance: user.equity
        },
        master: {
          id: master._id,
          username: master.username,
          previous_credits: previousMasterCredits,
          current_credits: master.credits,
          current_balance: master.equity
        },
        amount_credited: amount,
        updated_at: user.updatedAt
      };
    });

    session.endSession();

    // Rebuild metricsEngine cache so credit change is reflected in live metrics
    try {
      const metricsEngine = require('../services/metricsEngine');
      if (resultData?.user?.current_credits !== undefined) {
        const userId = id;
        metricsEngine.onTradeExecuted(userId);
      }
    } catch (_) {}

    res.status(200).json({
      success: true,
      message: 'Credit added successfully',
      data: resultData
    });
  } catch (error) {
    session.endSession();

    let statusCode = 500;
    if (error.message === 'User not found' || error.message === 'Master not found') statusCode = 404;
    else if (error.message.includes('Insufficient balance')) statusCode = 400;

    res.status(statusCode).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Debit User
const debitUser = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { amount, note } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required',
        data: null
      });
    }

    let resultData;

    await session.withTransaction(async () => {
      const user = await User.findOne({
        _id: id,
        master_id: req.master.id,
        deleted_at: null
      }).session(session);

      if (!user) throw new Error('User not found');

      // User pays from their credits
      if (user.credits < amount) {
        throw new Error('Insufficient credits on user account');
      }

      const master = await Master.findById(req.master.id).session(session);

      if (!master) throw new Error('Master not found');

      const previousUserCredits = user.credits;
      const previousUserBalance = user.equity;
      const previousMasterCredits = master.credits;
      const previousMasterBalance = master.equity;

      // Deduct from user's credits
      user.credits -= amount;

      // Add back to master's working balance (master's credits remain unaffected)
      master.equity += amount;

      await user.save({ session });
      await master.save({ session });

      // Create universal transaction record for master (gaining balance)
      const masterTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_M`,
        userId: master._id,
        userModel: 'Master',
        type: 'CREDIT',
        status: 'SUCCESS',
        amount,
        referenceId: user._id,
        referenceModel: 'User',
        balanceBefore: previousMasterBalance,
        balanceAfter: master.equity,
        metadata: { note: note || 'Debit from user' }
      });
      await masterTx.save({ session });

      // Create universal transaction record for user (losing credit tracking)
      const userTx = new Transaction({
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_U`,
        userId: user._id,
        userModel: 'User',
        type: 'DEBIT',
        status: 'SUCCESS',
        amount,
        referenceId: master._id,
        referenceModel: 'Master',
        balanceBefore: previousUserBalance,
        balanceAfter: user.equity, // Note: user balance unchanged
        metadata: { note: note || 'Debit to master' }
      });
      await userTx.save({ session });

      // Legacy tracking
      await CreditTransaction.create([{
        master_id: master._id,
        admin_id: req.master.id,
        transaction_type: 'CREDIT',
        amount,
        previous_balance: previousMasterCredits,
        new_balance: master.credits,
        note: note || 'Debit from user'
      }, {
        master_id: user.master_id,
        admin_id: req.master.id,
        transaction_type: 'DEBIT',
        amount,
        previous_balance: previousUserCredits,
        new_balance: user.credits,
        note: note || 'Debit to master'
      }], { session, ordered: true });

      resultData = {
        user: {
          id: user._id,
          username: user.username,
          previous_credits: previousUserCredits,
          current_credits: user.credits,
          current_balance: user.equity
        },
        master: {
          id: master._id,
          username: master.username,
          previous_credits: previousMasterCredits,
          current_credits: master.credits,
          current_balance: master.equity
        },
        amount_debited: amount,
        updated_at: user.updatedAt
      };
    });

    session.endSession();

    // Rebuild metricsEngine cache so credit change is reflected in live metrics
    try {
      const metricsEngine = require('../services/metricsEngine');
      metricsEngine.onTradeExecuted(id);
      metricsEngine.onMasterConfigChanged(req.master.id);
      const userId = id;
      metricsEngine.onTradeExecuted(userId);
    } catch (_) {}

    res.status(200).json({
      success: true,
      message: 'Amount debited successfully',
      data: resultData
    });
  } catch (error) {
    session.endSession();

    let statusCode = 500;
    if (error.message === 'User not found' || error.message === 'Master not found') statusCode = 404;
    else if (error.message.includes('Insufficient')) statusCode = 400;

    res.status(statusCode).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Get User Position
const getUserPosition = async (req, res) => {
  try {
    const { id } = req.params;

    const filterPos = { _id: id, deleted_at: null };
    if (req.master) filterPos.master_id = req.master.id;

    const user = await User.findOne(filterPos);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Calculate position from trades
    const positionData = await Trade.aggregate([
      {
        $match: {
          user_id: user._id,
          status: 'completed',
          deleted_at: null
        }
      },
      {
        $group: {
          _id: null,
          realised_pnl: { $sum: '$pnl' },
          total_brokerage: { $sum: '$brokerage' }
        }
      }
    ]);

    const position = positionData[0] || { realised_pnl: 0, total_brokerage: 0 };

    const mockPosition = {
      realised_pnl: position.realised_pnl,
      m2m_pnl: 0,
      credit: user.credits,
      equity: user.credits + position.realised_pnl
    };

    res.status(200).json({
      success: true,
      message: 'User position retrieved successfully',
      data: {
        user_id: user._id,
        username: user.username,
        position: mockPosition,
        last_updated: new Date().toISOString()
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

// Send Message to User
const sendMessageToUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
        data: null
      });
    }

    const filterMsg = { _id: id, deleted_at: null };
    if (req.master) filterMsg.master_id = req.master.id;

    const user = await User.findOne(filterMsg);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    const senderId = req.master?.id || req.admin?.id;
    const senderType = req.master ? 'Master' : 'Admin';

    const newMessage = await Message.create({
      sender_id: senderId,
      sender_type: senderType,
      recipient_id: user._id,
      recipient_type: 'User',
      subject: subject || '',
      message
    });

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: newMessage.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Delete User (Soft Delete)
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const filterDel = { _id: id, deleted_at: null };
    if (req.master) filterDel.master_id = req.master.id;

    const user = await User.findOne(filterDel);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    user.deleted_at = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: 'User deleted successfully',
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

// Update User Intraday Squareoff Settings
// Update User Intraday Squareoff Settings
const updateUserIntradaySquareoff = async (req, res) => {
  try {
    const { id } = req.params;
    const { intraday_squareoff } = req.body;

    const filter = { _id: id, deleted_at: null };
    if (req.master) filter.master_id = req.master.id;

    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found', data: null });
    }

    const allowedExchanges = user.exchanges_allowed.map(ex => ex.exchange_name);

    if (intraday_squareoff && Array.isArray(intraday_squareoff)) {
      const normalizedSettings = intraday_squareoff.map(s => ({
        exchange_name: s.exchange_name.toUpperCase(),
        enabled: s.enabled
      }));

      for (const setting of normalizedSettings) {
        if (!allowedExchanges.map(e => e.toUpperCase()).includes(setting.exchange_name)) {
          return res.status(400).json({ success: false, message: `Exchange ${setting.exchange_name} is not allowed for this user`, data: null });
        }
      }

      user.intraday_squareoff = normalizedSettings;
      user.exchanges_allowed = user.exchanges_allowed.map(ex => ({ ...ex, exchange_name: ex.exchange_name.toUpperCase() }));
      user.trade_limit = user.trade_limit.map(ex => ex.toUpperCase());
      await user.save();
    }

    res.status(200).json({ success: true, message: 'Intraday squareoff settings updated successfully', data: user.toJSON() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// Update User Margin Squareoff Percentage
const updateUserMarginSquareoffPercentage = async (req, res) => {
  try {
    const { id } = req.params;
    const { margin_square_off_percentage } = req.body;

    if (margin_square_off_percentage === undefined || margin_square_off_percentage === null) {
      return res.status(400).json({
        success: false,
        message: 'Margin square off percentage is required',
        data: null
      });
    }

    if (margin_square_off_percentage < 0 || margin_square_off_percentage > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage must be between 0 and 100',
        data: null
      });
    }

    const filterMSO = { _id: id, deleted_at: null };
    if (req.master) filterMSO.master_id = req.master.id;

    const user = await User.findOne(filterMSO);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    user.margin_square_off_percentage = margin_square_off_percentage;
    await user.save();

    // If percentage was set > 0, immediately check if user needs square-off
    if (margin_square_off_percentage > 0) {
      try {
        const metricsEngine = require('../services/metricsEngine');
        const marginSquareOffService = require('../services/marginSquareOffService');
        await metricsEngine.onTradeExecuted(user._id.toString());
        const metrics = metricsEngine.getCachedMetrics(user._id.toString());
        if (metrics) {
          await marginSquareOffService.checkUser(user._id.toString(), metrics);
        }
      } catch (e) {
        console.error('[MarginSquareOff] Immediate check after percentage update failed:', e.message);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Margin squareoff percentage updated successfully',
      data: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
      data: null
    });
  }
};

// Update User Report Permissions
const updateUserReportPermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { report_permissions } = req.body;

    if (!report_permissions || typeof report_permissions !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'report_permissions object is required',
        data: null
      });
    }

    // Find the user — must belong to the calling master's hierarchy
    const user = await User.findOne({ _id: id, deleted_at: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    // Determine caller and validate ownership
    let parentMaster = null;
    if (req.master) {
      // Master/SubMaster can only update their DIRECT users
      if (user.master_id.toString() !== req.master.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to update this user. You can only manage your direct users.',
          data: null
        });
      }
      parentMaster = await Master.findById(req.master.id).select('permissions').lean();
    } else if (req.admin) {
      parentMaster = await Master.findById(user.master_id).select('permissions').lean();
    } else {
      return res.status(403).json({ success: false, message: 'Unauthorized', data: null });
    }

    // Validate: cannot grant a permission the parent Master doesn't have
    const reportPermKeys = [
      'account_summary', 'pnl_summary', 'client_summary', 'settlement_report',
      'generate_pdf', 'weekly_admin', 'intraday_history', 'userwise_open_position',
      'script_quantity', 'deleted_trade', 'trade_account'
    ];

    for (const key of reportPermKeys) {
      if (report_permissions[key] === true && parentMaster && parentMaster.permissions) {
        if (parentMaster.permissions[key] === false) {
          return res.status(403).json({
            success: false,
            message: `Cannot grant '${key}' - parent master doesn't have this permission`,
            data: null
          });
        }
      }
    }

    // Update only provided report permission keys
    if (!user.report_permissions) {
      user.report_permissions = {};
    }
    for (const key of reportPermKeys) {
      if (report_permissions[key] !== undefined) {
        user.report_permissions[key] = report_permissions[key];
      }
    }
    user.markModified('report_permissions');
    await user.save();

    res.status(200).json({
      success: true,
      message: 'User report permissions updated successfully',
      data: {
        id: user._id,
        username: user.username,
        report_permissions: user.report_permissions
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

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUserDetails,
  updateUserIntradaySquareoff,
  updateUserMarginSquareoffPercentage,
  updateUserReportPermissions,
  creditUser,
  debitUser,
  getUserPosition,
  sendMessageToUser,
  deleteUser,
  _squareOffUserSegments
};
