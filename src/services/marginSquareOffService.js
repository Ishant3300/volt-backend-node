/**
 * Margin Square Off Service
 * Monitors user equity in real-time and auto-squares off all positions
 * when equity goes negative for users with margin_square_off enabled.
 */
const User = require('../models/User');
const Trade = require('../models/Trade');
const KiteInstrument = require('../models/KiteInstrument');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { calculateMargin } = require('./marginService');

let _livePriceService = null;
let _checkInterval = null;
const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

const init = (livePriceService) => {
  _livePriceService = livePriceService;
  // Start periodic equity check
  _checkInterval = setInterval(_checkAllUsers, CHECK_INTERVAL_MS);
  console.log('🛡️  [MarginSquareOff] Service initialized, checking every 10s');
};

const shutdown = () => {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
  console.log('🛡️  [MarginSquareOff] Service shut down');
};

const _checkAllUsers = async () => {
  try {
    // Find all users with margin_square_off enabled
    const users = await User.find({
      margin_square_off: true,
      active_status: true,
      status: 'active',
      deleted_at: null
    }).lean();

    if (users.length === 0) return;

    for (const user of users) {
      try {
        await _checkUserEquity(user);
      } catch (err) {
        console.error(`🛡️  [MarginSquareOff] Error checking user ${user.username}:`, err.message);
      }
    }
  } catch (err) {
    console.error('🛡️  [MarginSquareOff] Error in check cycle:', err.message);
  }
};

const _checkUserEquity = async (user) => {
  // Get all open positions for this user
  const trades = await Trade.find({
    user_id: user._id,
    status: 'completed',
    deleted_at: null
  }).lean();

  if (trades.length === 0) return;

  // Aggregate positions by instrument
  const positionMap = {};
  for (const t of trades) {
    if (!positionMap[t.instrument_token]) {
      positionMap[t.instrument_token] = {
        instrument_token: t.instrument_token,
        tradingsymbol: t.tradingsymbol,
        exchange: t.exchange,
        buyQty: 0, sellQty: 0,
        buyValue: 0, sellValue: 0
      };
    }
    const pos = positionMap[t.instrument_token];
    if (t.transaction_type === 'BUY') {
      pos.buyQty += t.executed_quantity;
      pos.buyValue += t.executed_quantity * t.executed_price;
    } else {
      pos.sellQty += t.executed_quantity;
      pos.sellValue += t.executed_quantity * t.executed_price;
    }
  }

  // Calculate floating P&L using live prices
  let realisedPnl = 0;
  let floatingPnl = 0;
  const openPositions = [];

  // Sum up realised P&L from all completed trades
  for (const t of trades) {
    realisedPnl += t.pnl || 0;
  }

  for (const token of Object.keys(positionMap)) {
    const pos = positionMap[token];
    const netQty = pos.buyQty - pos.sellQty;
    if (netQty === 0) continue;

    const avgBuy = pos.buyQty > 0 ? pos.buyValue / pos.buyQty : 0;
    const avgSell = pos.sellQty > 0 ? pos.sellValue / pos.sellQty : 0;

    // Get live price
    let ltp = null;
    if (_livePriceService && _livePriceService.latestPrices) {
      ltp = _livePriceService.latestPrices.get(parseInt(token)) ||
            _livePriceService.latestPrices.get(token.toString());
    }
    if (!ltp) ltp = netQty > 0 ? avgBuy : avgSell; // fallback to avg price

    let floating = 0;
    if (netQty > 0) floating = (ltp - avgBuy) * netQty;
    else floating = (avgSell - ltp) * Math.abs(netQty);

    floatingPnl += floating;
    openPositions.push({ ...pos, netQty, ltp, avgBuy, avgSell });
  }

  const m2m = realisedPnl + floatingPnl;
  const equity = user.equity + m2m;

  // If equity is negative, auto square off all positions
  if (equity < 0 && openPositions.length > 0) {
    console.log(`🛡️  [MarginSquareOff] User ${user.username}: equity=₹${equity.toFixed(2)} < 0, squaring off ${openPositions.length} position(s)`);
    await _squareOffAllPositions(user, openPositions);
  }
};

const _squareOffAllPositions = async (user, openPositions) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const freshUser = await User.findById(user._id).session(session);
      if (!freshUser) return;

      for (const pos of openPositions) {
        const netQty = pos.netQty;
        if (netQty === 0) continue;

        // To square off: if net long (netQty > 0), SELL that qty. If net short, BUY.
        const closeType = netQty > 0 ? 'SELL' : 'BUY';
        const closeQty = Math.abs(netQty);
        const closePrice = pos.ltp;

        // Calculate P&L for this closing trade (simplified)
        let pnl = 0;
        if (netQty > 0) pnl = (closePrice - pos.avgBuy) * closeQty;
        else pnl = (pos.avgSell - closePrice) * closeQty;

        const newTrade = new Trade({
          user_id: freshUser._id,
          master_id: freshUser.master_id,
          admin_id: freshUser.server_id,
          instrument_token: pos.instrument_token,
          tradingsymbol: pos.tradingsymbol,
          exchange: pos.exchange,
          transaction_type: closeType,
          quantity: closeQty,
          price: closePrice,
          order_type: 'MARKET',
          status: 'completed',
          executed_at: new Date(),
          executed_price: closePrice,
          executed_quantity: closeQty,
          pnl: pnl,
          brokerage: 0,
          taxes: 0,
          net_amount: pnl
        });
        await newTrade.save({ session });

        // Update user balance with P&L
        const balanceBefore = freshUser.equity;
        freshUser.equity += pnl;

        // Log transaction
        const tx = new Transaction({
          transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_MSO`,
          userId: freshUser._id,
          userModel: 'User',
          type: closeType,
          status: 'SUCCESS',
          amount: closePrice * closeQty,
          referenceId: newTrade._id,
          referenceModel: 'Trade',
          balanceBefore,
          balanceAfter: freshUser.equity,
          metadata: {
            tradingsymbol: pos.tradingsymbol,
            quantity: closeQty,
            executedPrice: closePrice,
            order_type: 'MARKET',
            realisedPnl: pnl,
            reason: 'MARGIN_SQUARE_OFF',
            positionClosed: true
          }
        });
        await tx.save({ session });

        console.log(`🛡️  [MarginSquareOff] Squared off ${pos.tradingsymbol}: ${closeType} ${closeQty} @ ₹${closePrice.toFixed(2)}, P&L: ₹${pnl.toFixed(2)}`);
      }

      await freshUser.save({ session });
    });

    session.endSession();

    // Notify user via WebSocket
    if (_livePriceService) {
      _livePriceService.broadcastToUser(user._id.toString(), {
        type: 'margin_square_off',
        message: 'Your positions have been auto-squared off due to negative equity.'
      });
    }

    // Notify via FCM
    try {
      const firebaseService = require('./firebaseService');
      firebaseService.sendNotification(user._id.toString(), 'admin_order_execution', {
        title: 'Margin Square Off',
        body: 'All your positions have been auto-squared off due to negative equity.',
        data: { reason: 'margin_square_off' }
      });
    } catch (_) {}

  } catch (err) {
    session.endSession();
    console.error(`🛡️  [MarginSquareOff] Failed to square off for ${user.username}:`, err.message);
  }
};

module.exports = { init, shutdown };
