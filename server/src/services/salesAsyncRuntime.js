'use strict';

const { createSalesOrderNoCache } = require('./salesOrderNoCache');
const { createSalesAsyncWorker } = require('./salesAsyncWorker');

/**
 * 异步销售的运行时装配（单号缓存 + worker）。放在这里是为了让 `routes/scanPage/index.js`
 * 保持薄壳、不触碰它的 1800 行门禁；行为仍是：开关开着才创建，worker 启动不阻塞服务。
 */
const createSalesAsyncRuntime = ({ gateway, writeService, config, options = {}, logError } = {}) => {
  const orderNoCache = options.salesOrderNoCache || createSalesOrderNoCache({ gateway });
  if (!writeService || config?.sale?.asyncFullEnabled !== true) {
    return { orderNoCache, worker: null };
  }
  const worker = options.salesAsync || createSalesAsyncWorker({ gateway, writeService });
  if (typeof worker.start === 'function') {
    setImmediate(() => { worker.start().catch((error) => logError('scan.sale.async.start_failed', { error: String(error?.message || error) })); });
  }
  return { orderNoCache, worker };
};

module.exports = { createSalesAsyncRuntime };
