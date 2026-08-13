const fs = require('fs');

let content = fs.readFileSync('src/controllers/adminController.js', 'utf8');

// 1. Replace createScriptQuantity
content = content.replace(
/const createScriptQuantity = async \(req, res\) => \{[\s\S]*?(?=^\/\/ Get All Script Quantities)/m,
`const createScriptQuantity = async (req, res) => {
  try {
    const { exchange_name, script_name, lot_size, max_qty, brk_qty, owner_id, owner_type } = req.body;

    if (!exchange_name || !script_name || lot_size === undefined || max_qty === undefined || brk_qty === undefined) {
      return res.status(400).json({
        success: false,
        message: 'exchange_name, script_name, lot_size, max_qty, and brk_qty are required',
        data: null
      });
    }

    const callerId = req.admin?.id || req.master?.id;
    const callerType = req.admin ? 'Admin' : 'Master';
    const effectiveOwnerId = owner_id || callerId;
    const effectiveOwnerType = owner_id ? (owner_type || 'User') : callerType;

    if (!effectiveOwnerId) {
      return res.status(400).json({
        success: false,
        message: 'Could not determine owner for script quantity',
        data: null
      });
    }

    if (req.master) {
      // Ownership check
      if (effectiveOwnerId !== req.master.id) {
        if (effectiveOwnerType !== 'User') {
          return res.status(403).json({ success: false, message: 'Not authorized to create for this owner type' });
        }
        const user = await User.findById(effectiveOwnerId);
        if (!user || user.master_id.toString() !== req.master.id) {
          return res.status(403).json({ success: false, message: 'Not authorized to create for this user' });
        }
      }

      // Limit check
      let ceilingLimit;
      if (effectiveOwnerId === req.master.id) {
        const adminGlobal = await ScriptQuantity.findOne({ owner_type: 'Admin', exchange_name, script_name, deleted_at: null }).lean();
        if (!adminGlobal) {
          return res.status(400).json({ success: false, message: 'Admin has not set a global limit for this script' });
        }
        ceilingLimit = adminGlobal.max_qty;
      } else {
        const masterLimit = await ScriptQuantity.findOne({ owner_id: req.master.id, owner_type: 'Master', exchange_name, script_name, deleted_at: null }).lean();
        if (!masterLimit) {
          return res.status(400).json({ success: false, message: 'You do not have a limit set for this script' });
        }
        ceilingLimit = masterLimit.max_qty;
      }

      if (max_qty > ceilingLimit) {
        return res.status(400).json({ success: false, message: \`max_qty cannot exceed limit of \${ceilingLimit}\` });
      }
    }

    const scriptQty = await ScriptQuantity.findOneAndUpdate(
      { owner_id: effectiveOwnerId, owner_type: effectiveOwnerType, exchange_name, script_name, deleted_at: null },
      { owner_id: effectiveOwnerId, owner_type: effectiveOwnerType, exchange_name, script_name, lot_size, max_qty, brk_qty, deleted_at: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (effectiveOwnerType === 'Master') {
      const { cascadeNewScriptToUsers } = require('../services/scriptQuantityCopyService');
      await cascadeNewScriptToUsers(effectiveOwnerId, exchange_name, script_name, { lot_size, max_qty, brk_qty });
    }

    if (effectiveOwnerType === 'Admin') {
      const { cascadeNewScriptGlobally } = require('../services/scriptQuantityCopyService');
      await cascadeNewScriptGlobally(exchange_name, script_name, { lot_size, max_qty, brk_qty }, effectiveOwnerId);
    }

    res.status(201).json({
      success: true,
      message: 'Script quantity saved successfully',
      data: scriptQty.toJSON()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

`
);

fs.writeFileSync('src/controllers/adminController.js', content, 'utf8');
