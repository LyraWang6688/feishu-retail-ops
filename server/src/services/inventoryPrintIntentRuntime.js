'use strict';

/**
 * 库存调整打印意图的**进程级单例**（issue #1210）。
 *
 * 依赖统一异步任务服务（同一份 job 存储）与打印队列（同一份队列实例）——
 * 与路由 / 启动恢复共用，避免"手机会把任务排进一个电脑永远看不到的队列"。
 */
const { logInfo, logWarn } = require('../utils/logger');
const { getAsyncJobService } = require('./asyncJobRuntime');
const { getLabelPrintQueue } = require('./labelPrintQueueRuntime');
const { createInventoryPrintIntentService } = require('./inventoryPrintIntentService');

let instance = null;

const getInventoryPrintIntentService = () => {
  if (!instance) {
    instance = createInventoryPrintIntentService({
      jobs: getAsyncJobService(),
      queue: getLabelPrintQueue(),
    });
  }
  return instance;
};

/** 用例注入 / 恢复（不传 = 下次重新按默认依赖建）。 */
const setInventoryPrintIntentServiceForTests = (service) => { instance = service || null; };

/**
 * 启动补做：已成功、有打印意图、但还没建打印任务的 job。
 * 后台跑、异常只 warn（不许把服务启动搞挂）。
 */
const recoverInventoryPrintIntents = async () => {
  try {
    const summary = await getInventoryPrintIntentService().recover();
    if (summary?.pending) {
      logInfo('inventory.print.intent.recovered', summary);
    }
    return summary;
  } catch (error) {
    logWarn('inventory.print.intent.recover_failed', {
      error: String(error?.message || error).slice(0, 300),
    });
    return null;
  }
};

module.exports = {
  getInventoryPrintIntentService,
  setInventoryPrintIntentServiceForTests,
  recoverInventoryPrintIntents,
};
