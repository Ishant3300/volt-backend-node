/**
 * Recovery script: Restore positions lost by the May 16 settlement bug.
 * 
 * The bug: Settlement soft-deleted all trades but failed to create re-opening trades
 * because the instruments had last_price=0 in the DB (no bhavcopy data).
 * 
 * This script:
 * 1. Finds positions that existed before the May 16 settlement
 * 2. Creates carry_forward re-opening trades at the last known price
 * 
 * Run: node scripts/recover_settlement_positions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trade = require('../src/models/Trade');
const KiteInstrument = require('../src/models/KiteInstrument');

const SETTLEMENT_DELETE_TIME = new Date('2026-05-16T02:31:16.111Z');

async function recover() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  // Find positions that existed before the May 16 settlement
  const lostPositions = await Trade.aggregate([
    { $match: { deleted_at: SETTLEMENT_DELETE_TIME, status: 'completed' } },
    { $group: {
      _id: { user_id: '$user_id', instrument_token: '$instrument_token' },
      net_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', { $multiply: ['$executed_quantity', -1] }] } },
      total_buy_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, '$executed_quantity', 0] } },
      total_buy_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'BUY'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
      total_sell_qty: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, '$executed_quantity', 0] } },
      total_sell_value: { $sum: { $cond: [{ $eq: ['$transaction_type', 'SELL'] }, { $multiply: ['$executed_quantity', '$executed_price'] }, 0] } },
      tradingsymbol: { $first: '$tradingsymbol' },
      exchange: { $first: '$exchange' },
      master_id: { $first: '$master_id' },
      admin_id: { $first: '$admin_id' },
    }},
    { $match: { net_qty: { $ne: 0 } } },
  ]);

  console.log(`Found ${lostPositions.length} lost position(s) to recover:\n`);

  if (lostPositions.length === 0) {
    console.log('Nothing to recover.');
    await mongoose.disconnect();
    return;
  }

  for (const pos of lostPositions) {
    const tokenStr = pos._id.instrument_token.toString();
    const isLong = pos.net_qty > 0;
    const absQty = Math.abs(pos.net_qty);
    const openSide = isLong ? 'BUY' : 'SELL';
    
    // Calculate the average entry price from the original trades
    const avgEntryPrice = isLong
      ? (pos.total_buy_qty > 0 ? pos.total_buy_value / pos.total_buy_qty : 0)
      : (pos.total_sell_qty > 0 ? pos.total_sell_value / pos.total_sell_qty : 0);

    console.log(`  ${pos.tradingsymbol}: ${openSide} ${absQty} @ avg ${avgEntryPrice.toFixed(2)} (token: ${tokenStr}, user: ${pos._id.user_id})`);

    // Create the re-opening trade at the average entry price
    // (Since we don't have a settlement price, use the avg entry price — this preserves the original position)
    const reopenTrade = await Trade.create({
      user_id: pos._id.user_id,
      master_id: pos.master_id,
      admin_id: pos.admin_id || null,
      instrument_token: tokenStr,
      tradingsymbol: pos.tradingsymbol,
      exchange: pos.exchange,
      transaction_type: openSide,
      quantity: absQty,
      price: avgEntryPrice,
      order_type: 'MARKET',
      placed_by: 'SYSTEM',
      trade_type: 'carry_forward',
      status: 'completed',
      executed_at: new Date(),
      executed_price: avgEntryPrice,
      executed_quantity: absQty,
      pnl: 0,
      remarks: 'Recovery: position restored after settlement bug (no close price available)',
    });

    console.log(`    ✅ Created: ${reopenTrade._id}`);
  }

  // Also update the KiteInstrument last_price for these tokens using the avg entry price
  // so that future settlement runs can find them
  console.log('\nUpdating KiteInstrument last_price for affected tokens...');
  for (const pos of lostPositions) {
    const tokenStr = pos._id.instrument_token.toString();
    const isLong = pos.net_qty > 0;
    const avgEntryPrice = isLong
      ? (pos.total_buy_qty > 0 ? pos.total_buy_value / pos.total_buy_qty : 0)
      : (pos.total_sell_qty > 0 ? pos.total_sell_value / pos.total_sell_qty : 0);

    if (avgEntryPrice > 0) {
      await KiteInstrument.updateOne(
        { instrument_token: tokenStr },
        { $set: { last_price: avgEntryPrice } }
      );
      console.log(`  Token ${tokenStr} (${pos.tradingsymbol}): last_price set to ${avgEntryPrice.toFixed(2)}`);
    }
  }

  console.log('\n✅ Recovery complete. Restart the server to rebuild metricsEngine caches.');
  await mongoose.disconnect();
}

recover().catch(e => { console.error(e); process.exit(1); });
