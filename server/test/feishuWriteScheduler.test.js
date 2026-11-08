'use strict';

// 全局飞书写入调度器（issue #879）—— 单元测试。
//
// 验收标准（先写预期，再对照跑）：
//   AC-WS1 分组：默认「表 + 操作类型」；同组**严格串行**（FIFO），组内最大并发恒为 1；
//   AC-WS2 组间**有限并发**：全局同时在飞 ≤ `maxConcurrency`（默认 3，可配）；
//   AC-WS3 重试：只重试"确定没写进去"的瞬时错误（1254607 / 429 / 瞬时 400），
//          指数退避、次数可配；永久错误一次都不重试；
//   AC-WS4 重试**重放同一个闭包**：payload / 关联键逐字相同（不会重复建单 / 扣库存）；
//   AC-WS5 日志：`queue_wait_ms` / `concurrency_limit` / `attempts` / `active_count` +
//          job/request 关联键（task_id / tap_id …）；
//   AC-WS6 配置闸门：并发数 / 重试次数 / 退避 / 可重试错误码都能用环境变量覆盖，
//          配错当场抛；`FEISHU_WRITE_SCHEDULER_ENABLED=false` ⇒ 单例为空（回滚开关）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFeishuWriteSchedulerConfig, classifyFeishuWriteError, retryDelayMs,
} = require('../src/config/feishuWriteScheduler');
const {
  createFeishuWriteScheduler, getFeishuWriteScheduler,
  setFeishuWriteSchedulerForTests, resetFeishuWriteSchedulerForTests,
} = require('../src/services/feishuWriteScheduler');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 捕获日志的 logger 替身（调度器支持注入 logger ⇒ 不用污染全局）。 */
const captureLogger = () => {
  const logs = [];
  const push = (level) => (event, fields) => logs.push({ level, event, fields: fields || {} });
  return {
    logs,
    logger: { logInfo: push('info'), logWarn: push('warn'), logError: push('error') },
  };
};

/** 一份确定的测试配置（不读 process.env；重试退避用 0 让用例快）。 */
const testConfig = (overrides = {}) => {
  const base = buildFeishuWriteSchedulerConfig({});
  return {
    ...base,
    maxConcurrency: 2,
    retry: { ...base.retry, maxAttempts: 3, baseMs: 10, maxDelayMs: 40, ...(overrides.retry || {}) },
    ...(overrides.maxConcurrency ? { maxConcurrency: overrides.maxConcurrency } : {}),
    ...(overrides.groupByTable === undefined ? {} : { groupByTable: overrides.groupByTable }),
    ...(overrides.groupByOperation === undefined ? {} : { groupByOperation: overrides.groupByOperation }),
  };
};

const defer = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

// ── AC-WS6：配置（环境变量覆盖 / 配错当场抛）──────────────────────────────────
test('AC-WS6 配置：默认值 + 环境变量覆盖 + 配错当场抛', () => {
  const defaults = buildFeishuWriteSchedulerConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxConcurrency, 3);
  assert.equal(defaults.groupByTable, true);
  assert.equal(defaults.groupByOperation, true);
  assert.equal(defaults.retry.maxAttempts, 3);
  assert.deepEqual(defaults.retry.larkCodes, [1254607, 1254290, 1254291]);
  assert.deepEqual(defaults.retry.retryableHttpStatuses, [429]);

  const custom = buildFeishuWriteSchedulerConfig({
    FEISHU_WRITE_SCHEDULER_ENABLED: 'false',
    FEISHU_WRITE_MAX_CONCURRENCY: '1',
    FEISHU_WRITE_GROUP_BY_TABLE: 'false',
    FEISHU_WRITE_GROUP_BY_OPERATION: 'false',
    FEISHU_WRITE_RETRY_MAX_ATTEMPTS: '5',
    FEISHU_WRITE_RETRY_BASE_MS: '250',
    FEISHU_WRITE_RETRY_MAX_DELAY_MS: '2000',
    FEISHU_WRITE_RETRY_LARK_CODES: '1254607, 1254291',
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.maxConcurrency, 1);
  assert.equal(custom.groupByTable, false);
  assert.equal(custom.groupByOperation, false);
  assert.equal(custom.retry.maxAttempts, 5);
  assert.equal(custom.retry.baseMs, 250);
  assert.equal(custom.retry.maxDelayMs, 2000);
  assert.deepEqual(custom.retry.larkCodes, [1254607, 1254291]);
  // 空串 = 一个都不认（显式关掉"按 code 重试"）
  assert.deepEqual(buildFeishuWriteSchedulerConfig({ FEISHU_WRITE_RETRY_LARK_CODES: '' }).retry.larkCodes, []);

  assert.throws(() => buildFeishuWriteSchedulerConfig({ FEISHU_WRITE_MAX_CONCURRENCY: '0' }), /必须是 1~32 之间的整数/);
  assert.throws(() => buildFeishuWriteSchedulerConfig({ FEISHU_WRITE_MAX_CONCURRENCY: 'many' }), /必须是 1~32 之间的整数/);
  assert.throws(() => buildFeishuWriteSchedulerConfig({ FEISHU_WRITE_SCHEDULER_ENABLED: 'maybe' }), /必须是显式布尔/);
  assert.throws(() => buildFeishuWriteSchedulerConfig({ FEISHU_WRITE_RETRY_MAX_ATTEMPTS: '99' }), /必须是 1~10 之间/);
});

