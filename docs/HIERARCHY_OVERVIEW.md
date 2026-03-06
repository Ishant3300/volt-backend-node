# Stocker Platform Hierarchy Overview

## System Architecture

The Stocker platform implements a hierarchical multi-tenant architecture with three user roles:

```
┌─────────────────────────────────────────────────────────────┐
│                           ADMIN                              │
│  - Top-level authority                                       │
│  - Creates and manages Masters                               │
│  - Full system access                                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ creates
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                      MASTER (Level 1)                        │
│  - Created by Admin                                          │
│  - Can create child Masters and Users                        │
│  - Manages their hierarchy                                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ creates
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              MASTER (Level 2) or USER                        │
│  - Created by parent Master                                  │
│  - Masters can create more children                          │
│  - Users are end-nodes (cannot create)                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ continues...
                     ▼
                   (infinite depth possible)
```

---

## Role Capabilities Comparison

| Capability | Admin | Master | User |
|-----------|-------|--------|------|
| Create Masters | ✅ | ✅ | ❌ |
| Create Users | ❌ | ✅ | ❌ |
| Manage own children | ✅ | ✅ | ❌ |
| View hierarchy trades | ✅ | ✅ | Own only |
| Credit/Debit operations | ✅ | ✅ | ❌ |
| Set permissions | ✅ | ✅ (inherited) | ❌ |
| Trade execution | ❌ | ❌ | ✅ |
| View positions | ✅ | ✅ | Own only |

---

## Key Concepts

### 1. Hierarchical Ownership
- Each entity (Master/User) has a `master_id` field pointing to their creator
- Top-level Masters created by Admin have `master_id = null`
- All entities track their `admin_id` for top-level accountability

### 2. Permission Inheritance
- Child entities can only have permissions their parent has
- Permissions flow downward, never upward
- Example:
  ```
  Parent Master: { bet: true, margin_square: false }
  Child Master: { bet: true }  ✅ Valid
  Child Master: { bet: false } ✅ Valid
  Child Master: { margin_square: true } ❌ Invalid (parent doesn't have it)
  ```

### 3. Credit Management
- Credits flow down the hierarchy
- Parent allocates credits to children from their own balance
- Credit transactions are logged for audit trail
- Parent cannot allocate more than they have

### 4. Scope Isolation
- Masters can only see/manage their direct children and descendants
- Masters cannot see siblings or parent's other children
- Admins have full visibility across all hierarchies

---

## Data Model Relationships

### Master Model
```javascript
{
  _id: ObjectId,
  name: String,
  username: String,
  master_id: ObjectId | null,  // null if created by admin
  admin_id: ObjectId,           // tracks top-level admin
  credits: Number,
  permissions: Object,
  // ... other fields
}
```

### User Model
```javascript
{
  _id: ObjectId,
  name: String,
  username: String,
  master_id: ObjectId,  // always set (creator master)
  credits: Number,
  // ... other fields (no permissions)
}
```

### Trade Model
```javascript
{
  _id: ObjectId,
  user_id: ObjectId,
  master_id: ObjectId,  // immediate parent master
  admin_id: ObjectId,   // top-level admin
  // ... trade details
}
```

---

## API Endpoint Structure

### Admin Endpoints (`/api/admin/*`)
- Manage Masters created by this Admin
- View all trades in their hierarchy
- Full CRUD on Masters

### Master Endpoints (`/api/master/*`)
- Manage child Masters and Users
- View trades in their sub-hierarchy
- Full CRUD on children
- **Same operations as Admin, but scoped to their hierarchy**

### User Endpoints (`/api/user/*`)
- Execute trades
- View own positions
- Manage own profile
- No creation/management capabilities

---

## Implementation Strategy

### Phase 1: Model Updates ✅
- [x] Add `master_id` field to Master model
- [x] Update User model with required fields
- [x] Create Trade and CreditTransaction models

### Phase 2: Master Controllers (To Do)
- [ ] Create `masterUserController.js` for user management
- [ ] Create `masterChildController.js` for child master management
- [ ] Implement hierarchy validation logic
- [ ] Implement permission inheritance validation

### Phase 3: Middleware (To Do)
- [ ] Create `authenticateMaster` middleware
- [ ] Add hierarchy validation middleware
- [ ] Add permission inheritance validator

### Phase 4: Routes (To Do)
- [ ] Create `/api/master/masters/*` routes
- [ ] Create `/api/master/users/*` routes
- [ ] Create `/api/master/trades` routes

### Phase 5: Testing (To Do)
- [ ] Test hierarchy creation
- [ ] Test permission inheritance
- [ ] Test credit allocation
- [ ] Test scope isolation

---

## Authorization Logic

### For Master Operations

