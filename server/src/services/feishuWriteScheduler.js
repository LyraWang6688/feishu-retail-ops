'use strict';

/**
 * 全局飞书写入调度器（issue #879）—— **所有写飞书的请求共享同一个并发控制**。
 *
 * 为什么要有它（真实伤口）：销售异步 worker / 工作台交付 / 售后各自有 FIFO，但**跨模块**仍会
 * 同时写：销售 worker + 采购入库 + 工作台交付一起打飞书 ⇒ `1254607 Data not ready` / 瞬时 400
 * ⇒ 某一方失败（生产测试里真实出现过）。FIFO 只能保证"自己内部不互打"。
 *
 * 调度语义（配置见 `config/feishuWriteScheduler.js`）：
 *   · **分组**：默认按「表 + 操作类型」分组（`liveInventory:create` / `salesEntry:update` …）；
 *   · **组内串行**：同一个组一条 FIFO，绝不会有两个请求同时打同一张表同一种操作
 *     （这正是 1254607 / 写冲突的来源）；
 *   · **组间有限并发**：全局最多 `FEISHU_WRITE_MAX_CONCURRENCY` 个请求同时在飞（默认 3）；
 *   · **不锁整个业务**：库存的 `stock_key` 串行仍在 `InventoryService.runForStock`（本层只调度
 *     单次 HTTP 写，不改任何业务排队语义、不重写写表逻辑）。
 *
 * 重试（只重试"确定没写进去"的瞬时错误）：
 *   · 飞书 code 1254607 / 1254290 / 1254291 + HTTP 429 + **瞬时 400**（data-not-ready 那一类）；
 *   · 重试**重放同一个闭包**（同一份 payload / 同一个 correlation）—— 不生成 job / submitKey /
 *     operationKey，天然复用原幂等键 ⇒ 不会重复建单、不会重复扣库存；
 *   · 5xx / 网络超时**不在这一层重试**（结果未知，重试可能写重）—— 交给上层 job 级重试
 *     （#948 的 `asyncJobs.run` 复用同一把业务键）。
 *
 * 日志（排查三件事：等了多久 / 同时几个 / 试了几次）：
 *   · `feishu.write.applied`（info）：queue_wait_ms / concurrency_limit / active_count / attempts …
 *   · `feishu.write.retry`（warn）：第几次、等多久、为什么（code / status / kind）
 *   · `feishu.write.failed`（error）：最终失败（同样带 queue_wait / attempts / 关联键）
 *   · 关联键（task_id / order_no / batch_no / tap_id …）由调用方传 `correlation`，
 *     本层**不透明**透传（与网关既有口径一致：不查表、不推导）。
 *
 * 边界：
 *   · 只调度**写**（create / update / delete 及其批量口）；读不进调度器（否则页面变慢）。
 *   · 本层不重写任何业务逻辑、不改 payload、不改返回值 —— 成功时原样返回 `work()` 的结果。
 */

const {
  FEISHU_WRITE_SCHEDULER, classifyFeishuWriteError, retryDelayMs,
} = require('../config/feishuWriteScheduler');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { larkErrorFields } = require('../utils/larkError');

const DEFAULT_SLEEP = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/**
 * 建一个调度器实例。
 *
 * @param {object} [deps]
 * @param {object} [deps.config]  `FEISHU_WRITE_SCHEDULER` 形状配置（用例注入）
 * @param {object} [deps.logger]  `{logInfo, logWarn, logError}`（用例注入以捕获日志）
 * @param {Function} [deps.sleep] `(ms) => Promise`（用例注入 0 延迟）
 * @param {Function} [deps.now]   `() => number`（用例注入时钟）
 */
