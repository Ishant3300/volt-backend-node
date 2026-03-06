# Admin Flow Documentation

This document outlines the complete Admin workflow for managing Masters in the Stocker platform.

## Overview

Admins have full control over Master accounts, including creation, permission management, status monitoring, credit/debit operations, trade monitoring, and communication.

---

## 1. Master Creation

### Description
Admin can create new Master accounts with comprehensive configuration including credits, sharing percentages, and exchange permissions.

### Required Fields
- `name` (string) - Full name of the master
- `username` (string, unique) - Login username
- `password` (string, will be hashed) - Login password
- `credits` (number) - Initial credit balance
- `note` (string) - Remark/note about the master
- `pnl_sharing` (number, 0-100) - P&L sharing percentage as decimal
- `brokerage_sharing` (number, 0-100) - Brokerage sharing percentage as decimal
- `exchanges_allowed` (array of strings) - Allowed exchanges: ['nse','mcx','sgx','callput','others','mcx-opt']
- `trade_limit` (array of strings) - Trade limit exchanges: ['nse','mcx','sgx','callput','others','mcx-opt']
- `add_master` (boolean) - If true, this master can create other masters; if false, can only create users
- `change_pass_on_first_login` (boolean) - If true, master must change password on first login
- `server_id` (ObjectId reference to Server)
- `admin_id` (ObjectId, automatically set to current admin)

### Optional Fields
- `max_credit` (number, default: 0)
- `status` (enum: 'active' | 'inactive' | 'suspended', default: 'active')
- `permissions` (object, see section 2)
- `last_due_bill` (Date, default: null)
- `active_status` (boolean, default: true)
- `last_login` (Date, tracks last login time)
- `ip_address` (string, IP of device from which master logged in)
- `exchanges` (array of strings, e.g., ['NSE', 'MCX'])

### API Endpoint
```
POST /api/admin/masters
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "name": "John Doe",
  "username": "master_001",
  "password": "securePassword123",
  "credits": 50000,
  "note": "Primary master for NSE trading",
  "pnl_sharing": 60.5,
  "brokerage_sharing": 40.0,
  "exchanges_allowed": ["nse", "mcx", "callput"],
  "trade_limit": ["nse", "mcx"],
  "add_master": true,
  "change_pass_on_first_login": false,
  "server_id": "507f1f77bcf86cd799439011",
  "max_credit": 100000,
  "status": "active",
  "permissions": {
    "account_summary": true,
    "pnl_summary": true,
    "client_summary": false,
    "settlement_report": true,
    "generate_pdf": true,
    "weekly_admin": false,
    "intraday_history": true,
    "userwise_open_position": true,
    "script_quantity": false,
    "deleted_trade": false,
    "trade_account": true,
    "close_only": false,
    "bet": true,
    "margin_square": true,
    "fresh_stoploss": false
  },
  "active_status": true,
  "exchanges": ["NSE", "MCX"]
}
```

### Response
```json
{
  "success": true,
  "message": "Master created successfully",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "name": "John Doe",
    "username": "master_001",
    "credits": 50000,
    "note": "Primary master for NSE trading",
    "pnl_sharing": 60.5,
    "brokerage_sharing": 40.0,
    "exchanges_allowed": ["nse", "mcx", "callput"],
    "trade_limit": ["nse", "mcx"],
    "server_id": "507f1f77bcf86cd799439011",
    "admin_id": "507f1f77bcf86cd799439010",
    "max_credit": 100000,
    "status": "active",
    "active_status": true,
    "last_due_bill": null,
    "last_login": null,
    "ip_address": null,
    "exchanges": ["NSE", "MCX"],
    "permissions": { ... },
    "created_at": "2024-02-17T10:30:00.000Z",
    "updated_at": "2024-02-17T10:30:00.000Z"
  }
}
```

---

## 2. Permission Management

### Description
Admin assigns granular access permissions to each Master, controlling which features they can access.

### Available Permissions

| Permission Key | Description | Default |
|---|---|---|
| `account_summary` | View account summary dashboard | `false` |
| `pnl_summary` | View profit & loss summary | `false` |
| `client_summary` | View client/user summary | `false` |
| `settlement_report` | Access settlement reports | `false` |
| `generate_pdf` | Generate PDF reports | `false` |
| `weekly_admin` | Access weekly admin panel | `false` |
| `intraday_history` | View intraday trading history | `false` |
| `userwise_open_position` | View user-wise open positions | `false` |
| `script_quantity` | Manage script quantity settings | `false` |
| `deleted_trade` | View deleted trades log | `false` |
| `trade_account` | Access trade account management | `false` |
| `close_only` | Allow close-only trading | `false` |
| `bet` | Enable BET functionality | `false` |
| `margin_square` | Allow margin square operations | `false` |
| `fresh_stoploss` | Enable fresh stop-loss orders | `false` |

