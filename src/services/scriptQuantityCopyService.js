/**
 * Script Quantity Copy Service
 * 
 * Handles copying ScriptQuantity data when creating masters/users:
 * - Admin creates Master → copy from GroupedQuantity (global data)
 * - Master creates Sub-Master → copy from parent master's ScriptQuantity
 * - Master creates User → copy from master's ScriptQuantity
 * 
 * Also handles cascade updates:
 * - Master's ScriptQuantity updated → propagate to all direct users
 */

const ScriptQuantity = require('../models/ScriptQuantity');
const GroupedQuantity = require('../models/GroupedQuantity');
const User = require('../models/User');

/**
 * Copy GroupedQuantity (global) data into ScriptQuantity for a new master.
 * Called when admin creates the first-level master.
 * @param {string} masterId - The new master's _id
 * @param {object} [session] - Optional mongoose session
 */
async function copyFromGroupedQuantityToMaster(masterId, session) {
  try {
    // Get all active GroupedQuantity entries
    const groupedData = await GroupedQuantity.find({ deleted_at: null })
      .select('exchange_name raw_name max_qty break_qty lot_size')
      .lean();

    if (groupedData.length === 0) return;

    // Deduplicate by exchange_name + raw_name (take the first/default group's values)
    const seen = new Set();
    const uniqueEntries = [];
    for (const gq of groupedData) {
      const key = `${gq.exchange_name}|${gq.raw_name}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueEntries.push(gq);
      }
    }

    const docs = uniqueEntries.map(gq => ({
      owner_id: masterId,
      owner_type: 'Master',
      exchange_name: gq.exchange_name,
      script_name: gq.raw_name,
      lot_size: gq.lot_size || 1,
      max_qty: gq.max_qty || 0,
      brk_qty: gq.break_qty || 0,
    }));

    if (docs.length > 0) {
      if (session) {
        await ScriptQuantity.insertMany(docs, { session });
      } else {
        await ScriptQuantity.insertMany(docs);
      }
      console.log(`📋 [ScriptQtyCopy] Copied ${docs.length} entries from GroupedQuantity to Master ${masterId}`);
    }
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error copying to master ${masterId}:`, e.message);
  }
}

/**
 * Copy a parent master's ScriptQuantity data to a new sub-master.
 * Called when a master creates a child master.
 * @param {string} parentMasterId - The parent master's _id
 * @param {string} childMasterId - The new child master's _id
 * @param {object} [session] - Optional mongoose session
 */
async function copyFromMasterToSubMaster(parentMasterId, childMasterId, session) {
  try {
    const parentData = await ScriptQuantity.find({
      owner_id: parentMasterId,
      owner_type: 'Master',
      deleted_at: null,
    }).lean();

    if (parentData.length === 0) return;

    const docs = parentData.map(sq => ({
      owner_id: childMasterId,
      owner_type: 'Master',
      exchange_name: sq.exchange_name,
      script_name: sq.script_name,
      lot_size: sq.lot_size,
      max_qty: sq.max_qty,
      brk_qty: sq.brk_qty,
    }));

    if (docs.length > 0) {
      if (session) {
        await ScriptQuantity.insertMany(docs, { session });
      } else {
        await ScriptQuantity.insertMany(docs);
      }
      console.log(`📋 [ScriptQtyCopy] Copied ${docs.length} entries from Master ${parentMasterId} to Sub-Master ${childMasterId}`);
    }
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error copying to sub-master ${childMasterId}:`, e.message);
  }
}

/**
 * Copy a master's ScriptQuantity data to a new user.
 * Called when a master creates a user.
 * @param {string} masterId - The master's _id
 * @param {string} userId - The new user's _id
 * @param {object} [session] - Optional mongoose session
 */
async function copyFromMasterToUser(masterId, userId, session) {
  try {
    const masterData = await ScriptQuantity.find({
      owner_id: masterId,
      owner_type: 'Master',
      deleted_at: null,
    }).lean();

    if (masterData.length === 0) return;

    const docs = masterData.map(sq => ({
      owner_id: userId,
      owner_type: 'User',
      exchange_name: sq.exchange_name,
      script_name: sq.script_name,
      lot_size: sq.lot_size,
      max_qty: sq.max_qty,
      brk_qty: sq.brk_qty,
    }));

    if (docs.length > 0) {
      if (session) {
        await ScriptQuantity.insertMany(docs, { session });
      } else {
        await ScriptQuantity.insertMany(docs);
      }
      console.log(`📋 [ScriptQtyCopy] Copied ${docs.length} entries from Master ${masterId} to User ${userId}`);
    }
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error copying to user ${userId}:`, e.message);
  }
}

/**
 * Cascade a master's ScriptQuantity update to all direct users.
 * Called when admin/master updates ScriptQuantity on a master's profile.
 * Only updates direct users (not sub-masters' users).
 * @param {string} masterId - The master whose data was updated
 * @param {string} exchangeName - The exchange that was updated
 * @param {string} scriptName - The script/raw_name that was updated
 * @param {object} newValues - { max_qty, brk_qty, lot_size }
 */
async function cascadeToDirectUsers(masterId, exchangeName, scriptName, newValues) {
  try {
    // Find all direct users of this master
    const directUsers = await User.find({
      master_id: masterId,
      deleted_at: null,
    }).select('_id').lean();

    if (directUsers.length === 0) return;

    const userIds = directUsers.map(u => u._id);

    // Update all matching ScriptQuantity entries for these users
    const result = await ScriptQuantity.updateMany(
      {
        owner_id: { $in: userIds },
        owner_type: 'User',
        exchange_name: exchangeName.toUpperCase(),
        script_name: scriptName,
        deleted_at: null,
      },
      {
        $set: {
          max_qty: newValues.max_qty,
          brk_qty: newValues.brk_qty,
          ...(newValues.lot_size !== undefined ? { lot_size: newValues.lot_size } : {}),
          updated_at: new Date(),
        },
      }
    );

    console.log(`📋 [ScriptQtyCopy] Cascaded ${scriptName}/${exchangeName} update to ${result.modifiedCount}/${directUsers.length} direct users of Master ${masterId}`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error cascading to users:`, e.message);
  }
}

module.exports = {
  copyFromGroupedQuantityToMaster,
  copyFromMasterToSubMaster,
  copyFromMasterToUser,
  cascadeToDirectUsers,
};
