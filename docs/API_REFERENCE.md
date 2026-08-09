# Stocker Backend — Complete API Reference

> Base URL: `https://apexlive-api.mynpe.in` (Production) | `http://localhost:3000` (Dev)
>
> All endpoints return: `{ "success": true/false, "message": "...", "data": {...} }`
>
> Auth: `Authorization: Bearer <jwt_token>` unless marked PUBLIC

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Admin — User Management](#2-admin--user-management)
3. [Admin — Grouped Quantities](#3-admin--grouped-quantities)
4. [Admin — Script Quantities](#4-admin--script-quantities)
6. [Admin — Brokerage Settings](#6-admin--brokerage-settings)
7. [Admin — Announcements](#7-admin--announcements)
8. [Admin — Fresh Stoploss Limits](#8-admin--fresh-stoploss-limits)
9. [Admin — TOTP Management](#9-admin--totp-management)
10. [Admin — Instrument Management](#10-admin--instrument-management)
11. [Admin — Settlement & Prices](#11-admin--settlement--prices)
12. [Master Flow — Child Masters](#12-master-flow--child-masters)
13. [Master Flow — Users](#13-master-flow--users)
14. [Master Flow — Trades & Positions](#14-master-flow--trades--positions)
15. [Master Flow — Reports](#15-master-flow--reports)
16. [Masters (Admin CRUD)](#16-masters-admin-crud)
17. [Trading](#17-trading)
18. [Kite Connect Integration](#18-kite-connect-integration)
19. [Watchlist](#19-watchlist)
20. [User Routes](#20-user-routes)
21. [Server Management](#21-server-management)
22. [Messages](#22-messages)
23. [Misc / Inline Routes](#23-misc--inline-routes)
24. [WebSocket](#24-websocket)

---

## 1. Authentication

All login endpoints are rate-limited: 10 attempts per 15 min per IP.

### POST `/api/auth/login`
Universal login — detects role from username automatically. If admin has TOTP enabled, requires a two-step flow using the same endpoint.

**Step 1 — Initial login (no TOTP code):**
```json
// Request
{ "username": "adminuser", "password": "Pass@123" }

// Response (TOTP required)
{ "success": true, "message": "TOTP verification required", "data": { "requires_totp": true, "totp_configured": true, "role": "ADMIN" } }
```

**Step 2 — Re-submit with TOTP code (same endpoint, same credentials + totp_code):**
```json
// Request
{ "username": "adminuser", "password": "Pass@123", "totp_code": "482937" }

// Response (success)
{ "success": true, "message": "Login successful", "data": { "token": "eyJhbGciOiJI...", "role": "ADMIN", "admin": { "id": "6a5d...", "username": "adminuser" } } }
```

> **Notes:**
> - Field name for the code is `totp_code`
> - Username + password ARE required again in the second call (no interim session token)
> - If TOTP is not enabled, the first call itself returns the token directly
> - Works the same on `/api/auth/admin/login`

**Normal flow (non-TOTP or user/master login):**
```json
// Request
{ "username": "chitra18", "password": "Pass@123" }

// Response
{ "success": true, "message": "Login successful", "data": { "token": "eyJhbGciOiJI...", "role": "user", "user": { "id": "6a5d...", "username": "chitra18", "name": "Chitra" } } }
```

### POST `/api/auth/user/login`
Login specifically as a user.

### POST `/api/auth/admin/login`
Login specifically as an admin.

### POST `/api/auth/master/login`
Login specifically as a master.

### POST `/api/auth/user/logout`
Logout user. Clears active_token. Auth: User.

### POST `/api/auth/admin/logout`
Logout admin. Auth: Admin.

### POST `/api/auth/master/logout`
Logout master. Auth: Master.

### POST `/api/auth/change-password`
Change password for any authenticated role.

```json
// Request
{ "current_password": "Old@123", "new_password": "New@456" }

// Response
{ "success": true, "message": "Password changed successfully" }
```

### GET `/api/auth/notification-settings`
Get notification preferences for the authenticated user/admin/master.

### PUT `/api/auth/notification-settings`
Update notification preferences.

```json
// Request
{ "market_order": true, "pending_order": true, "trading_sound": false }
```

### POST `/api/auth/fcm-token`
Register a Firebase Cloud Messaging token for push notifications.

```json
// Request
{ "token": "fMhJ7xR3Qc..." }
```

### DELETE `/api/auth/fcm-token`
Remove an FCM token (on logout or token refresh).

```json
// Request
{ "token": "fMhJ7xR3Qc..." }
```

### DELETE `/api/auth/account`
Delete own account. Auth: Any role.

---

## 2. Admin — User Management

Auth: Admin or Master (as noted).

### POST `/api/admin/users`
Create a new user under the authenticated master. Auth: Master.

```json
// Request
{ "name": "Chitra", "username": "chitra18", "password": "Pass@123", "credits": 50000, "server_id": "69ddd...", "exchanges_allowed": [{ "exchange_name": "NFO-FUT", "turnover": false, "lot": true, "group_name": "Gold" }] }

// Response
{ "success": true, "message": "User created", "data": { "id": "6a5d...", "username": "chitra18", "credits": 50000 } }
```

### GET `/api/admin/users`
List all users. Supports `?master_id=&limit=&page=&search=`. Auth: Admin/Master.

### GET `/api/admin/users/:id`
Get a single user by ID. Auth: Admin/Master.

### PUT `/api/admin/users/:id`
Update user details (name, exchanges, permissions, etc). Auth: Admin/Master.

### DELETE `/api/admin/users/:id`
Soft-delete a user. Auth: Master.

### POST `/api/admin/users/:id/credit`
Credit a user's balance. Auth: Admin.

```json
// Request
{ "amount": 10000, "note": "Weekly credit" }

// Response
{ "success": true, "message": "Credited 10000 to user", "data": { "new_balance": 60000 } }
```

### POST `/api/admin/users/:id/debit`
Debit from a user's balance. Auth: Admin.

```json
// Request
{ "amount": 5000, "note": "Penalty deduction" }
```

### Trade Wallet — Funding (admin grant/remove)

Per-category wallet pools (`NSE`, `MCX`, `GLOBAL`). Admin is the root of funds: assign grants (credit only, no debit source) and withdraw removes funds. Auth: Admin. `target_type` is `User` or `Master`.

### POST `/api/admin/wallet/assign`
Grant funds to any user/master's category wallet.

```json
// Request
{ "target_id": "6a5d...", "target_type": "Master", "category": "MCX", "amount": 100000 }
// Response
{ "success": true, "message": "Assigned ₹100000 to MCX wallet", "data": { "owner_type": "Master", "owner_id": "6a5d...", "wallet": { "NSE": 0, "MCX": 100000, "GLOBAL": 0 } } }
```

### POST `/api/admin/wallet/withdraw`
Remove funds from any user/master's category wallet. Rejected 400 if the target pool cannot cover it. Body shape identical to assign.

### GET `/api/admin/wallet?owner_id=&owner_type=`
Read per-category available balances for any owner.

### GET `/api/admin/wallet/reconcile?owner_id=&owner_type=`
Drift audit: recomputes blocked margin from the owner's open positions and reports per-category `{ available, blocked, total }` (`available + blocked` reconstructs the funded amount).

```json
// Response
{ "success": true, "data": { "ownerModel": "User", "ownerId": "6a5d...", "categories": { "NSE": { "available": 75000, "blocked": 25000, "total": 100000 }, "MCX": { "available": 0, "blocked": 0, "total": 0 }, "GLOBAL": { "available": 0, "blocked": 0, "total": 0 } } } }
```

---

## 3. Admin — Grouped Quantities

Lot group definitions that control max trade quantity per instrument group. Auth: Admin (write), Admin/Master (read).

### POST `/api/admin/grouped-quantities`
Create a single grouped quantity rule.

```json
// Request
{ "exchange_name": "NFO-FUT", "lot_name": "Gold", "raw_name": "NIFTY", "max_quantity": 1800 }
```

### POST `/api/admin/grouped-quantities/bulk-create`
Bulk create grouped quantity rules.

```json
// Request
{ "items": [{ "exchange_name": "NFO-FUT", "lot_name": "A", "raw_name": "NIFTY", "max_quantity": 1800 }] }
```

### GET `/api/admin/grouped-quantities`
List all grouped quantities.

### GET `/api/admin/grouped-quantities/:id`
Get single grouped quantity by ID.

### GET `/api/admin/grouped-quantities/exchange/:exchange_name/lot-names`
Get lot names available for a given exchange.

### GET `/api/admin/grouped-quantities/unique-raw-names/:segment`
Get unique instrument raw names in a segment.

### GET `/api/admin/grouped-quantities/group/:exchange_name/:lot_name`
Get instruments in a specific lot group.

### PUT `/api/admin/grouped-quantities/:id`
Update a grouped quantity rule.

### DELETE `/api/admin/grouped-quantities/:id`
Delete a grouped quantity rule.

---

## 4. Admin — Script Quantities

Per-instrument quantity limits for users. Auth: Admin/Master.

### POST `/api/admin/script-quantities`
Create a script quantity limit.

```json
// Request
{ "exchange_name": "NFO-FUT", "raw_name": "BANKNIFTY", "max_quantity": 900, "owner_id": "6a5d...", "owner_type": "User" }
```

### POST `/api/admin/script-quantities/bulk-create`
Bulk create script quantity rules.

### GET `/api/admin/script-quantities`
List all script quantities.

### GET `/api/admin/script-quantities/exchange/:exchange_name`
Get script quantities for a specific exchange.

### GET `/api/admin/script-quantities/:id`
Get single script quantity by ID.

### PUT `/api/admin/script-quantities/:id`
Update a script quantity rule.

### DELETE `/api/admin/script-quantities/:id`
Delete a script quantity rule.

---

## 6. Admin — Brokerage Settings

Per-instrument/exchange brokerage rules. Auth: Admin/Master.

### POST `/api/admin/brokerage-settings`
Create a brokerage setting.

```json
// Request
{ "exchange_name": "NFO-FUT", "script_name": "NIFTY", "type": "LOT WISE", "brk_value": 20 }
```

### POST `/api/admin/brokerage-settings/bulk-create`
Bulk create brokerage settings.

### GET `/api/admin/brokerage-settings`
List all brokerage settings.

### GET `/api/admin/brokerage-settings/exchange/:exchange_name`
Get brokerage settings for a specific exchange.

### GET `/api/admin/brokerage-settings/:id`
Get single brokerage setting by ID.

### PUT `/api/admin/brokerage-settings/bulk-update`
Bulk update multiple brokerage settings.

```json
// Request
{ "ids": ["id1", "id2"], "brk_value": 25, "type": "LOT WISE" }
```

### PUT `/api/admin/brokerage-settings/:id`
Update a single brokerage setting.

### DELETE `/api/admin/brokerage-settings/:id`
Delete a brokerage setting.

---

## 7. Admin — Announcements

System-wide announcements shown to all users. Auth: Admin (write), Any (read).

### POST `/api/admin/announcements`
Set an active announcement.

```json
// Request
{ "title": "Market Holiday", "message": "No trading on Monday 28th July", "type": "info" }
```

### DELETE `/api/admin/announcements`
Clear the active announcement.

### GET `/api/admin/announcements/active`
Get the currently active announcement. Auth: Any.

```json
// Response
{ "success": true, "data": { "title": "Market Holiday", "message": "No trading on Monday 28th July", "type": "info" } }
```

---

## 8. Admin — Fresh Stoploss Limits

Time and price offset restrictions for closing trades. Auth: Admin.

### GET `/api/admin/fresh-stoploss-limits`
List all fresh stoploss limits.

### POST `/api/admin/fresh-stoploss-limits/bulk-create`
Bulk create fresh stoploss limits.

```json
// Request
{ "items": [{ "exchange_name": "NFO-FUT", "raw_name": "NIFTY", "time_minutes": 5, "price_offset": 10 }] }
```

### PUT `/api/admin/fresh-stoploss-limits/bulk-update`
Bulk update fresh stoploss limits.

### PUT `/api/admin/fresh-stoploss-limits/:id`
Update a single fresh stoploss limit.

### DELETE `/api/admin/fresh-stoploss-limits/:id`
Delete a fresh stoploss limit.

---

## 9. Admin — TOTP Management

Two-factor authentication setup for admin accounts. Auth: Admin.

### GET `/api/admin/totp/status`
Check if TOTP is enabled for the admin.

### POST `/api/admin/totp/generate`
Generate a new TOTP secret and QR code.

```json
// Response
{ "success": true, "data": { "qr_data_url": "data:image/png;base64,...", "secret": "JBSWY3DPEHPK3PXP" } }
```

### POST `/api/admin/totp/verify-setup`
Verify a TOTP code to activate 2FA.

```json
// Request
{ "token": "123456" }
```

### POST `/api/admin/totp/toggle`
Enable or disable TOTP.

```json
// Request
{ "enabled": true }
```

### POST `/api/admin/totp/reset`
Reset TOTP (removes secret, requires re-setup).

---

## 10. Admin — Instrument Management

Manage tradeable instruments (enable/disable/delete/restore). Auth: Admin.

### GET `/api/admin/instruments/segments`
Get all unique instrument segments for filter dropdowns.

```json
// Response
{ "success": true, "data": ["BFO-FUT", "BFO-OPT", "MCX-FUT", "MCX-OPT", "NFO-FUT", "NFO-OPT"] }
```

### GET `/api/admin/instruments`
List instruments with pagination and filters.
Query: `?segment=NFO-FUT&search=NIFTY&enabled=true&page=1&limit=50`

```json
// Response
{ "success": true, "data": [{ "instrument_token": "256265", "tradingsymbol": "NIFTY26JULFUT", "raw_name": "NIFTY", "segment": "NFO-FUT", "lot_size": 25, "enabled": true }], "pagination": { "page": 1, "limit": 50, "total": 1200, "pages": 24 } }
```

### PUT `/api/admin/instruments/:id/toggle`
Enable or disable a single instrument.

```json
// Request
{ "enabled": false }
```

### PUT `/api/admin/instruments/bulk-toggle`
Enable/disable multiple instruments at once.

```json
// Request
{ "ids": ["id1", "id2", "id3"], "enabled": true }
```

### DELETE `/api/admin/instruments/:id`
Soft-delete an instrument (deactivates it).

### PUT `/api/admin/instruments/:id/restore`
Restore a soft-deleted instrument.

---

## 11. Admin — Settlement & Prices

Manual settlement and price refresh triggers. Auth: Admin.

### POST `/api/admin/settlement/start`
Trigger weekly settlement for all users.

```json
// Response
{ "success": true, "message": "Settlement started", "data": { "run_id": "6a66..." } }
```

### GET `/api/admin/settlement/status`
Check the status of the current/last settlement run.

### POST `/api/admin/bhavcopy/fetch`
Trigger bhavcopy settlement price fetch manually.

```json
// Request (optional)
{ "date": "2026-07-25" }

// Response
{ "success": true, "message": "Bhavcopy fetch completed", "data": { "nse": 150, "mcx": 45, "total": 195 } }
```

### POST `/api/admin/refresh-close-prices`
Refresh close prices from live data.

### POST `/api/admin/refresh-settlement-prices`
Refresh settlement prices via OHLC API.

---

## 12. Master Flow — Child Masters

Manage sub-masters within the hierarchy. Auth: Admin/Master.

### POST `/api/master/masters`
Create a child master under the authenticated master.

```json
// Request
{ "name": "SubBroker1", "username": "sub1", "password": "Pass@123", "credits": 100000 }
```

### GET `/api/master/masters`
List all child masters. Query: `?parent_id=&limit=100`

### GET `/api/master/masters/:id`
Get a child master by ID.

### PUT `/api/master/masters/:id/permissions`
Update child master permissions (close_only, bet, margin_square, fresh_stoploss, etc).

```json
// Request
{ "close_only": false, "bet": true, "margin_square": true, "fresh_stoploss": true }
```

### PUT `/api/master/masters/:id/details`
Update child master name, note, exchanges, sharing percentages.

### POST `/api/master/masters/:id/credit`
Credit a child master's balance.

```json
// Request
{ "amount": 50000, "note": "Weekly allocation" }
```

### POST `/api/master/masters/:id/debit`
Debit from a child master's balance.

### GET `/api/master/masters/:id/position`
Get aggregated positions for a child master's users.

### POST `/api/master/masters/:id/messages`
Send a message to a child master.

### DELETE `/api/master/masters/:id`
Soft-delete a child master.

---

## 13. Master Flow — Users

Manage users within the master's hierarchy. Auth: Admin/Master.

### POST `/api/master/users`
Create a user under the authenticated master.

### GET `/api/master/users`
List all users under this master. Query: `?limit=100&search=`

### GET `/api/master/users/:id`
Get user by ID.

### PUT `/api/master/users/:id/details`
Update user details (name, exchanges, permissions, etc).

```json
// Request
{ "active_status": true, "close_only": false, "bet": true, "margin_square_off": true }
```

### PUT `/api/master/users/:id`
Full user update (same as details).

### PUT `/api/master/users/:id/intraday-squareoff`
Update intraday square-off settings for user.

```json
// Request
{ "intraday_squareoff": [{ "exchange_name": "NFO-FUT", "enabled": true }] }
```

### PUT `/api/master/users/:id/margin-squareoff-percentage`
Set margin square-off trigger percentage.

```json
// Request
{ "margin_square_off_percentage": 80 }
```

### POST `/api/master/users/:id/credit`
Credit a user's balance.

### POST `/api/master/users/:id/debit`
Debit from a user's balance.

### GET `/api/master/users/:id/position`
Get positions for a specific user.

### POST `/api/master/users/:id/messages`
Send a message to a user.

### DELETE `/api/master/users/:id`
Soft-delete a user.

### Trade Wallet — Funding (master ↔ direct child)

Per-category wallet pools (`NSE`, `MCX`, `GLOBAL`). A master funds/withdraws only a **direct child** it owns (403 otherwise); the master's own same-category pool is debited on assign and credited on withdraw (a transfer). Auth: Admin/Master.

### POST `/api/master/wallet/assign`
Assign (fund) a direct child's category wallet from the master's own pool. Rejected 400 if the master's pool cannot cover it.

```json
// Request
{ "target_id": "6a5d...", "target_type": "User", "category": "NSE", "amount": 25000 }
// Response
{ "success": true, "message": "Assigned ₹25000 to NSE wallet", "data": { "owner_type": "User", "owner_id": "6a5d...", "wallet": { "NSE": 25000, "MCX": 0, "GLOBAL": 0 } } }
```

### POST `/api/master/wallet/withdraw`
Withdraw from a direct child's category wallet back to the master's pool. Rejected 400 if the child's pool cannot cover it. Body shape identical to assign.

### GET `/api/master/wallet?owner_id=&owner_type=`
Read per-category available balances. A master may read its own wallet or a direct child's (403 otherwise).

```json
// Response
{ "success": true, "data": { "owner_type": "User", "owner_id": "6a5d...", "wallet": { "NSE": 25000, "MCX": 0, "GLOBAL": 0 } } }
```

### GET `/api/master/username/generate`
Automatically generate a unique 6-digit username and reserve it in cache for 5 minutes. Auth: Admin/Master.

```json
// Response
{ "success": true, "data": { "username": "394821" } }
```

### POST `/api/master/username/release`
Release a generated username if the master/user creation flow is aborted. Auth: Admin/Master.

```json
// Request
{ "username": "394821" }

// Response
{ "success": true, "message": "Username 394821 released successfully" }
```

---

## 14. Master Flow — Trades & Positions

View trades and real-time positions across the hierarchy. Auth: Admin/Master.

### GET `/api/master/trades`
Get all trades in the master's hierarchy. Filters out carry_forward and margin_square_off trades.
Query: `?user_id=&master_id=&page=1&limit=50&status=completed&exchange=NFO`

```json
// Response
{ "success": true, "data": { "trades": [{ "id": "6a66...", "tradingsymbol": "NIFTY26JULFUT", "transaction_type": "BUY", "quantity": 25, "price": 23500, "status": "completed", "pnl": 1250 }], "total": 42 } }
```

### GET `/api/master/transactions`
Get credit/debit transaction history for the hierarchy.

### GET `/api/master/positions/aggregated`
Aggregated open positions across all child users (grouped by instrument).

### GET `/api/master/positions/user-metrics`
Full 6-metric breakdown per child user (realised P&L, floating, margin, equity, free margin, credit).

### GET `/api/master/positions/aggregated/:instrumentToken`
Per-user breakdown for a specific instrument.

### GET `/api/master/positions/admin-master-metrics`
Admin view: all masters with their users' positions for live P&L dashboard.

### GET `/api/master/positions/bulk-equity`
Bulk computed equity for user management list view.

### GET `/api/master/positions/live-metrics`
Live metrics from metricsEngine cache. Query: `?user_id=` or `?master_id=`

```json
// Response
{ "success": true, "data": [{ "user_id": "6a5d...", "credit": 50000, "realised_pnl": -1200, "position_pnl": 3500, "m2m_pnl": 2300, "margin_used": 15000, "equity": 52300, "free_margin": 37300, "positions": [...] }] }
```

### GET `/api/master/sharing-details`
Get P&L/brokerage sharing percentages for a master's children.

### GET `/api/master/login-history`
Login history for the hierarchy. Query: `?search=&page=1&limit=50`

---

## 15. Master Flow — Reports

PDF report data and summaries. Auth: Admin/Master.

### GET `/api/master/pnl-summary`
P&L summary — master sees per-user, admin sees per-master.

### GET `/api/master/weekly-admin-report`
Weekly admin report with P&L + brokerage per user/master.

### GET `/api/master/settlement-report`
Settlement report: per-user P&L + brokerage for a settlement date.

---

## 16. Masters (Admin CRUD)

Manage top-level masters. Auth: Admin/Master.

### POST `/api/masters`
Create a new master.

```json
// Request
{ "name": "IshantM", "username": "ishantmaster", "password": "Pass@123", "credits": 500000 }
```

### GET `/api/masters`
List all masters.

### GET `/api/masters/:id`
Get master by ID.

### PUT `/api/masters/:id`
Update master.

### DELETE `/api/masters/:id`
Soft-delete master.

### PUT `/api/masters/:id/status`
Update master active_status.

```json
// Request
{ "active_status": true }
```

### PUT `/api/masters/:id/permissions`
Update master permissions.

### PUT `/api/masters/:id/details`
Update master name/note/exchanges.

### PUT `/api/masters/:id/intraday-squareoff`
Update master intraday squareoff settings.

### PUT `/api/masters/:id/margin-squareoff-percentage`
Update master margin squareoff percentage.

### POST `/api/masters/:id/credit`
Credit master's balance.

### POST `/api/masters/:id/debit`
Debit from master's balance.

### GET `/api/masters/:id/position`
Get positions for master's hierarchy.

### POST `/api/masters/:id/messages`
Send message to master.

### GET `/api/masters/:id/account-limit`
Get account creation limits for a master.

### PUT `/api/masters/:id/account-limit`
Set account creation limits.

```json
// Request
{ "enabled": true, "max_masters": 5, "max_users": 50 }
```

---

## 17. Trading

Core trade execution and position management. Auth: Any authenticated role.

### POST `/api/trade`
Place a new trade (market or limit order).

```json
// Request
{ "instrument_token": "256265", "tradingsymbol": "NIFTY26JULFUT", "exchange": "NFO", "transaction_type": "BUY", "quantity": 25, "price": 23500, "order_type": "MARKET", "segment": "NFO-FUT" }

// Response
{ "success": true, "message": "Trade executed", "data": { "id": "6a66...", "status": "completed", "executed_price": 23502.5, "pnl": 0 } }
```

### PUT `/api/trade/:tradeId/cancel`
Cancel a pending (limit/SL) trade.

### DELETE `/api/trade/:tradeId`
Soft-delete a trade (admin/master only).

### GET `/api/trade/metrics`
Get current account metrics (P&L, margin, equity) for the authenticated user.

### POST `/api/trade/metrics`
Save client-computed metrics to DB (called by Flutter periodically).

### GET `/api/trade/positions`
Get all positions for the authenticated user (includes carry_forward trades for position calculation).

### GET `/api/trade/brokerage-rules`
Get brokerage rules applicable to the user.

### GET `/api/trade/report`
Trade report for PDF generation. Query: `?from=2026-07-21&to=2026-07-25&user_id=`

```json
// Response
{ "success": true, "data": { "user_name": "Chitra", "from": "2026-07-21", "to": "2026-07-25", "instruments": [...], "summary": { "total_pnl": -5000, "total_brokerage": 250, "net_pnl": -5250 }, "carry_forward": [...] } }
```

### GET `/api/trade/open-positions`
Current open positions for a user (no date filter). Used by Live M2M PDF. Query: `?user_id=`

### GET `/api/trade/settlement-history`
Immutable settlement history ledger. Query: `?from=&to=&user_id=`

### GET `/api/trade/instrument-info`
Get instrument details for trade card info sheet.

### GET `/api/trade/userwise-positions`
Open positions grouped per user (for admin/master dashboards).

### GET `/api/trade/script-qty-details`
Script quantity usage details for a user.

### GET `/api/trade/script-qty-all-lots`
All lots overview (admin/master read-only).

### GET `/api/trade/instrument-limit`
Get instrument-level position limits.

### GET `/api/trade/deleted-trades`
Deleted trades history (admin/master).

### GET `/api/trade/rejection-log`
Rejection/cancellation/deletion log for a user. Query: `?user_id=`

### POST `/api/trade/auto-squareoff-expired`
Auto square-off expired positions (called by Flutter on app open).

---

## 18. Kite Connect Integration

Zerodha Kite API integration for live market data. Mixed auth (some public, some protected).

### GET `/api/kite/login`
Initiate Kite OAuth login (redirects to Zerodha). PUBLIC.

### GET `/api/kite/callback`
Handle OAuth callback from Zerodha (exchanges request_token for access_token). PUBLIC.

### GET `/api/kite/auth-status`
Quick check if Kite is authenticated. PUBLIC.

```json
// Response
{ "success": true, "data": { "authenticated": true, "expires_at": "2026-07-28T00:30:00.000Z" } }
```

### GET `/api/kite/auth/status`
Detailed auth status (hours remaining, warnings). PUBLIC.

### POST `/api/kite/auth/auto-login`
Trigger automated login via TOTP (no browser needed). PUBLIC.

### DELETE `/api/kite/logout`
Clear Kite session. Auth: Any.

### POST `/api/kite/instruments/fetch`
Fetch and store instruments from Kite API. Auth: Any.

### GET `/api/kite/instruments/info`
Get instruments info (lot sizes, segments). Auth: Any.

### GET `/api/kite/instruments/search`
Legacy search instruments. Auth: Any.

### GET `/api/kite/instruments/smart-search`
Smart search with fuzzy matching and grouping. Query: `?q=NIFTY FUT&category=ALL&limit=10&page=1`

```json
// Response
{ "success": true, "data": { "groups": [{ "label": "Futures", "items": [{ "instrument_token": "256265", "tradingsymbol": "NIFTY26JULFUT", "name": "NIFTY", "instrument_type": "FUT", "lot_size": 25, "expiry": "2026-07-31" }] }], "total": 15, "hasMore": true } }
```

### GET `/api/kite/instruments/browse`
Browse all instruments in a category (no search query). Query: `?category=NFO-FUT&limit=100&page=1`

### GET `/api/kite/instruments/categories`
Get available search categories.

### POST `/api/kite/quotes/fetch`
Fetch fresh quotes from Kite API for given tokens.

### GET `/api/kite/quotes/latest`
Get latest cached quotes from database.

### GET `/api/kite/quotes/ltp/:instrumentToken`
Get LTP for a single instrument token.

### GET `/api/kite/option-chain/:tradingSymbol`
Get option chain for an instrument (all strikes, expiries). Auth: Any.

```json
// Response
{ "success": true, "data": { "underlying": "NIFTY", "expiries": ["2026-07-31", "2026-08-07"], "strikes": [{ "strike": 23000, "CE": { "ltp": 550, "oi": 12500 }, "PE": { "ltp": 120, "oi": 8900 } }] } }
```

### GET `/api/kite/market-depth/:instrumentToken`
Get market depth (bid/ask levels) for an instrument. Auth: Any.

### GET `/api/kite/historical/:instrumentToken/:interval`
Get historical OHLC candle data. Query: `?from=2026-07-01&to=2026-07-25`
Intervals: `minute`, `5minute`, `15minute`, `30minute`, `60minute`, `day`

### GET `/api/kite/profile`
Get Kite user profile. Auth: Any.

---

## 19. Watchlist

User watchlist management. Auth: Any authenticated role.

### GET `/api/watchlist`
Get the user's watchlist items.

```json
// Response
{ "success": true, "data": [{ "id": "6a5d...", "instrument_token": "256265", "tradingsymbol": "NIFTY26JULFUT", "exchange": "NFO", "segment": "NFO-FUT" }] }
```

### POST `/api/watchlist`
Add an instrument to the watchlist.

```json
// Request
{ "instrument_token": "256265", "tradingsymbol": "NIFTY26JULFUT", "exchange": "NFO" }
```

### DELETE `/api/watchlist/:id`
Remove an item from the watchlist.

---

## 20. User Routes

User-facing endpoints. Auth: User.

### GET `/api/users/:id`
Get user profile.

### GET `/api/users/:id/trades`
Get user's trade history.

---

## 21. Server Management

Server/broker entities used for user grouping. Auth: Admin (write), Public (read).

### GET `/api/servers/search`
Search servers by name. PUBLIC. Query: `?q=apex`

```json
// Response
{ "success": true, "data": [{ "id": "69dd...", "name": "Apex Live" }] }
```

### GET `/api/servers`
Get all servers. PUBLIC.

### GET `/api/servers/:id`
Get server by ID. Auth: Admin/Master.

### POST `/api/servers`
Create a new server. Auth: Admin.

```json
// Request
{ "name": "Apex Live", "description": "Primary trading server" }
```

### PUT `/api/servers/:id`
Update a server. Auth: Admin.

### DELETE `/api/servers/:id`
Delete a server. Auth: Admin.

---

## 22. Messages

Message management for masters. Auth: Master.

### GET `/api/master/messages`
Get all messages for the authenticated master.

### GET `/api/master/messages/:id`
Get a single message by ID.

### PUT `/api/master/messages/:id/read`
Mark a message as read.

### DELETE `/api/master/messages/:id`
Delete a message.

---

## 23. Misc / Inline Routes

Routes defined directly in `src/index.js`.

### GET `/`
Health check. Returns server status. PUBLIC.

```json
// Response
{ "success": true, "message": "Stocker Backend API is running", "data": null }
```

### GET `/api/my/login-history`
Get login history for the authenticated user (any role). Query: `?page=1&limit=50`

```json
// Response
{ "success": true, "data": [{ "username": "chitra18", "name": "Chitra", "role": "USER", "ip_address": "192.168.1.5", "logged_in_at": "2026-07-27T09:00:00Z" }], "total": 12 }
```

### GET `/api/account-summary`
Account summary report with per-instrument P&L breakdown.
Query: `?week=previous_week&mode=pnl&user_id=&search=&limit=200`

Modes: `pnl` (instrument breakdown), `brokerage` (same + brk focus), `credit` (transaction history).
Week: `this_week`, `previous_week`, `custom` (requires `from` & `to`).

```json
// Response (pnl mode)
{ "success": true, "data": { "week": "20-07-2026 to 26-07-2026", "mode": "pnl", "instruments": [{ "tradingsymbol": "NIFTY26JULFUT", "exchange": "NFO", "buy_qty": 50, "sell_qty": 50, "pnl": 12500.00, "brokerage": 250.00 }], "totals": { "pnl": 12500.00, "brokerage": 250.00, "trades": 15 } } }
```

```json
// Response (credit mode)
{ "success": true, "data": { "week": "20-07-2026 to 26-07-2026", "mode": "credit", "transactions": [{ "type": "CREDIT", "amount": 50000, "balance_before": 100000, "balance_after": 150000, "username": "chitra18", "created_at": "2026-07-22T10:00:00Z" }] } }
```

---

## 24. WebSocket

Real-time live price streaming and event broadcasting.

### `ws://host/ws/live-prices`

Bidirectional WebSocket connection for Flutter clients.

**Client → Server messages:**

```json
// Authenticate (required for targeted events)
{ "type": "auth", "userId": "6a5d...", "role": "user" }

// Subscribe to instrument tokens
{ "type": "subscribe", "tokens": ["256265", "260105"] }

// Unsubscribe
{ "type": "unsubscribe", "tokens": ["256265"] }
```

**Server → Client messages:**

```json
// Connection confirmation
{ "type": "connected", "message": "Connected to live price server", "kiteConnected": true }

// Live price ticks
{ "type": "ticks", "data": [{ "instrument_token": 256265, "last_price": 23520.5, "change": 0.85, "change_percent": 0.004, "bid_price": 23520, "ask_price": 23521, "high": 23600, "low": 23400, "open": 23450, "close": 23500 }] }

// Trade executed (limit order filled)
{ "type": "trade_executed", "tradingsymbol": "NIFTY26JULFUT", "transaction_type": "BUY", "quantity": 25, "executed_price": 23520.5, "status": "completed" }

// Trade rejected
{ "type": "trade_rejected", "tradingsymbol": "NIFTY26JULFUT", "message": "Insufficient margin" }

// Trade placed by admin/master
{ "type": "trade_placed", "tradingsymbol": "NIFTY26JULFUT", "transaction_type": "SELL", "quantity": 25, "price": 23500 }

// Margin square-off triggered
{ "type": "margin_square_off", "message": "Position auto-liquidated due to margin breach" }

// Real-time metrics push (per user)
{ "type": "metrics_update", "data": { "user_id": "6a5d...", "credit": 50000, "realised_pnl": 1200, "position_pnl": -500, "m2m_pnl": 700, "margin_used": 15000, "equity": 50700, "free_margin": 35700, "positions": [...] } }

// Master metrics (aggregate)
{ "type": "master_metrics_update", "data": { "users": [...] } }

// Admin metrics (all masters)
{ "type": "admin_metrics_update", "data": [...] }

// Kite connection status change
{ "type": "kite_status", "connected": true }

// Settlement progress
{ "type": "settlement_progress", "data": { "step": "processing", "current": 5, "total": 20 } }
```

---

## Endpoint Count Summary

| Section | Count |
|---------|-------|
| Authentication | 12 |
| Admin — Users | 7 |
| Admin — Grouped Quantities | 9 |
| Admin — Script Quantities | 7 |
| Admin — Brokerage Settings | 8 |
| Admin — Announcements | 3 |
| Admin — Fresh Stoploss | 5 |
| Admin — TOTP | 5 |
| Admin — Instruments | 7 |
| Admin — Settlement/Prices | 5 |
| Master Flow — Child Masters | 10 |
| Master Flow — Users | 13 |
| Master Flow — Trades/Positions | 12 |
| Master Flow — Reports | 3 |
| Masters (CRUD) | 15 |
| Trading | 15 |
| Kite Connect | 18 |
| Watchlist | 3 |
| User Routes | 2 |
| Server Management | 5 |
| Messages | 4 |
| Misc / Inline | 3 |
| WebSocket | 1 |
| **Total** | **~180** |
