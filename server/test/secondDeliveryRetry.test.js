// 「二次交付每日提醒：失败跨 tick 重试 + 瞬时错误小退避 + 失败可见告警」的验收用例。
//
// 背景（真机证据）：这条提醒与 9 点待处理单推送**都在 2026-10-06 / 10-08 早上 09:0x 掉过**
// （`Request failed with status code 400`，真因是飞书瞬时的 `1254607 Data not ready`）。
// 改动前这一条**当天失败即落 failed、当天不再重试，而且只写日志**（`docs/pending-push-card-and-retry-2026-10-08.md`
// 第 4.5 节把"补重试"挂在她口令上）；P0 批准后与 9 点推送共用 `config/pushRetry` 那一套：
//   · 按天层：每 10 分钟一次 × 6（`PUSH_DAILY_RETRY_*`），成功一次即停；
//   · 瞬时层：读表 / 发消息的 1254607 / 5xx / 429 / 网络中断小退避；确定性错误一次都不重试；
//   · 告警：次数用完往群里回一句人话（一天最多一句）。
//
// ⚠️ 本文件盯的是**重试 / 告警 / 瞬时层**这三件事：候选筛选与卡片长什么样由
//    `secondDeliveryService.test.js` 继续钉着（那边一个字都没改，全部照旧通过）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  resolvePushRetryConfig, DEFAULT_DAILY_RETRY_INTERVAL_MS, DEFAULT_DAILY_RETRY_MAX_RETRIES,
} = require('../src/config/pushRetry');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_second_delivery_retry';
// 首次失败时刻：北京 2026-10-05 09:05（与真机那两次同一时刻）。
const T0 = new Date('2026-10-05T01:05:00.000Z');
const MINUTE = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MINUTE);
const DAY_TASK_ID = 'reminder_day_2026-10-05';
const DAY_KEY = '2026-10-05';
const DELAYS_MS = [10, 20, 30, 40, 50, 60].map((minutes) => minutes * MINUTE);

// 卡片渲染只要这些字段（见 utils/larkCards.secondDeliveryOrderLines）。
const ORDER = {
  salesEntryRecordId: 'order_1', orderNo: 'XSD-P-9', tradeTypeLabel: '预定',
  pendingAmount: 260, pendingDeliveryQuantity: 1, quantity: 1,
};

const feishuError = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: {
      code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-sd', method_id: 'method-sd',
    },
  },
});
const permissionError = () => Object.assign(new Error('Access denied'), {
  response: { status: 403, data: { code: 99991672, msg: 'Access denied. One of the following scopes is required' } },
});

const isAlertPayload = (payload) => {
  try {
    return /今天不会再自动重试/.test(JSON.parse(payload.data.content).text || '');
  } catch (error) {
    return false;
  }
};
const isAlertCreate = (create) => isAlertPayload(create);
const cardCreates = (creates) => creates.filter((create) => !isAlertCreate(create));
const alertCreates = (creates) => creates.filter(isAlertCreate);

// `failTimes`：前 N 张**卡片**发失败（默认抛真机那个 1254607）；告警不参与（除非 failAlert）。
const fakeClient = ({ failTimes = 0, errorFactory = feishuError, failAlert = false } = {}) => {
  const creates = [];
  let cardAttempts = 0;
  return {
    creates,
    client: {
      im: {
        message: {
          create: async (payload) => {
            creates.push(payload);
            if (isAlertPayload(payload)) {
              if (failAlert) throw errorFactory();
              return { code: 0, data: { message_id: `om_alert_${creates.length}` } };
            }
            cardAttempts += 1;
            if (cardAttempts <= failTimes) throw errorFactory();
            return { code: 0, data: { message_id: `om_card_${cardAttempts}` } };
          },
        },
      },
    },
  };
};

const captureWarnings = () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  return {
    warnings,
    events: () => warnings.map((line) => JSON.parse(line)),
    restore: () => { console.warn = original; },
  };
};

// 这两个"读"的阶段本身由 `secondDeliveryService.test.js` 钉着（候选筛选 / 收款方式）；
// 本文件把它们换成替身，好把注意力集中在这一层：**失败之后到底还试不试、她看不看得见**。
const fakeEmptyGateway = () => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async () => [],
  get: async () => null,
});

// 与生产同一个开关形状：瞬时层可显式关掉（`maxRetries: 0`），免得按天层的用例计数被带偏。
const transientOff = (env = {}) =>
  resolvePushRetryConfig({ PUSH_TRANSIENT_RETRY_MAX_RETRIES: '0', ...env });

