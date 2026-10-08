// 「待处理单推送 · 发出后把那条消息置顶（飞书 Pin）」的验收用例（2026-10-07）。
//
// 这份文件盯的是**这个新动作的硬要求**，不碰推送本身的业务口径（那份在 pendingDealPush.test.js）：
//   □ 开关是**显式布尔**，默认关；关着时**一次 pin/unpin 远端调用都不发**；
//   □ 开着时：消息发出后调 `im.pin.create`，参数就是官方要的 `{ data: { message_id } }`；
//   □ **先 unpin 上一条、再 pin 新的**（顺序有断言）—— 防"每天一条越堆越多"；
//   □ 上一条 unpin 失败 → 记 warn、**本次不 pin 新的**（宁缺不堆），推送本身仍然成功；
//   □ pin 失败（错误码 / 抛异常 / client 没有 im.pin / 状态读不出来）→ 只 warn，**永不抛**，
//     `pushedOrderCount` 与按天认领一字不变；
//   □ 我们置顶的是哪一条，落在 data/pending_deal_push 的本地状态里（跟按天认领一个目录）。
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
const { LarkMessagePinService, PIN_STATE_TASK_ID } = require('../src/services/larkMessagePinService');
const { resolvePendingDealPushConfig, readFlag } = require('../src/config/pendingDealPush');
// ⭐ 2026-10-08（第一步）：候选换成"行"（`{ sections, rows, purchase }`）——
//   本文件只关心置顶，候选由这个替身给（`orderNo` 原样带过去，行模板里的 `{orderNo}` 照旧能用）。
const { fakeCandidates } = require('./helpers/pendingPushTestData');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const CHAT_ID = 'oc_test_pending_pin';
const DAY_1_MORNING = new Date('2026-10-06T02:00:00.000Z'); // 北京 10:00
const DAY_1_AFTERNOON = new Date('2026-10-06T06:00:00.000Z'); // 同一天 14:00
const DAY_2_MORNING = new Date('2026-10-07T02:00:00.000Z'); // 第二天 10:00

const ORDER_A = { salesEntryRecordId: 'sale_a', orderNo: 'XSD-A-1', pendingAmount: 1280 };

// ⚠️ 文案 / 模板的默认值**只有一处**（config/pendingDealPush）：先取一遍默认值再覆盖。
const settings = (overrides = {}) => ({
  ...resolvePendingDealPushConfig({}),
  enabled: true,
  chatId: CHAT_ID,
  hour: 9,
  intervalMs: 600000,
  linkLookupEnabled: false,
  linkRequired: false,
  pinEnabled: true,
  ...overrides,
});

// 假飞书 client：**只**实现本链路真正会调的那两个方法。
// ⚠️ `im.message.create` 与 `im.pin.*` 的入参形状照官方文档写死，参数不对这里会记下来。
const fakeClient = ({
  messageIds = ['om_push_1', 'om_push_2'],
  pinDelete = async () => ({ code: 0, msg: 'success', data: {} }),
  pinCreate = async () => ({ code: 0, msg: 'success', data: { pin: { message_id: 'om_push_1' } } }),
  withPin = true,
} = {}) => {
  const calls = [];
  let created = 0;
  const client = {
    im: {
      message: {
        create: async (payload) => {
          calls.push({ api: 'message.create', payload });
          const message_id = messageIds[Math.min(created, messageIds.length - 1)];
          created += 1;
          return { code: 0, data: { message_id } };
        },
        reply: async () => { throw new Error('本推送必须发到主聊天，不许 reply 到话题里'); },
      },
    },
  };
  if (withPin) {
    client.im.pin = {
      create: async (payload) => {
        calls.push({ api: 'pin.create', payload });
        return pinCreate(payload);
      },
      delete: async (payload) => {
        calls.push({ api: 'pin.delete', payload });
        return pinDelete(payload);
      },
    };
  }
  return { client, calls };
};

const newService = ({ orders = [ORDER_A], client, store, settings: overrides = {}, locator, pin } = {}) => {
  const resolvedSettings = settings(overrides);
  const service = new PendingDealPushService({
    settings: resolvedSettings,
    candidates: fakeCandidates({ orders }),
    locator: locator || new SalesGroupThreadLocator({ store: tmpStore('pending-pin-mapping-') }),
    resolver: new LarkMessageLinkResolver({ client: {}, lookupEnabled: false }),
    client,
    chatId: CHAT_ID,
    store: store || tmpStore('pending-pin-day-'),
    pin,
  });
  return { service, store };
};

