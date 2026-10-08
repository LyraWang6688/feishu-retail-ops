// 「9 点待处理单推送：**失败跨 tick 重试 + 瞬时错误小退避 + 失败可见告警**」的验收用例。
//
// 业务负责人口径（2026-10-08，P0 批准后定的三条）：
//   ① 失败要重试（跨 tick）：当天失败后按间隔重试，直到当天成功一次；上限 6 次，超过就停并告警；
//   ② 失败要可见：当天重试仍失败时，往配置的群里回一句人话（哪条推送 / 什么原因 / 当天不会再试）；
//   ③ 瞬时错误自动重试：读表与发消息的 1254607 / 5xx / 429 / 网络中断小退避；
//      确定性错误（权限 / 参数 / 缺配置）**一次都不重试**，只留一条清晰日志。
// 真机伤口（2026-10-08 09:05）：`sales.pending_deal_push.failed {error:"Request failed with status code 400"}`
//   → 09:15 那班记 `already_ran_today` ⇒ **一整天不再发**，而且没人知道。
//
// 本文件盯的是（验收标准 D1–D9 / C4 + 新增 E1–E4）：
//   D1 第一次失败**不算跑过**、`next_retry_at = 首次失败 + 10 分钟`；
//   D2 没到点不发；D3 到点重试；D4 六次重试用完 ⇒ 当天不再试 **且告警**；
//   D5 重试成功即停、**绝不重复发**；D6 定时器按 10/20/… 分钟被调用；
//   D7 窗口/次数/告警文案**配置化**；D8/D9 非失败终态与 running 不重试；
//   C4 失败日志带飞书真实 code/msg/log_id/method_id；
//   E1 瞬时错误（1254607）小退避后成功；E2 5xx/429 也重试；E3 确定性错误不重试；
//   E4 幂等：跨进程重启不重复推、告警一天最多一句。
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
// ⭐ 2026-10-08（P0）：共享的重试 / 告警策略（两条推送一处实现）。
const {
  resolvePushRetryConfig, DEFAULT_DAILY_RETRY_INTERVAL_MS, DEFAULT_DAILY_RETRY_MAX_RETRIES,
} = require('../src/config/pushRetry');
// ⭐ 2026-10-08（第一步）：候选换成"行"（`{ sections, rows, purchase }`）——
//   本文件只关心重试状态机，候选由这个替身给。
const { fakeCandidates } = require('./helpers/pendingPushTestData');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_retry';
// 首次失败时刻：北京 09:05（真机那次）。
const T0 = new Date('2026-10-08T01:05:00.000Z');
const MINUTE = 60 * 1000;
const at = (offsetMinutes) => new Date(T0.getTime() + offsetMinutes * MINUTE);
const DAY_TASK_ID = 'pending_deal_push_day_2026-10-08';
// 默认按天节奏：每 10 分钟一次 × 6（相对首次失败的偏移）。
const DELAYS_MS = [10, 20, 30, 40, 50, 60].map((minutes) => minutes * MINUTE);

// 真机那个 400 的形状：message 只有一句 axios 的话，真实原因在 response.data 里。
const feishuError = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: {
      code: 1254607, msg: 'Data not ready, please try again later', log_id: 'log-xyz', method_id: 'method-xyz',
    },
  },
});
// 确定性错误（权限不够）：重试一万次也没用 —— 用来证明"一次都不重试"。
const permissionError = () => Object.assign(new Error('Access denied'), {
  response: { status: 403, data: { code: 99991672, msg: 'Access denied. One of the following scopes is required' } },
});
const serverError = (status = 503) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

const ORDER = {
  salesEntryRecordId: 'sale_a', orderNo: 'XSD-A-1', fulfillmentStatus: '未交付',
  pendingAmount: 128, items: [{ kind: 'shoe', itemNo: 'JC002', size: '40' }],
};

// 告警也是一条 `msg_type:'text'` 的群消息（与纯文本降级的推送同一个出口）⇒ 按文案区分。
const isAlertPayload = (payload) => {
  try {
    return /今天不会再自动重试/.test(JSON.parse(payload.data.content).text || '');
  } catch (error) {
    return false;
  }
};
const isAlertCreate = (create) => isAlertPayload(create);
const pushCreates = (creates) => creates.filter((create) => !isAlertCreate(create));
const alertCreates = (creates) => creates.filter(isAlertCreate);

