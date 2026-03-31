/**
 * Bhuj Nifty — Synthetic Index Service
 *
 * REAL mode (09:15–15:30 Mon–Fri):
 *   Uses NIFTY 50 index price directly (it IS the weighted avg of 50 stocks)
 *
 * SYNTHETIC mode (after hours + Saturday):
 *   total_change = us_change (100% US indices, average of nasdaq and dow)
 *   index = last_real_index × (1 + total_change)
 *
 * Broadcasts as KiteInstrument token 9999999 via WebSocket.
 */

const KiteInstrument = require('../models/KiteInstrument');
const { LOG_LIVE_TICKS } = require('../config/logFlags');

const BHUJ_NIFTY_TOKEN = '9999999';

// ── Source instruments ─────────────────────────────────────
// Edit these to change what drives Bhuj Nifty
const SOURCES = {
  nifty50: 'NIFTY 50',    // Real mode: use this index directly
  nasdaq:  'US 100',      // Nasdaq 100 (exchange: GLOBAL)
  dow:     'US 30',       // Dow Jones 30 (exchange: GLOBAL)
};

// Synthetic mode weights (no GIFT Nifty or USDINR available in Kite feed)
const SYNTH_WEIGHT_US = 1.0;  // 100% US indices for now

class SyntheticInstrumentService {
  constructor() {
    this.livePriceService = null;
    this._initialized = false;
    this._sourceTokens = {};
    this._prices = new Map();
    this._computeTimer = null;
    this._lastRealIndex = 0;
    this._currentValue = 0;
    this._dayOpen = 0;
    this._dayHigh = 0;
    this._dayLow = Infinity;
    this._prevClose = 0;
    this._currentMode = 'SYNTHETIC';
    this._globalBaseline = {};
    this._todayKey = null;
  }

  async init(livePriceService) {
    this.livePriceService = livePriceService;

    for (const [key, name] of Object.entries(SOURCES)) {
      const inst = await KiteInstrument.findOne({
        $or: [{ tradingsymbol: name }, { name: name }, { display_name: name }],
        is_active: true,
      }).lean();
      if (inst) {
        this._sourceTokens[key] = inst.instrument_token.toString();
        console.log(`📊 [BhujNifty] Source "${name}" → token ${inst.instrument_token}`);
      } else {
        console.warn(`⚠️  [BhujNifty] Source "${name}" NOT FOUND`);
      }
    }

    this._initialized = true;
    const found = Object.values(this._sourceTokens).filter(Boolean).length;
    console.log(`📊 [BhujNifty] Ready: ${found}/${Object.keys(SOURCES).length} sources resolved`);

    // Seed lastRealIndex from NIFTY 50's last_price in DB (survives server restart)
    if (this._sourceTokens.nifty50) {
      const niftyInst = await KiteInstrument.findOne({ instrument_token: this._sourceTokens.nifty50 }).lean();
      if (niftyInst && niftyInst.last_price > 0) {
        this._lastRealIndex = niftyInst.last_price;
        this._currentValue = niftyInst.last_price;
        console.log(`📊 [BhujNifty] Seeded lastRealIndex from DB: ${niftyInst.last_price}`);
      }
    }
    // Seed global baselines from DB last_price
    for (const key of ['nasdaq', 'dow']) {
      const token = this._sourceTokens[key];
      if (token) {
        const inst = await KiteInstrument.findOne({ instrument_token: token }).lean();
        if (inst && inst.last_price > 0) {
          this._globalBaseline[key] = inst.last_price;
          this._prices.set(token, inst.last_price);
        }
      }
    }

    // Broadcast initial value immediately so price shows on app open
    if (this._lastRealIndex > 0) {
      this._compute();
      // Also set up periodic broadcast every 30s for when no source ticks arrive
      setInterval(() => {
        if (this._lastRealIndex > 0) this._compute();
      }, 30000);
    }
  }

  getSourceTokens() {
    return Object.values(this._sourceTokens)
      .filter(Boolean)
      .map(t => parseInt(t));
  }

  onTick(instrumentToken, ltp) {
    if (!this._initialized) return;
    const tokenStr = instrumentToken.toString();

    const isOurs = Object.values(this._sourceTokens).includes(tokenStr);
    if (!isOurs) return;

    this._prices.set(tokenStr, ltp);

    // Throttle: recompute at most once per second
    if (!this._computeTimer) {
      this._computeTimer = setTimeout(() => {
        this._computeTimer = null;
        this._compute();
      }, 1000);
    }
  }

