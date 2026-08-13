const fs = require('fs');

let content = fs.readFileSync('src/controllers/adminController.js', 'utf8');

// 2. Replace updateScriptQuantity
content = content.replace(
/const updateScriptQuantity = async \(req, res\) => \{[\s\S]*?(?=^\/\/ Delete Script Quantity)/m,
`const updateScriptQuantity = async (req, res) => {
  try {
    const { id } = req.params;
    const { exchange_name, script_name, lot_size, max_qty, brk_qty } = req.body;

    const scriptQty = await ScriptQuantity.findById(id);

    if (!scriptQty || scriptQty.deleted_at) {
      return res.status(404).json({ success: false, message: 'Script quantity not found', data: null });
    }

    if (req.master) {
      if (scriptQty.owner_id.toString() !== req.master.id) {
        if (scriptQty.owner_type !== 'User') {
          return res.status(403).json({ success: false, message: 'Not authorized to edit other masters' });
        }
        const user = await User.findById(scriptQty.owner_id);
        if (!user || user.master_id.toString() !== req.master.id) {
          return res.status(403).json({ success: false, message: 'Not authorized to edit this user' });
        }
      }

      if (max_qty !== undefined) {
        let ceilingLimit;
        if (scriptQty.owner_id.toString() === req.master.id) {
          const ex = exchange_name || scriptQty.exchange_name;
          const sc = script_name || scriptQty.script_name;
          const adminGlobal = await ScriptQuantity.findOne({ owner_type: 'Admin', exchange_name: ex, script_name: sc, deleted_at: null }).lean();
          if (!adminGlobal) {
            return res.status(400).json({ success: false, message: 'Admin has not set a global limit for this script' });
          }
          ceilingLimit = adminGlobal.max_qty;
        } else {
          const ex = exchange_name || scriptQty.exchange_name;
          const sc = script_name || scriptQty.script_name;
          const masterLimit = await ScriptQuantity.findOne({ owner_id: req.master.id, owner_type: 'Master', exchange_name: ex, script_name: sc, deleted_at: null }).lean();
          if (!masterLimit) {
            return res.status(400).json({ success: false, message: 'You do not have a limit set for this script' });
          }
          ceilingLimit = masterLimit.max_qty;
        }

        if (max_qty > ceilingLimit) {
          return res.status(400).json({ success: false, message: \`max_qty cannot exceed limit of \${ceilingLimit}\` });
        }
      }
    }

    if (exchange_name) scriptQty.exchange_name = exchange_name;
    if (script_name) scriptQty.script_name = script_name;
    if (lot_size !== undefined) scriptQty.lot_size = lot_size;
    if (max_qty !== undefined) scriptQty.max_qty = max_qty;
    if (brk_qty !== undefined) scriptQty.brk_qty = brk_qty;

    await scriptQty.save();

    if (req.admin && scriptQty.owner_type === 'Admin') {
      const { cascadeNewScriptGlobally } = require('../services/scriptQuantityCopyService');
      await cascadeNewScriptGlobally(
        scriptQty.exchange_name,
        scriptQty.script_name,
        { lot_size: scriptQty.lot_size, max_qty: scriptQty.max_qty, brk_qty: scriptQty.brk_qty },
        req.admin.id
      );
    } else if (scriptQty.owner_type === 'Master') {
      const { cascadeToDirectUsers } = require('../services/scriptQuantityCopyService');
      await cascadeToDirectUsers(
        scriptQty.owner_id.toString(),
        scriptQty.exchange_name,
        scriptQty.script_name,
        { max_qty: scriptQty.max_qty, brk_qty: scriptQty.brk_qty, lot_size: scriptQty.lot_size }
      );
    }

    res.status(200).json({ success: true, message: 'Script quantity updated successfully', data: scriptQty.toJSON() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

`
);

// 3. Replace deleteScriptQuantity
content = content.replace(
/const deleteScriptQuantity = async \(req, res\) => \{[\s\S]*?(?=^module\.exports)/m,
`const deleteScriptQuantity = async (req, res) => {
  try {
    const { id } = req.params;

    const scriptQty = await ScriptQuantity.findById(id);

    if (!scriptQty || scriptQty.deleted_at) {
      return res.status(404).json({ success: false, message: 'Script quantity not found', data: null });
    }

    if (req.master) {
      if (scriptQty.owner_id.toString() !== req.master.id) {
        if (scriptQty.owner_type !== 'User') {
          return res.status(403).json({ success: false, message: 'Not authorized to delete other masters' });
        }
        const user = await User.findById(scriptQty.owner_id);
        if (!user || user.master_id.toString() !== req.master.id) {
          return res.status(403).json({ success: false, message: 'Not authorized to delete this user script' });
        }
      }
    }

    scriptQty.deleted_at = new Date();
    await scriptQty.save();

    if (scriptQty.owner_type === 'Master') {
      const { cascadeDeleteScriptToUsers } = require('../services/scriptQuantityCopyService');
      await cascadeDeleteScriptToUsers(scriptQty.owner_id.toString(), scriptQty.exchange_name, scriptQty.script_name);
    }

    if (scriptQty.owner_type === 'Admin') {
      const { cascadeDeleteScriptGlobally } = require('../services/scriptQuantityCopyService');
      await cascadeDeleteScriptGlobally(scriptQty.exchange_name, scriptQty.script_name, scriptQty.owner_id.toString());
    } else if (req.admin && scriptQty.owner_type === 'Master') {
      const { cascadeDeleteScriptGlobally } = require('../services/scriptQuantityCopyService');
      await cascadeDeleteScriptGlobally(scriptQty.exchange_name, scriptQty.script_name, req.admin.id);
    }

    res.status(200).json({ success: true, message: 'Script quantity deleted successfully', data: null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

`
);

fs.writeFileSync('src/controllers/adminController.js', content, 'utf8');
