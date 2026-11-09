'use strict';

/**
 * 统一异步任务服务的**进程级单例**（#948）。
 *
 * 为什么需要单例：七类链路的"入队 / 通知 / 状态查询"必须看**同一份** job 存储与通知去重状态
 * ——各建一份 ⇒ 状态接口查不到、同一 job 可能被通知两次。
 *
 * ⭐ 2026-11-10 业务负责人：「**不需要加开关**」⇒ 统一异步层**固定常开**、没有全局开关。
 *   （删掉的 `ASYNC_JOB_ENABLED` 见 `test/asyncJobsSwitchRemoval.test.js` 的源码哨兵。）
 *
 * 用例：直接 `createAsyncJobService({ store: 临时目录, notifier: 假发送器 })` 注入，
 * 或用 `setAsyncJobServiceForTests()` 顶掉单例（**不要**在用例里真发群消息）。
 */
const { ASYNC_JOBS } = require('../config/asyncJobs');
const { createAsyncJobService } = require('./asyncJobService');
const { logInfo, logWarn } = require('../utils/logger');

let instance = null;
let initialized = false;

/** 取单例（统一层**固定常开**：没有"关掉"这个档）。 */
const getAsyncJobService = () => {
  if (!initialized) {
    initialized = true;
    instance = createAsyncJobService({ config: ASYNC_JOBS });
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
