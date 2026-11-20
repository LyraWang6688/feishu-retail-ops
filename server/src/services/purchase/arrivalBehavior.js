'use strict';

const { PURCHASE_BEHAVIORS } = require('../../config/purchaseBehaviors');

/** 验收成功时把「入库」行为记录 id 注入批次行写回。 */
const createArrivalMarkHandler = (webhooks) => async (batchNo, options = {}) => {
  if (!webhooks?.orderBatches?.markArrived) {
    return { updated: false, reason: 'not_wired' };
  }
  const behavior = webhooks.references?.resolveBehavior
    ? await webhooks.references.resolveBehavior(PURCHASE_BEHAVIORS.inbound)
    : null;
  return webhooks.orderBatches.markArrived(batchNo, {
    ...options,
    behaviorRecordId: behavior?.recordId || '',
  });
};

module.exports = { createArrivalMarkHandler };