const createFeishuWriteScheduler = ({
  config = FEISHU_WRITE_SCHEDULER,
  logger = { logInfo, logWarn, logError },
  sleep,
  now = Date.now,
} = {}) => {
  if (!config || typeof config !== 'object') throw new Error('FeishuWriteScheduler requires config');
  const limit = Math.max(1, Number(config.maxConcurrency) || 1);
  const retry = config.retry || {};
  const maxAttempts = Math.max(1, Number(retry.maxAttempts) || 1);
  const sleepFn = typeof sleep === 'function' ? sleep : DEFAULT_SLEEP;
  // ⚠️ 保留 `logInfo/logWarn/logError` 这三个**名字**（而不是 info/warn/error 别名）：
  //    `scripts/observability-events.mjs` 按 `logXxx('事件名'` 静态扫事件目录，别名会漏登记。
  const sink = {
    logInfo: typeof logger.logInfo === 'function' ? logger.logInfo : () => {},
    logWarn: typeof logger.logWarn === 'function' ? logger.logWarn : () => {},
    logError: typeof logger.logError === 'function' ? logger.logError : () => {},
  };

  /** groupKey → { running: boolean, queue: entry[] } */
  const groups = new Map();
  /** 等全局并发额度的任务（FIFO）。 */
  const waiters = [];
  let active = 0;
  let queued = 0;

  const groupKeyOf = (tableKey, operation) => {
    const table = config.groupByTable === false ? '' : String(tableKey || '').trim();
    const op = config.groupByOperation === false ? '' : String(operation || '').trim();
    return `${table}:${op}`;
  };

  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => { waiters.push(resolve); });
  };

  const release = () => {
    const next = waiters.shift();
    if (next) {
      // 额度**转交**给下一个等待者（active 不变）—— 这样"同时在飞"的上限不会被越过去。
      next();
      return;
    }
    active -= 1;
  };

  const correlationOf = (entry) => (entry.correlation && typeof entry.correlation === 'object'
    ? entry.correlation : {});

  /** 执行一个任务（已经拿到全局额度）：含瞬时错误重试 + 日志。 */
  const execute = async (entry) => {
    const startedAt = now();
    const queueWaitMs = Math.max(0, startedAt - entry.queuedAt);
    const base = {
      table_key: entry.tableKey,
      operation: entry.operation,
      group_key: entry.groupKey,
      queue_wait_ms: queueWaitMs,
      concurrency_limit: limit,
      ...correlationOf(entry),
    };
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await entry.work();
        sink.logInfo('feishu.write.applied', {
          ...base,
          attempts: attempt,
          duration_ms: Math.max(0, now() - startedAt),
          active_count: active,
          queue_depth: queued,
        });
        return result;
      } catch (thrown) {
        lastError = thrown;
        const classified = classifyFeishuWriteError(thrown, retry);
        const fields = larkErrorFields(thrown);
        const delayMs = retryDelayMs(attempt, retry);
        const retryable = classified.retryable === true && attempt < maxAttempts;
        const detail = {
          ...base,
          attempt,
          attempts: attempt,
          max_attempts: maxAttempts,
          retryable: classified.retryable === true,
          reason: classified.kind,
          code: classified.code || fields.code,
          status: classified.status || undefined,
          duration_ms: Math.max(0, now() - startedAt),
          error: classified.message || String(thrown?.message || thrown),
        };
        if (!retryable) {
          sink.logError('feishu.write.failed', detail);
          throw thrown;
        }
        sink.logWarn('feishu.write.retry', { ...detail, delay_ms: delayMs });
        await sleepFn(delayMs);
      }
    }
    // 理论不可达（循环里最后一次失败一定走 failed + throw）；防御性收口。
    throw lastError;
  };

  /** 组内 FIFO：一组同一时刻最多 1 个任务（组内串行），组间靠全局额度并发。 */
  const pumpGroup = (key) => {
    const group = groups.get(key);
    if (!group || group.running || !group.queue.length) return;
    group.running = true;
    const entry = group.queue.shift();
    queued = Math.max(0, queued - 1);
    acquire().then(async () => {
      try {
        entry.resolve(await execute(entry));
      } catch (thrown) {
        entry.reject(thrown);
      } finally {
        release();
        group.running = false;
        if (group.queue.length) pumpGroup(key);
        else if (groups.get(key) === group) groups.delete(key);
      }
    });
  };

  /**
   * 入队一次写请求。
   * @param {object} task
   * @param {string} task.tableKey  表（语义键或原始 table_id；只用于分组与日志）
   * @param {string} task.operation 操作类型（create / update / delete）
   * @param {Function} task.work    **只做一次飞书写请求**的闭包（重试会重放同一个闭包）
   * @param {object} [task.correlation] 关联键（白名单口径由调用方保证；本层只透传）
   * @param {string} [task.groupKey] 显式分组键（默认 `tableKey:operation`）
   * @returns {Promise<*>} `work()` 的返回值原样透出（成功时）
   */
  const run = ({ tableKey = '', operation = '', work, correlation = null, groupKey } = {}) => {
    if (typeof work !== 'function') throw new Error('FeishuWriteScheduler.run 需要 work 函数');
    const key = String(groupKey || groupKeyOf(tableKey, operation));
    return new Promise((resolve, reject) => {
      const entry = {
        tableKey, operation, groupKey: key, work, correlation, queuedAt: now(), resolve, reject,
      };
      let group = groups.get(key);
      if (!group) {
        group = { running: false, queue: [] };
        groups.set(key, group);
      }
      group.queue.push(entry);
      queued += 1;
      pumpGroup(key);
    });
  };

  /** 只读快照（排查 / 用例断言用；不含任务内容）。 */
  const stats = () => ({ limit, active, queued, groups: groups.size });

  return { run, stats, config };
};

// ── 进程级单例（网关默认用它；**没有开关，始终开启**）────────────────────────────
let instance = null;
let initialized = false;

const getFeishuWriteScheduler = () => {
  if (!initialized) {
    initialized = true;
    instance = createFeishuWriteScheduler({ config: FEISHU_WRITE_SCHEDULER });
  }
  return instance;
};

/** 用例注入 / 顶掉单例（`null` = 关掉调度）。 */
const setFeishuWriteSchedulerForTests = (scheduler) => {
  initialized = true;
  instance = scheduler || null;
};

/** 用例恢复（下一次 `getFeishuWriteScheduler()` 重新按配置建）。 */
const resetFeishuWriteSchedulerForTests = () => {
  initialized = false;
  instance = null;
};

module.exports = {
  createFeishuWriteScheduler,
  getFeishuWriteScheduler,
  setFeishuWriteSchedulerForTests,
  resetFeishuWriteSchedulerForTests,
};