### Schema Structure
```javascript
permissions: {
  account_summary: { type: Boolean, default: false },
  pnl_summary: { type: Boolean, default: false },
  client_summary: { type: Boolean, default: false },
  settlement_report: { type: Boolean, default: false },
  generate_pdf: { type: Boolean, default: false },
  weekly_admin: { type: Boolean, default: false },
  intraday_history: { type: Boolean, default: false },
  userwise_open_position: { type: Boolean, default: false },
  script_quantity: { type: Boolean, default: false },
  deleted_trade: { type: Boolean, default: false },
  trade_account: { type: Boolean, default: false },
  close_only: { type: Boolean, default: false },
  bet: { type: Boolean, default: false },
  margin_square: { type: Boolean, default: false },
  fresh_stoploss: { type: Boolean, default: false }
}
```

### Update Permissions API
```
PUT /api/admin/masters/:masterId/permissions
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "permissions": {
    "account_summary": true,
    "pnl_summary": true,
    "generate_pdf": false,
    "close_only": true,
    "bet": true
  }
}
```

### Response
```json
{
  "success": true,
  "message": "Permissions updated successfully",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "username": "master_001",
    "permissions": {
      "account_summary": true,
      "pnl_summary": true,
      "client_summary": false,
      "settlement_report": true,
      "generate_pdf": false,
      "close_only": true,
      "bet": true,
      ...
    }
  }
}
```

---

## 3. Master Status Monitoring

### Description
Admin can view and update the status of all Masters they created, including last login information and IP address tracking.

### Get All Masters API
```
GET /api/admin/masters?page=1&limit=20&status=active
Authorization: Bearer {admin_token}
```

### Query Parameters
- `page` (number, default: 1)
- `limit` (number, default: 20)
- `status` (string, optional: 'active' | 'inactive' | 'suspended')
- `server_id` (string, optional)

### Response
```json
{
  "success": true,
  "message": "Masters retrieved successfully",
  "data": {
    "masters": [
      {
        "id": "507f1f77bcf86cd799439012",
        "name": "John Doe",
        "username": "master_001",
        "server_id": "507f1f77bcf86cd799439011",
        "admin_id": "507f1f77bcf86cd799439010",
        "max_credit": 100000,
        "credits": 50000,
        "note": "Primary master for NSE trading",
        "pnl_sharing": 60.5,
        "brokerage_sharing": 40.0,
        "exchanges_allowed": ["nse", "mcx", "callput"],
        "trade_limit": ["nse", "mcx"],
        "status": "active",
        "active_status": true,
        "last_due_bill": "2024-02-15T18:00:00.000Z",
        "last_login": "2024-02-17T09:15:00.000Z",
        "ip_address": "192.168.1.100",
        "exchanges": ["NSE", "MCX"],
        "permissions": { ... },
        "created_at": "2024-02-17T10:30:00.000Z",
        "updated_at": "2024-02-17T10:30:00.000Z"
      }
    ],
    "total": 15,
    "page": 1,
    "pages": 1
  }
}
```

---

## 4. Credit/Debit Operations

### Description
Admin can credit or debit master accounts to manage their available balance.

### Credit Master Account API
```
POST /api/admin/masters/:masterId/credit
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "amount": 25000,
  "note": "Monthly credit allocation"
}
```

### Response
```json
{
  "success": true,
  "message": "Credit added successfully",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "username": "master_001",
    "previous_credits": 50000,
    "amount_credited": 25000,
    "current_credits": 75000,
    "transaction_id": "507f1f77bcf86cd799439025",
    "updated_at": "2024-02-17T14:30:00.000Z"
  }
}
```

### Debit Master Account API
```
POST /api/admin/masters/:masterId/debit
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "amount": 10000,
  "note": "Settlement adjustment"
}
```

### Response
```json
{
  "success": true,
  "message": "Amount debited successfully",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "username": "master_001",
    "previous_credits": 75000,
    "amount_debited": 10000,
    "current_credits": 65000,
    "transaction_id": "507f1f77bcf86cd799439026",
    "updated_at": "2024-02-17T14:35:00.000Z"
  }
}
```

---

## 5. Trade Management

### Description
Admin can fetch all trades of users created by masters under their supervision.

### Get All Trades API
```
GET /api/admin/masters/trades/all?master_id=507f1f77bcf86cd799439012&page=1&limit=50&date_from=2024-02-01&date_to=2024-02-17
Authorization: Bearer {admin_token}
```

