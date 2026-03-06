# Test Files Documentation

This directory contains comprehensive test files for the Stocker platform API endpoints.

## Test Files

### 1. testAdminFlow.js
Tests all Admin operations for managing Masters.

**Prerequisites:**
- Server running on `http://localhost:3000`
- Admin account exists (username: 'admin', password: 'admin')
- Valid server ID in database

**Run:**
```bash
node test/testAdminFlow.js
```

**Tests Covered (14 tests):**
1. Admin Login
2. Create Master (with new fields)
3. Get All Masters
4. Credit Master Account
5. Debit Master Account
6. Get Master Position
7. Update Master Details
8. Update Master Permissions
9. Update Master Status
10. Send Message to Master
11. Master Login
12. Get Master's Messages (Inbox)
13. Mark Message as Read
14. Get Master by ID

**New Fields Tested:**
- `name`, `credits`, `note`
- `pnl_sharing`, `brokerage_sharing`
- `exchanges_allowed`, `trade_limit`
- `add_master`, `change_pass_on_first_login`
- Credit/Debit operations
- Position management

---

### 2. testMasterFlow.js
Tests all Master operations for managing child Masters and Users.

**Prerequisites:**
- Server running on `http://localhost:3000`
- Admin account exists
- Valid server ID in database

**Run:**
```bash
node test/testMasterFlow.js
```

**Tests Covered (21 tests):**
1. Admin Login
2. Create Parent Master (by Admin)
3. Parent Master Login
4. Create Child Master (by Parent Master)
5. Create User (by Parent Master)
6. Get All Child Masters
7. Get All Users
8. Credit Child Master
9. Debit Child Master
10. Credit User
11. Debit User
12. Update Child Master Permissions
13. Update Child Master Details
14. Update User Details
15. Get Child Master Position
16. Get User Position
17. Get All Trades in Hierarchy
18. Send Message to Child Master
19. Send Message to User
20. Get Child Master by ID
21. Get User by ID

**Hierarchy Tested:**
```
Admin
  └── Parent Master (add_master: true)
      ├── Child Master (add_master: false)
      └── User
```

**New Features Tested:**
- Hierarchical master creation
- `add_master` permission control
- User creation with detailed exchange configuration
- `exchanges_allowed` as array of objects:
  - `exchange_name`
  - `turnover`
  - `lot`
  - `group_name`
- `margin_square_off`
- `change_pass_on_first_login`
- Credit/Debit operations for both masters and users
- Position tracking
- Message system

---

## Configuration

### Update Server ID
Before running tests, update the `server_id` in both test files:

```javascript
server_id: '698c22b313203b38f16f7da9' // Replace with your actual server ID
```

To get your server ID:
```bash
# Connect to MongoDB
mongo

# Use your database
use stocker

# Find server
db.servers.findOne()
```

### Update Admin Credentials
If your admin credentials are different:

```javascript
adminCredentials: {
  username: 'your_admin_username',
  password: 'your_admin_password'
}
```

---

## Test Data Structure

### Master Data (Admin Flow)
```javascript
{
  name: 'Test Master One',
  username: 'test_master_001',
  password: 'master123',
  credits: 50000,
  note: 'Test master for NSE trading',
  pnl_sharing: 60.5,
  brokerage_sharing: 40.0,
  exchanges_allowed: ['nse', 'mcx', 'callput'],
  trade_limit: ['nse', 'mcx'],
  add_master: true,
  change_pass_on_first_login: false,
  server_id: '...',
  max_credit: 100000,
  status: 'active',
  permissions: { ... }
}
```

### User Data (Master Flow)
```javascript
{
  name: 'Trading User One',
  username: 'user_001',
  password: 'user123',
  credits: 10000,
  note: 'Active trader for NSE',
  pnl_sharing: 40.0,
  brokerage_sharing: 20.0,
  exchanges_allowed: [
    {
      exchange_name: 'nse',
      turnover: true,
      lot: false,
      group_name: 'equity_group'
    },
    {
      exchange_name: 'mcx',
      turnover: false,
      lot: true,
      group_name: 'commodity_group'
    }
  ],
  trade_limit: ['nse'],
  margin_square_off: true,
  change_pass_on_first_login: true,
  server_id: '...',
  status: 'active'
}
```

---

## Expected Output

