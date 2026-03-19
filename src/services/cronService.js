const cron = require('node-cron');
const path = require('path');
const { fork } = require('child_process');
const User = require('../models/User');
const Master = require('../models/Master');
const orderExecutionService = require('./orderExecutionService');
const redisService = require('./redisService');
const { snapshotWeeklySummary } = require('./weeklySummaryService');

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
            { $set: { balance: '$credits' } }
        ]);
        console.log(`📊 [CRON] Reset balances for ${masterUpdateResult.modifiedCount} Masters.`);

        // 2. Reset User Balances
        const userUpdateResult = await User.updateMany({}, [
            { $set: { balance: '$credits' } }
        ]);
        console.log(`📊 [CRON] Reset balances for ${userUpdateResult.modifiedCount} Users.`);
    }
}

module.exports = new CronService();
