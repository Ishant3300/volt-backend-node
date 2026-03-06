# Test Scripts

This directory contains test scripts for debugging and verifying backend functionality.

## Bid/Ask Price Testing

### Quick Start

1. **Run diagnostic tool** (checks your setup):
   ```bash
   node test/checkBidAskStatus.js
   ```

2. **Find instrument token**:
   ```bash
   node test/findGoldToken.js
   ```
   This will search for GOLD futures in `instruments.csv` and display available tokens.

3. **Update test script**:
   Edit `test/testBidAsk.js` and update the `GOLD_INSTRUMENT_TOKEN` constant with the token from step 2.

4. **Run bid/ask test**:
   ```bash
   node test/testBidAsk.js
   ```
   This will connect to Kite WebSocket and display bid/ask prices for 30 seconds.

### Understanding the Output

#### Expected Output (Success):
```
✅ Connected to Kite WebSocket
📡 Subscribed to instrument
📡 Set mode to FULL (market depth enabled)

📦 Received 1 packet(s)
📊 Parsing packet for token: 116433415
   Packet size: 184 bytes
   Mode: FULL (184 bytes) - includes market depth
   Last Price: 70250.00

   📈 BUY DEPTH (Bids):
      Level 1: Price=70245.00, Qty=50, Orders=3
      Level 2: Price=70240.00, Qty=100, Orders=5

   📉 SELL DEPTH (Asks):
      Level 1: Price=70255.00, Qty=75, Orders=4
      Level 2: Price=70260.00, Qty=120, Orders=6

   ✅ Best BID (you can SELL at): 70245.00
   ✅ Best ASK (you can BUY at): 70255.00
   💰 SPREAD: 10.00 (0.014%)
```

#### Problem: Small Packet Size
```
📊 Parsing packet for token: 116433415
   Packet size: 8 bytes
   Mode: LTP (8 bytes)
   Last Price: 70250.00
```

**Solution**: Kite is sending LTP mode only. This happens when:
- Instrument is not actively traded
- Kite hasn't switched to full mode yet (wait a few seconds)
- Instrument doesn't support market depth

Try a more liquid instrument like NIFTY or BANKNIFTY futures.

#### Problem: No Access Token
```
❌ Error getting access token: No Kite access token found in database
```

**Solution**: 
1. Make sure the backend server is running
2. The backend should auto-login on startup
3. Check backend logs for "✅ Kite already authenticated"

### Troubleshooting

#### Issue: Both BUY and SELL show same price in Flutter app

**Possible Causes:**

1. **Backend not receiving full mode data**
   - Check backend logs for "⚠️  Packet size X bytes" warnings
   - If packet size is 8 or 28 bytes, bid/ask data is not available
   - Solution: Try a different, more liquid instrument

2. **Spread is too small to notice**
   - For GOLD at ₹70,000, a 0.05% spread = ₹35
   - Check if prices differ by small amounts
   - Solution: This is normal for liquid instruments

3. **Bid/Ask fields are null**
   - Check Flutter logs for "⚠️  Token X: Bid/Ask=NULL"
   - Solution: Backend needs to receive 184-byte packets

#### Issue: Test script fails with "MONGO_URI undefined"

**Solution**: Make sure `.env` file exists in `stocker-backend-node/` directory with:
```
MONGO_URI=mongodb+srv://...
KITE_API_KEY=...
KITE_API_SECRET=...
```

#### Issue: "instruments.csv not found"

**Solution**: Run the instrument fetch script first:
```bash
node scripts/fetchInstruments.js
```

### Testing with Different Instruments

To test with other instruments:

1. Search for the instrument:
   ```bash
   # For NIFTY futures
   grep "NIFTY.*FUT" instruments.csv | head -5
   
   # For BANKNIFTY futures
   grep "BANKNIFTY.*FUT" instruments.csv | head -5
   ```

2. Update `GOLD_INSTRUMENT_TOKEN` in `testBidAsk.js` with the token

3. Run the test again

### Backend Server Logs

When the backend is running and receiving bid/ask data, you should see:

```
📈 Received 1 tick(s):
   Token: 116433415 | LTP: 70250.00
   📊 Bid: 70245.00
   📊 Ask: 70255.00
   💰 SPREAD: 10.00 (0.014%)
   📤 Broadcasted to 1 client(s)
```

If you see "⚠️  Packet size 8 bytes" or "⚠️  Packet size 28 bytes", the backend is not receiving full market depth data.

### Flutter App Logs

In the Flutter app debug console, you should see:

```
💰 Token 116433415: LTP=70250.0, Bid=70245.0, Ask=70255.0
```

If you see "⚠️  Token X: Bid/Ask=NULL", the Flutter app is not receiving bid/ask data from the backend.
