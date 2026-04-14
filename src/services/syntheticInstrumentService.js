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
  giftnifty: 'GIFT NIFTY',
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
    if (this._sourceTokens.giftnifty) {
      const ni = await KiteInstrument.findOne({ instrument_token: this._sourceTokens.giftnifty }).lean();
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
    }
    // Always start the compute interval — even if no baseline yet,
    // it will start computing once the first GIFT NIFTY tick arrives
    setInterval(() => { this._compute(); }, 30000);
  }


  getSourceTokens() {
    return Object.values(this._sourceTokens).filter(Boolean).map(t => parseInt(t));
  }

  onTick(instrumentToken, ltp) {
    if (!this._initialized) return;
    const tokenStr = instrumentToken.toString();
    if (!Object.values(this._sourceTokens).includes(tokenStr)) return;

    this._prices.set(tokenStr, ltp);

    // Update _lastRealIndex immediately when GIFT NIFTY tick arrives
    if (this._sourceTokens.giftnifty === tokenStr && ltp > 0) {
      this._lastRealIndex = ltp;
    }

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
    if (day === 0) return false; // Sunday — no trading
    const mins = ist.getHours() * 60 + ist.getMinutes();
    // GIFT NIFTY trades ~6:30 AM to ~2:30 AM next day (SGX hours)
    // Use REAL mode when GIFT NIFTY is likely live (Mon 6:30 AM to Sat 2:30 AM)
    // Simplified: 6:30 AM (390 min) to 2:30 AM next day (150 min)
    if (day === 6) return mins < 150; // Saturday: only until 2:30 AM (Friday's session)
    return mins >= 390 || mins < 150; // 6:30 AM onwards OR before 2:30 AM (prev day session)
  }

  _compute() {
    // Weighted blend: 60% GIFT NIFTY, 30% US 30 (Dow), 10% US 100 (Nasdaq)
    // All three contribute at all times (market hours and after hours)
    const giftToken = this._sourceTokens.giftnifty;
    const dowToken = this._sourceTokens.dow;
    const nasdaqToken = this._sourceTokens.nasdaq;

    const giftPrice = giftToken ? this._prices.get(giftToken) : null;
    const dowPrice = dowToken ? this._prices.get(dowToken) : null;
    const nasdaqPrice = nasdaqToken ? this._prices.get(nasdaqToken) : null;

    // Update last real index from GIFT NIFTY when available
    if (giftPrice && giftPrice > 0) {
      this._lastRealIndex = giftPrice;
    }

    // Compute % change from baseline for each source
    const giftBaseline = this._lastRealIndex;
    const dowBaseline = this._globalBaseline.dow || 0;
    const nasdaqBaseline = this._globalBaseline.nasdaq || 0;

    // If we have no baseline at all, can't compute
    if (giftBaseline <= 0) return;

    // Snapshot baselines on first valid GIFT NIFTY tick
    if (giftPrice && giftPrice > 0 && Object.keys(this._globalBaseline).length === 0) {
      this._snapshotBaseline();
    }

    // Start with GIFT NIFTY as the base value
    let newValue = 0;
    let totalWeight = 0;

    // 60% GIFT NIFTY — use live price if available, else last known
    const giftLive = (giftPrice && giftPrice > 0) ? giftPrice : giftBaseline;
    newValue += giftLive * 0.6;
    totalWeight += 0.6;

    // 30% US 30 (Dow) — apply % change to GIFT NIFTY base
    if (dowPrice && dowPrice > 0 && dowBaseline > 0) {
      const dowChange = (dowPrice - dowBaseline) / dowBaseline;
      newValue += giftBaseline * (1 + dowChange) * 0.3;
      totalWeight += 0.3;
    }

    // 10% US 100 (Nasdaq) — apply % change to GIFT NIFTY base
    if (nasdaqPrice && nasdaqPrice > 0 && nasdaqBaseline > 0) {
      const nasdaqChange = (nasdaqPrice - nasdaqBaseline) / nasdaqBaseline;
      newValue += giftBaseline * (1 + nasdaqChange) * 0.1;
      totalWeight += 0.1;
    }

    // Normalize if some sources are missing
    if (totalWeight > 0 && totalWeight < 1) {
      newValue = newValue / totalWeight;
    }

    if (newValue <= 0) return;

    this._currentMode = (giftPrice && giftPrice > 0) ? 'REAL' : 'SYNTHETIC';

    // Snapshot US baselines when GIFT NIFTY is live
    if (giftPrice && giftPrice > 0) {
      this._snapshotBaseline();
    }

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

      // Update metricsEngine so synthetic positions get live P&L
      const metricsEngine = require('./metricsEngine');
      metricsEngine.onTick(BHUJ_NIFTY_TOKEN, r(newValue));
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
