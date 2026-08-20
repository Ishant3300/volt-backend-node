/**
 * Script Quantity Copy Service
 *
 * GroupedQuantity is Admin's universal catalog of named "Groups" (per
 * exchange+script) — available to every Master to choose from, not scoped
 * or assigned per master. ScriptQuantity is the actual enforced per-owner
 * limit that trade placement checks against.
 *
 * - Admin creates Master → copy from GroupedQuantity (merges every group;
 *   masters aren't themselves assigned one specific group)
 * - Master creates Sub-Master → copy from parent master's ScriptQuantity
 * - Master creates User → seeded from the specific Group picked per
 *   exchange on the creation form (seedUserScriptQuantityFromGroups) — a
 *   user's assigned Group is also the ceiling any later per-script edit
 *   for that user must respect; raising above it requires switching the
 *   user to a different Group first (reseedUserScriptQuantityForExchange)
 */

const ScriptQuantity = require('../models/ScriptQuantity');
const GroupedQuantity = require('../models/GroupedQuantity');
const User = require('../models/User');
const Master = require('../models/Master');

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
 * Seeds a new user's ScriptQuantity from the per-exchange "Group" selected
 * at creation (the mobile app's Create User screen: an exchange row, a
 * turnover/lot toggle, and a Group dropdown — `exchanges_allowed[].group_name`).
 *
 * Previously group_name was required by the API, stored on the user
 * record, and then never read again — copyFromMasterToUser always just
 * copied whatever the parent master's CURRENT ScriptQuantity happened to
 * be, so picking a different group in the UI had no effect on the user's
 * actual trading limits at all.
 *
 * GroupedQuantity is Admin's universal set of named groups — available to
 * ANY master to choose from, not scoped or capped per master. A master
 * picks ONE group per exchange for a new user, and that group's values are
 * copied to the user directly, as-is — group definitions themselves can
 * only be created/edited by Admin, never by a master. If a master wants a
 * SPECIFIC user to trade more (or less) than their assigned group allows
 * on a particular script, that's done afterward via the separate Script
 * Qty editing endpoint, not by changing the group.
 *
 * For each exchange the new user is being granted, looks up GroupedQuantity
 * rows for that (exchange_name, lot_name === group_name) pair — that's
 * what a "named group" actually is in this data model — and seeds one
 * ScriptQuantity row per script in that group with the group's own values,
 * unmodified.
 *
 * @param {string} userId
 * @param {Array<{exchange_name: string, group_name: string}>} exchangesAllowed
 * @param {object} [session]
 */
async function seedUserScriptQuantityFromGroups(userId, exchangesAllowed, session) {
  try {
    const docs = [];

    for (const ex of exchangesAllowed || []) {
      const exchangeName = (ex.exchange_name || '').toUpperCase();
      if (!exchangeName || !ex.group_name) continue;

      const groupRows = await (session
        ? GroupedQuantity.find({ exchange_name: exchangeName, lot_name: ex.group_name, deleted_at: null }).session(session)
        : GroupedQuantity.find({ exchange_name: exchangeName, lot_name: ex.group_name, deleted_at: null })
      ).lean();

      for (const gq of groupRows) {
        docs.push({
          owner_id: userId,
          owner_type: 'User',
          exchange_name: exchangeName,
          script_name: gq.raw_name,
          lot_size: gq.lot_size || 1,
          max_qty: gq.max_qty || 0,
          brk_qty: gq.break_qty || 0,
        });
      }
    }

    if (docs.length > 0) {
      if (session) {
        await ScriptQuantity.insertMany(docs, { session });
      } else {
        await ScriptQuantity.insertMany(docs);
      }
      console.log(`📋 [ScriptQtyCopy] Seeded ${docs.length} entries for User ${userId} from their assigned groups`);
    }
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error seeding user ${userId} from groups:`, e.message);
  }
}

/**
 * Re-seeds a user's ScriptQuantity for ONE exchange when their assigned
 * Group for that exchange is changed after creation. A master can lower a
 * user's individual script limits within their current group's max, but
 * raising above it requires switching the user to a different (higher)
 * group first — this is what applies that switch: replaces every existing
 * ScriptQuantity row this user has for the given exchange with the new
 * group's values, exactly as if the user were being created fresh with
 * that group (any prior per-script override for this exchange is
 * intentionally discarded, since it belonged to the old group's ceiling).
 *
 * @param {string} userId
 * @param {string} exchangeName
 * @param {string} groupName
 * @param {object} [session]
 */
async function reseedUserScriptQuantityForExchange(userId, exchangeName, groupName, session) {
  try {
    const normalizedExchange = exchangeName.toUpperCase();

    const groupRows = await (session
      ? GroupedQuantity.find({ exchange_name: normalizedExchange, lot_name: groupName, deleted_at: null }).session(session)
      : GroupedQuantity.find({ exchange_name: normalizedExchange, lot_name: groupName, deleted_at: null })
    ).lean();

    const deleteQuery = { owner_id: userId, owner_type: 'User', exchange_name: normalizedExchange, deleted_at: null };
    if (session) {
      await ScriptQuantity.updateMany(deleteQuery, { $set: { deleted_at: new Date() } }, { session });
    } else {
      await ScriptQuantity.updateMany(deleteQuery, { $set: { deleted_at: new Date() } });
    }

    if (groupRows.length === 0) {
      console.log(`📋 [ScriptQtyCopy] User ${userId} switched to group "${groupName}" on ${normalizedExchange}, but that group has no data — exchange now has no script limits`);
      return;
    }

    const docs = groupRows.map(gq => ({
      owner_id: userId,
      owner_type: 'User',
      exchange_name: normalizedExchange,
      script_name: gq.raw_name,
      lot_size: gq.lot_size || 1,
      max_qty: gq.max_qty || 0,
      brk_qty: gq.break_qty || 0,
    }));

    if (session) {
      await ScriptQuantity.insertMany(docs, { session });
    } else {
      await ScriptQuantity.insertMany(docs);
    }
    console.log(`📋 [ScriptQtyCopy] Re-seeded ${docs.length} entries for User ${userId} on ${normalizedExchange} from group "${groupName}"`);
  } catch (e) {
    console.error(`❌ [ScriptQtyCopy] Error re-seeding user ${userId} for ${exchangeName}:`, e.message);
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
  seedUserScriptQuantityFromGroups,
  reseedUserScriptQuantityForExchange,
  cascadeToDirectUsers,
  cascadeNewScriptToUsers,
  cascadeDeleteScriptToUsers,
  cascadeNewScriptGlobally,
  cascadeDeleteScriptGlobally,
  bulkCascadeNewScriptsToUsers,
};