### Query Parameters
- `master_id` (string, optional): Filter by specific master
- `user_id` (string, optional): Filter by specific user
- `page` (number, default: 1)
- `limit` (number, default: 50)
- `date_from` (string, ISO date): Start date filter
- `date_to` (string, ISO date): End date filter
- `status` (string, optional): 'completed' | 'pending' | 'cancelled'

### Response
```json
{
  "success": true,
  "message": "Trades retrieved successfully",
  "data": {
    "trades": [
      {
        "id": "507f1f77bcf86cd799439030",
        "user_id": "507f1f77bcf86cd799439015",
        "master_id": "507f1f77bcf86cd799439012",
        "instrument_token": "256265",
        "tradingsymbol": "RELIANCE",
        "exchange": "NSE",
        "transaction_type": "BUY",
        "quantity": 100,
        "price": 2450.50,
        "order_type": "MARKET",
        "status": "completed",
        "executed_at": "2024-02-17T10:30:00.000Z",
        "pnl": 1250.00,
        "brokerage": 25.50,
        "created_at": "2024-02-17T10:29:45.000Z"
      }
    ],
    "total": 150,
    "page": 1,
    "pages": 3,
    "summary": {
      "total_trades": 150,
      "total_pnl": 45000.00,
      "total_brokerage": 2250.00
    }
  }
}
```

---

## 6. Master Position Management

### Description
Admin can fetch the current position and financial status of masters.

### Get Master Position API
```
GET /api/admin/masters/:masterId/position
Authorization: Bearer {admin_token}
```

### Response
```json
{
  "success": true,
  "message": "Master position retrieved successfully",
  "data": {
    "master_id": "507f1f77bcf86cd799439012",
    "username": "master_001",
    "position": {
      "realised_pnl": 25000.50,
      "m2m_pnl": -1500.25,
      "credit": 65000.00,
      "equity": 89500.25,
      "margin_used": 45000.00,
      "free_margin": 44500.25
    },
    "last_updated": "2024-02-17T15:00:00.000Z"
  }
}
```

---

## 7. Enhanced Master Updates

### Description
Admin can update additional master fields including name, username, credits, note, exchanges, and trade limits.

### Update Master Details API
```
PUT /api/admin/masters/:masterId/details
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "name": "John Smith",
  "username": "master_001_updated",
  "credits": 80000,
  "note": "Updated master for expanded trading",
  "exchanges_allowed": ["nse", "mcx", "sgx", "callput"],
  "trade_limit": ["nse", "mcx", "sgx"]
}
```

### Response
```json
{
  "success": true,
  "message": "Master details updated successfully",
  "data": {
    "id": "507f1f77bcf86cd799439012",
    "name": "John Smith",
    "username": "master_001_updated",
    "credits": 80000,
    "note": "Updated master for expanded trading",
    "exchanges_allowed": ["nse", "mcx", "sgx", "callput"],
    "trade_limit": ["nse", "mcx", "sgx"],
    "updated_at": "2024-02-17T15:30:00.000Z"
  }
}
```

---

## 8. Messaging System

### Description
Admin can send text messages to Masters. Messages are stored in the master's inbox for later retrieval.

### Message Schema
```javascript
{
  sender_id: ObjectId (Admin),
  sender_type: 'Admin',
  recipient_id: ObjectId (Master),
  recipient_type: 'Master',
  subject: String (optional),
  message: String (required),
  read: Boolean (default: false),
  read_at: Date (default: null),
  created_at: Date,
  updated_at: Date
}
```

### Send Message API
```
POST /api/admin/masters/:masterId/messages
Authorization: Bearer {admin_token}
```

### Request Body
```json
{
  "subject": "Credit Limit Update",
  "message": "Your credit limit has been increased to 100,000. Please review the updated terms."
}
```

### Response
```json
{
  "success": true,
  "message": "Message sent successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "sender_id": "507f1f77bcf86cd799439010",
    "sender_type": "Admin",
    "recipient_id": "507f1f77bcf86cd799439012",
    "recipient_type": "Master",
    "subject": "Credit Limit Update",
    "message": "Your credit limit has been increased to 100,000. Please review the updated terms.",
    "read": false,
    "read_at": null,
    "created_at": "2024-02-17T12:50:00.000Z"
  }
}
```

---

## Database Schema Updates

### Master Model
Location: `src/models/Master.js`

