# Kite API Testing Guide

## Prerequisites
1. Make sure your backend server is running
2. Ensure MongoDB is connected
3. Have your Kite API credentials in `.env` file

## Step-by-Step Testing

### Step 1: Get Login URL and Authenticate

Run the test script to get the Kite login URL:

```bash
node test/testKite.js
```

This will output a login URL like:
```
https://kite.zerodha.com/connect/login?api_key=xxx&v=3
```

### Step 2: Login to Kite

1. Copy the login URL and open it in your browser
2. Login with your Zerodha credentials
3. After successful login, you'll be redirected to a URL like:
   ```
   http://localhost:3000/api/kite/callback?request_token=xxx&action=login&status=success
   ```
4. Copy the `request_token` value from the URL

### Step 3: Generate Session

Run the session generator with your request token:

```bash
node test/generateSession.js <your_request_token>
```

Example:
```bash
node test/generateSession.js H06I6Ydv95y23D2Dp7pwzjxzjxjxjxjx
```

This will:
- Generate an access token
- Save it to the database
- Display your Kite profile information

### Step 4: Run Full Tests

Now run the complete test suite:

```bash
node test/testKite.js
```

This will:
1. ✓ Verify access token exists
2. ✓ Download FUT/CE/PE instruments from NFO exchange
3. ✓ Search for NIFTY instruments
4. ✓ Get LTP (Last Traded Price) for instruments
5. ✓ Get your Kite profile

## Expected Output

```
=== Testing Kite Service ===

Step 1: Get Login URL
Login URL: https://kite.zerodha.com/connect/login?api_key=xxx&v=3

✓ Valid access token found: xxxxxxxxxxxxx...

Step 2: Downloading FUT/CE/PE instruments from NSE...
Download Result: {
  "success": true,
  "message": "Downloaded 1500 FUT/CE/PE instruments from NFO",
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

Step 3: Searching for NIFTY instruments...
Found 150 instruments
First 3 results:
1. NIFTY24FEB24000FUT (FUT) - Token: 256265
2. NIFTY24FEB24000CE (CE) - Token: 256266
3. NIFTY24FEB24000PE (PE) - Token: 256267

Step 4: Getting LTP for first instrument...
LTP Result: {
  "NFO:NIFTY24FEB24000FUT": {
    "instrument_token": 256265,
    "last_price": 24050.50
  }
}

Step 5: Getting Kite profile...
Profile: {
  "user_id": "XX1234",
  "user_name": "Your Name",
  "email": "your@email.com",
  "broker": "ZERODHA"
}

✓ All tests completed successfully!
```

## Troubleshooting

### Error: "No valid access token found"
- Complete Step 1-3 to authenticate first
- Access tokens expire after 24 hours, re-authenticate if needed

### Error: "Failed to download instruments"
- Check if you have an active Kite subscription
- Verify your API credentials in `.env`
- Ensure you're using NFO exchange for derivatives

### Error: "Connection refused"
- Make sure MongoDB is running
- Check your MONGO_URI in `.env`

## Notes

- Access tokens expire after 24 hours
- You need to re-authenticate daily
- Only FUT, CE, and PE instruments are downloaded
- Use NFO exchange for NSE derivatives
- Use BFO exchange for BSE derivatives
- Use MCX exchange for commodity derivatives