// `failTimes`：前 N 次**推送** create 抛 `errorFactory()`（默认 = 真机那个 1254607），之后成功。
// ⚠️ 告警那条 create **不参与 `failTimes`**（默认能发出去）：否则"失败到需要告警"的场景里
//    连告警本身也一起失败，就测不出"她到底看不看得见"了。`failAlert:true` 单独测告警也发不出去。
const fakeClient = ({ failTimes = 0, errorFactory = feishuError, failAlert = false } = {}) => {
  const creates = [];
  let pushAttempts = 0;
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
            pushAttempts += 1;
            if (pushAttempts <= failTimes) throw errorFactory();
            return { code: 0, data: { message_id: `om_${pushAttempts}` } };
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

// ⚠️ 本文件默认把"瞬时层"关掉（`maxRetries: 0`）：本文件绝大部分用例盯的是**按天层**
//    （每 10 分钟一次 × 6），瞬时层会让每个失败变成 3 次 create、把计数和耗时全带偏。
//    瞬时层由 E1–E3 显式打开后单独钉住。
const transientOff = (env = {}) =>
  resolvePushRetryConfig({ PUSH_TRANSIENT_RETRY_MAX_RETRIES: '0', ...env });

const newService = ({
  failTimes = 0, errorFactory, store, scheduled = [], settings: overrides = {},
  retrySettings, sleep,
} = {}) => {
  const { client, creates } = fakeClient({ failTimes, errorFactory });
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
    candidates: fakeCandidates({ orders: [ORDER] }),
    locator: new SalesGroupThreadLocator({ store: tmpStore('pending-retry-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store: store || tmpStore('pending-retry-day-'),
    pin: { pinLatest: async () => ({ pinned: false, reason: 'pin_disabled', previousMessageId: '' }) },
    retrySettings: retrySettings || transientOff(),
    sleep: sleep || (async () => {}),
    scheduleRetry: (delayMs, callback) => { scheduled.push({ delayMs, callback }); return { delayMs }; },
  });
  return { service, creates };
};

// ─────────────────────────────────────────────────────────────────────────────
// D1 / D2 / D3 / D4：失败不算跑过 → 每 10 分钟一次 → 用完就停 + 告警
// ─────────────────────────────────────────────────────────────────────────────

test('D1–D4 失败后每 10 分钟重试一次（上限 6 次）；用完全部失败 ⇒ 当天不再试 + 群里一句告警', async () => {
  const log = captureWarnings();
  const store = tmpStore('pending-retry-flow-');
  const scheduled = [];
  try {
    const { service, creates } = newService({ failTimes: 99, store, scheduled });

    // ① 第一次失败：**不许**记成"今天跑过了"，也**还不该**告警（后面还有重试）。
    await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
    let day = await store.get(DAY_TASK_ID);
    assert.equal(day.status, 'failed');
    assert.notEqual(day.sent, true, '第一次失败**不算**发出去过');
    assert.equal(day.attempts, 1);
    assert.equal(day.first_failed_at, T0.toISOString());
    assert.equal(day.next_retry_at, at(10).toISOString(), 'D1 首次失败 + 10 分钟');
    assert.equal(pushCreates(creates).length, 1);
    assert.equal(day.alert_attempted, undefined, '还有重试 ⇒ 不告警');

    // C4 失败日志要带飞书真实四项（不许只有 "Request failed with status code 400"）。
    const failed = log.events().find((entry) => entry.event === 'sales.pending_deal_push.failed');
    assert.equal(failed.attempt, 1);
    assert.equal(failed.max_attempts, 7);
    assert.equal(failed.will_retry, true);
    assert.equal(failed.next_retry_at, at(10).toISOString());
    assert.equal(failed.code, 1254607);
    assert.equal(failed.msg, 'Data not ready, please try again later');
    assert.equal(failed.log_id, 'log-xyz');
    assert.equal(failed.method_id, 'method-xyz');
    assert.ok(!log.warnings.join('\n').includes('[object]'));

    // D6 定时器被以 10 分钟排了一次。
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [10 * MINUTE]);

    // D2 没到点：什么都不做（**一条消息都不发**）。
    const waiting = await service.sendDailyPush({ now: at(9) });
    assert.equal(waiting.skipped, true);
    assert.equal(waiting.reason, 'retry_waiting');
    assert.equal(pushCreates(creates).length, 1, '没到点不许发');

    // D3 到点：真的重试（第 2 次尝试）；再失败 ⇒ 下一次 = 首次失败 + 20 分钟。
    await assert.rejects(() => service.sendDailyPush({ now: at(10) }), /status code 400/);
    day = await store.get(DAY_TASK_ID);
    assert.equal(day.attempts, 2);
    assert.equal(day.next_retry_at, at(20).toISOString(), 'D3 第二次重试 = 首次失败 + 20 分钟');
    assert.equal(pushCreates(creates).length, 2);
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), [10 * MINUTE, 20 * MINUTE]);

    // D4 把剩下的 5 次用完（at 20/30/40/50/60）：最后一次失败 ⇒ 当天不再试 + 告警。
    for (const minute of [20, 30, 40, 50, 60]) {
      await assert.rejects(() => service.sendDailyPush({ now: at(minute) }), /status code 400/);
    }
    day = await store.get(DAY_TASK_ID);
    assert.equal(day.attempts, 7, '首次 + 6 次重试 = 7 次尝试');
    assert.equal(day.next_retry_at, '', '没有第 7 次重试了');
    assert.equal(pushCreates(creates).length, 7);
    assert.deepEqual(scheduled.map((entry) => entry.delayMs), DELAYS_MS);

    // ⭐ 失败要可见：一天一句、带"哪条推送 / 哪天 / 什么原因 / 不会再试"。
    assert.equal(day.alert_attempted, true);
    assert.equal(day.alert_sent, true);
    assert.ok(day.alert_message_id, '告警消息 id 要落盘（排查"到底发出去没有"）');
    const alertText = JSON.parse(alertCreates(creates)[0].data.content).text;
    assert.match(alertText, /9 点待处理单推送/);
    assert.match(alertText, /2026-10-08/);
    assert.match(alertText, /不会再自动重试/);
    assert.match(alertText, /Data not ready/);
    const alertLog = log.events().find((entry) => entry.event === 'sales.pending_deal_push.alert.sent');
    assert.equal(alertLog.attempt, 7);
    assert.equal(alertLog.max_attempts, 7);

    // 超上限：当天不再发，**也不再重复告警**（一天最多一句）。
    const log2 = captureWarnings();
    let exhausted;
    try {
      exhausted = await service.sendDailyPush({ now: at(120) });
    } finally {
      log2.restore();
    }
    assert.equal(exhausted.skipped, true);
    assert.equal(exhausted.reason, 'retries_exhausted');
    assert.equal(pushCreates(creates).length, 7, '当天不再试');
    assert.equal(alertCreates(creates).length, 1, '告警一天只发一句');
    assert.ok(!log2.events().some((entry) => entry.event === 'sales.pending_deal_push.alert.sent'));

    // 第二天是**新的一天**：照常进候选、照常第一次尝试（可自愈）。
    await assert.rejects(() => service.sendDailyPush({ now: new Date('2026-10-09T01:05:00.000Z') }), /status code 400/);
    assert.equal(pushCreates(creates).length, 8);
    assert.equal((await store.get('pending_deal_push_day_2026-10-09')).attempts, 1);
  } finally {
    log.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 + E4：重试成功即停；跨进程重启不重复推
// ─────────────────────────────────────────────────────────────────────────────

test('D5 重试成功 ⇒ 记 sent；同一天再调 already_ran_today，**绝不重复发**', async () => {
  const store = tmpStore('pending-retry-success-');
  const scheduled = [];
  const { service, creates } = newService({ failTimes: 2, store, scheduled });

  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  await assert.rejects(() => service.sendDailyPush({ now: at(10) }), /status code 400/);
  assert.equal(pushCreates(creates).length, 2, '前两次尝试都失败');

  const third = await service.sendDailyPush({ now: at(20) });
  assert.equal(third.pushedOrderCount, 1);
  assert.equal(third.attemptCount, 3);
  assert.equal(pushCreates(creates).length, 3, '第 3 次真的发出去了');

  const day = await store.get(DAY_TASK_ID);
  assert.equal(day.status, 'completed');
  assert.equal(day.sent, true);
  assert.equal(day.attempts, 3);
  assert.equal(day.alert_attempted, undefined, '成功了就不告警');

  // 之后同一天的任何一班都不再发（幂等的唯一根据 = 当天记录里 sent:true）。
  const again = await service.sendDailyPush({ now: at(30) });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already_ran_today');
  assert.equal(pushCreates(creates).length, 3, '绝不重复发');
});

test('E4 幂等（跨进程/重启）：新实例 + 同一个 store —— 失败时按 next_retry_at 等，成功后一次都不重发', async () => {
  const store = tmpStore('pending-retry-restart-');
  const scheduled = [];
  // 进程 A：第一次失败。
  const first = newService({ failTimes: 99, store, scheduled });
  await assert.rejects(() => first.service.sendDailyPush({ now: T0 }), /status code 400/);
  assert.equal(pushCreates(first.creates).length, 1);

  // PM2 reload：**新实例、新 client，同一个 store**（线上就是这个形状）。
  const second = newService({ failTimes: 0, store });
  const waiting = await second.service.sendDailyPush({ now: at(5) });
  assert.equal(waiting.reason, 'retry_waiting');
  assert.equal(pushCreates(second.creates).length, 0, '重启后不会立刻重发（按 next_retry_at 等）');

  const retried = await second.service.sendDailyPush({ now: at(10) });
  assert.equal(retried.pushedOrderCount, 1);
  assert.equal(pushCreates(second.creates).length, 1);

  // 再重启一次：成功过 ⇒ **绝不重发**（按天记录里 sent:true）。
  const third = newService({ failTimes: 0, store });
  const again = await third.service.sendDailyPush({ now: at(30) });
  assert.equal(again.reason, 'already_ran_today');
  assert.equal(pushCreates(third.creates).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// D8 / D9：非失败终态不重试；崩在 running 时不重发
// ─────────────────────────────────────────────────────────────────────────────

test('D8 没有候选单（非失败）与改动前一致：当天不再试，也不排重试、不告警', async () => {
  const store = tmpStore('pending-retry-empty-');
  const scheduled = [];
  const { client, creates } = fakeClient({});
  const service = new PendingDealPushService({
    settings: {
      ...resolvePendingDealPushConfig({}), enabled: true, chatId: CHAT_ID, linkLookupEnabled: false, linkRequired: false,
    },
    candidates: fakeCandidates({ orders: [] }),
    locator: new SalesGroupThreadLocator({ store: tmpStore('pending-retry-empty-map-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store,
    pin: { pinLatest: async () => ({ pinned: false, reason: 'pin_disabled', previousMessageId: '' }) },
    retrySettings: transientOff(),
    sleep: async () => {},
    scheduleRetry: (delayMs, callback) => { scheduled.push({ delayMs, callback }); return {}; },
  });

  const first = await service.sendDailyPush({ now: T0 });
  assert.equal(first.reason, 'no_pending_order');
  assert.equal((await store.get(DAY_TASK_ID)).sent, false);
  assert.deepEqual(scheduled, [], '不是失败 ⇒ 不排重试');

  const second = await service.sendDailyPush({ now: at(10) });
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
// D7：窗口 / 次数 / 告警文案配置化
// ─────────────────────────────────────────────────────────────────────────────

test('D7 重试窗口可配：默认每 10 分钟 × 6；显式覆盖；空串 = 不重试；非法值启动时抛错', async () => {
  assert.equal(DEFAULT_DAILY_RETRY_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_DAILY_RETRY_MAX_RETRIES, 6);
  assert.deepEqual(resolveRetryDelaysMs({}), DELAYS_MS);
  assert.deepEqual(DEFAULT_RETRY_DELAYS_MS, DELAYS_MS);
  assert.deepEqual(resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '60000,120000,300000' }),
    [60000, 120000, 300000], '显式覆盖仍然有效（想回到 5/15 分钟也只改环境变量）');
  assert.deepEqual(resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '' }), [], '空串 = 不重试');
  assert.throws(() => resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '0' }), /整数毫秒/);
  assert.throws(() => resolveRetryDelaysMs({ PENDING_DEAL_PUSH_RETRY_DELAYS_MS: '5m' }), /整数毫秒/);
  assert.deepEqual(resolvePendingDealPushConfig({}).retryDelaysMs, DELAYS_MS);

  // 共享的按天策略（两条推送共用）：间隔 / 上限可配，总跨度不许超过一天。
  assert.deepEqual(resolvePushRetryConfig({ PUSH_DAILY_RETRY_INTERVAL_MS: '120000', PUSH_DAILY_RETRY_MAX_RETRIES: '2' })
    .daily.retryDelaysMs, [120000, 240000]);
  assert.deepEqual(resolvePushRetryConfig({ PUSH_DAILY_RETRY_MAX_RETRIES: '0' }).daily.retryDelaysMs, []);
  assert.throws(() => resolvePushRetryConfig({
    PUSH_DAILY_RETRY_INTERVAL_MS: '86400000', PUSH_DAILY_RETRY_MAX_RETRIES: '2',
  }), /不能超过一天/);

  // 不重试（空串）：第一次失败之后当天就不再来一次 —— 但**必须告警**（不静默）。
  const store = tmpStore('pending-retry-off-');
  const scheduled = [];
  const { service, creates } = newService({ failTimes: 99, store, scheduled, settings: { retryDelaysMs: [] } });
  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  assert.deepEqual(scheduled, []);
  assert.equal(alertCreates(creates).length, 1, '不重试 ⇒ 当天就没机会了 ⇒ 当场告警');
  const again = await service.sendDailyPush({ now: at(60) });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'retry_disabled');
  assert.equal(pushCreates(creates).length, 1);
  assert.equal(alertCreates(creates).length, 1, '告警不重复');
});

test('D7 重试次数跟着窗口走：配一个窗口 ⇒ 只重试一次，然后告警', async () => {
  const store = tmpStore('pending-retry-one-');
  const scheduled = [];
  const { service, creates } = newService({
    failTimes: 99, store, scheduled, settings: { retryDelaysMs: [7 * MINUTE] },
  });
  await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
  assert.equal((await store.get(DAY_TASK_ID)).next_retry_at, at(7).toISOString());
  await assert.rejects(() => service.sendDailyPush({ now: at(7) }), /status code 400/);
  assert.equal(pushCreates(creates).length, 2);
  assert.equal(alertCreates(creates).length, 1, '窗口用完 ⇒ 当天就不会再试 ⇒ 告警');
  const done = await service.sendDailyPush({ now: at(8) });
  assert.equal(done.reason, 'retries_exhausted');
  assert.equal(pushCreates(creates).length, 2);
});

test('D7 告警开关 / 文案 / 名字都可配；文案写错（缺 {push} 或不认识的占位符）启动时抛错', () => {
  // 显式布尔：空串 = 关（与仓库里所有开关同一套规矩，不用 `||` 兜底）。
  assert.equal(resolvePushRetryConfig({}).alert.enabled, true, '默认开（不静默是这次的 P0 目标）');
  assert.equal(resolvePushRetryConfig({ PUSH_RETRY_ALERT_ENABLED: '' }).alert.enabled, false);
  assert.throws(() => resolvePushRetryConfig({ PUSH_RETRY_ALERT_ENABLED: '也许吧' }), /显式布尔/);
  assert.throws(() => resolvePushRetryConfig({ PUSH_RETRY_ALERT_TEMPLATE: '失败了' }), /必须带 \{push\}/);
  assert.throws(() => resolvePushRetryConfig({ PUSH_RETRY_ALERT_TEMPLATE: '{push} {typo}' }), /无法识别的占位符/);
  const custom = resolvePushRetryConfig({
    PUSH_RETRY_ALERT_TEMPLATE: '【{push}】{day} 挂了：{msg}',
    PENDING_DEAL_PUSH_ALERT_NAME: '待办推送',
    PUSH_RETRY_ALERT_CHAT_ID: 'oc_alert_only',
  }).alert;
  assert.equal(custom.template, '【{push}】{day} 挂了：{msg}');
  assert.equal(custom.names.pendingDealPush, '待办推送');
  assert.equal(custom.chatId, 'oc_alert_only');
});

// ─────────────────────────────────────────────────────────────────────────────
// E1–E3：瞬时层（秒级小退避）—— 读表 / 发消息的瞬时错误自动重试；确定性错误不重试
// ─────────────────────────────────────────────────────────────────────────────

test('E1 发消息撞上 1254607：1s → 2s 小退避后成功 ⇒ 当天照常发出去（不再整天不发）', async () => {
  const store = tmpStore('pending-transient-ok-');
  const delays = [];
  const { service, creates } = newService({
    failTimes: 2, store, retrySettings: resolvePushRetryConfig({}), sleep: async (ms) => { delays.push(ms); },
  });

  const result = await service.sendDailyPush({ now: T0 });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(pushCreates(creates).length, 3, '两次瞬时失败 + 第 3 次成功');
  assert.deepEqual(delays, [1000, 2000], '指数退避 1s → 2s');
  const day = await store.get(DAY_TASK_ID);
  assert.equal(day.sent, true);
  assert.equal(day.attempts, 1, '在瞬时层就成功了 ⇒ 按天层只算第一次尝试');
});

test('E2 发消息撞上 503（HTTP 5xx）也重试；429 同理', async () => {
  for (const status of [503, 429]) {
    const delays = [];
    const { service, creates } = newService({
      failTimes: 1,
      errorFactory: () => serverError(status),
      retrySettings: resolvePushRetryConfig({}),
      sleep: async (ms) => { delays.push(ms); },
    });
    const result = await service.sendDailyPush({ now: T0 });
    assert.equal(result.pushedOrderCount, 1, `${status} 之后应当重试成功`);
    assert.equal(pushCreates(creates).length, 2);
    assert.deepEqual(delays, [1000]);
  }
});

test('E3 确定性错误（权限 99991672）**一次都不重试**：只留一条 retryable:false 的清晰日志', async () => {
  const log = captureWarnings();
  const delays = [];
  const store = tmpStore('pending-transient-deterministic-');
  try {
    const { service, creates } = newService({
      failTimes: 99,
      errorFactory: permissionError,
      store,
      retrySettings: resolvePushRetryConfig({}),
      sleep: async (ms) => { delays.push(ms); },
    });
    await assert.rejects(() => service.sendDailyPush({ now: T0 }), /Access denied/);

    assert.deepEqual(delays, [], '确定性错误 ⇒ 一次睡眠都没有（不重试）');
    assert.equal(pushCreates(creates).length, 1);
    const skipped = log.events().find((entry) => entry.event === 'push.transient_retry.skipped');
    assert.ok(skipped, '要留一条"为什么不重试"的日志');
    assert.equal(skipped.retryable, false);
    assert.equal(skipped.code, '99991672');
    assert.match(skipped.msg, /Access denied/);
    // 瞬时层不重试 ≠ 按天层不重试：这一天的账照记（失败不算跑过、有重试窗口与告警兜底）。
    // 两边分工写在 config/pushRetry 顶部；"确定性错误不重试"这条只管**秒级那一层**。
    const day = await store.get(DAY_TASK_ID);
    assert.equal(day.status, 'failed');
    assert.equal(day.attempts, 1);
    assert.equal(day.next_retry_at, at(10).toISOString());
  } finally {
    log.restore();
  }
});

test('E3b 瞬时层重试用完（一直 1254607）⇒ exhausted 日志 + 抛给按天层；不会无限重试', async () => {
  const log = captureWarnings();
  const delays = [];
  try {
    const { service, creates } = newService({
      failTimes: 99,
      retrySettings: resolvePushRetryConfig({}),
      sleep: async (ms) => { delays.push(ms); },
    });
    await assert.rejects(() => service.sendDailyPush({ now: T0 }), /status code 400/);
    assert.equal(pushCreates(creates).length, 3, '1 次 + 2 次重试');
    assert.deepEqual(delays, [1000, 2000]);
    const exhausted = log.events().find((entry) => entry.event === 'push.transient_retry.exhausted');
    assert.ok(exhausted);
    assert.equal(exhausted.retryable, true);
    assert.equal(exhausted.attempt, 3);
    assert.equal(exhausted.max_attempts, 3);
    // 失败仍按按天层记账（等 10 分钟再来一次）。
    const retryLog = log.events().find((entry) => entry.event === 'sales.pending_deal_push.failed');
    assert.equal(retryLog.will_retry, true);
  } finally {
    log.restore();
  }
});
