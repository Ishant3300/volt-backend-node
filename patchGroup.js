const fs = require('fs');

let content = fs.readFileSync('src/controllers/groupedQuantityController.js', 'utf8');

content = content.replace(
/max_qty: default_max_qty,\s*break_qty: default_break_qty,/,
''
);
content = content.replace(
/\$set: \{/,
'$set: {\n            max_qty: default_max_qty,\n            break_qty: default_break_qty,'
);

// Now patch bulkCreateScriptQuantity
content = content.replace(
/const bulkCreateScriptQuantity = async \(req, res\) => \{[\s\S]*?(?=^\/\/ GET \/api\/admin\/script-quantities\/exchange)/m,
`const bulkCreateScriptQuantity = async (req, res) => {
  try {
    const { exchange_name, default_max_qty, default_brk_qty, owner_id, owner_type } = req.body;
    if (!exchange_name || default_max_qty === undefined || default_brk_qty === undefined) {
      return res.status(400).json({ success: false, message: 'exchange_name, default_max_qty, and default_brk_qty are required', data: null });
    }
    const normalizedExchange = exchange_name.toUpperCase();
    const filter = buildSegmentFilter(normalizedExchange);
    const results = await KiteInstrument.aggregate([
      { $match: filter },
      { $group: { _id: '$raw_name', lot_size: { $first: '$lot_size' } } },
      { $sort: { _id: 1 } }
    ]);
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: \`No instruments found for \${normalizedExchange}\`, data: null });
    }

    const effectiveOwnerId = owner_id || (req.admin ? req.admin.id : req.master?.id);
    const effectiveOwnerType = owner_id ? (owner_type || 'User') : (req.admin ? 'Admin' : 'Master');

    if (req.master) {
      if (effectiveOwnerId !== req.master.id) {
        if (effectiveOwnerType !== 'User') {
          return res.status(403).json({ success: false, message: 'Not authorized to create for this owner type' });
        }
        const user = await User.findById(effectiveOwnerId);
        if (!user || user.master_id.toString() !== req.master.id) {
          return res.status(403).json({ success: false, message: 'Not authorized to create for this user' });
        }
      }

      // We only check against the first script for limit ceiling, as bulk applies the same limit.
      const sampleScript = results[0]._id;
      let ceilingLimit;
      if (effectiveOwnerId === req.master.id) {
        const adminGlobal = await ScriptQuantity.findOne({ owner_type: 'Admin', exchange_name: normalizedExchange, script_name: sampleScript, deleted_at: null }).lean();
        if (!adminGlobal) {
          return res.status(400).json({ success: false, message: 'Admin has not set global limits for this exchange' });
        }
        ceilingLimit = adminGlobal.max_qty;
      } else {
        const masterLimit = await ScriptQuantity.findOne({ owner_id: req.master.id, owner_type: 'Master', exchange_name: normalizedExchange, script_name: sampleScript, deleted_at: null }).lean();
        if (!masterLimit) {
          return res.status(400).json({ success: false, message: 'You do not have a limit set for this exchange' });
        }
        ceilingLimit = masterLimit.max_qty;
      }

      if (default_max_qty > ceilingLimit) {
        return res.status(400).json({ success: false, message: \`max_qty cannot exceed limit of \${ceilingLimit}\` });
      }
    }

    const baseFilter = { exchange_name: normalizedExchange, owner_id: effectiveOwnerId, owner_type: effectiveOwnerType, deleted_at: null };

    const bulkOps = results.map(r => ({
      updateOne: {
        filter: { ...baseFilter, script_name: r._id },
        update: {
          $setOnInsert: {
            exchange_name: normalizedExchange,
            script_name: r._id,
            owner_id: effectiveOwnerId,
            owner_type: effectiveOwnerType,
            created_at: new Date(),
          },
          $set: { 
            lot_size: r.lot_size || 1,
            max_qty: default_max_qty,
            brk_qty: default_brk_qty,
            updated_at: new Date(), 
            deleted_at: null 
          }
        },
        upsert: true
      }
    }));
    const bulkResult = await ScriptQuantity.bulkWrite(bulkOps);

    if (effectiveOwnerType === 'Master') {
      const { bulkCascadeNewScriptsToUsers } = require('../services/scriptQuantityCopyService');
      const scriptsToCascade = results.map(r => ({ script_name: r._id, max_qty: default_max_qty, brk_qty: default_brk_qty, lot_size: r.lot_size || 1 }));
      await bulkCascadeNewScriptsToUsers(effectiveOwnerId, normalizedExchange, scriptsToCascade);
    }

    if (effectiveOwnerType === 'Admin') {
      const { cascadeNewScriptGlobally } = require('../services/scriptQuantityCopyService');
      // For Admin, global cascade is still heavy. Maybe they don't bulk create often.
      // We will leave the loop for Admin as they run it rarely.
      for (const r of results) {
        await cascadeNewScriptGlobally(normalizedExchange, r._id, {
          lot_size: r.lot_size || 1,
          max_qty: default_max_qty,
          brk_qty: default_brk_qty,
        }, effectiveOwnerId);
      }
    }

    res.status(201).json({
      success: true,
      message: \`Script quantity created for \${results.length} instruments\`,
      data: { exchange_name: normalizedExchange, total: results.length, inserted: bulkResult.upsertedCount, existing: results.length - bulkResult.upsertedCount }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
`
);

fs.writeFileSync('src/controllers/groupedQuantityController.js', content, 'utf8');