const pinStateOf = (store) => store.get(PIN_STATE_TASK_ID);

// ─────────────────────────────────────────────────────────────────────────────
// 一、配置：显式布尔、默认关
// ─────────────────────────────────────────────────────────────────────────────

test('置顶开关是显式布尔：默认关；空串 = 关；认不出来的值当场抛错', () => {
  assert.equal(resolvePendingDealPushConfig({}).pinEnabled, false, '没设 → 默认 false');
  assert.equal(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PIN_ENABLED: 'true' }).pinEnabled, true);
  assert.equal(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PIN_ENABLED: '1' }).pinEnabled, true);
  // ⭐ 「清空变量想关掉」必须真的关得掉（`|| 默认值` 的写法会在这里回退成 true）。
  assert.equal(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PIN_ENABLED: '' }).pinEnabled, false);
  assert.equal(resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PIN_ENABLED: 'false' }).pinEnabled, false);
  assert.throws(
    () => resolvePendingDealPushConfig({ PENDING_DEAL_PUSH_PIN_ENABLED: '钉住' }),
    /显式布尔/,
  );
  assert.equal(readFlag({ X: '' }, 'X', true), false, '空串 = 关（与全仓同一套规则）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、关着时：一次远端调用都不发
// ─────────────────────────────────────────────────────────────────────────────

test('置顶关着（默认）：推送照常发，但一次 pin/unpin 调用都不发', async () => {
  const { client, calls } = fakeClient();
  const { service } = newService({ client, settings: { pinEnabled: false } });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });

  assert.equal(result.pushedOrderCount, 1);
  assert.deepEqual(calls.map((call) => call.api), ['message.create'], '只有发送，没有任何 pin 调用');
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'pin_disabled');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、首次置顶：只 create，不 delete
// ─────────────────────────────────────────────────────────────────────────────