const newService = ({
  store, gateway, client, orders = [ORDER], retrySettings, sleep, scheduled = [], failTimes = 0,
  errorFactory, failAlert = false,
} = {}) => {
  const fake = client || fakeClient({ failTimes, errorFactory, failAlert });
  const service = new SecondDeliveryService({
    gateway: gateway || fakeEmptyGateway(),
    store: store || tmpStore('second-delivery-retry-'),
    client: fake.client,
    chatId: CHAT_ID,
    retrySettings: retrySettings || transientOff(),
    sleep: sleep || (async () => {}),
    scheduleRetry: (delayMs, callback) => { scheduled.push({ delayMs, callback }); return { delayMs }; },
  });
  // 候选与收款方式：这一层只关心"发得出去吗"，候选由别的文件钉。
  service.listPendingDeliveries = async () => orders;
  service.paymentMethodNames = async () => ['微信'];
  return { service, creates: fake.creates };
};

// ─────────────────────────────────────────────────────────────────────────────
// R1–R3：失败跨 tick 重试（每 10 分钟 × 6）
// ─────────────────────────────────────────────────────────────────────────────

test('R1 第一次失败**不算跑过**：落 failed + next_retry_at = 首次失败 + 10 分钟；没到点不发、到点才重试', async () => {
  const log = captureWarnings();
  const store = tmpStore('sd-retry-r1-');
  const scheduled = [];
  try {
    const { service, creates } = newService({ failTimes: 99, store, scheduled });

    await assert.rejects(() => service.sendDailyReminder({ now: T0 }), /status code 400/);
    let day = await store.get(DAY_TASK_ID);
    assert.equal(day.status, 'failed');
    assert.notEqual(day.sent, true, '失败**不算**今天发过了（改动前正是这里把它当成了跑过）');
    assert.equal(day.attempts, 1);
    assert.equal(day.first_failed_at, T0.toISOString());
    assert.equal(day.next_retry_at, at(10).toISOString());
    assert.equal(day.retry_delays_ms.length, 6);
    assert.equal(cardCreates(creates).length, 1);
    assert.equal(day.alert_attempted, undefined, '后面还有重试 ⇒ 不告警');

    const failed = log.events().find((entry) => entry.event === 'sales.second_delivery.reminder.failed');
    assert.equal(failed.attempt, 1);
    assert.equal(failed.max_attempts, 7);
    assert.equal(failed.will_retry, true);
    assert.equal(failed.next_retry_at, at(10).toISOString());
    assert.equal(failed.code, 1254607);
    assert.equal(failed.msg, 'Data not ready, please try again later');
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [10 * MINUTE]);

    // 没到点：一次远端调用都不发。
    const waiting = await service.sendDailyReminder({ now: at(9) });
    assert.equal(waiting.skipped, true);
    assert.equal(waiting.reason, 'retry_waiting');
    assert.equal(cardCreates(creates).length, 1);

    // 到点：重试（第 2 次），再失败 ⇒ 下一次 = 首次失败 + 20 分钟。
    await assert.rejects(() => service.sendDailyReminder({ now: at(10) }), /status code 400/);
    day = await store.get(DAY_TASK_ID);
    assert.equal(day.attempts, 2);
    assert.equal(day.next_retry_at, at(20).toISOString());
    assert.equal(cardCreates(creates).length, 2);
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [10 * MINUTE, 20 * MINUTE]);
  } finally {
    log.restore();
  }
});

test('R2 六次重试用完 ⇒ 当天不再试 + 往群里回一句人话（含哪条推送 / 哪天 / 原因 / 不会再试），且一天只一句', async () => {
  const log = captureWarnings();
  const store = tmpStore('sd-retry-r2-');
  try {
    const { service, creates } = newService({ failTimes: 99, store });
    await assert.rejects(() => service.sendDailyReminder({ now: T0 }), /status code 400/);
    for (const minute of [10, 20, 30, 40, 50, 60]) {
      await assert.rejects(() => service.sendDailyReminder({ now: at(minute) }), /status code 400/);
    }

    const day = await store.get(DAY_TASK_ID);
    assert.equal(day.attempts, 7, '首次 + 6 次重试');
    assert.equal(day.next_retry_at, '');
    assert.equal(cardCreates(creates).length, 7);
    assert.equal(day.alert_attempted, true);
    assert.equal(day.alert_sent, true);
    assert.ok(day.alert_message_id);

    const alerts = alertCreates(creates);
    assert.equal(alerts.length, 1, '一天最多一句');
    const text = JSON.parse(alerts[0].data.content).text;
    assert.match(text, /二次交付每日提醒/);
    assert.match(text, /2026-10-05/);
    assert.match(text, /不会再自动重试/);
    assert.match(text, /Data not ready/);
    assert.equal(alerts[0].data.msg_type, 'text');
    assert.equal(alerts[0].data.receive_id, CHAT_ID);

    const alertLog = log.events().find((entry) => entry.event === 'sales.second_delivery.reminder.alert.sent');
    assert.equal(alertLog.attempt, 7);
    assert.equal(alertLog.max_attempts, 7);

    // 超上限：当天不再发、也不再重复告警。
    const exhausted = await service.sendDailyReminder({ now: at(120) });
    assert.equal(exhausted.skipped, true);
    assert.equal(exhausted.reason, 'retries_exhausted');
    assert.equal(cardCreates(creates).length, 7);
    assert.equal(alertCreates(creates).length, 1);

    // 第二天是新的一天：照常第一次尝试。
    assert.equal(DEFAULT_DAILY_RETRY_INTERVAL_MS, 10 * MINUTE);
    assert.equal(DEFAULT_DAILY_RETRY_MAX_RETRIES, 6);
    assert.equal((await store.get(DAY_TASK_ID)).retry_delays_ms.length, 6);
  } finally {
    log.restore();
  }
});

