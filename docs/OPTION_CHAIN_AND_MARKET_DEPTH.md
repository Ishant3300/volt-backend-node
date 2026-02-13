# Option Chain and Market Depth Features

## Overview
This document describes the newly implemented Option Chain and Market Depth features for the Stocker application.

## Backend APIs

### 1. Get Option Chain
**Endpoint:** `GET /api/kite/option-chain/:tradingSymbol`

**Description:** Fetches the complete option chain for a given trading symbol.

**Parameters:**
- `tradingSymbol` (path): Base trading symbol (e.g., "NIFTY", "BANKNIFTY")
- `expiry` (query, optional): Filter by expiry date (format: YYYY-MM-DD)

**Response:**
```json
{
  "success": true,
  "message": "Found 50 strike prices",
  "data": {
    "tradingSymbol": "NIFTY",
    "expiry": "2024-01-25",
    "chain": [
      {
        "strike": 21000,
        "CE": {
          "instrument_token": "12345",
          "tradingsymbol": "NIFTY2410021000CE",
          "last_price": 125.50,
          "strike": 21000,
          "instrument_type": "CE",
          "expiry": "2024-01-25T00:00:00.000Z"
        },
        "PE": {
          "instrument_token": "12346",
          "tradingsymbol": "NIFTY2410021000PE",
          "last_price": 85.25,
          "strike": 21000,
          "instrument_type": "PE",
          "expiry": "2024-01-25T00:00:00.000Z"
        }
      }
    ]
  }
}
```

**Example Usage:**
```bash
# Get all option chains for NIFTY
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/kite/option-chain/NIFTY

# Get option chain with expiry filter
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/api/kite/option-chain/NIFTY?expiry=2024-01-25"
```

### 2. Get Market Depth
**Endpoint:** `GET /api/kite/market-depth/:instrumentToken`

**Description:** Fetches market depth (OHLC data) for a specific instrument.

**Parameters:**
- `instrumentToken` (path): Instrument token

**Response:**
```json
{
  "success": true,
  "message": "Market depth fetched successfully",
  "data": {
    "NSE:12345": {
      "ohlc": {
        "open": 21500.00,
        "high": 21650.00,
        "low": 21450.00,
        "close": 21580.00
      },
      "last_price": 21600.00,
      "volume": 1250000
    }
  }
}
```

**Example Usage:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/kite/market-depth/12345
```

## Frontend Implementation

### 1. Trade Card Page
**File:** `stocker/lib/views/trade_card_view.dart`

**Features:**
- Displays live instrument data passed from watchlist
- Shows real-time price updates via Provider
- Displays OHLC data (Open, High, Low, Close)
- Navigation to Option Chain and Market Depth

**Usage:**
```dart
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => TradeCardPage(item: watchlistItem),
  ),
);
```

### 2. Option Chain View
**File:** `stocker/lib/views/option_chain_view.dart`

**Features:**
- Displays complete option chain with Call and Put options
- Filter by expiry (All, 7 Days, 1 Month, 3 Months)
- Search functionality to switch between instruments
- Real-time price display for each strike
- Grouped by strike price with CE/PE side by side

**Usage:**
```dart
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => OptionChainView(
      instrument: kiteInstrument,
    ),
  ),
);
```

### 3. Market Depth Sheet
**File:** `stocker/lib/views/market_depth_sheet.dart`

**Features:**
- Bottom sheet modal display
- Shows OHLC data (Open, High, Low, Close)
- Displays last traded price
- Auto-loads data on open
- Retry functionality on error

**Usage:**
```dart
showMarketDepthSheet(context, instrumentToken);
```

## Models

### OptionChainItem
**File:** `stocker/lib/models/option_chain.dart`

```dart
class OptionChainItem {
  final double strike;
  final OptionData? call;  // CE data
  final OptionData? put;   // PE data
}

class OptionData {
  final String instrumentToken;
  final String tradingSymbol;
  final double lastPrice;
  final double strike;
  final String instrumentType;
  final DateTime? expiry;
}
```

### MarketDepth
**File:** `stocker/lib/models/market_depth.dart`

```dart
class MarketDepth {
  final String instrumentToken;
  final OhlcData? ohlc;
  final double? lastPrice;
  final double? volume;
}