// ── AC-WS3：错误分类（哪些能在这一层重试）──────────────────────────────────────
test('AC-WS3 错误分类：1254607 / 429 / 瞬时 400 可重试；永久错误与"结果未知"不重试', () => {
  const retry = testConfig().retry;
  const code = (bitableCode, message = 'x') => Object.assign(new Error(message), { bitableCode });
  const http = (status, message, data = {}) => Object.assign(new Error(message), { response: { status, data } });

  // ① 飞书 code 优先于 HTTP 400 判（真机 data-not-ready 是"HTTP 400 + code 1254607"两层形状）
  assert.equal(classifyFeishuWriteError(code(1254607, 'Data not ready'), retry).retryable, true);
  assert.equal(classifyFeishuWriteError(http(400, 'Request failed with status code 400', { code: 1254607, msg: 'Data not ready, please try again later' }), retry).retryable, true);
  assert.equal(classifyFeishuWriteError(code(1254290, 'too many request'), retry).retryable, true);
  assert.equal(classifyFeishuWriteError(code(1254291, 'write conflict'), retry).retryable, true);
  // ② HTTP 429 限流
  assert.equal(classifyFeishuWriteError(http(429, 'Request failed with status code 429'), retry).retryable, true);
  // ③ 瞬时 400（msg 是"再试一次"的说法）
  assert.equal(classifyFeishuWriteError(http(400, 'Request failed with status code 400', { msg: 'system busy' }), retry).retryable, true);
  assert.equal(classifyFeishuWriteError(new Error('数据未准备好'), retry).retryable, true);
  // ④ 永久错误：字段名 / 权限 / 参数 / 通用 400
  assert.equal(classifyFeishuWriteError(code(99991672, 'no permission'), retry).retryable, false);
  assert.equal(classifyFeishuWriteError(http(400, 'InvalidFieldNames (Code: 1254024)'), retry).retryable, false);
  assert.equal(classifyFeishuWriteError(http(400, 'Request failed with status code 400'), retry).retryable, false);
  // ⑤ 5xx / 网络超时 = 结果未知 ⇒ 这一层不重试（交给 job 级重试，那里有幂等键）
  assert.equal(classifyFeishuWriteError(http(500, 'Request failed with status code 500'), retry).retryable, false);
  assert.equal(classifyFeishuWriteError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), retry).retryable, false);
  // kind 便于日志排查
  assert.equal(classifyFeishuWriteError(code(1254607), retry).kind, 'feishu_code');
  assert.equal(classifyFeishuWriteError(http(429, 'x'), retry).kind, 'http_status');
  assert.equal(classifyFeishuWriteError(http(400, 'data not ready'), retry).kind, 'transient_400');
  assert.equal(classifyFeishuWriteError(http(400, '参数错误'), retry).kind, 'permanent');
});

