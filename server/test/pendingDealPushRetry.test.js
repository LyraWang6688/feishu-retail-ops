// 「9 点待处理单推送：**失败自动重试**」的验收用例（业务负责人 2026-10-08 口径）。
//
// 逐字口径：
//   「② **推送失败自动重试**：失败后隔 **5/15 分钟**各重试一次，别一次失败就整天不发 … 可以一并修复～」
// 真机伤口（2026-10-08 09:05）：`sales.pending_deal_push.failed {error:"Request failed with status code 400"}`
//   → 09:15 那班记 `already_ran_today` ⇒ **一整天不再发**。
//
// 本文件盯的是（验收标准 D1–D9 / C4）：
//   D1 第一次失败**不算跑过**、`next_retry_at = 首次失败 + 5 分钟`；
//   D2 没到点不发；D3 到点重试；D4 两次用完 ⇒ 当天不再试；
//   D5 重试成功即停、**绝不重复发**；D6 定时器按 5/15 分钟被调用；
//   D7 窗口/次数**配置化**；C4 失败日志带飞书真实 code/msg/log_id/method_id。
// 逐条对照见 docs/pending-push-card-and-retry-2026-10-08.md 第 4 节。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { LarkMessageLinkResolver } = require('../src/services/larkMessageLinkResolver');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const {
  resolvePendingDealPushConfig, resolveRetryDelaysMs, DEFAULT_RETRY_DELAYS_MS,
} = require('../src/config/pendingDealPush');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_retry';
// 首次失败时刻：北京 09:05（真机那次）。
const T0 = new Date('2026-10-08T01:05:00.000Z');
const MINUTE = 60 * 1000;
const at = (offsetMinutes) => new Date(T0.getTime() + offsetMinutes * MINUTE);
const DAY_TASK_ID = 'pending_deal_push_day_2026-10-08';

// 真机那个 400 的形状：message 只有一句 axios 的话，真实原因在 response.data 里。
const feishuError = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: {
      code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-xyz', method_id: 'method-xyz',
    },
  },
});

const ORDER = {
  salesEntryRecordId: 'sale_a', orderNo: 'XSD-A-1', fulfillmentStatus: '未交付',
  pendingAmount: 128, items: [{ kind: 'shoe', itemNo: 'JC002', size: '40' }],
};