```javascript
const masterSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  credits: { type: Number, required: true, default: 0 },
  note: { type: String, required: true, default: '' },
  pnl_sharing: { type: Number, required: true, default: 0, min: 0, max: 100 },
  brokerage_sharing: { type: Number, required: true, default: 0, min: 0, max: 100 },
  exchanges_allowed: { 
    type: [String], 
    required: true,
    enum: ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt'],
    default: []
  },
  trade_limit: { 
    type: [String], 
    required: true,
    enum: ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt'],
    default: []
  },
  server_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
  max_credit: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  active_status: { type: Boolean, default: true },
  last_due_bill: { type: Date, default: null },
  last_login: { type: Date, default: null },
  ip_address: { type: String, default: null },
  exchanges: { 
    type: [String], 
    enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'],
    default: []
  },
  permissions: {
    account_summary: { type: Boolean, default: false },
    pnl_summary: { type: Boolean, default: false },
    client_summary: { type: Boolean, default: false },
    settlement_report: { type: Boolean, default: false },
    generate_pdf: { type: Boolean, default: false },
    weekly_admin: { type: Boolean, default: false },
    intraday_history: { type: Boolean, default: false },
    userwise_open_position: { type: Boolean, default: false },
    script_quantity: { type: Boolean, default: false },
    deleted_trade: { type: Boolean, default: false },
    trade_account: { type: Boolean, default: false },
    close_only: { type: Boolean, default: false },
    bet: { type: Boolean, default: false },
    margin_square: { type: Boolean, default: false },
    fresh_stoploss: { type: Boolean, default: false }
  },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', default: null },
  add_master: { type: Boolean, default: false },
  change_pass_on_first_login: { type: Boolean, default: false },
  active_token: { type: String, default: null },
  deleted_at: { type: Date, default: null }
}, { timestamps: true });
```

### User Model
Location: `src/models/User.js`

```javascript
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  credits: { type: Number, required: true, default: 0 },
  note: { type: String, required: true, default: '' },
  pnl_sharing: { type: Number, required: true, default: 0, min: 0, max: 100 },
  brokerage_sharing: { type: Number, required: true, default: 0, min: 0, max: 100 },
  exchanges_allowed: {
    type: [{
      exchange_name: {
        type: String,
        required: true,
        enum: ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt']
      },
      turnover: { type: Boolean, required: true, default: false },
      lot: { type: Boolean, required: true, default: false },
      group_name: { type: String, required: true, default: '' }
    }],
    required: true,
    default: []
  },
  trade_limit: { 
    type: [String], 
    required: true,
    enum: ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt'],
    default: []
  },
  margin_square_off: { type: Boolean, default: false },
  change_pass_on_first_login: { type: Boolean, default: false },
  server_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', required: true },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  active_token: { type: String, default: null },
  last_login: { type: Date, default: null },
  ip_address: { type: String, default: null },
  deleted_at: { type: Date, default: null }
}, { timestamps: true });
```

### Trade Model
Location: `src/models/Trade.js`

```javascript
const tradeSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', required: true },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  instrument_token: { type: String, required: true },
  tradingsymbol: { type: String, required: true },
  exchange: { type: String, required: true, enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'] },
  transaction_type: { type: String, required: true, enum: ['BUY', 'SELL'] },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
  order_type: { type: String, required: true, enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'] },
  status: { type: String, required: true, enum: ['pending', 'completed', 'cancelled', 'rejected'], default: 'pending' },
  order_id: { type: String, default: null },
  executed_at: { type: Date, default: null },
  executed_price: { type: Number, default: null },
  executed_quantity: { type: Number, default: null },
  pnl: { type: Number, default: 0 },
  brokerage: { type: Number, default: 0 },
  taxes: { type: Number, default: 0 },
  net_amount: { type: Number, default: 0 },
  remarks: { type: String, default: '' },
  deleted_at: { type: Date, default: null }
}, { timestamps: true });
```

### CreditTransaction Model
Location: `src/models/CreditTransaction.js`

```javascript
const creditTransactionSchema = new mongoose.Schema({
  master_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Master', required: true },
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  transaction_type: { type: String, required: true, enum: ['CREDIT', 'DEBIT'] },
  amount: { type: Number, required: true },
  previous_balance: { type: Number, required: true },
  new_balance: { type: Number, required: true },
  note: { type: String, default: '' },
  reference_id: { type: String, default: null },
  deleted_at: { type: Date, default: null }
}, { timestamps: true });
```

---

## Security Considerations

1. **Authentication**: All endpoints require valid admin JWT token
2. **Authorization**: Admin can only manage masters they created (check `admin_id`)
3. **Validation**: Validate all input fields (especially percentages: 0-100)
4. **Password Hashing**: Always hash master passwords using bcryptjs
5. **Soft Deletes**: Use `deleted_at` field instead of hard deletes
6. **Rate Limiting**: Implement rate limiting on message sending to prevent spam
7. **IP Tracking**: Login IP addresses are tracked for security auditing
8. **Transaction Logging**: All credit/debit operations are logged in CreditTransaction model

---

## Error Handling

All endpoints follow the standard response format:

### Success Response
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... }
}
```

### Error Response
```json
{
  "success": false,
  "message": "Error description",
  "data": null
}
```

### Common HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error
