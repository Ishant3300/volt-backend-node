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

/**
 * Cascade a NEW script entry to all direct users of a master.
 * Called when admin/master creates a new ScriptQuantity for a master.
 * Upserts the record for each user so existing ones are updated, new ones are created.
 * @param {string} masterId
 * @param {string} exchangeName
 * @param {string} scriptName
 * @param {object} values - { lot_size, max_qty, brk_qty }
 */
async function cascadeNewScriptToUsers(masterId, exchangeName, scriptName, values) {
  try {
    const directUsers = await User.find({
      master_id: masterId,
      deleted_at: null,
    }).select('_id').lean();

    if (directUsers.length === 0) return;

    const normalizedExchange = exchangeName.toUpperCase();
    const now = new Date();

    const bulkOps = directUsers.map(u => ({
      updateOne: {
        filter: {
          owner_id: u._id,
          owner_type: 'User',
          exchange_name: normalizedExchange,
          script_name: scriptName,
          deleted_at: null,
        },
        update: {
          $set: {
            lot_size: values.lot_size,
            max_qty: values.max_qty,
            brk_qty: values.brk_qty,
            updated_at: now,
            deleted_at: null,
          },
          $setOnInsert: {
            owner_id: u._id,
            owner_type: 'User',
            exchange_name: normalizedExchange,
            script_name: scriptName,
            created_at: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await ScriptQuantity.bulkWrite(bulkOps);
    console.log(`📋 [ScriptQtyCopy] Cascaded new script ${scriptName}/${normalizedExchange} to ${directUsers.length} users of Master ${masterId} (upserted: ${result.upsertedCount}, modified: ${result.modifiedCount})`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error cascading new script to users:`, e.message);
  }
}

/**
 * Cascade a soft-delete to all direct users of a master for a specific script.
 * Called when admin/master deletes a ScriptQuantity on a master.
 * @param {string} masterId
 * @param {string} exchangeName
 * @param {string} scriptName
 */
async function cascadeDeleteScriptToUsers(masterId, exchangeName, scriptName) {
  try {
    const directUsers = await User.find({
      master_id: masterId,
      deleted_at: null,
    }).select('_id').lean();

    if (directUsers.length === 0) return;

    const userIds = directUsers.map(u => u._id);
    const normalizedExchange = exchangeName.toUpperCase();

    const result = await ScriptQuantity.updateMany(
      {
        owner_id: { $in: userIds },
        owner_type: 'User',
        exchange_name: normalizedExchange,
        script_name: scriptName,
        deleted_at: null,
      },
      { $set: { deleted_at: new Date() } }
    );

    console.log(`📋 [ScriptQtyCopy] Cascade-deleted ${scriptName}/${normalizedExchange} for ${result.modifiedCount}/${directUsers.length} users of Master ${masterId}`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error cascading delete to users:`, e.message);
  }
}

/**
 * Cascade a NEW script from Admin (global) to all Masters and their direct users.
 * Called when admin creates a ScriptQuantity at the global level.
 * @param {string} exchangeName
 * @param {string} scriptName
 * @param {object} values - { lot_size, max_qty, brk_qty }
 */
/**
 * Cascade a NEW script from Admin to their own Masters and those Masters' users.
 * Called when admin creates/updates a ScriptQuantity at their level.
 * @param {string} exchangeName
 * @param {string} scriptName
 * @param {object} values - { lot_size, max_qty, brk_qty }
 * @param {string} [adminId] - The admin's ID to scope cascade to their hierarchy only
 */
async function cascadeNewScriptGlobally(exchangeName, scriptName, values, adminId) {
  try {
    const Master = require('../models/Master');
    
    // If adminId is provided, only cascade to that admin's masters
    const masterFilter = { deleted_at: null };
    if (adminId) {
      masterFilter.admin_id = adminId;
    }
    const allMasters = await Master.find(masterFilter).select('_id').lean();

    if (allMasters.length === 0) return;

    const normalizedExchange = exchangeName.toUpperCase();
    const now = new Date();

    const masterIds = allMasters.map(m => m._id);

    // First: updateMany to update ALL existing master records (handles duplicates)
    await ScriptQuantity.updateMany(
      {
        owner_id: { $in: masterIds },
        owner_type: 'Master',
        exchange_name: normalizedExchange,
        script_name: scriptName,
        deleted_at: null,
      },
      { $set: { lot_size: values.lot_size, max_qty: values.max_qty, brk_qty: values.brk_qty, updated_at: now } }
    );

    // Then: upsert for masters who don't have a record yet
    const masterBulkOps = allMasters.map(m => ({
      updateOne: {
        filter: {
          owner_id: m._id,
          owner_type: 'Master',
          exchange_name: normalizedExchange,
          script_name: scriptName,
          deleted_at: null,
        },
        update: {
          $set: { lot_size: values.lot_size, max_qty: values.max_qty, brk_qty: values.brk_qty, updated_at: now, deleted_at: null },
          $setOnInsert: { owner_id: m._id, owner_type: 'Master', exchange_name: normalizedExchange, script_name: scriptName, created_at: now },
        },
        upsert: true,
      },
    }));
    await ScriptQuantity.bulkWrite(masterBulkOps);

    // Same for users under these masters
    const allUsers = await User.find({ master_id: { $in: masterIds }, deleted_at: null }).select('_id').lean();

    if (allUsers.length > 0) {
      const userIds = allUsers.map(u => u._id);

      // Update ALL existing user records for this script (handles duplicates)
      await ScriptQuantity.updateMany(
        {
          owner_id: { $in: userIds },
          owner_type: 'User',
          exchange_name: normalizedExchange,
          script_name: scriptName,
          deleted_at: null,
        },
        { $set: { lot_size: values.lot_size, max_qty: values.max_qty, brk_qty: values.brk_qty, updated_at: now } }
      );

      // Upsert for users who don't have a record yet
      const userBulkOps = allUsers.map(u => ({
        updateOne: {
          filter: {
            owner_id: u._id,
            owner_type: 'User',
            exchange_name: normalizedExchange,
            script_name: scriptName,
            deleted_at: null,
          },
          update: {
            $set: { lot_size: values.lot_size, max_qty: values.max_qty, brk_qty: values.brk_qty, updated_at: now, deleted_at: null },
            $setOnInsert: { owner_id: u._id, owner_type: 'User', exchange_name: normalizedExchange, script_name: scriptName, created_at: now },
          },
          upsert: true,
        },
      }));
      await ScriptQuantity.bulkWrite(userBulkOps);
    }

    console.log(`📋 [ScriptQtyCopy] Globally cascaded new script ${scriptName}/${normalizedExchange} to ${allMasters.length} masters and ${allUsers.length} users`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error globally cascading new script:`, e.message);
  }
}

/**
 * Cascade a soft-delete to all Masters and their users for a specific script.
 * Called when admin deletes a global-level ScriptQuantity.
 * @param {string} exchangeName
 * @param {string} scriptName
 * @param {string} [adminId] - The admin's ID to scope cascade to their hierarchy only
 */
async function cascadeDeleteScriptGlobally(exchangeName, scriptName, adminId) {
  try {
    const Master = require('../models/Master');
    const normalizedExchange = exchangeName.toUpperCase();
    const now = new Date();

    // Find only this admin's masters
    const masterFilter = { deleted_at: null };
    if (adminId) {
      masterFilter.admin_id = adminId;
    }
    const masters = await Master.find(masterFilter).select('_id').lean();
    const masterIds = masters.map(m => m._id);

    // Delete for masters
    await ScriptQuantity.updateMany(
      {
        owner_id: { $in: masterIds },
        owner_type: 'Master',
        exchange_name: normalizedExchange,
        script_name: scriptName,
        deleted_at: null,
      },
      { $set: { deleted_at: now } }
    );

    // Delete for users under those masters
    const allUsers = await User.find({ master_id: { $in: masterIds }, deleted_at: null }).select('_id').lean();
    if (allUsers.length > 0) {
      const userIds = allUsers.map(u => u._id);
      await ScriptQuantity.updateMany(
        {
          owner_id: { $in: userIds },
          owner_type: 'User',
          exchange_name: normalizedExchange,
          script_name: scriptName,
          deleted_at: null,
        },
        { $set: { deleted_at: now } }
      );
    }

    console.log(`📋 [ScriptQtyCopy] Deleted script ${scriptName}/${normalizedExchange} for ${masterIds.length} masters and ${allUsers.length} users`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error cascading delete:`, e.message);
  }
}


/**
 * Cascade NEW scripts from Master to their direct users in bulk.
 * @param {string} masterId
 * @param {string} exchangeName
 * @param {Array} scripts - [{ script_name, max_qty, brk_qty, lot_size }]
 */
async function bulkCascadeNewScriptsToUsers(masterId, exchangeName, scripts) {
  try {
    const directUsers = await User.find({ master_id: masterId, deleted_at: null }).select('_id').lean();
    if (directUsers.length === 0) return;

    const userIds = directUsers.map(u => u._id);
    const normalizedExchange = exchangeName.toUpperCase();
    const now = new Date();

    const bulkOps = [];
    for (const u of userIds) {
      for (const s of scripts) {
        bulkOps.push({
          updateOne: {
            filter: {
              owner_id: u,
              owner_type: 'User',
              exchange_name: normalizedExchange,
              script_name: s.script_name,
              deleted_at: null,
            },
            update: {
              $set: { lot_size: s.lot_size, max_qty: s.max_qty, brk_qty: s.brk_qty, updated_at: now, deleted_at: null },
              $setOnInsert: { owner_id: u, owner_type: 'User', exchange_name: normalizedExchange, script_name: s.script_name, created_at: now },
            },
            upsert: true,
          }
        });
      }
    }

    if (bulkOps.length > 0) {
      const result = await ScriptQuantity.bulkWrite(bulkOps);
      console.log(`📋 [ScriptQtyCopy] Bulk cascaded ${scripts.length} scripts for ${normalizedExchange} to ${userIds.length} users (upserted: ${result.upsertedCount}, modified: ${result.modifiedCount})`);
    }
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error bulk cascading new scripts:`, e.message);
  }
}

module.exports = {
  copyFromGroupedQuantityToMaster,
  copyFromMasterToSubMaster,
  copyFromMasterToUser,
  cascadeToDirectUsers,
  cascadeNewScriptToUsers,
  cascadeDeleteScriptToUsers,
  cascadeNewScriptGlobally,
  cascadeDeleteScriptGlobally,
  bulkCascadeNewScriptsToUsers,
};