test('首次置顶：调 im.pin.create，参数就是官方要的 { data: { message_id } }；不调 delete', async () => {
  const { client, calls } = fakeClient({ messageIds: ['om_day1'] });
  const store = tmpStore('pending-pin-first-');
  const { service } = newService({ client, store });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });

  assert.deepEqual(calls.map((call) => call.api), ['message.create', 'pin.create']);
  assert.deepEqual(
    calls[1].payload,
    { data: { message_id: 'om_day1' } },
    'Pin 的入参形状照官方文档：body 里只有 message_id（chat_id 不是 Pin 的参数）',
  );
  assert.equal(result.pinned, true);
  assert.equal(result.pinReason, '');
  // 状态落盘：记住"我们当前置顶的是哪一条"，明天才能取消它。
  const state = await pinStateOf(store);
  assert.equal(state.pinned_message_id, 'om_day1');
  assert.equal(state.chat_id, CHAT_ID);
  assert.equal(state.day, '2026-10-06');
  // 推送那天的记录也带上置顶结果，排查一眼就看见。
  const day = await store.get('pending_deal_push_day_2026-10-06');
  assert.equal(day.pinned, true);
  assert.equal(day.pin_reason, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、防堆积：**先取消上一条，再置顶新的**（顺序是硬要求）
// ─────────────────────────────────────────────────────────────────────────────

test('第二天：先 unpin 上一条、再 pin 新的（顺序有断言），状态换成新的那条', async () => {
  const { client, calls } = fakeClient({ messageIds: ['om_day1', 'om_day2'] });
  const store = tmpStore('pending-pin-rotate-');
  const { service } = newService({ client, store });

  await service.sendDailyPush({ now: DAY_1_MORNING });
  calls.length = 0;
  const second = await service.sendDailyPush({ now: DAY_2_MORNING });

  assert.deepEqual(
    calls.map((call) => call.api),
    ['message.create', 'pin.delete', 'pin.create'],
    '🔴 顺序必须是"先取消上一条 → 再置顶新的"（反过来就是同时在群里钉两条）',
  );
  assert.deepEqual(calls[1].payload, { path: { message_id: 'om_day1' } }, 'unpin 走路径参数');
  assert.deepEqual(calls[2].payload, { data: { message_id: 'om_day2' } });
  assert.equal(second.pinned, true);
  assert.equal((await pinStateOf(store)).pinned_message_id, 'om_day2');
});

test('上一条已经被人工取消过：unpin 返回成功（官方口径），照常置顶新的', async () => {
  // 官方文档：「如果消息未被 Pin 或已被撤回，则该接口返回成功信息 msg: success」
  const { client } = fakeClient({ messageIds: ['om_day1', 'om_day2'] });
  const store = tmpStore('pending-pin-idempotent-');
  const { service } = newService({ client, store });
  await service.sendDailyPush({ now: DAY_1_MORNING });
  const second = await service.sendDailyPush({ now: DAY_2_MORNING });
  assert.equal(second.pinned, true);
  assert.equal((await pinStateOf(store)).pinned_message_id, 'om_day2');
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、失败路径：只 warn、永不抛、不影响推送
// ─────────────────────────────────────────────────────────────────────────────

test('上一条 unpin 失败（如 230046 仅群主可 Pin）：本次不 pin 新的，状态保留，推送仍成功', async () => {
  const pinDelete = async () => ({ code: 230046, msg: 'No Permission to Pin/Unpin messages in the chat' });
  const { client, calls } = fakeClient({ messageIds: ['om_day1', 'om_day2'], pinDelete });
  const store = tmpStore('pending-pin-unpin-fail-');
  const { service } = newService({ client, store });

  await service.sendDailyPush({ now: DAY_1_MORNING });
  calls.length = 0;
  const second = await service.sendDailyPush({ now: DAY_2_MORNING });

  assert.deepEqual(calls.map((call) => call.api), ['message.create', 'pin.delete'], '取消失败就不置顶新的');
  // 推送本身**成功**：消息发出去了、按天认领照记。
  assert.equal(second.pushedOrderCount, 1);
  assert.equal(second.messageId, 'om_day2');
  assert.equal(second.pinned, false);
  assert.equal(second.pinReason, 'previous_unpin_failed');
  // 状态保留旧 id：明天再试取消它，不会因为"没记住"而堆积。
  assert.equal((await pinStateOf(store)).pinned_message_id, 'om_day1');
  const day = await store.get('pending_deal_push_day_2026-10-07');
  assert.equal(day.status, 'completed');
  assert.equal(day.pin_reason, 'previous_unpin_failed');

  // 同一天再跑一次：按天认领仍然生效（置顶的失败没有把这一天翻成"没推过"）。
  const again = await service.sendDailyPush({ now: DAY_1_AFTERNOON });
  assert.equal(again.reason, 'already_ran_today');
});

test('pin 抛异常：吞掉、只记 warn，推送结果与按天认领一字不变', async () => {
  const pinCreate = async () => { throw new Error('socket hang up'); };
  const { client } = fakeClient({ messageIds: ['om_day1'], pinCreate });
  const store = tmpStore('pending-pin-throw-');
  const { service } = newService({ client, store });

  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.messageId, 'om_day1');
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'pin_failed');
  assert.equal((await pinStateOf(store))?.pinned_message_id ?? '', '', '置顶没成功就不该记住它');
  assert.equal((await store.get('pending_deal_push_day_2026-10-06')).status, 'completed');
});

test('pin 返回业务错误码（230027 缺权限）：算失败、不抛、不重试', async () => {
  const pinCreate = async () => ({ code: 230027, msg: 'Lack of necessary permissions' });
  const { client, calls } = fakeClient({ messageIds: ['om_day1'], pinCreate });
  const { service } = newService({ client, store: tmpStore('pending-pin-code-') });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'pin_failed');
  assert.equal(calls.filter((call) => call.api === 'pin.create').length, 1, '不重试到死：只调一次');
});

test('client 没有 im.pin（老 client / 替身）：只 warn、不抛，推送照常', async () => {
  const { client, calls } = fakeClient({ withPin: false, messageIds: ['om_day1'] });
  const { service } = newService({ client, store: tmpStore('pending-pin-noclient-') });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'client_missing');
  assert.deepEqual(calls.map((call) => call.api), ['message.create']);
});

test('状态读不出来（不知道上一条是哪条）：宁可不置顶，也不冒堆积的险', async () => {
  const { client } = fakeClient({ messageIds: ['om_day1'] });
  const store = tmpStore('pending-pin-badstate-');
  const originalGet = store.get.bind(store);
  // 只让**置顶状态**那条读不出来（按天认领那条还得正常读，否则测的就不是置顶这条路径了）。
  store.get = async (id) => {
    if (id === PIN_STATE_TASK_ID) throw new Error('Unexpected end of JSON input');
    return originalGet(id);
  };
  const { service } = newService({ client, store });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'state_unavailable');
});

