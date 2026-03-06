# Restart Backend Server

I've added logging to track order execution. Please restart your backend server:

## Steps:

1. Stop the current backend server (Ctrl+C in the terminal where it's running)

2. Start it again:
```bash
cd stocker-backend-node
node src/index.js
```

3. Watch for these log messages:

**On startup:**
- `✅ [PriceQueue] Queue and worker initialised` - Confirms worker is running
- `🚀 Redis Order Book + BullMQ Price Queue active` - Confirms system is ready

**When price updates arrive:**
- `📈 Received X tick(s)` - From livePriceService (confirms prices arriving)
- `🔄 [PriceQueue] Processing price update: Token 291849 @ XXXXX` - Worker is processing
- `ℹ️  No matching orders` OR `⚡ X order(s) to execute` - Shows matching result
- `✅ [PriceQueue] Executed BUY LIMIT...` - Order executed successfully
- `📤 [WS] Sent 'trade_executed' to user...` - WebSocket event sent to Flutter

## What to look for:

If you see `📈 Received X tick(s)` but NO `🔄 [PriceQueue] Processing` messages:
- **Problem:** Worker is not running or not picking up jobs
- **Fix:** Check if Redis is running, restart backend

If you see `🔄 Processing` but `ℹ️  No matching orders`:
- **Problem:** Price hasn't hit the limit yet (this is normal)
- **Wait:** Order will execute when price drops to your limit

If you see `⚡ X order(s) to execute` but NO `✅ Executed`:
- **Problem:** Execution is failing (check error logs)
- **Look for:** `❌ [PriceQueue] Execution error` messages

If you see `✅ Executed` but NO `📤 Sent 'trade_executed'`:
- **Problem:** WebSocket broadcast failing
- **Check:** Is Flutter app connected? Look for authenticated userId in logs

## After restart:

Place a new test order and watch the logs in real-time to see exactly where it's failing.
