'use strict';

/**
 * 统一异步任务服务的**进程级单例**（#948）。
 *
 * 为什么需要单例：七类链路的"入队 / 通知 / 状态查询"必须看**同一份** job 存储与通知去重状态
 * ——各建一份 ⇒ 状态接口查不到、同一 job 可能被通知两次。
 *
 * 开关：`ASYNC_JOB_ENABLED=false` ⇒ `getAsyncJobService()` 返回 `null`（各链路回落到"只记日志"的旧行为）。
 * 默认**开**（业务负责人 2026-11-08 定稿要落地的就是这套机制）。
 *
 * 用例：直接 `createAsyncJobService({ store: 临时目录, notifier: 假发送器 })` 注入，
 * 或用 `setAsyncJobServiceForTests()` 顶掉单例（**不要**在用例里真发群消息）。
 */
const { ASYNC_JOBS } = require('../config/asyncJobs');
const { createAsyncJobService } = require('./asyncJobService');
const { logInfo, logWarn } = require('../utils/logger');

let instance = null;
let initialized = false;

/** 取单例（`ASYNC_JOB_ENABLED=false` ⇒ null）。 */
const getAsyncJobService = () => {
  if (!initialized) {
    initialized = true;
    instance = ASYNC_JOBS.enabled === true
      ? createAsyncJobService({ config: ASYNC_JOBS })
      : null;
    if (!instance) logInfo('async_job.disabled', { env: 'ASYNC_JOB_ENABLED' });
  }
  return instance;
};

/** 用例注入 / 顶掉单例（`null` = 关掉）。 */
const setAsyncJobServiceForTests = (service) => {
  initialized = true;
  instance = service || null;
};

/** 用例恢复（下一次 `getAsyncJobService()` 重新按配置建）。 */
const resetAsyncJobServiceForTests = () => {
  initialized = false;
  instance = null;
};

/**
 * 启动收尾（后台、不阻塞服务）：补发未通知的失败 + 如实记录残留 running。
 * **任何异常只 warn** —— 统一层不许把服务启动搞挂。
 */
const startAsyncJobService = async () => {
  const service = getAsyncJobService();
  if (!service) return null;
  try {
    const summary = await service.start();
    logInfo('async_job.start.done', summary);
    return summary;
  } catch (error) {
    logWarn('async_job.start.failed', { error: String(error?.message || error).slice(0, 300) });
    return null;
  }
};

module.exports = {
  getAsyncJobService,
  setAsyncJobServiceForTests,
  resetAsyncJobServiceForTests,
  startAsyncJobService,
};
