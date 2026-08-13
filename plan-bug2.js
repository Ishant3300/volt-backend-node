// Script to fix updateChildMasterDetails in masterChildController.js
// 1. Import getAllSubMasterIds
// 2. Instead of detailQuery.master_id = req.master.id, use:
//    const allowedSubMasters = await getAllSubMasterIds(req.master.id);
//    if (!allowedSubMasters.includes(id)) return 403
