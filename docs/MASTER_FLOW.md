# Master Flow Documentation

This document outlines the complete Master workflow for managing child Masters and Users in the Stocker platform.

## Overview

Masters have similar capabilities to Admins but operate within a hierarchical structure. A Master can create child Masters and Users, and can pass down their permissions to their children. Masters can manage all entities they create, including viewing trades, managing credits, and monitoring positions.

### Hierarchy Structure
```
Admin
  └── Master (Level 1)
      ├── Master (Level 2)
      │   ├── Master (Level 3)
      │   │   └── User
      │   └── User
      └── User
```

**Key Concepts:**
- Admin creates Masters
- Masters can create both child Masters and Users
- Each Master is the parent of all entities they create
- Masters can only manage their direct children and descendants
- Permissions flow down from parent to children (cannot exceed parent's permissions)
- All operations track the hierarchy through `master_id` field

---

## 1. Master Creation (by Master)

### Description
A Master can create child Master accounts with configuration similar to how Admins create Masters. The child Master inherits the parent's context and can only have permissions that the parent Master possesses.

### Required Fields
- `name` (string) - Full name of the child master
- `username` (string, unique) - Login username
- `password` (string, will be hashed) - Login password
- `credits` (number) - Initial credit balance
- `note` (string) - Remark/note about the child master
- `pnl_sharing` (number, 0-100) - P&L sharing percentage as decimal
- `brokerage_sharing` (number, 0-100) - Brokerage sharing percentage as decimal
- `exchanges_allowed` (array of strings) - Allowed exchanges: ['nse','mcx','sgx','callput','others','mcx-opt']
- `trade_limit` (array of strings) - Trade limit exchanges: ['nse','mcx','sgx','callput','others','mcx-opt']
- `add_master` (boolean) - If true, this master can create other masters; if false, can only create users
- `change_pass_on_first_login` (boolean) - If true, master must change password on first login
- `server_id` (ObjectId reference to Server)
- `master_id` (ObjectId, automatically set to current master - the parent)

### Optional Fields
- `max_credit` (number, default: 0)
- `status` (enum: 'active' | 'inactive' | 'suspended', default: 'active')
- `permissions` (object, subset of parent's permissions)
- `last_due_bill` (Date, default: null)
- `active_status` (boolean, default: true)
- `exchanges` (array of strings, e.g., ['NSE', 'MCX'])

### API Endpoint
```
POST /api/master/masters
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "name": "Sub Master One",
  "username": "submaster_001",
  "password": "securePassword123",
  "credits": 30000,
  "note": "Child master for NSE trading",
  "pnl_sharing": 50.0,
  "brokerage_sharing": 30.0,
  "exchanges_allowed": ["nse", "mcx"],
  "trade_limit": ["nse"],
  "add_master": true,
  "change_pass_on_first_login": false,
  "server_id": "507f1f77bcf86cd799439011",
  "max_credit": 50000,
  "status": "active",
  "permissions": {
    "account_summary": true,
    "pnl_summary": true,
    "trade_account": true,
    "bet": true
  },
  "active_status": true,
  "exchanges": ["NSE"]
}
```

### Response
```json
{
  "success": true,
  "message": "Master created successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "name": "Sub Master One",
    "username": "submaster_001",
    "credits": 30000,
    "note": "Child master for NSE trading",
    "pnl_sharing": 50.0,
    "brokerage_sharing": 30.0,
    "exchanges_allowed": ["nse", "mcx"],
    "trade_limit": ["nse"],
    "server_id": "507f1f77bcf86cd799439011",
    "master_id": "507f1f77bcf86cd799439012",
    "admin_id": "507f1f77bcf86cd799439010",
    "max_credit": 50000,
    "status": "active",
    "active_status": true,
    "last_due_bill": null,
    "last_login": null,
    "ip_address": null,
    "exchanges": ["NSE"],
    "permissions": { ... },
    "created_at": "2024-02-17T10:30:00.000Z",
    "updated_at": "2024-02-17T10:30:00.000Z"
  }
}
```

### Permission Inheritance Rules
- Child Master can only have permissions that parent Master has
- If parent has `bet: true`, child can have `bet: true` or `bet: false`
- If parent has `bet: false`, child cannot have `bet: true`
- System validates permissions against parent's permissions on creation

### Master Creation Control (`add_master` field)
- When a Master is created with `add_master: true`, they can create both child Masters and Users
- When a Master is created with `add_master: false`, they can ONLY create Users (not child Masters)
- This provides granular control over hierarchy expansion
- Example use case: Limit certain masters to only managing end-users without creating sub-hierarchies

**Validation Logic:**
```javascript
// When Master attempts to create a child Master
if (!parentMaster.add_master) {
  throw new Error('You do not have permission to create child masters. You can only create users.');
}
```

---

## 2. User Creation (by Master)

### Description
A Master can create User accounts. Users are end-users who can trade but cannot create other entities.

### Required Fields
- `name` (string) - Full name of the user
- `username` (string, unique) - Login username
- `password` (string, will be hashed) - Login password
- `credits` (number) - Initial credit balance
- `note` (string) - Remark/note about the user
- `pnl_sharing` (number, 0-100) - P&L sharing percentage as decimal
- `brokerage_sharing` (number, 0-100) - Brokerage sharing percentage as decimal
- `exchanges_allowed` (array of objects) - Each object contains:
  - `exchange_name` (string) - One of: ['nse','mcx','sgx','callput','others','mcx-opt']
  - `turnover` (boolean) - Enable/disable turnover for this exchange
  - `lot` (boolean) - Enable/disable lot trading for this exchange
  - `group_name` (string) - Group identifier for this exchange
- `trade_limit` (array of strings) - Trade limit exchanges: ['nse','mcx','sgx','callput','others','mcx-opt']
- `margin_square_off` (boolean) - Enable/disable margin square off
- `change_pass_on_first_login` (boolean) - If true, user must change password on first login
- `server_id` (ObjectId reference to Server)
- `master_id` (ObjectId, automatically set to current master)

### Optional Fields
- `status` (enum: 'active' | 'inactive' | 'suspended', default: 'active')
- `last_login` (Date, tracks last login time)
- `ip_address` (string, IP of device from which user logged in)

### API Endpoint
```
POST /api/master/users
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "name": "Trading User One",
  "username": "user_001",
  "password": "securePassword123",
  "credits": 10000,
  "note": "Active trader for NSE",
  "pnl_sharing": 40.0,
  "brokerage_sharing": 20.0,
  "exchanges_allowed": [
    {
      "exchange_name": "nse",
      "turnover": true,
      "lot": false,
      "group_name": "equity_group"
    },
    {
      "exchange_name": "mcx",
      "turnover": false,
      "lot": true,
      "group_name": "commodity_group"
    }
  ],
  "trade_limit": ["nse"],
  "margin_square_off": true,
  "change_pass_on_first_login": true,
  "server_id": "507f1f77bcf86cd799439011",
  "status": "active"
}
```

### Response
```json
{
  "success": true,
  "message": "User created successfully",
  "data": {
    "id": "507f1f77bcf86cd799439030",
    "name": "Trading User One",
    "username": "user_001",
    "credits": 10000,
    "note": "Active trader for NSE",
    "pnl_sharing": 40.0,
    "brokerage_sharing": 20.0,
    "exchanges_allowed": [
      {
        "exchange_name": "nse",
        "turnover": true,
        "lot": false,
        "group_name": "equity_group"
      },
      {
        "exchange_name": "mcx",
        "turnover": false,
        "lot": true,
        "group_name": "commodity_group"
      }
    ],
    "trade_limit": ["nse"],
    "margin_square_off": true,
    "change_pass_on_first_login": true,
    "server_id": "507f1f77bcf86cd799439011",
    "master_id": "507f1f77bcf86cd799439012",
    "status": "active",
    "last_login": null,
    "ip_address": null,
    "created_at": "2024-02-17T11:00:00.000Z",
    "updated_at": "2024-02-17T11:00:00.000Z"
  }
}
```

---

## 3. Fetch Child Masters

### Description
Master can view all child Masters they created, including status, credits, and login information.

### Get All Child Masters API
```
GET /api/master/masters?page=1&limit=20&status=active
Authorization: Bearer {master_token}
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
  "message": "Child masters retrieved successfully",
  "data": {
    "masters": [
      {
        "id": "507f1f77bcf86cd799439020",
        "name": "Sub Master One",
        "username": "submaster_001",
        "server_id": "507f1f77bcf86cd799439011",
        "master_id": "507f1f77bcf86cd799439012",
        "admin_id": "507f1f77bcf86cd799439010",
        "max_credit": 50000,
        "credits": 30000,
        "note": "Child master for NSE trading",
        "pnl_sharing": 50.0,
        "brokerage_sharing": 30.0,
        "exchanges_allowed": ["nse", "mcx"],
        "trade_limit": ["nse"],
        "status": "active",
        "active_status": true,
        "last_due_bill": null,
        "last_login": "2024-02-17T09:15:00.000Z",
        "ip_address": "192.168.1.101",
        "exchanges": ["NSE"],
        "permissions": { ... },
        "created_at": "2024-02-17T10:30:00.000Z",
        "updated_at": "2024-02-17T10:30:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "pages": 1
  }
}
```

---

## 4. Fetch Users

### Description
Master can view all Users they created directly.

### Get All Users API
```
GET /api/master/users?page=1&limit=20&status=active
Authorization: Bearer {master_token}
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
  "message": "Users retrieved successfully",
  "data": {
    "users": [
      {
        "id": "507f1f77bcf86cd799439030",
        "name": "Trading User One",
        "username": "user_001",
        "server_id": "507f1f77bcf86cd799439011",
        "master_id": "507f1f77bcf86cd799439012",
        "credits": 10000,
        "note": "Active trader for NSE",
        "pnl_sharing": 40.0,
        "brokerage_sharing": 20.0,
        "exchanges_allowed": ["nse"],
        "trade_limit": ["nse"],
        "status": "active",
        "last_login": "2024-02-17T10:00:00.000Z",
        "ip_address": "192.168.1.102",
        "created_at": "2024-02-17T11:00:00.000Z",
        "updated_at": "2024-02-17T11:00:00.000Z"
      }
    ],
    "total": 10,
    "page": 1,
    "pages": 1
  }
}
```

---

## 5. Permission Management

### Description
Master can update permissions for their child Masters, but only within the scope of their own permissions.

### Update Child Master Permissions API
```
PUT /api/master/masters/:masterId/permissions
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "permissions": {
    "account_summary": true,
    "pnl_summary": true,
    "bet": false
  }
}
```

### Response
```json
{
  "success": true,
  "message": "Permissions updated successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "username": "submaster_001",
    "permissions": {
      "account_summary": true,
      "pnl_summary": true,
      "client_summary": false,
      "bet": false,
      ...
    }
  }
}
```

---

## 6. Credit/Debit Operations

### Description
Master can credit or debit child Masters and Users to manage their available balance.

### Credit Child Master Account API
```
POST /api/master/masters/:masterId/credit
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "amount": 15000,
  "note": "Monthly credit allocation"
}
```

### Response
```json
{
  "success": true,
  "message": "Credit added successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "username": "submaster_001",
    "previous_credits": 30000,
    "amount_credited": 15000,
    "current_credits": 45000,
    "transaction_id": "507f1f77bcf86cd799439040",
    "updated_at": "2024-02-17T14:30:00.000Z"
  }
}
```

### Debit Child Master Account API
```
POST /api/master/masters/:masterId/debit
Authorization: Bearer {master_token}
```

### Credit User Account API
```
POST /api/master/users/:userId/credit
Authorization: Bearer {master_token}
```

### Debit User Account API
```
POST /api/master/users/:userId/debit
Authorization: Bearer {master_token}
```

---

## 7. Trade Management

### Description
Master can fetch all trades of Users and child Masters under their hierarchy.

### Get All Trades API
```
GET /api/master/trades?master_id=507f1f77bcf86cd799439020&page=1&limit=50&date_from=2024-02-01&date_to=2024-02-17
Authorization: Bearer {master_token}
```

### Query Parameters
- `master_id` (string, optional): Filter by specific child master
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
        "id": "507f1f77bcf86cd799439050",
        "user_id": "507f1f77bcf86cd799439030",
        "master_id": "507f1f77bcf86cd799439012",
        "instrument_token": "256265",
        "tradingsymbol": "RELIANCE",
        "exchange": "NSE",
        "transaction_type": "BUY",
        "quantity": 50,
        "price": 2450.50,
        "order_type": "MARKET",
        "status": "completed",
        "executed_at": "2024-02-17T10:30:00.000Z",
        "pnl": 625.00,
        "brokerage": 12.50,
        "created_at": "2024-02-17T10:29:45.000Z"
      }
    ],
    "total": 75,
    "page": 1,
    "pages": 2,
    "summary": {
      "total_trades": 75,
      "total_pnl": 22500.00,
      "total_brokerage": 1125.00
    }
  }
}
```

---

## 8. Position Management

### Description
Master can fetch the current position and financial status of child Masters and Users.

### Get Child Master Position API
```
GET /api/master/masters/:masterId/position
Authorization: Bearer {master_token}
```

### Response
```json
{
  "success": true,
  "message": "Master position retrieved successfully",
  "data": {
    "master_id": "507f1f77bcf86cd799439020",
    "username": "submaster_001",
    "position": {
      "realised_pnl": 12500.50,
      "m2m_pnl": -750.25,
      "credit": 45000.00,
      "equity": 56750.25,
      "margin_used": 22000.00,
      "free_margin": 34750.25
    },
    "last_updated": "2024-02-17T15:00:00.000Z"
  }
}
```

### Get User Position API
```
GET /api/master/users/:userId/position
Authorization: Bearer {master_token}
```

---

## 9. Update Child Master Details

### Description
Master can update details of child Masters including name, username, credits, note, exchanges, and trade limits.

### Update Child Master Details API
```
PUT /api/master/masters/:masterId/details
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "name": "Sub Master One Updated",
  "username": "submaster_001_updated",
  "credits": 40000,
  "note": "Updated child master",
  "exchanges_allowed": ["nse", "mcx", "sgx"],
  "trade_limit": ["nse", "mcx"]
}
```

### Response
```json
{
  "success": true,
  "message": "Master details updated successfully",
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "name": "Sub Master One Updated",
    "username": "submaster_001_updated",
    "credits": 40000,
    "note": "Updated child master",
    "exchanges_allowed": ["nse", "mcx", "sgx"],
    "trade_limit": ["nse", "mcx"],
    "updated_at": "2024-02-17T15:30:00.000Z"
  }
}
```

---

## 10. Update User Details

### Description
Master can update details of Users they created.

### Update User Details API
```
PUT /api/master/users/:userId/details
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "name": "Trading User One Updated",
  "username": "user_001_updated",
  "credits": 15000,
  "note": "Updated active trader",
  "exchanges_allowed": ["nse", "mcx"],
  "trade_limit": ["nse"]
}
```

---

## 11. Messaging System

### Description
Master can send messages to child Masters and Users.

### Send Message to Child Master API
```
POST /api/master/masters/:masterId/messages
Authorization: Bearer {master_token}
```

### Send Message to User API
```
POST /api/master/users/:userId/messages
Authorization: Bearer {master_token}
```

### Request Body
```json
{
  "subject": "Credit Update",
  "message": "Your credit has been updated. Please check your account."
}
```

---

## Database Schema Considerations

### Master Model Updates
The Master model needs to support the parent-child relationship and master creation capability:

```javascript
master_id: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Master',
  default: null  // null for top-level masters created by admin
},
add_master: {
  type: Boolean,
  default: false  // if true, can create child masters; if false, can only create users
},
change_pass_on_first_login: {
  type: Boolean,
  default: false  // if true, must change password on first login
}
```

### User Model - Exchange Structure
Users have a more detailed exchange configuration:

```javascript
exchanges_allowed: {
  type: [{
    exchange_name: {
      type: String,
      required: true,
      enum: ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt']
    },
    turnover: {
      type: Boolean,
      required: true,
      default: false
    },
    lot: {
      type: Boolean,
      required: true,
      default: false
    },
    group_name: {
      type: String,
      required: true,
      default: ''
    }
  }],
  required: true,
  default: []
},
margin_square_off: {
  type: Boolean,
  default: false
},
change_pass_on_first_login: {
  type: Boolean,
  default: false
}
```

### Hierarchy Tracking
- Top-level Masters (created by Admin): `master_id = null`
- Child Masters (created by Master): `master_id = parent_master_id`
- Users always have: `master_id = creator_master_id`

### Authorization Logic
When a Master performs operations:
1. Verify the target entity's `master_id` matches the authenticated Master's `_id`
2. For nested operations, traverse the hierarchy to verify ownership
3. For permission grants, verify parent has the permission being granted

---

## Security Considerations

1. **Hierarchy Validation**: Always verify parent-child relationships before operations
2. **Permission Inheritance**: Child cannot have permissions parent doesn't have
3. **Credit Limits**: Master cannot allocate more credits than they have available
4. **Scope Isolation**: Master can only see/manage their direct children and descendants
5. **Admin Override**: Admins can see entire hierarchy but Masters cannot see siblings
6. **Audit Trail**: All operations log the master_id for accountability

---

## API Route Structure

### Master Routes (`/api/master/*`)
All routes require `authenticateMaster` middleware:

```javascript
// Child Master Management
POST   /api/master/masters              // Create child master
GET    /api/master/masters              // Get all child masters
GET    /api/master/masters/:id          // Get specific child master
PUT    /api/master/masters/:id          // Update child master
DELETE /api/master/masters/:id          // Delete child master
PUT    /api/master/masters/:id/permissions
PUT    /api/master/masters/:id/details
POST   /api/master/masters/:id/credit
POST   /api/master/masters/:id/debit
GET    /api/master/masters/:id/position
POST   /api/master/masters/:id/messages

// User Management
POST   /api/master/users                // Create user
GET    /api/master/users                // Get all users
GET    /api/master/users/:id            // Get specific user
PUT    /api/master/users/:id            // Update user
DELETE /api/master/users/:id            // Delete user
PUT    /api/master/users/:id/details
POST   /api/master/users/:id/credit
POST   /api/master/users/:id/debit
GET    /api/master/users/:id/position
POST   /api/master/users/:id/messages

// Trade Management
GET    /api/master/trades               // Get all trades in hierarchy
```

---

## Error Handling

### Hierarchy Errors
```json
{
  "success": false,
  "message": "You can only manage entities you created",
  "data": null
}
```

### Permission Errors
```json
{
  "success": false,
  "message": "Cannot grant permission 'bet' - you don't have this permission",
  "data": null
}
```

### Credit Errors
```json
{
  "success": false,
  "message": "Insufficient credits. Available: 30000, Requested: 50000",
  "data": null
}
```

---

## Implementation Notes

1. **Middleware**: Create `authenticateMaster` middleware similar to `authenticateAdmin`
2. **Controllers**: Create `masterUserController.js` for user management by masters
3. **Validation**: Add hierarchy validation in all master operations
4. **Permissions**: Implement permission inheritance validation
5. **Credits**: Track credit allocation across hierarchy
6. **Queries**: Filter by `master_id` for all fetch operations
7. **Cascade**: Consider cascade rules for deletions (soft delete recommended)

---

## Common HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `403` - Forbidden (insufficient permissions or not in hierarchy)
- `404` - Not Found
- `500` - Internal Server Error