  _isMarketHours() {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const timeInMins = ist.getHours() * 60 + ist.getMinutes();
    return timeInMins >= 555 && timeInMins <= 930; // 09:15–15:30
  }

  _compute() {
    const isReal = this._isMarketHours();
    let newValue;

    if (isReal) {
      newValue = this._computeReal();
      if (newValue > 0) {
        this._lastRealIndex = newValue;
        this._currentMode = 'REAL';
        this._snapshotGlobalBaseline();
      }
    } else {
      newValue = this._computeSynthetic();
      this._currentMode = 'SYNTHETIC';
    }

    if (!newValue || newValue <= 0) return;

    // Track daily OHLC
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const todayKey = `${ist.getFullYear()}-${ist.getMonth()}-${ist.getDate()}`;

    if (!this._todayKey || this._todayKey !== todayKey) {
      this._prevClose = this._currentValue || newValue;
      this._dayOpen = newValue;
      this._dayHigh = newValue;
      this._dayLow = newValue;
      this._todayKey = todayKey;
    }

    this._currentValue = newValue;
    if (newValue > this._dayHigh) this._dayHigh = newValue;
    if (newValue < this._dayLow) this._dayLow = newValue;

    const change = this._prevClose > 0 ? newValue - this._prevClose : 0;
    const changePct = this._prevClose > 0 ? (change / this._prevClose) * 100 : 0;

    if (this.livePriceService) {
      this.livePriceService.latestPrices.set(BHUJ_NIFTY_TOKEN, newValue);
      this.livePriceService.latestPrices.set(parseInt(BHUJ_NIFTY_TOKEN), newValue);

      this.livePriceService._broadcastToClients({
        type: 'ticks',
        data: [{
          instrument_token: BHUJ_NIFTY_TOKEN,
          last_price: Math.round(newValue * 100) / 100,
          change: Math.round(change * 100) / 100,
          change_percent: Math.round(changePct * 100) / 100,
          open: Math.round(this._dayOpen * 100) / 100,
          close: Math.round(this._prevClose * 100) / 100,
          high: Math.round(this._dayHigh * 100) / 100,
          low: Math.round(this._dayLow * 100) / 100,
          bid_price: Math.round((newValue - newValue * 0.0005) * 100) / 100,
          ask_price: Math.round((newValue + newValue * 0.0005) * 100) / 100,
        }],
      });
    }

    if (LOG_LIVE_TICKS) {
      console.log(`📊 [BhujNifty] ${this._currentMode}: ${newValue.toFixed(2)} (H:${this._dayHigh.toFixed(2)} L:${this._dayLow.toFixed(2)})`);
    }
  }

  _computeReal() {
    const token = this._sourceTokens.nifty50;
    if (!token) return 0;
    const price = this._prices.get(token);
    return (price && price > 0) ? price : 0;
  }

  _snapshotGlobalBaseline() {
    for (const key of ['nasdaq', 'dow']) {
      const token = this._sourceTokens[key];
      if (token) {
        const price = this._prices.get(token);
        if (price && price > 0) this._globalBaseline[key] = price;
      }
    }
  }

  _computeSynthetic() {
    if (this._lastRealIndex <= 0) {
      const realAttempt = this._computeReal();
      if (realAttempt > 0) {
        this._lastRealIndex = realAttempt;
        this._snapshotGlobalBaseline();
      } else {
        return 0;
      }
    }

    const getChange = (key) => {
      const token = this._sourceTokens[key];
      const baseline = this._globalBaseline[key];
      if (!token || !baseline || baseline <= 0) return null;
      const current = this._prices.get(token);
      if (!current || current <= 0) return null;
      return (current - baseline) / baseline;
    };

    const nasdaqChange = getChange('nasdaq');
    const dowChange = getChange('dow');

    let usChange = null;
    if (nasdaqChange !== null && dowChange !== null) usChange = (nasdaqChange + dowChange) / 2;
    else if (nasdaqChange !== null) usChange = nasdaqChange;
    else if (dowChange !== null) usChange = dowChange;

    let totalChange = 0;
    let totalWeight = 0;

    if (usChange !== null) { totalChange += SYNTH_WEIGHT_US * usChange; totalWeight += SYNTH_WEIGHT_US; }

    if (totalWeight > 0 && totalWeight < 1) totalChange = totalChange / totalWeight;
    if (totalWeight === 0) return this._lastRealIndex;

    return this._lastRealIndex * (1 + totalChange);
  }
}

const syntheticInstrumentService = new SyntheticInstrumentService();
module.exports = syntheticInstrumentService;
