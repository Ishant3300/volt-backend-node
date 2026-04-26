const cron = require('node-cron');
const path = require('path');
const { fork } = require('child_process');
const User = require('../models/User');
const Master = require('../models/Master');
const orderExecutionService = require('./orderExecutionService');
const redisService = require('./redisService');
const { snapshotWeeklySummary } = require('./weeklySummaryService');
const livePriceService = require('./livePriceService');

class CronService {
    constructor() {
        this.jobs = [];
    }

    /**
     * Initializes all scheduled jobs
     */
    init() {
        console.log('🕒 Initializing Cron Scheduler...');

        // Fetch & sync instruments from Kite every day at 8:00 AM
        // Runs fetchInstruments.js in a child process (it calls process.exit internally)
        const fetchInstrumentsJob = cron.schedule('30 7 * * *', () => {
            console.log('📡 [CRON] Starting daily instrument fetch...');
            const scriptPath = path.join(__dirname, '../../scripts/fetchInstruments.js');
            const child = fork(scriptPath, [], { silent: true });

            child.stdout.on('data', data => process.stdout.write(`[fetchInstruments] ${data}`));
            child.stderr.on('data', data => process.stderr.write(`[fetchInstruments] ${data}`));

            child.on('exit', code => {
                if (code === 0) {
                    console.log('✅ [CRON] Instrument fetch completed successfully.');
                } else {
                    console.error(`❌ [CRON] Instrument fetch exited with code ${code}.`);
                }
            });
        });
        this.jobs.push(fetchInstrumentsJob);

        // Snapshot weekly P&L every Sunday at 23:55 (before midnight balance reset)
        const weeklySummarySnapshot = cron.schedule('55 23 * * 0', async () => {
            console.log('📊 [CRON] Starting Weekly Summary Snapshot...');
            try {
                await snapshotWeeklySummary();
                console.log('✅ [CRON] Weekly Summary Snapshot completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during Weekly Summary Snapshot:', error);
            }
        });
        this.jobs.push(weeklySummarySnapshot);

        // Schedule Weekly Balance Reset at Sunday 00:00 AM
        const weeklyBalanceReset = cron.schedule('0 0 * * 0', async () => {
            console.log('🔄 [CRON] Starting Weekly Balance Reset...');
            try {
                await this.resetWeeklyBalances();
                console.log('✅ [CRON] Weekly Balance Reset completed successfully.');
            } catch (error) {
                console.error('❌ [CRON] Error during Weekly Balance Reset:', error);
            }
        });

        this.jobs.push(weeklyBalanceReset);

        // DB-fallback limit order check every 10 seconds
        // Only actually queries the DB when Redis is unavailable;
        // when Redis is up, the BullMQ price queue handles execution.
        const limitOrderCheck = cron.schedule('*/10 * * * * *', async () => {
            try {
                await orderExecutionService.processPendingOrders();
            } catch (error) {
                console.error('❌ [CRON] Error during Limit Order check:', error);
            }
        });

        this.jobs.push(limitOrderCheck);

        // ── Kite Token Refresh ─────────────────────────────────────────
        // Check every hour if the Kite access token is still valid.
        // If expired or expiring soon, perform automated login (same as server startup).
        const kiteTokenRefresh = cron.schedule('0 * * * *', async () => {
            try {
                const kiteAuthService = require('./kiteAuthService');
                const status = await kiteAuthService.checkTokenStatus();

                if (status.valid) {
                    console.log(`🔐 [CRON] Kite token OK (valid for ${status.hoursLeft} hours).`);
                    return;
                }

                console.log(`⚠️  [CRON] Kite token not valid: ${status.reason}. Attempting auto-login...`);
                const loginResult = await kiteAuthService.performAutomatedLogin();

                if (loginResult.success) {
                    console.log('✅ [CRON] Kite auto-login successful! Reconnecting WebSocket...');
                    // Reconnect the Kite WebSocket with the fresh token
                    try { livePriceService._connectToKite(); } catch (_) {}
                } else {
                    console.error('❌ [CRON] Kite auto-login failed:', loginResult.error);
                }
            } catch (error) {
                console.error('❌ [CRON] Error during Kite token refresh:', error.message);
            }
        });
        this.jobs.push(kiteTokenRefresh);

        // ── Settlement Price Refresh Schedule ────────────────────────────
        //
        // NSE: settlement available in Kite Historical API by ~6 PM same day
        // MCX: settlement available in Kite OHLC API ohlc.close by ~8-9 AM next morning
        //
        // Strategy:
        // 1. 6:00 PM — NSE/NFO provisional close via Historical API (has settlement by then)
        // 2. 8:30 AM — Full settlement refresh via OHLC API (covers MCX + validates NSE)

        // NSE/NFO: Historical API has settlement price by 6 PM same day
        const nseCloseRefresh = cron.schedule('0 18 * * 1-5', async () => {
            console.log('📊 [CRON] Refreshing NSE/NFO settlement prices (Historical API)...');
            try {
                await livePriceService.refreshClosePrices();
                console.log('✅ [CRON] NSE/NFO settlement refresh completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during NSE/NFO settlement refresh:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(nseCloseRefresh);

        // Morning full settlement refresh — OHLC API ohlc.close has all settlements by 8:30 AM
        // This covers MCX (previous night) + validates NSE
        const morningSettlementRefresh = cron.schedule('30 8 * * 1-6', async () => {
            console.log('📊 [CRON] Morning settlement price refresh (OHLC API)...');
            try {
                await livePriceService.refreshSettlementPrices();
                console.log('✅ [CRON] Morning settlement price refresh completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during morning settlement refresh:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(morningSettlementRefresh);

        // ── Expiry Auto Square-Off ───────────────────────────────────────
        // 3:35 PM IST (after NSE close) + 11:32 PM IST (after MCX close at 11:30 PM)
        // Checks for instruments that expired today and auto-squares-off open positions
        const expirySquareOffNSE = cron.schedule('35 15 * * 1-5', async () => {
            console.log('📊 [CRON] Expiry auto square-off check (NSE close)...');
            try {
                await this.autoSquareOffExpiredPositions();
                console.log('✅ [CRON] NSE expiry auto square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during NSE expiry auto square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(expirySquareOffNSE);

        const expirySquareOffMCX = cron.schedule('32 23 * * 1-5', async () => {
            console.log('📊 [CRON] Expiry auto square-off check (MCX close)...');
            try {
                await this.autoSquareOffExpiredPositions();
                console.log('✅ [CRON] MCX expiry auto square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during MCX expiry auto square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(expirySquareOffMCX);

        // ── Weekend Carry Forward ────────────────────────────────────────
        // Sunday 1:00 PM IST — fetches closing prices and carries forward open positions
        // 1. Cancels all pending orders (limit/SL expired)
        // 2. Carries forward open positions at Friday's close price (ATP reset)
        const weekendCarryForward = cron.schedule('55 11 * * 0', async () => {
            console.log('🔄 [CRON] Starting Weekend Carry Forward...');
            try {
                const { runWeekendCarryForward } = require('./weekendCarryForwardService');
                await runWeekendCarryForward();
                console.log('✅ [CRON] Weekend Carry Forward completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during Weekend Carry Forward:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(weekendCarryForward);

        const engineMode = redisService.isAvailable()
            ? 'Redis + BullMQ (cron fallback standby)'
            : 'DB polling every 10s (Redis unavailable)';

        console.log(`✅ Cron Scheduler activated (limit engine: ${engineMode}).`);
    }

    /**
     * Resets the `balance` field to equal the `credits` field for all users and masters
     */
    async resetWeeklyBalances() {
        // 1. Reset Master Balances
        const masterUpdateResult = await Master.updateMany({}, [
            { $set: { equity: '$credits' } }
        ]);
        console.log(`📊 [CRON] Reset balances for ${masterUpdateResult.modifiedCount} Masters.`);

        // 2. Reset User Balances
        const userUpdateResult = await User.updateMany({}, [
            { $set: { equity: '$credits' } }
        ]);
        console.log(`📊 [CRON] Reset balances for ${userUpdateResult.modifiedCount} Users.`);
    }

    /**
     * Auto square-off positions on instruments that expired today.
     * Uses LTP (not bid/ask) for the closing price.
     */
    async autoSquareOffExpiredPositions() {
        const Trade = require('../models/Trade');
        const KiteInstrument = require('../models/KiteInstrument');
        const metricsEngine = require('./metricsEngine');

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Find instruments that expire today
        const expiredInstruments = await KiteInstrument.find({
            expiry: { $gte: today, $lt: tomorrow },
            deleted_at: null,
        }).select('instrument_token tradingsymbol exchange last_price').lean();

        if (expiredInstruments.length === 0) {
            console.log('   No instruments expiring today.');
            return;
        }

        const expiredTokens = expiredInstruments.map(i => i.instrument_token.toString());
        const priceMap = {};
        for (const inst of expiredInstruments) {
            // Use LTP from metricsEngine if available, else DB last_price
            const ltp = metricsEngine._ltpMap?.get(inst.instrument_token.toString()) || inst.last_price;
            priceMap[inst.instrument_token.toString()] = { price: ltp, symbol: inst.tradingsymbol, exchange: inst.exchange };
        }

        // Find all open positions on expired instruments
        const openPositions = await Trade.aggregate([
            { $match: { instrument_token: { $in: expiredTokens }, status: 'completed', deleted_at: null } },
            { $group: {
                _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
                net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
            }},
            { $match: { net_qty: { $ne: 0 } } },
        ]);

        if (openPositions.length === 0) {
            console.log(`   ${expiredInstruments.length} instrument(s) expiring today, no open positions.`);
            return;
        }

        console.log(`   Found ${openPositions.length} open position(s) on ${expiredInstruments.length} expiring instrument(s).`);

        let squared = 0;
        for (const pos of openPositions) {
            const token = pos._id.instrument_token;
            const userId = pos._id.user_id;
            const instData = priceMap[token];
            if (!instData || !instData.price || instData.price <= 0) continue;

            const absQty = Math.abs(pos.net_qty);
            const closeSide = pos.net_qty > 0 ? 'SELL' : 'BUY';

            try {
                const user = await User.findById(userId).select('master_id admin_id').lean();
                if (!user) continue;

                await Trade.create({
                    user_id: userId,
                    master_id: user.master_id,
                    admin_id: user.admin_id || null,
                    instrument_token: token,
                    tradingsymbol: instData.symbol,
                    exchange: instData.exchange,
                    transaction_type: closeSide,
                    quantity: absQty,
                    price: instData.price,
                    order_type: 'MARKET',
                    placed_by: 'SYSTEM',
                    trade_type: 'margin_square_off',
                    status: 'completed',
                    executed_at: new Date(),
                    executed_price: instData.price,
                    executed_quantity: absQty,
                    pnl: 0,
                    remarks: `Auto square-off: instrument expired (${instData.symbol})`,
                });

                await metricsEngine.onTradeExecuted(userId.toString());
                squared++;
                console.log(`   ✅ Squared off ${instData.symbol}: ${closeSide} ${absQty} @ ${instData.price} for user ${userId}`);
            } catch (err) {
                console.error(`   ❌ Failed to square off ${instData.symbol} for user ${userId}: ${err.message}`);
            }
        }

        console.log(`   ✅ Auto squared off ${squared} position(s).`);
    }
}

module.exports = new CronService();