test('R3 重试成功 ⇒ 当天发出去了；同一天再 tick 记 already_ran_today，**绝不重复发**', async () => {
  const store = tmpStore('sd-retry-r3-');
  const { service, creates } = newService({ failTimes: 2, store });

  await assert.rejects(() => service.sendDailyReminder({ now: T0 }), /status code 400/);
  await assert.rejects(() => service.sendDailyReminder({ now: at(10) }), /status code 400/);
  assert.equal(cardCreates(creates).length, 2);

  const third = await service.sendDailyReminder({ now: at(20) });
  assert.equal(third.pushedOrderCount, 1);
  assert.equal(third.attemptCount, 3);
  assert.equal(cardCreates(creates).length, 3);

  const day = await store.get(DAY_TASK_ID);
  assert.equal(day.status, 'completed');
  assert.equal(day.sent, true);
  assert.equal(day.attempts, 3);
  assert.equal(day.alert_attempted, undefined, '成功了就不告警');

  const again = await service.sendDailyReminder({ now: at(30) });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already_ran_today');
  assert.equal(cardCreates(creates).length, 3, '绝不重复发');
});

test('R4 幂等（跨进程/重启）：新实例 + 同一个 store —— 失败按 next_retry_at 等，成功后一次都不重发', async () => {
  const store = tmpStore('sd-retry-r4-');
  const first = newService({ failTimes: 99, store });
  await assert.rejects(() => first.service.sendDailyReminder({ now: T0 }), /status code 400/);
  assert.equal(cardCreates(first.creates).length, 1);

  // PM2 reload：新实例、新 client、同一个 store。
  const second = newService({ store });
  const waiting = await second.service.sendDailyReminder({ now: at(5) });
  assert.equal(waiting.reason, 'retry_waiting');
  assert.equal(cardCreates(second.creates).length, 0, '重启后不会立刻重发');

  const retried = await second.service.sendDailyReminder({ now: at(10) });
  assert.equal(retried.pushedOrderCount, 1);
  assert.equal(cardCreates(second.creates).length, 1);

  const third = newService({ store });
  const again = await third.service.sendDailyReminder({ now: at(30) });
  assert.equal(again.reason, 'already_ran_today');
  assert.equal(cardCreates(third.creates).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// R5–R7：瞬时层（读表 / 发消息的小退避；确定性错误不重试）
// ─────────────────────────────────────────────────────────────────────────────

test('R5 发卡片撞上 1254607：1s → 2s 小退避后成功 ⇒ 当天照常发出去（不再整天不发）', async () => {
  const delays = [];
  const store = tmpStore('sd-retry-r5-');
  const { service, creates } = newService({
    failTimes: 2, store, retrySettings: resolvePushRetryConfig({}), sleep: async (ms) => { delays.push(ms); },
  });
  const result = await service.sendDailyReminder({ now: T0 });

  assert.equal(result.pushedOrderCount, 1);
  assert.equal(cardCreates(creates).length, 3, '两次瞬时失败 + 第 3 次成功');
  assert.deepEqual(delays, [1000, 2000], '指数退避 1s → 2s');
  const day = await store.get(DAY_TASK_ID);
  assert.equal(day.sent, true);
  assert.equal(day.attempts, 1, '瞬时层就成功了 ⇒ 按天层只算第一次尝试');
  assert.equal(alertCreates(creates).length, 0);
});

test('R6 读表撞上 1254607：整表读也走小退避（早上 9:00 那一下正是这里）', async () => {
  const delays = [];
  let attempts = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'salesEntry') {
        attempts += 1;
        if (attempts <= 2) throw feishuError();
      }
      return [];
    },
    get: async () => null,
  };
  const service = new SecondDeliveryService({
    gateway,
    store: tmpStore('sd-retry-r6-'),
    client: fakeClient({}).client,
    chatId: CHAT_ID,
    retrySettings: resolvePushRetryConfig({}),
    sleep: async (ms) => { delays.push(ms); },
    scheduleRetry: () => ({}),
  });
  // ⚠️ 这里**不**替换 `listPendingDeliveries`：走的是真的整表读。
  const orders = await service.listPendingDeliveries({ now: T0 });
  assert.deepEqual(orders, []);
  assert.equal(attempts, 3, '两次瞬时失败 + 第 3 次成功');
  assert.deepEqual(delays, [1000, 2000]);
});

