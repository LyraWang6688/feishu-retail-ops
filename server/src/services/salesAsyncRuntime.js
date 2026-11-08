'use strict';

const { createSalesOrderNoCache } = require('./salesOrderNoCache');
const { createSalesAsyncWorker } = require('./salesAsyncWorker');
const { getAsyncJobService } = require('./asyncJobRuntime');

/**
 * 异步销售的运行时装配（单号缓存 + worker）。放在这里是为了让 `routes/scanPage/index.js`
 * 保持薄壳、不触碰它的 1800 行门禁；行为仍是：开关开着才创建，worker 启动不阻塞服务。
 */
const createSalesAsyncRuntime = ({ gateway, writeService, config, options = {}, logError } = {}) => {
  const orderNoCache = options.salesOrderNoCache || createSalesOrderNoCache({ gateway });
  if (!writeService) {
    return { orderNoCache, worker: null };
  }
  // #948：统一异步任务（重试 / 失败通知发运营群）。用例可 `options.asyncJobs` 注入或置 null。
  const asyncJobs = options.asyncJobs !== undefined ? options.asyncJobs : getAsyncJobService();
  const worker = options.salesAsync || createSalesAsyncWorker({ gateway, writeService, asyncJobs });
  if (typeof worker.start === 'function') {
    setImmediate(() => { worker.start().catch((error) => logError('scan.sale.async.start_failed', { error: String(error?.message || error) })); });
  }
  return { orderNoCache, worker };
};

module.exports = { createSalesAsyncRuntime };
