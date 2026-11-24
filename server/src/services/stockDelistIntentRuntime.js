'use strict';

/** 库存成功后下架意图的进程级单例（复用统一 async job + 既有 ProductDelistService）。 */
const { logInfo, logWarn } = require('../utils/logger');
const { V1BitableGateway } = require('./v1BitableGateway');
const { createProductDelistService } = require('./productDelistService');
const { getAsyncJobService } = require('./asyncJobRuntime');
const { createStockDelistIntentService } = require('./stockDelistIntentService');

let instance = null;

const getStockDelistIntentService = () => {
  if (!instance) {
    const gateway = new V1BitableGateway();
    const delist = createProductDelistService({ gateway }).deleteDelistedProduct;
    instance = createStockDelistIntentService({
      jobs: getAsyncJobService(),
      delist,
    });
  }
  return instance;
};

const setStockDelistIntentServiceForTests = (service) => { instance = service || null; };

const recoverStockDelistIntents = async () => {
  try {
    const summary = await getStockDelistIntentService().recover();
    if (summary?.pending) logInfo('stock.delist.intent.recovered', summary);
    return summary;
  } catch (error) {
    logWarn('stock.delist.intent.recover_failed', {
      error: String(error?.message || error).slice(0, 300),
    });
    return null;
  }
};

module.exports = {
  getStockDelistIntentService,
  setStockDelistIntentServiceForTests,
  recoverStockDelistIntents,
};