test('R7 确定性错误（权限 99991672）**一次都不重试**：只留一条 retryable:false 的日志，并按天层等下一次', async () => {
  const log = captureWarnings();
  const delays = [];
  const store = tmpStore('sd-retry-r7-');
  try {
    const { service, creates } = newService({
      failTimes: 99, errorFactory: permissionError, store,
      retrySettings: resolvePushRetryConfig({}), sleep: async (ms) => { delays.push(ms); },
    });
    await assert.rejects(() => service.sendDailyReminder({ now: T0 }), /Access denied/);
    assert.deepEqual(delays, [], '确定性错误 ⇒ 一次睡眠都没有（不重试）');
    assert.equal(cardCreates(creates).length, 1);
    const skipped = log.events().find((entry) => entry.event === 'push.transient_retry.skipped');
    assert.ok(skipped);
    assert.equal(skipped.operation, 'second_delivery.reminder.send_card');
    assert.equal(skipped.retryable, false);
    assert.equal(skipped.code, '99991672');
    const day = await store.get(DAY_TASK_ID);
    assert.equal(day.status, 'failed');
    assert.equal(day.next_retry_at, at(10).toISOString(), '按天层照旧记账（不是"今天不试了"）');
  } finally {
    log.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R8–R10：非失败终态 / running / 告警本身发不出去
// ─────────────────────────────────────────────────────────────────────────────

test('R8 没有候选单（非失败）与改动前一致：当天不再试、不排重试、不告警', async () => {
  const store = tmpStore('sd-retry-r8-');
  const scheduled = [];
  const { service, creates } = newService({ orders: [], store, scheduled });
  const first = await service.sendDailyReminder({ now: T0 });
  assert.equal(first.reason, 'no_pending_order');
  assert.equal((await store.get(DAY_TASK_ID)).sent, false);
  assert.deepEqual(scheduled, []);
  assert.equal(creates.length, 0);

  const second = await service.sendDailyReminder({ now: at(10) });
  assert.equal(second.reason, 'already_ran_today');
  assert.equal(creates.length, 0);
});

test('R9 记录停在 running（进程崩在两次写之间）⇒ 当天不发（绝不复重复发）', async () => {
  const store = tmpStore('sd-retry-r9-');
  await store.create({
    task_id: DAY_TASK_ID, day: DAY_KEY, status: 'running', attempts: 1, sent: false,
  });
  const { service, creates } = newService({ store });
  const result = await service.sendDailyReminder({ now: T0 });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'in_progress');
  assert.equal(creates.length, 0);
});

test('R10 告警本身发不出去：不抛、不改变"今天不再试"的结论，落 alert_sent:false + 原因；不重复告警', async () => {
  const log = captureWarnings();
  const store = tmpStore('sd-retry-r10-');
  try {
    const { service, creates } = newService({
      failTimes: 99,
      failAlert: true,
      store,
      retrySettings: {
        ...transientOff(),
        daily: { retryIntervalMs: MINUTE, maxRetries: 0, retryDelaysMs: [] },
      },
    });
    await assert.rejects(() => service.sendDailyReminder({ now: T0 }), /status code 400/);

    const day = await store.get(DAY_TASK_ID);
    assert.equal(day.alert_attempted, true);
    assert.equal(day.alert_sent, false);
    assert.ok(day.alert_error, '告警发不出去也要留下原因');
    const alertFailed = log.events().find((entry) => entry.event === 'sales.second_delivery.reminder.alert.failed');
    assert.ok(alertFailed);

    // 之后同一天不再试、也不再重复告警（一天最多一次尝试）。
    const before = alertCreates(creates).length;
    const after = await service.sendDailyReminder({ now: at(60) });
    assert.equal(after.reason, 'retry_disabled');
    assert.equal(alertCreates(creates).length, before);
  } finally {
    log.restore();
  }
});
