# Bid/Ask Price Implementation Guide

## Overview

The Stocker app now displays separate bid and ask prices for trading:
- **SELL button**: Shows bid price (price at which you can sell)
- **BUY button**: Shows ask price (price at which you can buy)

## How It Works

### Backend (Node.js)

1. **WebSocket Connection** (`src/services/livePriceService.js`):
   - Connects to Kite WebSocket API
   - Subscribes to instruments in FULL mode (184-byte packets)
   - Parses market depth data from binary packets

2. **Bid/Ask Parsing**:
   - Best bid price: Read from offset 64 (first buy order in market depth)
   - Best ask price: Read from offset 124 (first sell order in market depth)
   - Only available in FULL mode (184-byte packets)

3. **Broadcasting**:
   - Sends tick data to Flutter clients via WebSocket
   - Includes `bid_price` and `ask_price` fields when available

### Frontend (Flutter)

1. **WatchlistProvider** (`lib/providers/watchlist_provider.dart`):
   - Receives tick data from backend WebSocket
   - Updates `WatchlistItem` with `bidPrice` and `askPrice`
   - Logs when bid/ask data is received

2. **WatchlistItem Model** (`lib/models/watchlist_item.dart`):
   - Added `bidPrice` and `askPrice` fields
   - Nullable to handle cases where data is unavailable

3. **TradeCardView** (`lib/views/trade_card_view.dart`):
   - SELL button: Uses `bidPrice` (or LTP - 0.05% if null)
   - BUY button: Uses `askPrice` (or LTP + 0.05% if null)
   - Fallback spread: 0.05% (typical for liquid instruments)

## Testing

### Step 1: Run Diagnostic

```bash
cd stocker-backend-node
node test/checkBidAskStatus.js
```

This checks your environment setup and provides troubleshooting guidance.

### Step 2: Find Instrument Token

```bash
node test/findGoldToken.js
```

This searches for GOLD futures in `instruments.csv` and displays available tokens.

### Step 3: Test Bid/Ask Reception

1. Update `test/testBidAsk.js` with the correct instrument token
2. Run the test:
   ```bash
   node test/testBidAsk.js
   ```
3. Watch for bid/ask prices in the output

### Step 4: Check Backend Logs

When the backend server is running, watch for these log messages:

```
📈 Received 1 tick(s):
   Token: 116433415 | LTP: 70250.00
   📊 Bid: 70245.00
   📊 Ask: 70255.00
   💰 SPREAD: 10.00 (0.014%)
```

### Step 5: Check Flutter Logs

In the Flutter app debug console, look for:

```
💰 Token 116433415: LTP=70250.0, Bid=70245.0, Ask=70255.0
```

## Troubleshooting

### Issue: Both BUY and SELL show the same price

**Diagnosis:**
1. Check backend logs for packet size warnings
2. Check Flutter logs for "Bid/Ask=NULL" messages
3. Verify the spread calculation

**Common Causes:**

1. **Backend receiving small packets (8 or 28 bytes)**
   - Kite is not sending full mode data
   - Instrument may not be actively traded
   - Solution: Try NIFTY or BANKNIFTY futures (more liquid)

2. **Spread is very small**
   - For GOLD at ₹70,000, a 0.05% spread = ₹35
   - This is normal for liquid instruments
   - Check if prices differ by small amounts (₹10-50)

3. **Bid/Ask fields are null**
   - Backend is not receiving 184-byte packets
   - Flutter falls back to LTP ± 0.05%
   - Solution: Ensure backend is subscribed in FULL mode

### Issue: Test script fails

**Error: "No Kite access token found"**
- Backend server must be running
- Backend auto-login should authenticate on startup
- Check backend logs for authentication status

**Error: "MONGO_URI undefined"**
- Ensure `.env` file exists in `stocker-backend-node/`
- Check that `MONGO_URI` is set (not `MONGODB_URI`)

**Error: "instruments.csv not found"**
- Run: `node scripts/fetchInstruments.js`

### Issue: Prices not updating in Flutter app

1. Check WebSocket connection status
2. Verify instruments are subscribed
3. Check backend logs for tick reception
4. Restart Flutter app to reconnect WebSocket

## Technical Details

### Kite WebSocket Packet Formats

1. **LTP Mode (8 bytes)**:
   - Only last traded price
   - No bid/ask data

2. **Quote Mode (28-44 bytes)**:
   - OHLC data
   - No bid/ask data

3. **Full Mode (184 bytes)**:
   - OHLC data
   - Market depth (5 levels buy + 5 levels sell)
   - Bid/ask prices available

### Market Depth Structure

Starting at offset 60 (after OHLC data):

```
Offset 60-119: Buy depth (5 entries × 12 bytes)
  Each entry: 4 bytes quantity + 4 bytes price + 4 bytes orders
  
Offset 120-179: Sell depth (5 entries × 12 bytes)
  Each entry: 4 bytes quantity + 4 bytes price + 4 bytes orders
```

Best bid: Price at offset 64 (first buy entry)
Best ask: Price at offset 124 (first sell entry)

### Fallback Spread Calculation

When bid/ask data is unavailable, the app uses:
- Sell price: LTP - (LTP × 0.0005) = LTP - 0.05%
- Buy price: LTP + (LTP × 0.0005) = LTP + 0.05%

This 0.05% spread is typical for liquid instruments in Indian markets.

## Files Modified

### Backend
- `src/services/livePriceService.js`: Added bid/ask parsing
- `test/testBidAsk.js`: Test script for bid/ask reception
- `test/findGoldToken.js`: Helper to find instrument tokens
- `test/checkBidAskStatus.js`: Diagnostic tool

### Frontend
- `lib/models/watchlist_item.dart`: Added bidPrice/askPrice fields
- `lib/providers/watchlist_provider.dart`: Process bid/ask from WebSocket
- `lib/views/trade_card_view.dart`: Display bid/ask prices

## Next Steps

1. Run the diagnostic tool to verify your setup
2. Test with a liquid instrument (NIFTY/BANKNIFTY)
3. Monitor backend logs for packet sizes
4. Check Flutter logs for bid/ask reception
5. Verify prices differ by expected spread

## Support

If issues persist:
1. Share backend logs (look for packet size and bid/ask messages)
2. Share Flutter logs (look for bid/ask reception messages)
3. Verify instrument is actively traded during market hours
4. Try different instruments to isolate the issue
