/**
 * fetch_mcx_lot_sizes.js
 *
 * Uses Kite's basket margin API to back-calculate the real lot size for
 * every unique MCX instrument name (COPPER, GOLD, SILVER, etc.).
 *
 * Strategy:
 *   POST /margins/orders  with quantity=1 for a FUT contract
 *   → returns total SPAN margin for 1 unit
 *   Then:
 *   POST /margins/orders  with quantity=1000 for the same contract
 *   → if margin scales linearly, lot_size = margin_1000 / margin_1 / 1000 ... no.
 *
 * Better strategy — Kite's /margins/orders returns `pnl.realised` = 0 but
 * `total` = SPAN margin per lot when quantity = lot_size.
 *
 * SIMPLEST reliable approach:
 *   Use Kite's /quote API to get last_price, then use /margins/orders
 *   with qty=1 to get margin_per_unit, then:
 *     lot_size = round(contract_value_per_lot / last_price)
 *   where contract_value_per_lot comes from MCX published specs.
 *
 * Since Kite doesn't expose lot_size directly via API for MCX options,
 * the most reliable programmatic approach is:
 *   1. Fetch the FUT contract for each MCX name
 *   2. Call POST /margins/orders with qty=1 → get span margin per unit
 *   3. Call POST /margins/orders with qty=2 → confirm linear scaling
 *   4. The lot_size is what makes margin_per_lot = published_span_per_lot
 *
 * ACTUAL WORKING APPROACH:
 * Kite's instruments CSV has lot_size=1 for MCX, but the SPAN margin API
 * returns margin for the FULL LOT when you pass qty=1 (Kite treats qty as lots for MCX).
 * So: margin for qty=1 = margin for 1 lot = span_per_lot
 * And: margin for qty=2 = margin for 2 lots
 * We can verify: margin(2) / margin(1) = 2 → confirms qty is in lots
 *
 * To get actual lot_size in units:
 *   lot_size_units = contract_value / last_price
 *   where contract_value = span_margin / margin_rate
 *
 * SIMPLEST FINAL APPROACH — use Kite quote + known MCX contract sizes:
 * Fetch all unique MCX instrument names, call /quote for one FUT per name,
 * then use the margin API to get span per lot, and back-calculate.
 *
 * Run: node scripts/fetch_mcx_lot_sizes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const KiteInstrument = require('../src/models/KiteInstrument');
const { AccessToken } = require('../src/models/KiteConfig');

const KITE_BASE = 'https://api.kite.trade';
const API_KEY = process.env.KITE_API_KEY;

async function getAccessToken() {
  const doc = await AccessToken.findOne({ expires_at: { $gt: new Date() } }).sort({ created_at: -1 });
  if (!doc) throw new Error('No valid Kite access token found. Please login first.');
  return doc.access_token;
}

function kiteHeaders(token) {
  return {
    'X-Kite-Version': '3',
    'Authorization': `token ${API_KEY}:${token}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const accessToken = await getAccessToken();
  console.log('✅ Got Kite access token\n');

  // Get one FUT per unique MCX instrument name
  const mcxFuts = await KiteInstrument.find({
    exchange: 'MCX',
    instrument_type: 'FUT',
    expiry: { $gte: new Date() }
  })
  .sort({ expiry: 1 })
  .lean();

  // Deduplicate by name — take nearest expiry FUT for each
  const byName = {};
  for (const inst of mcxFuts) {
    if (!byName[inst.name]) byName[inst.name] = inst;
  }

  const names = Object.keys(byName);
  console.log(`Found ${names.length} unique MCX instruments: ${names.join(', ')}\n`);

  const results = {};

  for (const name of names) {
    const inst = byName[name];
    try {
      // Call Kite basket margin API with qty=1 and qty=2
      // POST /margins/orders with array of order objects
      const orderPayload = (qty) => {
        const params = new URLSearchParams();
        params.append('orders[0][exchange]', 'MCX');
        params.append('orders[0][tradingsymbol]', inst.tradingsymbol);
        params.append('orders[0][transaction_type]', 'BUY');
        params.append('orders[0][variety]', 'regular');
        params.append('orders[0][product]', 'NRML');
        params.append('orders[0][order_type]', 'MARKET');
        params.append('orders[0][quantity]', qty.toString());
        return params.toString();
      };

      const [r1, r2] = await Promise.all([
        axios.post(`${KITE_BASE}/margins/orders`, orderPayload(1), { headers: kiteHeaders(accessToken) }),
        axios.post(`${KITE_BASE}/margins/orders`, orderPayload(2), { headers: kiteHeaders(accessToken) }),
      ]);

      const margin1 = r1.data?.data?.final?.total ?? r1.data?.data?.[0]?.total ?? 0;
      const margin2 = r2.data?.data?.final?.total ?? r2.data?.data?.[0]?.total ?? 0;

      // Also get last price via quote
      const quoteRes = await axios.get(`${KITE_BASE}/quote`, {
        params: { 'i': `MCX:${inst.tradingsymbol}` },
        headers: kiteHeaders(accessToken)
      });
      const ltp = quoteRes.data?.data?.[`MCX:${inst.tradingsymbol}`]?.last_price ?? 0;

      // margin2 / margin1 should be ~2 if qty is in lots
      // contract_value_per_lot = margin1 / margin_rate
      // lot_size = contract_value_per_lot / ltp
      // But we don't know margin_rate directly.
      //
      // Alternative: Kite's margin for MCX FUT = SPAN + Exposure
      // SPAN is typically ~4-8% of contract value
      // contract_value = lot_size * ltp
      // So: lot_size = margin1 / (span_rate * ltp)
      //
      // Since we don't know span_rate, use ratio approach:
      // If margin scales linearly with qty, qty IS in lots already.
      // Then lot_size = contract_value / ltp where contract_value
      // can be estimated from published MCX specs.
      //
      // BEST: just report margin1, margin2, ltp and let us see the pattern.

      const ratio = margin1 > 0 ? (margin2 / margin1).toFixed(3) : 'N/A';

      results[name] = {
        tradingsymbol: inst.tradingsymbol,
        ltp: ltp.toFixed(2),
        margin_qty1: margin1.toFixed(2),
        margin_qty2: margin2.toFixed(2),
        ratio_2_to_1: ratio,
        // Estimate: if margin ≈ 5% of contract value, lot_size ≈ margin1 / (0.05 * ltp)
        estimated_lot_size_at_5pct: ltp > 0 ? Math.round(margin1 / (0.05 * ltp)) : 'N/A',
        estimated_lot_size_at_8pct: ltp > 0 ? Math.round(margin1 / (0.08 * ltp)) : 'N/A',
      };

      console.log(`${name.padEnd(15)} LTP: ${ltp.toFixed(0).padStart(8)}  margin(1): ${margin1.toFixed(0).padStart(10)}  margin(2): ${margin2.toFixed(0).padStart(10)}  ratio: ${ratio}`);

    } catch (e) {
      console.error(`❌ ${name}: ${e.response?.data?.message || e.message}`);
      results[name] = { error: e.response?.data?.message || e.message };
    }

    // Rate limit: Kite allows 3 req/sec
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('\n\n=== FULL RESULTS ===');
  console.log(JSON.stringify(results, null, 2));

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
