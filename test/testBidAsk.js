/**
 * Test script to fetch and parse bid/ask prices from Kite WebSocket
 * for GOLD APR FUT instrument
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { AccessToken } = require('../src/models/KiteConfig');

// GOLD APR 2026 FUT instrument token
// Run: node test/findGoldToken.js to find the correct token
// Common tokens: 116433415 (GOLD26APRFUT), check instruments.csv for current month
const GOLD_INSTRUMENT_TOKEN = 116433415; // Update this with the correct token from findGoldToken.js

async function getAccessToken() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI not found in environment variables. Check your .env file.');
    }

    await mongoose.connect(mongoUri);
    console.log('📦 Connected to MongoDB');

    const tokenDoc = await AccessToken.findOne({
      expires_at: { $gt: new Date() }
    }).sort({ created_at: -1 });
    
    if (!tokenDoc || !tokenDoc.access_token) {
      throw new Error('No valid Kite access token found in database');
    }

    console.log('✅ Found valid Kite access token');
    console.log(`   Created: ${tokenDoc.created_at.toLocaleString()}`);
    console.log(`   Expires: ${tokenDoc.expires_at.toLocaleString()}`);
    return tokenDoc.access_token;
  } catch (error) {
    console.error('❌ Error getting access token:', error.message);
    throw error;
  }
}

function parseTick(packet) {
  try {
    if (packet.length < 4) return null;

    const instrumentToken = packet.readInt32BE(0);
    console.log(`\n📊 Parsing packet for token: ${instrumentToken}`);
    console.log(`   Packet size: ${packet.length} bytes`);

    // LTP mode (8 bytes)
    if (packet.length === 8) {
      const lastPrice = packet.readInt32BE(4) / 100;
      console.log(`   Mode: LTP (8 bytes)`);
      console.log(`   Last Price: ${lastPrice}`);
      return {
        instrument_token: instrumentToken,
        last_price: lastPrice,
        mode: 'ltp'
      };
    }

    // Quote mode (28-44 bytes)
    if (packet.length >= 28 && packet.length < 184) {
      const lastPrice = packet.readInt32BE(4) / 100;
      const highPrice = packet.readInt32BE(8) / 100;
      const lowPrice = packet.readInt32BE(12) / 100;
      const openPrice = packet.readInt32BE(16) / 100;
      const closePrice = packet.readInt32BE(20) / 100;

      console.log(`   Mode: QUOTE (${packet.length} bytes)`);
      console.log(`   Last Price: ${lastPrice}`);
      console.log(`   High: ${highPrice}`);
      console.log(`   Low: ${lowPrice}`);
      console.log(`   Open: ${openPrice}`);
      console.log(`   Close: ${closePrice}`);

      return {
        instrument_token: instrumentToken,
        last_price: lastPrice,
        high: highPrice,
        low: lowPrice,
        open: openPrice,
        close: closePrice,
        mode: 'quote'
      };
    }

    // Full mode (184 bytes) - includes market depth
    if (packet.length >= 184) {
      const lastPrice = packet.readInt32BE(4) / 100;
      const highPrice = packet.readInt32BE(8) / 100;
      const lowPrice = packet.readInt32BE(12) / 100;
      const openPrice = packet.readInt32BE(16) / 100;
      const closePrice = packet.readInt32BE(20) / 100;

      console.log(`   Mode: FULL (${packet.length} bytes) - includes market depth`);
      console.log(`   Last Price: ${lastPrice}`);
      console.log(`   High: ${highPrice}`);
      console.log(`   Low: ${lowPrice}`);
      console.log(`   Open: ${openPrice}`);
      console.log(`   Close: ${closePrice}`);

      // Try different offsets to find bid/ask
      console.log(`\n   🔍 Attempting to parse market depth...`);
      
      // According to Kite docs, market depth structure:
      // Offset 60: Buy depth (5 entries x 12 bytes each)
      // Offset 120: Sell depth (5 entries x 12 bytes each)
      // Each entry: 4 bytes quantity + 4 bytes price + 4 bytes orders

      const buyDepth = [];
      const sellDepth = [];

      // Parse buy depth (5 levels)
      for (let i = 0; i < 5; i++) {
        const offset = 60 + (i * 12);
        if (offset + 12 <= packet.length) {
          const quantity = packet.readInt32BE(offset);
          const price = packet.readInt32BE(offset + 4) / 100;
          const orders = packet.readInt32BE(offset + 8);
          
          if (price > 0) {
            buyDepth.push({ quantity, price, orders });
          }
        }
      }

      // Parse sell depth (5 levels)
      for (let i = 0; i < 5; i++) {
        const offset = 120 + (i * 12);
        if (offset + 12 <= packet.length) {
          const quantity = packet.readInt32BE(offset);
          const price = packet.readInt32BE(offset + 4) / 100;
          const orders = packet.readInt32BE(offset + 8);
          
          if (price > 0) {
            sellDepth.push({ quantity, price, orders });
          }
        }
      }

      console.log(`\n   📈 BUY DEPTH (Bids):`);
      buyDepth.forEach((level, idx) => {
        console.log(`      Level ${idx + 1}: Price=${level.price}, Qty=${level.quantity}, Orders=${level.orders}`);
      });

      console.log(`\n   📉 SELL DEPTH (Asks):`);
      sellDepth.forEach((level, idx) => {
        console.log(`      Level ${idx + 1}: Price=${level.price}, Qty=${level.quantity}, Orders=${level.orders}`);
      });

      const bestBid = buyDepth.length > 0 ? buyDepth[0].price : null;
      const bestAsk = sellDepth.length > 0 ? sellDepth[0].price : null;

      if (bestBid) console.log(`\n   ✅ Best BID (you can SELL at): ${bestBid}`);
      if (bestAsk) console.log(`   ✅ Best ASK (you can BUY at): ${bestAsk}`);
      if (bestBid && bestAsk) {
        console.log(`   💰 SPREAD: ${(bestAsk - bestBid).toFixed(2)} (${(((bestAsk - bestBid) / bestBid) * 100).toFixed(3)}%)`);
      }

      return {
        instrument_token: instrumentToken,
        last_price: lastPrice,
        high: highPrice,
        low: lowPrice,
        open: openPrice,
        close: closePrice,
        bid_price: bestBid,
        ask_price: bestAsk,
        buy_depth: buyDepth,
        sell_depth: sellDepth,
        mode: 'full'
      };
    }

    return null;
  } catch (error) {
    console.error('❌ Error parsing tick:', error.message);
    return null;
  }
}

async function testBidAsk() {
  let accessToken;
  
  try {
    accessToken = await getAccessToken();
    
    const apiKey = process.env.KITE_API_KEY;
    const wsUrl = `wss://ws.kite.trade?api_key=${apiKey}&access_token=${accessToken}`;

    console.log(`\n🔌 Connecting to Kite WebSocket...`);
    console.log(`   Instrument: GOLD APR FUT`);
    console.log(`   Token: ${GOLD_INSTRUMENT_TOKEN}`);

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('✅ Connected to Kite WebSocket\n');

      // Subscribe to the instrument
      const subscribeMsg = JSON.stringify({
        a: 'subscribe',
        v: [GOLD_INSTRUMENT_TOKEN],
      });
      ws.send(subscribeMsg);
      console.log('📡 Subscribed to instrument');

      // Set mode to FULL to get market depth
      const modeMsg = JSON.stringify({
        a: 'mode',
        v: ['full', [GOLD_INSTRUMENT_TOKEN]],
      });
      ws.send(modeMsg);
      console.log('📡 Set mode to FULL (market depth enabled)');
      console.log('\n⏳ Waiting for tick data...\n');
    });

    ws.on('message', (data) => {
      try {
        const buffer = Buffer.from(data);

        // First 2 bytes = number of packets
        if (buffer.length < 2) return;

        const numPackets = buffer.readInt16BE(0);
        let offset = 2;

        console.log(`\n📦 Received ${numPackets} packet(s)`);

        for (let i = 0; i < numPackets; i++) {
          if (offset + 2 > buffer.length) break;

          const packetLength = buffer.readInt16BE(offset);
          offset += 2;

          if (offset + packetLength > buffer.length) break;

          const packet = buffer.slice(offset, offset + packetLength);
          offset += packetLength;

          const tick = parseTick(packet);
          
          if (tick) {
            console.log(`\n${'='.repeat(60)}`);
            console.log('✅ Successfully parsed tick data');
            console.log(`${'='.repeat(60)}\n`);
          }
        }
      } catch (error) {
        console.error('❌ Error processing message:', error.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`\n⚠️  WebSocket closed: ${code} - ${reason}`);
      mongoose.disconnect();
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
      mongoose.disconnect();
      process.exit(1);
    });

    // Keep the script running for 30 seconds to receive ticks
    setTimeout(() => {
      console.log('\n⏱️  Test complete (30 seconds elapsed)');
      ws.close();
    }, 30000);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    process.exit(1);
  }
}

// Run the test
console.log('🧪 Starting Bid/Ask Price Test\n');

// Verify environment variables
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGO_URI not found in .env file');
  console.log('   Make sure .env file exists in stocker-backend-node/ directory\n');
  process.exit(1);
}

if (!process.env.KITE_API_KEY) {
  console.error('❌ KITE_API_KEY not found in .env file');
  console.log('   Make sure .env file exists in stocker-backend-node/ directory\n');
  process.exit(1);
}

console.log('✅ Environment variables loaded');
console.log(`   MongoDB: ${mongoUri.substring(0, 30)}...`);
console.log(`   Kite API Key: ${process.env.KITE_API_KEY.substring(0, 10)}...\n`);

testBidAsk();