```javascript
// Pseudo-code for authorization
async function canMasterManageEntity(masterId, entityId, entityType) {
  const entity = await getEntity(entityId, entityType);
  
  // Direct child check
  if (entity.master_id.equals(masterId)) {
    return true;
  }
  
  // Descendant check (recursive)
  if (entityType === 'Master') {
    return await isDescendant(masterId, entityId);
  }
  
  return false;
}

async function isDescendant(ancestorId, descendantId) {
  const descendant = await Master.findById(descendantId);
  if (!descendant.master_id) return false;
  if (descendant.master_id.equals(ancestorId)) return true;
  return await isDescendant(ancestorId, descendant.master_id);
}
```

### For Permission Grants

```javascript
// Pseudo-code for permission validation
async function validatePermissions(parentMasterId, requestedPermissions) {
  const parent = await Master.findById(parentMasterId);
  
  for (const [key, value] of Object.entries(requestedPermissions)) {
    if (value === true && parent.permissions[key] !== true) {
      throw new Error(`Cannot grant permission '${key}' - parent doesn't have it`);
    }
  }
  
  return true;
}
```

---

## Query Patterns

### Get All Children (Direct)
```javascript
// Get all direct children of a master
const children = await Master.find({
  master_id: currentMasterId,
  deleted_at: null
});
```

### Get All Descendants (Recursive)
```javascript
// Get entire sub-hierarchy
async function getAllDescendants(masterId) {
  const directChildren = await Master.find({ master_id: masterId });
  const allDescendants = [...directChildren];
  
  for (const child of directChildren) {
    const childDescendants = await getAllDescendants(child._id);
    allDescendants.push(...childDescendants);
  }
  
  return allDescendants;
}
```

### Get All Trades in Hierarchy
```javascript
// Get all trades from users in master's hierarchy
const descendantMasterIds = await getAllDescendantIds(masterId);
const allMasterIds = [masterId, ...descendantMasterIds];

const trades = await Trade.find({
  master_id: { $in: allMasterIds },
  deleted_at: null
});
```

---

## Credit Flow Example

```
Admin (100,000 credits)
  │
  ├─ Allocates 50,000 to Master A
  │   │
  │   ├─ Master A (50,000 credits)
  │   │   │
  │   │   ├─ Allocates 20,000 to Master B
  │   │   │   │
  │   │   │   └─ Master B (20,000 credits)
  │   │   │       │
  │   │   │       └─ Allocates 5,000 to User 1
  │   │   │           │
  │   │   │           └─ User 1 (5,000 credits)
  │   │   │
  │   │   └─ Allocates 10,000 to User 2
  │   │       │
  │   │       └─ User 2 (10,000 credits)
  │   │
  │   └─ Master A remaining: 20,000 credits
  │
  └─ Admin remaining: 50,000 credits
```

**Rules:**
- Master A cannot allocate more than 50,000 total
- Each allocation reduces parent's available balance
- Credits can be debited back up the hierarchy
- All transactions are logged

---

## Security Considerations

### 1. Horizontal Privilege Escalation Prevention
- Masters cannot access siblings' data
- Strict `master_id` filtering on all queries
- Middleware validates ownership before operations

### 2. Vertical Privilege Escalation Prevention
- Children cannot modify parent's permissions
- Permission grants validated against parent's permissions
- Credit allocations cannot exceed parent's balance

### 3. Audit Trail
- All operations log `master_id` and `admin_id`
- Credit transactions maintain full history
- Soft deletes preserve data for auditing

### 4. Token Security
- Each role has separate JWT tokens
- Tokens include role information
- Middleware validates role matches endpoint

---

## Testing Scenarios

### Hierarchy Creation
1. Admin creates Master A
2. Master A creates Master B
3. Master B creates User 1
4. Verify: User 1 has correct `master_id` and `admin_id`

### Permission Inheritance
1. Admin creates Master A with `bet: true`
2. Master A creates Master B with `bet: true` ✅
3. Master A creates Master C with `margin_square: true` ❌
4. Verify: Master C creation fails

### Credit Allocation
1. Admin allocates 50,000 to Master A
2. Master A allocates 30,000 to Master B
3. Master A attempts to allocate 25,000 to Master C ❌
4. Verify: Allocation fails (only 20,000 remaining)

### Scope Isolation
1. Admin creates Master A and Master B
2. Master A creates User 1
3. Master B attempts to view User 1 ❌
4. Verify: Master B cannot see User 1

---

## Next Steps

1. **Update Master Model**: Add `master_id` field with proper indexing
2. **Create Controllers**: Implement master-specific controllers
3. **Add Middleware**: Create authentication and authorization middleware
4. **Define Routes**: Set up `/api/master/*` route structure
5. **Implement Validation**: Add hierarchy and permission validators
6. **Write Tests**: Comprehensive testing of hierarchy operations
7. **Update Frontend**: Add master management UI

---

## Benefits of This Architecture

1. **Scalability**: Unlimited hierarchy depth
2. **Flexibility**: Each master can manage their own sub-organization
3. **Security**: Strong isolation between hierarchies
4. **Accountability**: Full audit trail through hierarchy
5. **Simplicity**: Same operations at each level, just different scope