test('状态写不进去：pin 已经成功，也不许把它翻成失败（只记 warn）', async () => {
  const { client } = fakeClient({ messageIds: ['om_day1'] });
  const store = tmpStore('pending-pin-writefail-');
  const originalUpdate = store.update.bind(store);
  const originalCreate = store.create.bind(store);
  // 只让**置顶状态**那条写不进去；按天认领那条照常落盘（否则测不出"推送没受影响"）。
  store.update = async (id, patch) => {
    if (id === PIN_STATE_TASK_ID) throw new Error('disk full');
    return originalUpdate(id, patch);
  };
  store.create = async (task) => {
    if (task?.task_id === PIN_STATE_TASK_ID) throw new Error('disk full');
    return originalCreate(task);
  };
  const { service } = newService({ client, store });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pinned, true, '飞书那边 Pin 成功了，就不该报成失败');
  assert.equal(result.pushedOrderCount, 1);
  assert.equal((await store.get('pending_deal_push_day_2026-10-06')).status, 'completed');
});

test('置顶服务内部意外抛异常：pinMessage 也吞掉（推送绝不因为置顶挂掉）', async () => {
  const { client } = fakeClient({ messageIds: ['om_day1'] });
  const explodingPin = { pinLatest: async () => { throw new Error('unexpected'); } };
  const { service } = newService({ client, store: tmpStore('pending-pin-explode-'), pin: explodingPin });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.pushedOrderCount, 1);
  assert.equal(result.pinned, false);
  assert.equal(result.pinReason, 'pin_failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// 六、没发出去时不该置顶
// ─────────────────────────────────────────────────────────────────────────────

test('没有候选单：不发消息也不置顶（更不该去 pin 一条不存在的消息）', async () => {
  const { client, calls } = fakeClient();
  const { service } = newService({ client, orders: [], store: tmpStore('pending-pin-empty-') });
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, 'no_pending_order');
  assert.deepEqual(calls, []);
});

test('没配群 id：不推也不置顶（不知道发哪儿就更不知道钉哪儿）', async () => {
  const { client, calls } = fakeClient();
  const { service } = newService({ client, store: tmpStore('pending-pin-nochat-') });
  service.chatId = '';
  const result = await service.sendDailyPush({ now: DAY_1_MORNING });
  assert.equal(result.reason, 'no_chat');
  assert.deepEqual(calls, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 七、LocalMessagePinService 单独看：状态只有一个口径
// ─────────────────────────────────────────────────────────────────────────────

test('LarkMessagePinService：把上一条取消成功后状态清空，置顶成功后才写新 id', async () => {
  const calls = [];
  let state = null;
  const store = {
    get: async () => state,
    update: async (id, patch) => { state = { task_id: id, ...state, ...patch }; return state; },
    create: async (record) => { state = { ...record }; return state; },
  };
  const service = new LarkMessagePinService({
    store,
    client: {
      im: {
        pin: {
          create: async (payload) => { calls.push(['create', payload.data.message_id]); return { code: 0 }; },
          delete: async (payload) => { calls.push(['delete', payload.path.message_id]); return { code: 0 }; },
        },
      },
    },
  });

  // 没有上一条：只 create。
  assert.deepEqual(await service.pinLatest({ messageId: 'om_1', chatId: CHAT_ID, day: '2026-10-06' }),
    { pinned: true, reason: '', previousMessageId: '' });
  assert.equal(state.pinned_message_id, 'om_1');
  // 有上一条：先 delete 再 create。
  calls.length = 0;
  await service.pinLatest({ messageId: 'om_2', chatId: CHAT_ID, day: '2026-10-07' });
  assert.deepEqual(calls, [['delete', 'om_1'], ['create', 'om_2']]);
  assert.equal(state.pinned_message_id, 'om_2');
  assert.equal(state.day, '2026-10-07');
});

test('LarkMessagePinService：messageId 为空 → 一次远端调用都不发', async () => {
  const client = { im: { pin: { create: async () => { throw new Error('不该调'); }, delete: async () => { throw new Error('不该调'); } } } };
  const service = new LarkMessagePinService({ client, store: tmpStore('pending-pin-emptyid-') });
  assert.deepEqual(await service.pinLatest({ messageId: '' }), { pinned: false, reason: 'no_message_id', previousMessageId: '' });
});
