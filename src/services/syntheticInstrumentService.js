/**
 * Bhuj Nifty — Synthetic Index Service
 *
 * REAL mode (09:15–15:30 Mon–Fri):
 *   Uses NIFTY 50 index price directly (it IS the weighted avg of 50 stocks)
 *
 * SYNTHETIC mode (after hours + Saturday):
 *   usChange = average(% change of Nasdaq + Dow)
 *   index = lastRealIndex × (1 + usChange)
 *
 * Broadcasts as KiteInstrument token 9999999 via WebSocket.
 */

const KiteInstrument = require('../models/KiteInstrument');
const { LOG_LIVE_TICKS } = require('../config/logFlags');

const BHUJ_NIFTY_TOKEN = '9999999';

const SOURCES = {
  nifty50: 'NIFTY 50',
  nasdaq:  'US 100',
  dow:     'US 30',
};

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
        console.log(`📊 [BhujNifty] "${name}" → token ${inst.instrument_token}`);
      } else {
        console.warn(`⚠️  [BhujNifty] "${name}" NOT FOUND`);
      }
    }

    this._initialized = true;
    console.log(`📊 [BhujNifty] Ready: ${Object.values(this._sourceTokens).filter(Boolean).length}/${Object.keys(SOURCES).length} sources`);

    // Seed from DB
    if (this._sourceTokens.nifty50) {
      const ni = await KiteInstrument.findOne({ instrument_token: this._sourceTokens.nifty50 }).lean();
      if (ni && ni.last_price > 0) {
        this._lastRealIndex = ni.last_price;
        this._currentValue = ni.last_price;
      }
    }
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

    if (this._lastRealIndex > 0) {
      this._compute();
      setInterval(() => { if (this._lastRealIndex > 0) this._compute(); }, 30000);
    }
  }


  getSourceTokens() {
    return Object.values(this._sourceTokens).filter(Boolean).map(t => parseInt(t));
  }

  onTick(instrumentToken, ltp) {
    if (!this._initialized) return;
    const tokenStr = instrumentToken.toString();
    if (!Object.values(this._sourceTokens).includes(tokenStr)) return;

    this._prices.set(tokenStr, ltp);

    // Set baseline on first tick if not seeded from DB
    for (const key of ['nasdaq', 'dow']) {
      if (this._sourceTokens[key] === tokenStr && !this._globalBaseline[key]) {
        this._globalBaseline[key] = ltp;
      }
    }

    if (!this._computeTimer) {
      this._computeTimer = setTimeout(() => {
        this._computeTimer = null;
        this._compute();
      }, 1000);
    }
  }

  _istNow() {
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utcMs + (5.5 * 3600000));
  }

  _isMarketHours() {
    const ist = this._istNow();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= 555 && mins <= 930;
  }

  _compute() {
    const isReal = this._isMarketHours();
    let newValue;

    if (isReal) {
      const token = this._sourceTokens.nifty50;
      const price = token ? this._prices.get(token) : null;
      if (price && price > 0) {
        newValue = price;
        this._lastRealIndex = price;
        this._currentMode = 'REAL';
        this._snapshotBaseline();
      }
    } else {
      newValue = this._computeSynthetic();
      this._currentMode = 'SYNTHETIC';
    }

    if (!newValue || newValue <= 0) return;

    // Daily OHLC
    const ist = this._istNow();
    const todayKey = `${ist.getFullYear()}-${ist.getMonth()}-${ist.getDate()}`;
    if (this._todayKey !== todayKey) {
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
    const r = (v) => Math.round(v * 100) / 100;

    if (this.livePriceService) {
      this.livePriceService.latestPrices.set(BHUJ_NIFTY_TOKEN, newValue);
      this.livePriceService.latestPrices.set(parseInt(BHUJ_NIFTY_TOKEN), newValue);
      this.livePriceService._broadcastToClients({
        type: 'ticks',
        data: [{
          instrument_token: BHUJ_NIFTY_TOKEN,
          last_price: r(newValue),
          change: r(change),
          change_percent: r(changePct),
          open: r(this._dayOpen),
          close: r(this._prevClose),
          high: r(this._dayHigh),
          low: r(this._dayLow),
          bid_price: r(newValue - newValue * 0.0005),
          ask_price: r(newValue + newValue * 0.0005),
        }],
      });
    }

    if (LOG_LIVE_TICKS) {
      console.log(`📊 [BhujNifty] ${this._currentMode}: ${newValue.toFixed(2)} (H:${this._dayHigh.toFixed(2)} L:${this._dayLow.toFixed(2)})`);
    }
  }

  _snapshotBaseline() {
    for (const key of ['nasdaq', 'dow']) {
      const token = this._sourceTokens[key];
      if (token) {
        const price = this._prices.get(token);
        if (price && price > 0) this._globalBaseline[key] = price;
      }
    }
  }

  _computeSynthetic() {
    if (this._lastRealIndex <= 0) return 0;

    const getChange = (key) => {
      const token = this._sourceTokens[key];
      const baseline = this._globalBaseline[key];
      if (!token || !baseline || baseline <= 0) return null;
      const current = this._prices.get(token);
      if (!current || current <= 0) return null;
      return (current - baseline) / baseline;
    };

    const nc = getChange('nasdaq');
    const dc = getChange('dow');

    let usChange = null;
    if (nc !== null && dc !== null) usChange = (nc + dc) / 2;
    else if (nc !== null) usChange = nc;
    else if (dc !== null) usChange = dc;

    if (usChange === null) return this._lastRealIndex;
    return this._lastRealIndex * (1 + usChange);
  }
}

const syntheticInstrumentService = new SyntheticInstrumentService();
module.exports = syntheticInstrumentService;