// `failTimes`：前 N 次 create 抛飞书错（失败），之后成功。
const fakeClient = ({ failTimes = 0 } = {}) => {
  const creates = [];
  let attempts = 0;
  return {
    creates,
    client: {
      im: {
        message: {
          create: async (payload) => {
            creates.push(payload);
            attempts += 1;
            if (attempts <= failTimes) throw feishuError();
            return { code: 0, data: { message_id: `om_${attempts}` } };
          },
          reply: async () => { throw new Error('本推送必须发到主聊天，不许 reply'); },
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

const newService = ({ failTimes = 0, store, scheduled = [], settings: overrides = {} } = {}) => {
  const { client, creates } = fakeClient({ failTimes });
  const service = new PendingDealPushService({
    // ⚠️ 重试用例走**纯文本**形态：每次尝试 = 一次 create，计数直白
    //（卡片形态下"卡片失败 → 纯文本兜底"是两次 create，那条链路由
    //  pendingDealPushCard.test.js 的「自动降级」用例单独钉住）。
    settings: {
      ...resolvePendingDealPushConfig({}),
      enabled: true,
      chatId: CHAT_ID,
      linkLookupEnabled: false,
      linkRequired: false,
      messageFormat: 'text',
      ...overrides,
    },
    secondDelivery: { client, listPendingDeliveries: async () => [ORDER] },
    locator: new SalesGroupThreadLocator({ store: tmpStore('pending-retry-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store: store || tmpStore('pending-retry-day-'),
    pin: { pinLatest: async () => ({ pinned: false, reason: 'pin_disabled', previousMessageId: '' }) },
    scheduleRetry: (delayMs, callback) => { scheduled.push({ delayMs, callback }); return { delayMs }; },
    purchasePending: { listPendingBatches: async () => [], loadLinkIndex: async () => new Map(), resolveThreadLinkFrom: () => ({}) },
  });
  return { service, creates };
};

// ─────────────────────────────────────────────────────────────────────────────
// D1 / D2 / D3 / D4：失败不算跑过 → 5 分钟 → 15 分钟 → 用完就停
// ─────────────────────────────────────────────────────────────────────────────

test('D1–D4 失败后 5 / 15 分钟各重试一次；用完全部失败 ⇒ 当天不再试（真机那个坑）', async () => {
  const log = captureWarnings();
  const store = tmpStore('pending-retry-flow-');
  const scheduled = [];
  try {
    const { service, creates } = newService({ failTimes: 99, store, scheduled });

    // ① 第一次失败：**不许**记成"今天跑过了"。
    await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
    const first = await store.get(DAY_TASK_ID);
    assert.equal(first.status, 'failed');
    assert.notEqual(first.sent, true, '第一次失败**不算**发出去过');
    assert.equal(first.attempts, 1);
    assert.equal(first.first_failed_at, T0.toISOString());
    assert.equal(first.next_retry_at, at(5).toISOString(), 'D1 首次失败 + 5 分钟');
    assert.equal(creates.length, 1);

    // C4 失败日志要带飞书真实四项（不许只有 "Request failed with status code 400"）。
    const failed = log.events().find((entry) => entry.event === 'sales.pending_deal_push.failed');
    assert.equal(failed.attempt, 1);
    assert.equal(failed.will_retry, true);
    assert.equal(failed.next_retry_at, at(5).toISOString());
    assert.equal(failed.code, 1254607);
    assert.equal(failed.msg, 'Data not ready, please try again later');
    assert.equal(failed.log_id, 'log-xyz');
    assert.equal(failed.method_id, 'method-xyz');
    assert.ok(!log.warnings.join('\n').includes('[object]'));

    // D6 定时器被以 5 分钟排了一次。
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [5 * MINUTE]);

    // D2 没到点：什么都不做（**一条消息都不发**）。
    const waiting = await service.sendDailyPush({ now: at(4) });
    assert.equal(waiting.skipped, true);
    assert.equal(waiting.reason, 'retry_waiting');
    assert.equal(creates.length, 1, '没到点不许发');

    // D3 到点：真的重试（第 2 次尝试）；再失败 ⇒ 下一次 = 首次失败 + 15 分钟。
    await assert.rejects(() => service.sendDailyPush({ now: at(5) }), /status code 400/);
    const second = await store.get(DAY_TASK_ID);
    assert.equal(second.attempts, 2);
    assert.equal(second.next_retry_at, at(15).toISOString(), 'D3 第二次重试 = 首次失败 + 15 分钟');
    assert.equal(creates.length, 2);
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [5 * MINUTE, 15 * MINUTE]);

    // 14 分钟时还没到点。
    assert.equal((await service.sendDailyPush({ now: at(14) })).reason, 'retry_waiting');
    // D4 15 分钟：最后一次尝试；再失败 ⇒ 当天不再试。
    await assert.rejects(() => service.sendDailyPush({ now: at(15) }), /status code 400/);
    assert.equal(creates.length, 3);
    const third = await store.get(DAY_TASK_ID);
    assert.equal(third.attempts, 3);
    assert.equal(third.next_retry_at, '', '没有第 3 次重试了');

    const log2 = captureWarnings();
    let exhausted;
    try {
      exhausted = await service.sendDailyPush({ now: at(60) });
    } finally {
      log2.restore();
    }
    assert.equal(exhausted.skipped, true);
    assert.equal(exhausted.reason, 'retries_exhausted');
    assert.equal(creates.length, 3, '当天不再试');
    // 第二天是**新的一天**：照常进候选、照常第一次尝试（可自愈）。
    await assert.rejects(() => service.sendDailyPush({ now: new Date('2026-10-09T01:05:00.000Z') }), /status code 400/);
    assert.equal(creates.length, 4);
    assert.equal((await store.get('pending_deal_push_day_2026-10-09')).attempts, 1);
  } finally {
    log.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D5：重试成功即停、绝不重复发
// ─────────────────────────────────────────────────────────────────────────────

test('D5 重试成功 ⇒ 记 sent；同一天再调 already_ran_today，**绝不重复发**', async () => {
  const store = tmpStore('pending-retry-success-');
  const scheduled = [];
  const { service, creates } = newService({ failTimes: 2, store, scheduled });

  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  await assert.rejects(() => service.sendDailyPush({ now: at(5) }), /status code 400/);
  assert.equal(creates.length, 2, '前两次尝试都失败');

  const third = await service.sendDailyPush({ now: at(15) });
  assert.equal(third.pushedOrderCount, 1);
  assert.equal(third.attemptCount, 3);
  assert.equal(creates.length, 3, '第 3 次真的发出去了');

  const day = await store.get(DAY_TASK_ID);
  assert.equal(day.status, 'completed');
  assert.equal(day.sent, true);
  assert.equal(day.attempts, 3);

  // 之后同一天的任何一班都不再发（幂等的唯一根据 = 当天记录里 sent:true）。
  const again = await service.sendDailyPush({ now: at(20) });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already_ran_today');
  assert.equal(creates.length, 3, '绝不重复发');
});

// ─────────────────────────────────────────────────────────────────────────────
// D8 / D9：非失败终态不重试；崩在 running 时不重发
// ─────────────────────────────────────────────────────────────────────────────

test('D8 没有候选单（非失败）与改动前一致：当天不再试，也不排重试', async () => {
  const store = tmpStore('pending-retry-empty-');
  const scheduled = [];
  const { client, creates } = fakeClient({});
  const service = new PendingDealPushService({
    settings: {
      ...resolvePendingDealPushConfig({}), enabled: true, chatId: CHAT_ID, linkLookupEnabled: false, linkRequired: false,
    },
    secondDelivery: { client, listPendingDeliveries: async () => [] },
    locator: new SalesGroupThreadLocator({ store: tmpStore('pending-retry-empty-map-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store,
    pin: { pinLatest: async () => ({ pinned: false, reason: 'pin_disabled', previousMessageId: '' }) },
    scheduleRetry: (delayMs, callback) => { scheduled.push({ delayMs, callback }); return {}; },
    purchasePending: { listPendingBatches: async () => [], loadLinkIndex: async () => new Map(), resolveThreadLinkFrom: () => ({}) },
  });

  const first = await service.sendDailyPush({ now: T0 });
  assert.equal(first.reason, 'no_pending_order');
  assert.equal((await store.get(DAY_TASK_ID)).sent, false);
  assert.deepEqual(scheduled, [], '不是失败 ⇒ 不排重试');

  const second = await service.sendDailyPush({ now: at(5) });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_ran_today');
  assert.equal(creates.length, 0);
});

test('D9 记录停在 running（进程崩在两次写之间）⇒ 当天不发（与改动前一致），绝不重复发', async () => {
  const store = tmpStore('pending-retry-running-');
  await store.create({
    task_id: DAY_TASK_ID, day: '2026-10-08', status: 'running', attempts: 1, sent: false,
  });
  const { service, creates } = newService({ store });
  const result = await service.sendDailyPush({ now: T0 });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'in_progress');
  assert.equal(creates.length, 0, '宁可少推一天，也绝不重复发');
});

// ─────────────────────────────────────────────────────────────────────────────
// D7：窗口 / 次数配置化
// ─────────────────────────────────────────────────────────────────────────────

test('D7 重试窗口可配：默认 5/15 分钟；空串 = 不重试；非法值启动时抛错', async () => {
  assert.deepEqual(resolveRetryDelaysMs({}), [5 * 60 * 1000, 15 * 60 * 1000]);
  assert.deepEqual(DEFAULT_RETRY_DELAYS_MS, [300000, 900000]);
  assert.deepEqual(resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '60000,120000,300000' }),
    [60000, 120000, 300000]);
  assert.deepEqual(resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '' }), [], '空串 = 不重试');
  assert.throws(() => resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '0' }), /整数毫秒/);
  assert.throws(() => resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '5m' }), /整数毫秒/);
  assert.deepEqual(resolvePendingDealPushConfig({}).retryDelaysMs, [300000, 900000]);

  // 不重试（空串）：第一次失败之后当天就不再来一次。
  const store = tmpStore('pending-retry-off-');
  const scheduled = [];
  const { service, creates } = newService({ failTimes: 99, store, scheduled, settings: { retryDelaysMs: [] } });
  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  assert.deepEqual(scheduled, []);
  const again = await service.sendDailyPush({ now: at(60) });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'retry_disabled');
  assert.equal(creates.length, 1);
});

test('D7 重试次数跟着窗口走：配一个窗口 ⇒ 只重试一次', async () => {
  const store = tmpStore('pending-retry-one-');
  const scheduled = [];
  const { service, creates } = newService({
    failTimes: 99, store, scheduled, settings: { retryDelaysMs: [7 * MINUTE] },
  });
  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  assert.equal((await store.get(DAY_TASK_ID)).next_retry_at, at(7).toISOString());
  await assert.rejects(() => service.sendDailyPush({ now: at(7) }), /status code 400/);
  assert.equal(creates.length, 2);
  const done = await service.sendDailyPush({ now: at(8) });
  assert.equal(done.reason, 'retries_exhausted');
  assert.equal(creates.length, 2);
});