test('AC-WS3 退避：指数递增、封顶、baseMs=0 立即重试', () => {
  const retry = { baseMs: 600, maxDelayMs: 3000 };
  assert.equal(retryDelayMs(1, retry), 600);
  assert.equal(retryDelayMs(2, retry), 1200);
  assert.equal(retryDelayMs(3, retry), 2400);
  assert.equal(retryDelayMs(10, retry), 3000, '封顶');
  assert.equal(retryDelayMs(1, { baseMs: 0, maxDelayMs: 3000 }), 0);
});

// ── AC-WS1：同组串行（FIFO）──────────────────────────────────────────────────
test('AC-WS1 同一组严格串行（FIFO）：组内同时在飞恒为 1，顺序不乱', async () => {
  const { logger } = captureLogger();
  const scheduler = createFeishuWriteScheduler({ config: testConfig({ maxConcurrency: 4 }), logger });
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const task = (id) => scheduler.run({
    tableKey: 'liveInventory', operation: 'create',
    work: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${id}`);
      await sleep(5);
      order.push(`end:${id}`);
      inFlight -= 1;
      return id;
    },
  });
  const results = await Promise.all([task('a'), task('b'), task('c')]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(maxInFlight, 1, '同表同操作必须串行');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('AC-WS1 分组键 = 表 + 操作类型：不同表 / 不同操作互不阻塞', async () => {
  const scheduler = createFeishuWriteScheduler({ config: testConfig({ maxConcurrency: 4 }), logger: captureLogger().logger });
  const gate = defer();
  let otherStarted = false;
  const blocked = scheduler.run({
    tableKey: 'liveInventory', operation: 'create', work: async () => { await gate.promise; return 'blocked'; },
  });
  const otherTable = scheduler.run({
    tableKey: 'salesEntry', operation: 'create', work: async () => { otherStarted = true; return 'sales'; },
  });
  const otherOperation = scheduler.run({
    tableKey: 'liveInventory', operation: 'delete', work: async () => 'deleted',
  });
  assert.equal(await otherTable, 'sales');
  assert.equal(await otherOperation, 'deleted');
  assert.equal(otherStarted, true);
  gate.resolve();
  assert.equal(await blocked, 'blocked');
});

test('AC-WS1 关掉分组开关 ⇒ 全仓一条队列；显式 groupKey 覆盖默认分组', async () => {
  const scheduler = createFeishuWriteScheduler({
    config: testConfig({ maxConcurrency: 1, groupByTable: false, groupByOperation: false }),
    logger: captureLogger().logger,
  });
  let inFlight = 0;
  let maxInFlight = 0;
  await Promise.all(['a', 'b', 'c'].map((id) => scheduler.run({
    tableKey: `t_${id}`, operation: 'create',
    work: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(2); inFlight -= 1; },
  })));
  assert.equal(maxInFlight, 1, '两个开关都关 ⇒ 所有写进同一条队列');

  const explicit = createFeishuWriteScheduler({ config: testConfig({ maxConcurrency: 2 }), logger: captureLogger().logger });
  const first = defer();
  const second = defer();
  const a = explicit.run({ tableKey: 't1', operation: 'create', groupKey: 'same', work: () => first.promise });
  const b = explicit.run({ tableKey: 't2', operation: 'create', groupKey: 'same', work: () => second.promise });
  await sleep(5);
  assert.deepEqual(explicit.stats(), { limit: 2, active: 1, queued: 1, groups: 1 },
    '显式 groupKey 相同 ⇒ 即使表和操作不同也串行');
  first.resolve('a');
  assert.equal(await a, 'a');
  second.resolve('b');
  assert.equal(await b, 'b');
});

// ── AC-WS2：组间有限并发（≤ 配置值）──────────────────────────────────────────
test('AC-WS2 跨表并发不超过 maxConcurrency，且确实用到了并发（不是全锁死）', async () => {
  const scheduler = createFeishuWriteScheduler({ config: testConfig({ maxConcurrency: 2 }), logger: captureLogger().logger });
  let inFlight = 0;
  let maxInFlight = 0;
  const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => scheduler.run({
    tableKey: `t_${id}`, operation: 'create',
    work: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(8);
      inFlight -= 1;
    },
  }));
  await Promise.all(tasks);
  assert.equal(maxInFlight, 2, '同时在飞必须恰好打到配置上限（既不超，也不全串）');
  assert.equal(scheduler.stats().active, 0);
  assert.equal(scheduler.stats().queued, 0);
  assert.equal(scheduler.stats().groups, 0, '空组要清掉（不泄漏 Map 内存）');
});

test('AC-WS2 并发=1 ⇒ 全局严格串行（跨表也一样）', async () => {
  const scheduler = createFeishuWriteScheduler({ config: testConfig({ maxConcurrency: 1 }), logger: captureLogger().logger });
  let inFlight = 0;
  let maxInFlight = 0;
  await Promise.all(['a', 'b', 'c'].map((id) => scheduler.run({
    tableKey: `t_${id}`, operation: 'create',
    work: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(3); inFlight -= 1; },
  })));
  assert.equal(maxInFlight, 1);
});

// ── AC-WS3 / AC-WS4：重试 + 重放同一个闭包 + 日志 ────────────────────────────────
test('AC-WS3/4/5 瞬时错误重试：退避、次数、重放同一闭包；成功日志带 queue_wait/并发/attempts/关联键', async () => {
  const { logs, logger } = captureLogger();
  let clock = 1_000;
  const delays = [];
  const scheduler = createFeishuWriteScheduler({
    config: testConfig({ maxConcurrency: 2 }),
    logger,
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
  });
  const payload = { fields: { 名称: 'A' } };
  const seen = [];
  let calls = 0;
  const result = await scheduler.run({
    tableKey: 'purchaseRequest', operation: 'create',
    correlation: { task_id: 'job-1', tap_id: 'tap-1' },
    work: async () => {
      calls += 1;
      seen.push(JSON.stringify(payload));
      clock += 5;
      if (calls < 3) {
        const error = new Error('新增“单据信息”记录失败: Data not ready, please try again later (Code: 1254607)');
        error.bitableRejected = true;
        error.bitableCode = 1254607;
        throw error;
      }
      return 'created';
    },
  });
  assert.equal(result, 'created');
  assert.equal(calls, 3, '两次瞬时错误 + 一次成功');
  assert.deepEqual(delays, [10, 20], '指数退避（base=10ms）');
  assert.deepEqual(seen, [JSON.stringify(payload), JSON.stringify(payload), JSON.stringify(payload)],
    '每次重试重放**逐字相同**的 payload（不改任何业务键）');

  const retries = logs.filter((item) => item.event === 'feishu.write.retry');
  assert.equal(retries.length, 2);
  assert.equal(retries[0].level, 'warn');
  assert.equal(retries[0].fields.attempt, 1);
  assert.equal(retries[0].fields.reason, 'feishu_code');
  assert.equal(retries[0].fields.code, 1254607);
  assert.equal(retries[0].fields.delay_ms, 10);
  assert.equal(retries[0].fields.task_id, 'job-1');

  const applied = logs.filter((item) => item.event === 'feishu.write.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].level, 'info');
  assert.equal(applied[0].fields.attempts, 3, '日志带重试次数');
  assert.equal(applied[0].fields.table_key, 'purchaseRequest');
  assert.equal(applied[0].fields.operation, 'create');
  assert.equal(applied[0].fields.concurrency_limit, 2, '日志带并发上限');
  assert.equal(applied[0].fields.active_count, 1);
  assert.equal(typeof applied[0].fields.queue_wait_ms, 'number');
  assert.equal(applied[0].fields.task_id, 'job-1', 'job 关联键');
  assert.equal(applied[0].fields.tap_id, 'tap-1', 'request/点击关联键');
});

test('AC-WS3 重试次数用尽 / 永久错误：不重试、抛原错、failed 日志带原因', async () => {
  // ① 瞬时错误 × maxAttempts ⇒ 最终失败，抛原错
  const { logs, logger } = captureLogger();
  const scheduler = createFeishuWriteScheduler({
    config: testConfig({ maxConcurrency: 1 }), logger, sleep: async () => {},
  });
  let calls = 0;
  const transient = Object.assign(new Error('Data not ready (Code: 1254607)'), { bitableCode: 1254607 });
  await assert.rejects(scheduler.run({
    tableKey: 'liveInventory', operation: 'create', correlation: { task_id: 'job-x' },
    work: async () => { calls += 1; throw transient; },
  }), /Data not ready/);
  assert.equal(calls, 3, 'maxAttempts=3');
  const failed = logs.filter((item) => item.event === 'feishu.write.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].fields.attempts, 3);
  assert.equal(failed[0].fields.retryable, true);
  assert.equal(failed[0].fields.code, 1254607);
  assert.equal(failed[0].fields.task_id, 'job-x');
  assert.equal(logs.filter((item) => item.event === 'feishu.write.retry').length, 2);

  // ② 永久错误 ⇒ 一次都不重试、不等待
  const second = captureLogger();
  let delays = 0;
  const permanent = createFeishuWriteScheduler({
    config: testConfig({ maxConcurrency: 1 }),
    logger: second.logger,
    sleep: async () => { delays += 1; },
  });
  let permanentCalls = 0;
  const rejected = Object.assign(new Error('no permission (Code: 99991672)'), { bitableCode: 99991672 });
  await assert.rejects(permanent.run({
    tableKey: 'salesEntry', operation: 'update',
    work: async () => { permanentCalls += 1; throw rejected; },
  }), /no permission/);
  assert.equal(permanentCalls, 1, '永久错误一次都不重试');
  assert.equal(delays, 0);
  const permanentFailed = second.logs.filter((item) => item.event === 'feishu.write.failed');
  assert.equal(permanentFailed.length, 1);
  assert.equal(permanentFailed[0].fields.retryable, false);
  assert.equal(permanentFailed[0].fields.reason, 'permanent');
});

// ── AC-WS2/5：queue_wait_ms 如实反映排队时间 ─────────────────────────────────
test('AC-WS5 queue_wait_ms = 从入队到真正开始执行（组内被前一个挡住的时间也算）', async () => {
  const { logs, logger } = captureLogger();
  let clock = 0;
  const scheduler = createFeishuWriteScheduler({
    config: testConfig({ maxConcurrency: 1 }), logger, now: () => clock,
  });
  const gate = defer();
  const first = scheduler.run({
    tableKey: 'liveInventory', operation: 'create',
    work: async () => { await gate.promise; clock += 100; return 'first'; },
  });
  const second = scheduler.run({
    tableKey: 'liveInventory', operation: 'create',
    work: async () => 'second',
  });
  await sleep(2);
  clock += 50; // 第二个在队列里等的时间
  gate.resolve();
  await Promise.all([first, second]);
  const applied = logs.filter((item) => item.event === 'feishu.write.applied');
  const secondLog = applied.find((item) => item.fields.attempts === 1 && item.fields.queue_wait_ms >= 50);
  assert.ok(secondLog, `第二个任务的 queue_wait_ms 必须反映排队时间；实际日志：${JSON.stringify(applied)}`);
});

// ── AC-WS6：进程级单例的开关 ─────────────────────────────────────────────────
test('AC-WS6 单例：默认按配置建；注入 null ⇒ 网关直写（回滚开关）', () => {
  resetFeishuWriteSchedulerForTests();
  const scheduler = getFeishuWriteScheduler();
  assert.ok(scheduler && typeof scheduler.run === 'function');

  setFeishuWriteSchedulerForTests(null);
  assert.equal(getFeishuWriteScheduler(), null, '关掉后网关拿到 null ⇒ 所有写逐字回到改动前');

  resetFeishuWriteSchedulerForTests();
  assert.ok(getFeishuWriteScheduler(), 'reset 后按配置重新建');
  resetFeishuWriteSchedulerForTests();
});

test('AC-WS1 run 入参校验：没有 work 函数直接抛（不静默排队）', () => {
  const scheduler = createFeishuWriteScheduler({ config: testConfig(), logger: captureLogger().logger });
  assert.throws(() => scheduler.run({ tableKey: 't', operation: 'create' }), /需要 work 函数/);
});
