# Field Updates Summary

This document summarizes all the new fields added to Master and User models based on the latest requirements.

---

## Master Model Updates

### New Fields Added

#### 1. `master_id` (ObjectId, ref: 'Master')
- **Purpose**: Tracks the parent master who created this master
- **Default**: `null` (for top-level masters created by admin)
- **Usage**: Enables hierarchical structure where masters can create child masters
- **Example**: 
  ```javascript
  master_id: "507f1f77bcf86cd799439012" // Parent master's ID
  ```

#### 2. `add_master` (Boolean)
- **Purpose**: Controls whether this master can create child masters
- **Default**: `false`
- **Values**:
  - `true`: Master can create both child masters and users
  - `false`: Master can only create users (not child masters)
- **Usage**: Provides granular control over hierarchy expansion
- **Example**:
  ```javascript
  add_master: true  // Can create child masters
  add_master: false // Can only create users
  ```

#### 3. `change_pass_on_first_login` (Boolean)
- **Purpose**: Forces master to change password on first login
- **Default**: `false`
- **Usage**: Security feature for initial password setup
- **Example**:
  ```javascript
  change_pass_on_first_login: true // Must change password on first login
  ```

### Updated Master Schema
```javascript
{
  // ... existing fields ...
  admin_id: ObjectId,
  master_id: ObjectId | null,        // NEW
  add_master: Boolean,               // NEW
  change_pass_on_first_login: Boolean, // NEW
  active_token: String,
  deleted_at: Date
}
```

---

## User Model Updates

### New Fields Added

#### 1. `exchanges_allowed` (Array of Objects) - RESTRUCTURED
Previously a simple array of strings, now an array of objects with detailed configuration.

**Old Structure:**
```javascript
exchanges_allowed: ['nse', 'mcx', 'sgx']
```

**New Structure:**
```javascript
exchanges_allowed: [
  {
    exchange_name: 'nse',      // Required: one of ['nse','mcx','sgx','callput','others','mcx-opt']
    turnover: true,            // Required: boolean
    lot: false,                // Required: boolean
    group_name: 'equity_group' // Required: string
  },
  {
    exchange_name: 'mcx',
    turnover: false,
    lot: true,
    group_name: 'commodity_group'
  }
]
```

**Field Descriptions:**
- `exchange_name`: The exchange identifier
- `turnover`: Enable/disable turnover-based trading for this exchange
- `lot`: Enable/disable lot-based trading for this exchange
- `group_name`: Group identifier for organizing exchanges

#### 2. `margin_square_off` (Boolean)
- **Purpose**: Controls margin square-off functionality
- **Default**: `false`
- **Usage**: Risk management feature
- **Example**:
  ```javascript
  margin_square_off: true // Enable margin square-off
  ```

#### 3. `change_pass_on_first_login` (Boolean)
- **Purpose**: Forces user to change password on first login
- **Default**: `false`
- **Usage**: Security feature for initial password setup
- **Example**:
  ```javascript
  change_pass_on_first_login: true // Must change password on first login
  ```

### Updated User Schema
```javascript
{
  name: String,
  username: String,
  password: String,
  credits: Number,
  note: String,
  pnl_sharing: Number,
  brokerage_sharing: Number,
  exchanges_allowed: [           // RESTRUCTURED
    {
      exchange_name: String,
      turnover: Boolean,
      lot: Boolean,
      group_name: String
    }
  ],
  trade_limit: [String],
  margin_square_off: Boolean,    // NEW
  change_pass_on_first_login: Boolean, // NEW
  server_id: ObjectId,
  master_id: ObjectId,
  status: String,
  active_token: String,
  last_login: Date,
  ip_address: String,
  deleted_at: Date
}
```

---

## API Request Examples

### Creating a Master (by Admin)

```json
POST /api/admin/masters
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
  "add_master": true,                    // NEW
  "change_pass_on_first_login": false,   // NEW
  "server_id": "507f1f77bcf86cd799439011",
  "max_credit": 100000,
  "status": "active",
  "permissions": { ... },
  "active_status": true,
  "exchanges": ["NSE", "MCX"]
}
```

### Creating a Child Master (by Master)

```json
POST /api/master/masters
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
  "add_master": true,                    // NEW - Can this child create masters?
  "change_pass_on_first_login": false,   // NEW
  "server_id": "507f1f77bcf86cd799439011",
  "max_credit": 50000,
  "status": "active",
  "permissions": { ... },
  "active_status": true,
  "exchanges": ["NSE"]
}
```

### Creating a User (by Master)

```json
POST /api/master/users
{
  "name": "Trading User One",
  "username": "user_001",
  "password": "securePassword123",
  "credits": 10000,
  "note": "Active trader for NSE",
  "pnl_sharing": 40.0,
  "brokerage_sharing": 20.0,
  "exchanges_allowed": [                 // NEW STRUCTURE
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
  "margin_square_off": true,             // NEW
  "change_pass_on_first_login": true,    // NEW
  "server_id": "507f1f77bcf86cd799439011",
  "status": "active"
}
```

---

## Validation Rules

### Master Creation Validation

1. **`add_master` Permission Check**
   ```javascript
   // When a master tries to create a child master
   if (!parentMaster.add_master) {
     throw new Error('You do not have permission to create child masters. You can only create users.');
   }
   ```

