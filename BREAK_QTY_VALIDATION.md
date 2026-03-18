# Break Quantity Validation Implementation ✅

## Overview
Added validation for `break_qty` (breakup quantity) from `GroupedQuantity` to enforce per-order limits on trading.

## Business Rules

### 1. max_qty (Maximum Position Limit)
- **Definition**: Maximum total lots a user can hold for a specific instrument
- **Example**: If `max_qty = 5`, user can hold maximum 5 lots total

### 2. break_qty (Breakup Quantity / Per-Order Limit)
- **Definition**: Maximum lots allowed in a single order
- **Example**: If `break_qty = 1`, user can only buy/sell 1 lot at a time
- **Purpose**: Forces users to split large orders into smaller chunks

## Implementation

### Data Source
```javascript
// From GroupedQuantity model
{
  exchange_name: "MCX-OPT",
  lot_name: "LOT_A",
  instrument_id: "12345",
  instrument_symbol: "COPPER1030CE23MAR25",
  max_qty: 5,        // Max 5 lots total position
  break_qty: 1,      // Max 1 lot per order
  lot_size: 1        // From Zerodha (will be converted to 100 for MCX)
}
```

### Validation Order (in tradeController.js)

#### Step 1: Calculate Lot Size
```javascript
// Get lot_size from KiteInstrument
let lotSize = kiteInst?.lot_size || 1;

// Apply MCX business rule (1 lot = 100 qty)
const isMCX = normalizedExchange === 'MCX-FUT' || normalizedExchange === 'MCX-OPT';
if (isMCX && lotSize === 1) {
  lotSize = 100;
}
```

#### Step 2: Get Limits from GroupedQuantity
```javascript
const groupQty = await GroupedQuantity.findOne({
  exchange_name: normalizedExchange,
  lot_name: groupName,
  instrument_id: instrument_token,
  deleted_at: null
});

const lotLimit = groupQty.max_qty;    // e.g., 5 lots
const breakQty = groupQty.break_qty;  // e.g., 1 lot
```

#### Step 3: Validate Break Quantity (Per-Order Limit)
```javascript
const requestedLots = Math.ceil(quantity / lotSize);

if (breakQty > 0 && requestedLots > breakQty) {
  throw new Error(
    `Order size exceeds breakup limit. ` +
    `Max lots per order: ${breakQty}, Requested: ${requestedLots} lot(s). ` +
    `Please split your order into smaller quantities.`
  );
}
```

#### Step 4: Validate Maximum Position Limit
```javascript
const currentLots = Math.floor(Math.abs(currentNetQty) / lotSize);
const remainingLotsByLimit = Math.max(0, lotLimit - currentLots);

if (requestedLots > remainingLotsByLimit) {
  throw new Error(
    `Order exceeds maximum position limit. ` +
    `Max allowed: ${lotLimit} lot(s), Current position: ${currentLots} lot(s), ` +
    `Remaining: ${remainingLotsByLimit} lot(s), Requested: ${requestedLots} lot(s).`
  );
}
```

#### Step 5: Validate Sufficient Balance
```javascript
const marginPerLot = await calculateMargin(normalizedExchange, lotSize, priceForMargin);
const maxAffordableLots = Math.floor(availableBalance / marginPerLot);

if (requestedLots > maxAffordableLots) {
  throw new Error(
    `Insufficient balance for ${requestedLots} lot(s). ` +
    `Available: ₹${availableBalance.toFixed(2)}, Required: ₹${requiredMargin.toFixed(2)}.`
  );
}
```

## Example Scenarios

### Scenario 1: Break Quantity Violation
**Setup:**
- Instrument: COPPER 1030 CE (MCX-OPT)
- lot_size: 100 (after MCX conversion)
- max_qty: 5 lots
- break_qty: 1 lot
- User tries to buy: 200 qty (2 lots)

**Result:**
```
❌ Error: Order size exceeds breakup limit. 
Max lots per order: 1, Requested: 2 lot(s). 
Please split your order into smaller quantities.
```

**Solution:** User must place two separate orders of 100 qty each.

### Scenario 2: Maximum Position Limit
**Setup:**
- max_qty: 5 lots
- Current position: 4 lots
- User tries to buy: 200 qty (2 lots)

**Result:**
```
❌ Error: Order exceeds maximum position limit. 
Max allowed: 5 lot(s), Current position: 4 lot(s), 
Remaining: 1 lot(s), Requested: 2 lot(s).
```

**Solution:** User can only buy 1 more lot (100 qty).

### Scenario 3: Successful Order
**Setup:**
- max_qty: 5 lots
- break_qty: 2 lots
- Current position: 0 lots
- User tries to buy: 100 qty (1 lot)
- Balance: Sufficient

**Result:**
```
✅ Trade executed successfully
```

## MCX Lot Size Handling

### Important Note:
The code now properly handles MCX lot sizes:

```javascript
// Zerodha returns lot_size = 1 for MCX
// But MCX trading rule: 1 lot = 100 qty
const isMCX = normalizedExchange === 'MCX-FUT' || normalizedExchange === 'MCX-OPT';
if (isMCX && lotSize === 1) {
  lotSize = 100; // Apply MCX business rule
}
```

This ensures:
- Database stores `lot_size = 1` (accurate Zerodha data)
- Application logic applies `lot_size = 100` (MCX trading rule)
- Validations work correctly with actual trading quantities

## Testing Checklist

### Test 1: Break Quantity Validation
- [ ] Set break_qty = 1 for an MCX instrument
- [ ] Try to buy 2 lots (200 qty)
- [ ] Verify error: "Order size exceeds breakup limit"

### Test 2: Maximum Position Validation
- [ ] Set max_qty = 3 for an instrument
- [ ] Buy 2 lots
- [ ] Try to buy 2 more lots
- [ ] Verify error: "Order exceeds maximum position limit"

### Test 3: Successful Order Within Limits
- [ ] Set break_qty = 2, max_qty = 5
- [ ] Buy 1 lot (100 qty for MCX)
- [ ] Verify order executes successfully

### Test 4: MCX Lot Size Conversion
- [ ] Verify MCX instruments use lot_size = 100
- [ ] Verify non-MCX instruments use their actual lot_size
- [ ] Check validation calculations are correct

## Files Modified

1. **stocker-backend-node/src/controllers/tradeController.js**
   - Added break_qty validation
   - Added MCX lot_size conversion
   - Improved error messages
   - Reordered validations for better UX

## Benefits

1. **Risk Management**: Prevents users from placing excessively large orders
2. **Compliance**: Enforces exchange-specific trading rules
3. **User Protection**: Forces gradual position building
4. **Clear Errors**: Detailed error messages help users understand limits
5. **Flexibility**: Different limits per instrument/group

## Status: COMPLETE ✅

Break quantity validation is now fully implemented and integrated with MCX lot size handling.