### Success Output
```
🚀 Starting Admin Flow Tests...
================================

📝 Test 1: Admin Login
✅ Admin login successful
   Token: eyJhbGciOiJIUzI1NiIs...

📝 Test 2: Create Master
✅ Master created successfully
   Master ID: 507f1f77bcf86cd799439012
   Name: Test Master One
   Username: test_master_001
   Credits: 50000
   ...

================================
📊 Test Results:
   ✅ Passed: 14
   ❌ Failed: 0
   📈 Total: 14
================================
```

### Failure Output
```
📝 Test 2: Create Master
❌ Master creation failed: {
  success: false,
  message: 'Username already exists',
  data: null
}
```

---

## Troubleshooting

### Common Issues

#### 1. Connection Refused
```
Error: connect ECONNREFUSED 127.0.0.1:3000
```
**Solution:** Make sure the server is running:
```bash
npm start
# or
npm run dev
```

#### 2. Invalid Server ID
```
❌ Master creation failed: Server not found
```
**Solution:** Update the `server_id` in test configuration with a valid server ID from your database.

#### 3. Username Already Exists
```
❌ Master creation failed: Username already exists
```
**Solution:** Change the username in test configuration or delete the existing master:
```javascript
username: 'test_master_002' // Use different username
```

#### 4. Unauthorized
```
❌ Test failed: Unauthorized
```
**Solution:** Check admin credentials are correct and admin account exists in database.

#### 5. Insufficient Credits
```
❌ Debit operation failed: Insufficient credits
```
**Solution:** This is expected if trying to debit more than available. Adjust test amounts.

---

## API Endpoints Tested

### Admin Endpoints
- `POST /api/auth/admin/login`
- `POST /api/masters`
- `GET /api/masters`
- `GET /api/masters/:id`
- `PUT /api/masters/:id`
- `PUT /api/masters/:id/status`
- `PUT /api/masters/:id/permissions`
- `PUT /api/masters/:id/details`
- `POST /api/masters/:id/credit`
- `POST /api/masters/:id/debit`
- `GET /api/masters/:id/position`
- `POST /api/masters/:id/messages`
- `DELETE /api/masters/:id`

### Master Endpoints
- `POST /api/auth/master/login`
- `POST /api/master/masters`
- `POST /api/master/users`
- `GET /api/master/masters`
- `GET /api/master/masters/:id`
- `GET /api/master/users`
- `GET /api/master/users/:id`
- `PUT /api/master/masters/:id/permissions`
- `PUT /api/master/masters/:id/details`
- `PUT /api/master/users/:id/details`
- `POST /api/master/masters/:id/credit`
- `POST /api/master/masters/:id/debit`
- `POST /api/master/users/:id/credit`
- `POST /api/master/users/:id/debit`
- `GET /api/master/masters/:id/position`
- `GET /api/master/users/:id/position`
- `GET /api/master/trades`
- `POST /api/master/masters/:id/messages`
- `POST /api/master/users/:id/messages`
- `GET /api/master/messages`
- `PUT /api/master/messages/:id/read`

---

## Running Tests in Sequence

To run all tests:

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Run Admin Flow tests
node test/testAdminFlow.js

# Terminal 3: Run Master Flow tests
node test/testMasterFlow.js
```

---

## Test Coverage

### Admin Flow Coverage
- ✅ Master CRUD operations
- ✅ Permission management
- ✅ Status updates
- ✅ Credit/Debit operations
- ✅ Position tracking
- ✅ Messaging system
- ✅ New field validation

### Master Flow Coverage
- ✅ Hierarchical master creation
- ✅ User creation with detailed exchange config
- ✅ Child master management
- ✅ User management
- ✅ Credit/Debit for children
- ✅ Permission inheritance
- ✅ Position tracking for hierarchy
- ✅ Trade aggregation
- ✅ Messaging to children
- ✅ `add_master` permission control

---

## Notes

1. **Test Order**: Tests run sequentially and depend on previous tests (e.g., create before update)
2. **Cleanup**: Tests don't automatically clean up created data. You may want to manually delete test data after running
3. **Delays**: Small delays (500ms) between tests prevent rate limiting issues
4. **Tokens**: Tokens are stored in variables and reused across tests
5. **IDs**: Created entity IDs are stored and used in subsequent tests

---

## Future Enhancements

- [ ] Add cleanup function to delete test data
- [ ] Add test for `add_master: false` validation
- [ ] Add test for permission inheritance validation
- [ ] Add test for credit limit validation
- [ ] Add test for hierarchy depth limits
- [ ] Add performance benchmarks
- [ ] Add concurrent request tests
- [ ] Add error scenario tests
