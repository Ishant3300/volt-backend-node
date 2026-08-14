const cron = require('node-cron');
const mongoose = require('mongoose');
const path = require('path');
const { fork } = require('child_process');
const User = require('../models/User');
const Master = require('../models/Master');
const orderExecutionService = require('./orderExecutionService');
const redisService = require('./redisService');
const { snapshotWeeklySummary } = require('./weeklySummaryService');
const livePriceService = require('./livePriceService');
const { beginTradeWrite } = require('./tradeWriteFenceService');
const walletService = require('./walletService');
const { categoryForSegment } = require('../utils/walletCategory');

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

        // ── Settlement prices are now fetched via bhavcopy crons below (no OHLC) ──

        // ── Bhavcopy Settlement Price Fetch ──────────────────────────────
        // NSE: 5:30 PM IST (Mon-Fri) — fetches today's settlement prices
        // MCX: 1:00 AM IST (Tue-Sat) — fetches previous day's settlement prices

        const nseBhavcopyJob = cron.schedule('30 17 * * 1-5', async () => {
            console.log(`📊 [CRON] Fetching NSE settlement prices (5:30 PM IST)...`);
            try {
                const { fetchAndApplyBhavcopy } = require('./bhavcopyService');
                const result = await fetchAndApplyBhavcopy();
                console.log(`✅ [CRON] Bhavcopy done: NSE=${result.nseMatched}, MCX=${result.mcxMatched}`);
            } catch (error) {
                console.error(`❌ [CRON] Bhavcopy NSE error: ${error.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(nseBhavcopyJob);

        const mcxBhavcopyJob = cron.schedule('0 1 * * 2-6', async () => {
            console.log(`📊 [CRON] Fetching MCX settlement prices (1:00 AM IST)...`);
            try {
                const { fetchAndApplyBhavcopy } = require('./bhavcopyService');
                const result = await fetchAndApplyBhavcopy();
                console.log(`✅ [CRON] Bhavcopy done: NSE=${result.nseMatched}, MCX=${result.mcxMatched}`);
            } catch (error) {
                console.error(`❌ [CRON] Bhavcopy MCX error: ${error.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(mcxBhavcopyJob);

        // ── Atomic Weekend Settlement ───────────────────────────────────
        // Retry hourly after the 1:00 AM MCX fetch on Saturday. The durable
        // period key guarantees that only one worker can commit the week; later
        // invocations are no-ops after success and retries after price failures.
        const weekendSettlementJob = cron.schedule('30 1-5 * * 6', async () => {
            console.log('[CRON] Checking Saturday weekly settlement...');
            try {
                const settlementService = require('./settlementService');
                const result = await settlementService.runSettlement({
                    trigger: 'cron',
                    waitForCompletion: true,
                    refreshPrices: true,
                });
                if (result.success) {
                    console.log(`[CRON] Settlement ${result.periodKey}: ${result.alreadyCompleted ? 'already completed' : 'completed successfully'}.`);
                } else {
                    console.error(`[CRON] Settlement ${result.periodKey || 'unknown'} failed: ${result.message}`);
                }
            } catch (error) {
                console.error(`[CRON] Weekend settlement error: ${error.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(weekendSettlementJob);

        // Recover a run stranded by process restart, network failure, or a crash
        // after DB commit. Recovery uses the run's stored trading date rather
        // than advancing to the current week.
        const settlementRecoveryJob = cron.schedule('*/15 * * * *', async () => {
            try {
                const settlementService = require('./settlementService');
                const result = await settlementService.recoverIncompleteSettlements({ ensureCurrentPeriod: true });
                if (result.recovered) {
                    console.log(`[CRON] Settlement recovery ${result.periodKey || ''}: ${result.message}`);
                }
            } catch (error) {
                console.error(`[CRON] Settlement recovery error: ${error.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(settlementRecoveryJob);

        // Every PM2 worker observes the durable committed generation and rebuilds
        // its own metrics/live-price maps. On-demand risk checks also reconcile,
        // while this poll keeps WebSocket-only clients current.
        const settlementGenerationSyncJob = cron.schedule('*/15 * * * * *', async () => {
            try {
                const metricsEngine = require('./metricsEngine');
                await metricsEngine.synchronizeSettlementGeneration({ maxAgeMs: 0, broadcast: true });
            } catch (error) {
                console.error(`[Settlement] Worker generation sync error: ${error.message}`);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(settlementGenerationSyncJob);

        // ── Expiry Auto Square-Off ───────────────────────────────────────
        // 3:35 PM IST (after NSE close) + 11:32 PM IST (after MCX close at 11:30 PM)
        // Checks for instruments that expired today and auto-squares-off open positions
        const expirySquareOffNSE = cron.schedule('46 15 * * 1-5', async () => {
            console.log('📊 [CRON] Expiry auto square-off check (NSE close)...');
            try {
                await this.autoSquareOffExpiredPositions();
                console.log('✅ [CRON] NSE expiry auto square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during NSE expiry auto square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(expirySquareOffNSE);

        const expirySquareOffMCX = cron.schedule('33 23 * * 1-5', async () => {
            console.log('📊 [CRON] Expiry auto square-off check (MCX close)...');
            try {
                await this.autoSquareOffExpiredPositions();
                console.log('✅ [CRON] MCX expiry auto square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during MCX expiry auto square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(expirySquareOffMCX);

        // ── Intraday Square-Off at Market Close ──────────────────────────
        // Squares off positions for users who have intraday_squareoff enabled for the segment.
        // NSE/NFO: 3:30 PM IST
        const intradaySquareOffNSE = cron.schedule('41 15 * * 1-5', async () => {
            console.log('🔄 [CRON] Intraday square-off (NSE/NFO close)...');
            try {
                await this.runIntradaySquareOff(['NFO-FUT', 'NFO-OPT']);
                console.log('✅ [CRON] NSE/NFO intraday square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during NSE intraday square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(intradaySquareOffNSE);

        // MCX: 11:30 PM IST
        const intradaySquareOffMCX = cron.schedule('31 23 * * 1-5', async () => {
            console.log('🔄 [CRON] Intraday square-off (MCX close)...');
            try {
                await this.runIntradaySquareOff(['MCX-FUT', 'MCX-OPT']);
                console.log('✅ [CRON] MCX intraday square-off completed.');
            } catch (error) {
                console.error('❌ [CRON] Error during MCX intraday square-off:', error);
            }
        }, { timezone: 'Asia/Kolkata' });
        this.jobs.push(intradaySquareOffMCX);

        // GLOBAL/INDICES: no fixed close — skip for now (24hr market)

        // ── Weekend Carry Forward (DISABLED — admin triggers manually via Settlement UI) ──
        // const weekendCarryForward = cron.schedule('55 11 * * 0', async () => {
        //     console.log('🔄 [CRON] Starting Weekend Carry Forward...');
        //     try {
        //         const { runWeekendCarryForward } = require('./weekendCarryForwardService');
        //         await runWeekendCarryForward();
        //         console.log('✅ [CRON] Weekend Carry Forward completed.');
        //     } catch (error) {
        //         console.error('❌ [CRON] Error during Weekend Carry Forward:', error);
        //     }
        // }, { timezone: 'Asia/Kolkata' });
        // this.jobs.push(weekendCarryForward);

        const engineMode = redisService.isAvailable()
            ? 'Redis + BullMQ (cron fallback standby)'
            : 'DB polling every 10s (Redis unavailable)';

        console.log(`✅ Cron Scheduler activated (limit engine: ${engineMode}).`);
    }

    /**
     * Run intraday square-off for the given segments.
     * Finds all users who have intraday_squareoff enabled for any of the segments,
     * then squares off their open positions in those segments using bid/ask CMP.
     */
    async runIntradaySquareOff(segments) {
        const Trade = require('../models/Trade');
        const metricsEngine = require('./metricsEngine');
        const { _squareOffUserSegments } = require('../controllers/masterUserController');

        // Find all users who have intraday_squareoff enabled for any of these segments
        const users = await User.find({
            deleted_at: null,
            'intraday_squareoff.enabled': true,
            'intraday_squareoff.exchange_name': { $in: segments.map(s => s.toUpperCase()) },
        }).select('_id username intraday_squareoff').lean();

        if (users.length === 0) {
            console.log(`   No users with intraday square-off enabled for ${segments.join(', ')}.`);
            return;
        }

        console.log(`   Found ${users.length} user(s) with intraday square-off enabled.`);

        let totalSquaredOff = 0;
        for (const u of users) {
            // Get only the segments that are enabled for this user AND match the closing segments
            const userEnabledSegments = (u.intraday_squareoff || [])
                .filter(s => s.enabled && segments.map(seg => seg.toUpperCase()).includes(s.exchange_name.toUpperCase()))
                .map(s => s.exchange_name);

            if (userEnabledSegments.length === 0) continue;

            try {
                const count = await _squareOffUserSegments(u._id.toString(), userEnabledSegments);
                if (count > 0) {
                    totalSquaredOff += count;
                    console.log(`   ✅ ${u.username}: squared off ${count} position(s) in ${userEnabledSegments.join(', ')}`);
                }
            } catch (e) {
                console.error(`   ❌ ${u.username}: square-off error: ${e.message}`);
            }
        }

        console.log(`   ✅ Total: ${totalSquaredOff} position(s) squared off for ${users.length} user(s).`);
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
    async autoSquareOffExpiredPositions(options = {}) {
        const Trade = require('../models/Trade');
        const KiteInstrument = require('../models/KiteInstrument');
        const metricsEngine = require('./metricsEngine');
        let lease = null;
        let session = null;
        let squared = 0;

        try {
            lease = await beginTradeWrite('expiry_square_off');
            session = await mongoose.startSession();
            const today = options.now ? new Date(options.now) : new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const expiredInstruments = await KiteInstrument.find({
                expiry: { $gte: today, $lt: tomorrow },
                deleted_at: null,
            }).select('instrument_token tradingsymbol exchange last_price segment').lean();

            if (expiredInstruments.length === 0) {
                console.log('   No instruments expiring today.');
                return;
            }

            const expiredTokens = expiredInstruments.map(instrument => instrument.instrument_token.toString());
            const priceMap = {};
            for (const instrument of expiredInstruments) {
                const token = instrument.instrument_token.toString();
                const ltp = metricsEngine._ltpMap?.get(token) || instrument.last_price;
                priceMap[token] = { price: ltp, symbol: instrument.tradingsymbol, exchange: instrument.exchange, segment: instrument.segment };
            }

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
            for (const candidate of openPositions) {
                const token = candidate._id.instrument_token.toString();
                const userId = candidate._id.user_id;
                const instData = priceMap[token];
                if (!instData?.price || instData.price <= 0) continue;

                let committed = null;
                try {
                    await session.withTransaction(async () => {
                        committed = null;
                        await lease.assertActive({ session });
                        const freshPosition = await Trade.aggregate([
                            { $match: { user_id: userId, instrument_token: token, status: 'completed', deleted_at: null } },
                            { $group: {
                                _id: null,
                                net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
                                total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
                                total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
                                total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                                total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
                            }},
                        ]).session(session);
                        const netQty = Number(freshPosition[0]?.net_qty || 0);
                        if (netQty === 0) return;

                        // Requirement 3.2 / 7.5: this path closes at LTP with pnl:0 and does
                        // not carry an avg entry price, so derive it from the trade legs to
                        // release the ENTRY notional (independent of the exit/LTP price).
                        const buyQty = Number(freshPosition[0]?.total_buy_qty || 0);
                        const sellQty = Number(freshPosition[0]?.total_sell_qty || 0);
                        const buyVal = Number(freshPosition[0]?.total_buy_value || 0);
                        const sellVal = Number(freshPosition[0]?.total_sell_value || 0);
                        const avgBuy = buyQty > 0 ? buyVal / buyQty : 0;
                        const avgSell = sellQty > 0 ? sellVal / sellQty : 0;
                        const avgEntry = netQty > 0 ? avgBuy : avgSell;
                        const releaseCategory = categoryForSegment(instData.segment || instData.exchange || '');

                        const user = await User.findById(userId).select('master_id admin_id').session(session).lean();
                        if (!user) throw new Error(`User ${userId} not found`);
                        const absQty = Math.abs(netQty);
                        const closeSide = netQty > 0 ? 'SELL' : 'BUY';
                        await Trade.create([{
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
                        }], { session });

                        // Requirement 3.2 / 7.5: release the closed position's ENTRY notional
                        // back to its category wallet inside this same transaction, so the
                        // release commits atomically with the close trade (keeps pnl:0).
                        if (absQty > 0 && avgEntry > 0) {
                            await walletService.release('User', userId, releaseCategory, absQty * avgEntry, session);
                        }

                        if (options.faultInjector) {
                            await options.faultInjector({
                                phase: 'before_final_lease_proof',
                                lease,
                                session,
                                userId,
                                instrumentToken: token,
                            });
                        }
                        await lease.assertActive({ session });
                        committed = { absQty, closeSide };
                    });

                    if (!committed) continue;
                    await metricsEngine.onTradeExecuted(userId.toString());
                    squared++;
                    console.log(`   ✅ Squared off ${instData.symbol}: ${committed.closeSide} ${committed.absQty} @ ${instData.price} for user ${userId}`);
                } catch (error) {
                    if (error.code === 'TRADE_WRITE_LEASE_LOST') throw error;
                    console.error(`   ❌ Failed to square off ${instData.symbol} for user ${userId}: ${error.message}`);
                }
            }

            console.log(`   ✅ Auto squared off ${squared} position(s).`);
        } finally {
            try {
                if (session) await session.endSession();
            } finally {
                await lease?.release();
            }
        }
    }
}

module.exports = new CronService();