class OhlcData {
  final double open;
  final double high;
  final double low;
  final double close;
}
```

## Services

### KiteService
**File:** `stocker/lib/services/kite_service.dart`

**Methods:**
- `getOptionChain(String tradingSymbol, {String? expiry})` - Fetch option chain
- `getMarketDepth(String instrumentToken)` - Fetch market depth
- `searchInstruments(String query, {String? exchange, int limit})` - Search instruments

## Testing

### Run Backend Tests
```bash
cd stocker-backend-node
node test/testNewAPIs.js
```

The test file includes:
1. User authentication
2. Instrument search
3. Watchlist retrieval
4. Kite authentication status
5. Option chain fetching (with and without expiry filter)
6. Market depth fetching

### Manual Testing Checklist

#### Option Chain
- [ ] Open watchlist and tap on an instrument
- [ ] Tap "Option Chain" link
- [ ] Verify option chain loads with CE/PE data
- [ ] Test "All" filter
- [ ] Test "7 Days" filter
- [ ] Test "1 Month" filter
- [ ] Test "3 Months" filter
- [ ] Search for different instrument (e.g., "BANKNIFTY")
- [ ] Verify search results update option chain

#### Market Depth
- [ ] Open watchlist and tap on an instrument
- [ ] Tap "Market Depth" link
- [ ] Verify bottom sheet opens
- [ ] Verify OHLC data displays correctly
- [ ] Verify last price displays
- [ ] Test close button
- [ ] Test with different instruments

#### Trade Card
- [ ] Verify live price updates in header
- [ ] Verify OHLC stats update in real-time
- [ ] Verify change percentage displays correctly
- [ ] Test navigation back to watchlist

## Data Flow

### Option Chain Flow
```
User taps instrument → TradeCardPage opens → User taps "Option Chain"
→ OptionChainView opens → Calls KiteService.getOptionChain()
→ Backend fetches from MongoDB → Groups by strike → Returns to UI
→ User can filter by expiry or search new instrument
```

### Market Depth Flow
```
User taps "Market Depth" → showMarketDepthSheet() called
→ MarketDepthSheet widget created → Calls KiteService.getMarketDepth()
→ Backend calls Kite API → Returns OHLC data → Displays in bottom sheet
```

### Live Price Updates
```
WebSocket receives tick → LivePriceService broadcasts
→ WatchlistProvider updates item → Consumer rebuilds UI
→ TradeCardPage shows updated prices in real-time
```

## Error Handling

### Backend
- Returns 404 if instrument not found
- Returns 500 on API errors
- Logs all errors with context

### Frontend
- Shows loading spinner while fetching
- Displays error message with retry button
- Gracefully handles missing data
- Falls back to default values

## Performance Considerations

1. **Option Chain Caching**: Consider implementing Redis cache for frequently accessed option chains
2. **Pagination**: For large option chains, implement pagination
3. **WebSocket Updates**: Option chain prices could be updated via WebSocket for real-time data
4. **Debouncing**: Search input is debounced to avoid excessive API calls

## Future Enhancements

1. **Greeks Display**: Add Delta, Gamma, Theta, Vega for options
2. **Open Interest**: Display OI and OI change
3. **Volume Analysis**: Show volume data for each strike
4. **Chart Integration**: Add mini charts for option price movement
5. **Alerts**: Set price alerts for specific strikes
6. **Comparison**: Compare multiple strikes side by side
7. **Export**: Export option chain data to CSV/Excel

## Troubleshooting

### Option Chain Not Loading
1. Check if instruments are fetched: `GET /api/kite/instruments/info`
2. Verify trading symbol format
3. Check backend logs for errors
4. Ensure Kite authentication is valid

### Market Depth Shows No Data
1. Verify instrument token is correct
2. Check if Kite API is accessible
3. Ensure access token is valid
4. Check network connectivity

### Search Not Working
1. Verify search query format
2. Check if instruments database is populated
3. Review backend search logs
4. Test with known instrument names

## API Rate Limits

- Kite API has rate limits (3 requests/second)
- Implement request queuing if needed
- Cache frequently accessed data
- Use WebSocket for real-time updates instead of polling

## Security Notes

- All endpoints require authentication
- Token validation on every request
- No sensitive data in logs
- Secure storage of access tokens