2. **Hierarchy Tracking**
   ```javascript
   // Child master automatically gets parent's master_id
   childMaster.master_id = parentMaster._id;
   childMaster.admin_id = parentMaster.admin_id; // Inherit admin_id
   ```

### User Creation Validation

1. **Exchange Configuration Validation**
   ```javascript
   // Each exchange object must have all required fields
   exchanges_allowed.forEach(exchange => {
     if (!exchange.exchange_name || 
         exchange.turnover === undefined || 
         exchange.lot === undefined || 
         !exchange.group_name) {
       throw new Error('Invalid exchange configuration');
     }
   });
   ```

2. **Exchange Name Validation**
   ```javascript
   const validExchanges = ['nse', 'mcx', 'sgx', 'callput', 'others', 'mcx-opt'];
   exchanges_allowed.forEach(exchange => {
     if (!validExchanges.includes(exchange.exchange_name)) {
       throw new Error(`Invalid exchange name: ${exchange.exchange_name}`);
     }
   });
   ```

---

## Migration Considerations

### Existing Data Migration

If you have existing data, you'll need to migrate:

#### 1. Master Model Migration
```javascript
// Add new fields to existing masters
db.masters.updateMany(
  {},
  {
    $set: {
      master_id: null,  // Top-level masters have null
      add_master: true, // Default to true for existing masters
      change_pass_on_first_login: false
    }
  }
);
```

#### 2. User Model Migration
```javascript
// Convert old exchanges_allowed array to new structure
db.users.find({}).forEach(user => {
  const newExchanges = user.exchanges_allowed.map(exchangeName => ({
    exchange_name: exchangeName,
    turnover: false,
    lot: false,
    group_name: 'default_group'
  }));
  
  db.users.updateOne(
    { _id: user._id },
    {
      $set: {
        exchanges_allowed: newExchanges,
        margin_square_off: false,
        change_pass_on_first_login: false
      }
    }
  );
});
```

---

## Use Cases

### Use Case 1: Hierarchical Master Structure with Control

**Scenario**: Admin wants to create a regional master who can create state-level masters, but state-level masters should only create users.

```javascript
// Admin creates regional master
{
  name: "Regional Master North",
  add_master: true,  // Can create child masters
  // ... other fields
}

// Regional master creates state master
{
  name: "State Master Delhi",
  master_id: "regional_master_id",
  add_master: false, // Can only create users, not masters
  // ... other fields
}

// State master tries to create another master
// ❌ Error: "You do not have permission to create child masters"

// State master creates user
// ✅ Success
```

### Use Case 2: Exchange-Specific User Configuration

**Scenario**: User needs different trading configurations for different exchanges.

```javascript
{
  name: "Multi-Exchange Trader",
  exchanges_allowed: [
    {
      exchange_name: "nse",
      turnover: true,   // Turnover-based for NSE
      lot: false,
      group_name: "equity_traders"
    },
    {
      exchange_name: "mcx",
      turnover: false,
      lot: true,        // Lot-based for MCX
      group_name: "commodity_traders"
    }
  ]
}
```

### Use Case 3: Forced Password Change

**Scenario**: Security policy requires password change on first login.

```javascript
// Create master with forced password change
{
  name: "New Master",
  change_pass_on_first_login: true,
  // ... other fields
}

// On first login
// 1. User logs in with initial password
// 2. System checks change_pass_on_first_login flag
// 3. If true, redirect to password change page
// 4. After password change, set flag to false
```

---

## Database Indexes

### Recommended Indexes

```javascript
// Master Model
masterSchema.index({ username: 1 }, { unique: true });
masterSchema.index({ server_id: 1 });
masterSchema.index({ admin_id: 1 });
masterSchema.index({ master_id: 1 });  // NEW - for hierarchy queries
masterSchema.index({ status: 1 });
masterSchema.index({ add_master: 1 }); // NEW - for filtering masters by capability

// User Model
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ server_id: 1 });
userSchema.index({ master_id: 1 });
userSchema.index({ status: 1 });
userSchema.index({ 'exchanges_allowed.exchange_name': 1 }); // NEW - for exchange queries
```

---

## Testing Checklist

### Master Model Tests
- [ ] Create master with `add_master: true`
- [ ] Create master with `add_master: false`
- [ ] Verify master with `add_master: false` cannot create child masters
- [ ] Verify master with `add_master: true` can create child masters
- [ ] Test `change_pass_on_first_login` flag on login
- [ ] Verify `master_id` is set correctly for child masters
- [ ] Verify `master_id` is null for top-level masters

### User Model Tests
- [ ] Create user with new `exchanges_allowed` structure
- [ ] Validate exchange object has all required fields
- [ ] Validate exchange names are from allowed enum
- [ ] Test `margin_square_off` flag
- [ ] Test `change_pass_on_first_login` flag on login
- [ ] Query users by exchange name
- [ ] Query users by group name

---

## Summary of Changes

| Model | Field | Type | Purpose |
|-------|-------|------|---------|
| Master | `master_id` | ObjectId | Track parent master |
| Master | `add_master` | Boolean | Control child master creation |
| Master | `change_pass_on_first_login` | Boolean | Force password change |
| User | `exchanges_allowed` | Array[Object] | Detailed exchange config |
| User | `margin_square_off` | Boolean | Margin management |
| User | `change_pass_on_first_login` | Boolean | Force password change |

**Total New Fields**: 6 (3 in Master, 3 in User)
**Restructured Fields**: 1 (User.exchanges_allowed)
