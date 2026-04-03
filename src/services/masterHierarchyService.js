/**
 * Master Hierarchy Service
 * Recursively resolves all sub-master IDs in the tree under a given master.
 */
const Master = require('../models/Master');

/**
 * Get all master IDs in the hierarchy under a given master (inclusive).
 * Returns: [masterId, subMaster1Id, subSubMaster1Id, ...]
 */
const getAllSubMasterIds = async (masterId) => {
  const result = [masterId];
  const queue = [masterId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = await Master.find(
      { master_id: currentId, deleted_at: null },
      '_id'
    ).lean();

    for (const child of children) {
      const childId = child._id.toString();
      result.push(childId);
      queue.push(childId);
    }
  }

  return result;
};

module.exports = { getAllSubMasterIds };
