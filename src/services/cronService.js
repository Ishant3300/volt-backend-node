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
        const fetchInstrumentsJob = cron.schedule('0 8 * * *', () => {
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
}

module.exports = new CronService();
