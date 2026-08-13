const fs = require('fs');

let content = fs.readFileSync('src/services/scriptQuantityCopyService.js', 'utf8');

// Add bulkCascadeNewScriptsToUsers
const bulkFn = `
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
      console.log(\`📋 [ScriptQtyCopy] Bulk cascaded \${scripts.length} scripts for \${normalizedExchange} to \${userIds.length} users (upserted: \${result.upsertedCount}, modified: \${result.modifiedCount})\`);
    }
  } catch (e) {
    console.error(\`❌ [ScriptQtyCopy] Error bulk cascading new scripts:\`, e.message);
  }
}

module.exports = {`;

content = content.replace('module.exports = {', bulkFn);
content = content.replace('cascadeDeleteScriptGlobally,', 'cascadeDeleteScriptGlobally,\n  bulkCascadeNewScriptsToUsers,');

fs.writeFileSync('src/services/scriptQuantityCopyService.js', content, 'utf8');
