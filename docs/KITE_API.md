# Kite API Documentation

## Authentication Flow

### 1. Get Login URL
Get the Kite login URL to authenticate.

**Endpoint:** `GET /api/kite/login-url`

**Response:**
```json
{
  "success": true,
  "message": "Login URL generated successfully",
  "data": {
    "login_url": "https://kite.zerodha.com/connect/login?api_key=xxx&v=3"
  }
}
```

### 2. Handle Callback
After user logs in to Kite, they will be redirected to this endpoint with a request token.

**Endpoint:** `GET /api/kite/callback?request_token=xxx`

**Response:**
```json
{
  "success": true,
  "message": "Session generated successfully",
  "data": {
    "access_token": "xxx",
    "user_id": "xxx",
    "user_name": "xxx"
  }
}
```

## Instruments

### 3. Download Instruments
Download and save FUT, CE, and PE instruments from Kite to database (Admin only).

**Endpoint:** `GET /api/kite/download-instruments?exchange=NSE`

**Headers:**
```
Authorization: Bearer {admin_token}
```

**Query Parameters:**
- `exchange` (optional): Exchange name (NSE, BSE, MCX, etc.). Default: NSE

**Note:** Only FUT (Futures), CE (Call Options), and PE (Put Options) instruments are downloaded.

**Response:**
```json
{
  "success": true,
  "message": "Downloaded 1500 FUT/CE/PE instruments from NSE",
  "data": {
    "total": 1500,
    "inserted": 1200,
    "updated": 300,
    "breakdown": {
      "FUT": 500,
      "CE": 500,
      "PE": 500
    }
  }
}
```

### 4. Search Instruments
Search for FUT, CE, and PE instruments by symbol or name (Admin only).

**Endpoint:** `GET /api/kite/search?query=NIFTY&exchange=NSE&instrument_type=FUT`

**Headers:**
```
Authorization: Bearer {admin_token}
```

**Query Parameters:**
- `query` (required): Search query
- `exchange` (optional): Filter by exchange
- `instrument_type` (optional): Filter by instrument type (FUT, CE, or PE)

**Response:**
```json
{
  "success": true,
  "message": "Instruments found",
  "data": [
    {
      "id": "xxx",
      "instrument_token": "256265",
      "exchange_token": "1001",
      "trading_symbol": "NIFTY24FEB24000FUT",
      "name": "NIFTY",
      "last_price": 24000.50,
      "expiry": "2024-02-29",
      "strike": 0,
      "exchange": "NSE",
      "segment": "NFO-FUT",
      "instrument_type": "FUT",
      "lot_size": 50
    }
  ]
}
```

### 5. Get Instrument by Token
Get instrument details by instrument token (Admin only).

**Endpoint:** `GET /api/kite/instrument/:token`

**Headers:**
```
Authorization: Bearer {admin_token}
```

**Response:**
```json
{
  "success": true,
  "message": "Instrument found",
  "data": {
    "id": "xxx",
    "instrument_token": "738561",
    "trading_symbol": "RELIANCE",
    "name": "RELIANCE INDUSTRIES LTD",
    "last_price": 2450.50
  }
}
```

## Market Data

### 6. Get Quote
Get full market quote for instruments (Admin only).

**Endpoint:** `POST /api/kite/quote`

**Headers:**
```
Authorization: Bearer {admin_token}
Content-Type: application/json
```

**Request Body:**
```json
{
  "instruments": ["NSE:RELIANCE", "NSE:INFY"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Quotes fetched successfully",
  "data": {
    "NSE:RELIANCE": {
      "instrument_token": 738561,
      "last_price": 2450.50,
      "ohlc": {
        "open": 2440.00,
        "high": 2460.00,
        "low": 2435.00,
        "close": 2445.00
      },
      "volume": 1234567
    }
  }
}
```

### 7. Get LTP (Last Traded Price)
Get last traded price for instruments (Admin only).

**Endpoint:** `POST /api/kite/ltp`

**Headers:**
```
Authorization: Bearer {admin_token}
Content-Type: application/json
```

**Request Body:**
```json
{
  "instruments": ["NSE:RELIANCE", "NSE:INFY"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "LTP fetched successfully",
  "data": {
    "NSE:RELIANCE": {
      "instrument_token": 738561,
      "last_price": 2450.50
    },
    "NSE:INFY": {
      "instrument_token": 408065,
      "last_price": 1450.75
    }
  }
}
```

### 8. Get OHLC
Get OHLC (Open, High, Low, Close) data for instruments (Admin only).

**Endpoint:** `POST /api/kite/ohlc`

**Headers:**
```
Authorization: Bearer {admin_token}
Content-Type: application/json
```

**Request Body:**
```json
{
  "instruments": ["NSE:RELIANCE", "NSE:INFY"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "OHLC fetched successfully",
  "data": {
    "NSE:RELIANCE": {
      "instrument_token": 738561,
      "last_price": 2450.50,
      "ohlc": {
        "open": 2440.00,
        "high": 2460.00,
        "low": 2435.00,
        "close": 2445.00
      }
    }
  }
}
```

### 9. Get Profile
Get Kite user profile (Admin only).

**Endpoint:** `GET /api/kite/profile`

**Headers:**
```
Authorization: Bearer {admin_token}
```

**Response:**
```json
{
  "success": true,
  "message": "Profile fetched successfully",
  "data": {
    "user_id": "xxx",
    "user_name": "xxx",
    "email": "xxx@example.com",
    "broker": "ZERODHA"
  }
}
```

## cURL Examples

### Download Instruments
```bash
curl -X GET "http://localhost:3000/api/kite/download-instruments?exchange=NSE" \
  -H "Authorization: Bearer {admin_token}"
```

### Search Instruments
```bash
curl -X GET "http://localhost:3000/api/kite/search?query=NIFTY&instrument_type=FUT" \
  -H "Authorization: Bearer {admin_token}"
```

### Get LTP
```bash
curl -X POST "http://localhost:3000/api/kite/ltp" \
  -H "Authorization: Bearer {admin_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "instruments": ["NSE:RELIANCE", "NSE:INFY"]
  }'
```

## Notes

1. Before using any Kite API, you must first authenticate by visiting the login URL and completing the OAuth flow.
2. Access tokens expire after 24 hours. You'll need to re-authenticate after expiry.
3. All market data endpoints require admin authentication.
4. Instrument tokens are unique identifiers for each tradable instrument.
5. The service automatically saves fetched data to the database for caching.
6. **Only FUT (Futures), CE (Call Options), and PE (Put Options) instruments are downloaded and searchable.**
7. Supported exchanges: NSE, BSE, MCX (for derivatives trading).
