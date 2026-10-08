const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  isPurchaseArrivalIntakeEnabled,
  PURCHASE_ARRIVAL_INTAKE_ENV_KEY,
} = require('../src/config/purchaseArrivalIntake');

// 分派前 handler 要先认出"这是我们自己的 Base"，所以先给一个测试用 app token。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
const APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN;

test('authenticated card payload without a top-level token reaches the card service', async () => {
  let received;
  // ⚠️ 这个桩**刻意不提供 `sendText`**：卡片动作路径已经不认识"私聊收件人"这个出口了
  //（见下面 ① 的两条调用计数用例）。哪天有人把那条私聊文字加回来，这里会直接炸。
  const service = {
    handleCardAction: async (event) => {
      received = event;
      return {};
    },
  };
  const handlers = createLarkEventHandlers(service);
  const event = {
    operator: { operator_id: { open_id: 'ou_test' } },
    action: { value: { action: 'modify_sale', draft_id: 'rec_test' } },
  };

  const response = handlers['card.action.trigger'](event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，正在处理' } });
  assert.equal(received, event);
});

// ─────────────────────────────────────────────────────────────────────────────
// ① 🔴 卡片动作**不再额外发一条私聊文字**（业务负责人 2026-10-06）
//
// 她的原话：「**卡片点按钮后那条多余的私聊文字，需要删。**」
//          「**我们的消息卡片会变化啊！**」
// ⇒ 「点按钮后必须回一个响应」由两件事承担，两个都必须还在：
//      · 同步响应 —— handler 的返回值（`{ toast: { type: 'info', … } }`）；
//      · 业务结果 —— `handleCardAction` 内部对**那张卡片本身**的更新。
//    所以要删的**只是那条 `sendText(operator_open_id, toast)`**，不是整个响应。
//
// ⭐ 这两件事必须用**真实调用计数**证明，不能只断言"没调某个方法" ——
//    "整条链路根本没跑"同样会让那种断言通过。所以下面用**真的 LarkMvpService**
//    跑一条**真的卡片动作**，数两个出口：
//      · `im.message.patch`  = 卡片更新（`updateInteractiveCard`）→ 必须 **1 次**
//      · `im.message.create` = 主动发消息（落到私聊）              → 必须 **0 次**
// ─────────────────────────────────────────────────────────────────────────────

/** 会数两个出口的假飞书客户端：patch=改卡片，create=主动发消息（私聊）。 */
const createCountingClient = () => {
  const patched = [];
  const created = [];
  const client = {
    im: {
      v1: {
        message: {
          patch: async (request) => {
            patched.push(request);
            return { code: 0, data: {} };
          },
        },
      },
      message: {
        create: async (request) => {
          created.push(request);
          return { code: 0, data: { message_id: `om_create_${created.length}` } };
        },
        reply: async (request) => {
          created.push({ ...request, replied: true });
          return { code: 0, data: { message_id: `om_reply_${created.length}`, thread_id: 'omt_t' } };
        },
      },
      messageReaction: { create: async () => ({ code: 0 }) },
    },
  };
  return { client, patched, created };
};

/** 用**真的 LarkMvpService**（不是桩）：只有真链路才能给出真实的调用计数。 */
const createRealService = (client) => new LarkMvpService({
  client,
  gateway: { table: () => ({ fields: {} }), listAll: async () => [], validateTables: async () => [] },
  posting: {},
  recognizer: {},
  store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-card-toast-')), idField: 'task_id',
  }),
  botOpenId: 'ou_test_bot',
});

test('① 点按钮 → 卡片更新 1 次 ＋ 主动私聊发送 0 次（真实调用计数）', async () => {
  const { client, patched, created } = createCountingClient();
  const service = createRealService(client);
  const taskId = 'sample_card_task_1';
  // 一条**已完成**的补样品任务：点它的按钮会走「卡片更新」那条真实分支
  // （`publishCard` → `updateInteractiveCard` → `im.message.patch`）。
  await service.store.create({
    task_id: taskId,
    type: 'sample_replacement',
    status: 'completed',
    sender_open_id: 'ou_operator',
    product_number: 'TEST-1',
    result: { size: 40 },
  });

  const handlers = createLarkEventHandlers(service);
  const response = handlers['card.action.trigger']({
    operator: { operator_id: { open_id: 'ou_operator' } },
    action: { value: { action: 'choose_sample_replacement', draft_id: taskId, size: 40 } },
    context: { open_message_id: 'om_card_1' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(patched.length, 1, '卡片必须仍然被更新（updateInteractiveCard → im.message.patch 恰好 1 次）');
  assert.equal(patched[0]?.path?.message_id, 'om_card_1');
  assert.equal(created.length, 0, '不应再有任何主动发送（im.message.create / reply）到私聊');
  // 「点按钮后必须回一个响应」这条飞书要求不能被误伤：同步响应原样保留。
  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，正在处理' } });
});

test('① 卡片动作失败 → 同样不发私聊（也不再抛出去）', async () => {
  const created = [];
  const handlers = createLarkEventHandlers({
    handleCardAction: async () => { throw new Error('卡片更新失败'); },
    sendText: async (...args) => { created.push(args); },
  });
  const response = handlers['card.action.trigger']({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(created, [], '失败分支也不许再用私聊文字兜底');
  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，正在处理' } },
    '同步响应照旧 —— 她点按钮不会觉得"点不动"');
});

test('① 私聊链路已移除：非文字消息只回那一句「请到群里说」（不建任务、不跑链路）', async () => {
  // 🔴 2026-10-07「私聊链路移除」：这条用例原来钉的是「私聊既有行为逐字不变：
  //    非文字消息仍然回同样那一条私聊文字」。私聊入口已整体删除（业务负责人拍板的 ⓐ：
  //    代码里一行私聊都不留，见 docs/private-chat-removal-decision-2026-10-07.md），
  //    所以断言反过来：私聊消息**不建任务、不跑链路、也不回任何消息**。
  const { client, patched, created } = createCountingClient();
  const service = createRealService(client);

  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_seller' } },
    message: {
      chat_type: 'p2p', message_type: 'image', message_id: 'om_p2p_1',
      content: JSON.stringify({ image_key: 'img_x' }), create_time: '1759700000000',
    },
  });

  assert.equal(result.reason, 'private_chat_removed');
  assert.equal(patched.length, 0, '私聊这条路不碰卡片更新');
  // ⭐ 她 2026-10-07 拍板：那句「请到群里说」**保留**（对面是人）。除它之外什么都不发。
  assert.equal(created.length, 1, '只回那一句');
  assert.match(JSON.stringify(created[0]), /请到群里说/);

  // 文字消息同样：不建任务、不回消息。
  const text = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_seller' } },
    message: {
      chat_type: 'p2p', message_type: 'text', message_id: 'om_p2p_2',
      content: JSON.stringify({ text: 'A100 38码一双，100元微信' }), create_time: '1759700000001',
    },
  });
  assert.equal(text.reason, 'private_chat_removed');
  assert.equal(created.length, 2, '文字也照样只回那一句');
});

// ─────────────────────────────────────────────────────────────────────────────
// 「采购到货 → 拍照识别 → 入库」链路**已退场**（2026-10-05），
// 而且那张表本身**已被业务负责人整个删除**（2026-10-07 晚）——到货落点搬到「报货批次」。
//
// 所以路由层现在的状态是：
//   1) 判定函数本身仍然保留单测（config/purchaseArrivalIntake.js 这个开关模块
//      **刻意留着**，将来恢复「对话到货」时是现成的显式开关，且它钉住了
//      "空字符串不等于关闭"那个坑）；
//   2) **schema 里不再有 `purchaseArrival`** ⇒ 路由里也没有它的任何分派/排查分支；
//   3) 就算飞书还推来一条**旧表 id** 的事件（订阅没来得及删），也必须
//      "什么都不做、也不报错"（下面两条用例钉住这一点）；
//   4) 报货（supplier-report）**照常分派**：它是当前唯一的采购入口（关键回归）。
// ─────────────────────────────────────────────────────────────────────────────

// 表 ID 从 schema 读，测试里不再写死一份——换 Base 时测试自动跟着走。
// ⚠️ 但**已删除的**「到货验收」表没有 schema 可读了：下面这条常量就是那个**已作废**的
//    生产 tableId，专门用来模拟"飞书还推来旧表事件"（回归钉子）。
const DELETED_ARRIVAL_TABLE_ID = 'tblvLOXKESNTbZ7v';
const REPORT_TABLE_ID = V1_BITABLE_SCHEMA.tables.purchaseReport.tableId;

const bitableEvent = (tableId, recordId) => ({
  file_token: APP_TOKEN,
  table_id: tableId,
  action_list: [{ record_id: recordId, action: 'record_added' }],
});

// accept 是被 setImmediate 异步调起的，等一拍再断言。
const flushDispatch = () => new Promise((resolve) => setTimeout(resolve, 10));

const createRecordingService = () => {
  const accepted = [];
  // 「同一包」的记录会以一次 acceptMany 调用进来：packages 记下每包的 id 列表，
  // accepted 仍按"每条记录一对"展开，便于既有用例继续按记录断言。
  const packages = [];
  return {
    accepted,
    packages,
    service: {
      purchaseWebhooks: {
        acceptMany: async (kind, recordIds, options) => {
          const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
          // 第三个参数是「这一包应有几条」（到齐的判据），一并记下来供断言。
          packages.push([kind, ids, options?.expectedCount]);
          for (const id of ids) accepted.push([kind, id]);
        },
      },
    },
  };
};

// 捕获结构化日志行，用来断言"退场后有排查线索"。
const captureLogs = async (run) => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines;
};

test('开关判定：只有显式 false（忽略大小写与首尾空格）才算关闭', () => {
  const key = PURCHASE_ARRIVAL_INTAKE_ENV_KEY;
  const disabled = ['false', 'FALSE', 'False', ' false ', '\tfalse\n', '  FaLsE  '];
  disabled.forEach((value) => {
    assert.equal(
      isPurchaseArrivalIntakeEnabled({ [key]: value }),
      false,
      `${JSON.stringify(value)} 应判定为关闭`,
    );
  });
});

test('开关判定：未配置、空字符串、true、1 以及写错的值一律视为开启', () => {
  const key = PURCHASE_ARRIVAL_INTAKE_ENV_KEY;
  // ⚠️ '' 必须在"开启"这一侧：清空环境变量不等于关闭，这是不能用 `||` 兜底的原因。
  const enabled = [undefined, null, '', '   ', 'true', 'TRUE', '1', '0', 'yes', 'no', 'flase'];
  enabled.forEach((value) => {
    assert.equal(
      isPurchaseArrivalIntakeEnabled({ [key]: value }),
      true,
      `${JSON.stringify(value)} 应判定为开启`,
    );
  });
  assert.equal(isPurchaseArrivalIntakeEnabled({}), true, '键不存在时应判定为开启');
  assert.equal(isPurchaseArrivalIntakeEnabled(), true, '默认参数 process.env 未配置时应判定为开启');
});

test('链路已退场：旧「到货验收」表 id 的事件不再被分派，也不报错（schema 里已没有那张表）', async () => {
  // 2026-10-07 晚：业务负责人把那张表**整个删掉了** ⇒ schema 里不再有 `purchaseArrival`，
  // 路由里也没有任何指向它的分支。这条用例模拟"飞书订阅还没删、旧表事件仍推过来"：
  // 必须什么都不做、也不抛错（那个排查日志 `lark.intake.arrival_retired` 也一并退场了）。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseArrival, undefined,
    'schema 里不许再有「到货验收」这张表（她已删除，到货落点搬到「报货批次」）');
  const { service, accepted, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  const logs = await captureLogs(async () => {
    assert.doesNotThrow(() =>
      handlers['drive.file.bitable_record_changed_v1'](bitableEvent(DELETED_ARRIVAL_TABLE_ID, 'rec_arrival_retired')),
    );
    await flushDispatch();
  });

  assert.deepEqual(accepted, [], '旧到货表的新增不应触达任何采购链路');
  assert.deepEqual(packages, [], '连 acceptMany 都不该被调用');
  assert.equal(
    logs.some((line) => line.includes('lark.intake.arrival_retired')),
    false,
    '那条"链路已退场"的排查日志随表一起删了（表都不在了，不存在"配错表 ID"这回事）',
  );
});

test('到货退场不影响报货：供应商报单新增记录仍然分派到 supplier-report', async () => {
  const { service, accepted } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  assert.doesNotThrow(() =>
    handlers['drive.file.bitable_record_changed_v1'](bitableEvent(REPORT_TABLE_ID, 'rec_report_ok')),
  );
  await flushDispatch();

  assert.deepEqual(accepted, [['supplier-report', 'rec_report_ok']]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 归批的首选信号：「同一包」
//
// 一次表单提交 = 同一张表的多条记录，飞书把它们放在**同一个 action_list** 里推过来。
// 逐条分派会让报货链路各自走一遍处理（N 条 → N 张采购申请图），所以这里要能看出
// 「这一包里的 record_added 是一起交出去的」。
// ─────────────────────────────────────────────────────────────────────────────

test('同一包里的多条 record_added 合成一次分派（一次提交 = 一包）', async () => {
  const { service, accepted, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: REPORT_TABLE_ID,
    action_list: [
      { record_id: 'rec_p1', action: 'record_added' },
      { record_id: 'rec_p2', action: 'record_added' },
      { record_id: 'rec_p3', action: 'record_added' },
    ],
  });
  await flushDispatch();

  assert.deepEqual(
    packages,
    [['supplier-report', ['rec_p1', 'rec_p2', 'rec_p3'], 3]],
    '三条要作为一包一起分派，并把「这一包应有 3 条」传下去（到齐的判据）',
  );
  assert.deepEqual(accepted, [
    ['supplier-report', 'rec_p1'],
    ['supplier-report', 'rec_p2'],
    ['supplier-report', 'rec_p3'],
  ]);
});

test('一包里非 record_added 的动作不进包：编辑/删除不触发报货', async () => {
  const { service, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: REPORT_TABLE_ID,
    action_list: [
      { record_id: 'rec_edited', action: 'record_edited' },
      { record_id: 'rec_added', action: 'record_added' },
    ],
  });
  await flushDispatch();

  assert.deepEqual(packages, [['supplier-report', ['rec_added'], 1]]);
});

// 原先还有一条「一包里的多条到货记录也合成一次分派（到货链路行为不变）」。
// 到货那张表已被删除（2026-10-07 晚）⇒ 这里只留"旧表 id 的一包也不分派"这条回归钉子。
test('同一包里的多条旧到货表记录同样一条都不分派（表已删除）', async () => {
  const { service, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: DELETED_ARRIVAL_TABLE_ID,
    action_list: [
      { record_id: 'arr_a', action: 'record_added' },
      { record_id: 'arr_b', action: 'record_added' },
    ],
  });
  await flushDispatch();

  assert.deepEqual(packages, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 「货品信息」的新支路：`标签二维码` 自动补齐（2026-10-08）
//
// 路由层只做**一件事**：按 **table_id** 认出"事件来自货品信息表"，把整个 `action_list`
// 原样交给 `tagQrCodes.handleTableChanges`（判定与写库都在那个 service 里）。
//
// 这里钉住的是**分派**，不是业务：
//   · 只认货品信息 —— 报货表的事件**一个字都不许**流到这条新支路；
//   · 反向也要钉：货品信息的事件**不许**碰 `purchaseWebhooks`（报货那条路逐字不变）；
//   · 异步 —— handler 同步返回 `{}`（飞书要求及时响应），处理在 `setImmediate` 之后。
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_TABLE_ID = V1_BITABLE_SCHEMA.tables.product.tableId;

const createTagQrRecordingService = () => {
  const calls = [];
  const purchaseCalls = [];
  return {
    calls,
    purchaseCalls,
    service: {
      tagQrCodes: {
        handleTableChanges: async (actionList) => {
          calls.push(actionList);
          return { enabled: true, results: [] };
        },
      },
      purchaseWebhooks: {
        acceptMany: async (kind, recordIds, options) => {
          purchaseCalls.push([kind, recordIds, options?.expectedCount]);
        },
      },
    },
  };
};

test('⑤ 分派：货品信息表的新增 + 修改**整包**交给 tagQrCodes，且一个采购分派都不产生', async () => {
  const { service, calls, purchaseCalls } = createTagQrRecordingService();
  const handlers = createLarkEventHandlers(service);
  const actionList = [
    { record_id: 'rec_p_new', action: 'record_added' },
    { record_id: 'rec_p_edit', action: 'record_edited' },
  ];

  assert.doesNotThrow(() => handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: PRODUCT_TABLE_ID,
    action_list: actionList,
  }));
  await flushDispatch();

  assert.equal(calls.length, 1, '一次事件只调一次 handleTableChanges');
  // 原样透传：**判定"哪条动作要出码"不在这层**（口径在 config + service），所以连
  // record_edited 也一起交下去，不在这里筛。
  assert.deepEqual(calls[0], actionList);
  assert.deepEqual(purchaseCalls, [], '货品信息的事件不许流进报货那条路');
});

test('⑤ 分派只认货品信息：报货表的事件不碰 tagQrCodes（报货那条路逐字不变的哨兵）', async () => {
  const { service, calls, purchaseCalls } = createTagQrRecordingService();
  const handlers = createLarkEventHandlers(service);

  handlers['drive.file.bitable_record_changed_v1'](bitableEvent(REPORT_TABLE_ID, 'rec_report_sentinel'));
  await flushDispatch();

  assert.deepEqual(calls, [], '报货表的事件只能走 purchaseWebhooks');
  assert.deepEqual(purchaseCalls, [['supplier-report', ['rec_report_sentinel'], 1]], '报货那条路的形状没变');
});

test('⑤ 异步：handler 同步返回 {} ，处理在 setImmediate 之后才发生', async () => {
  const { service, calls } = createTagQrRecordingService();
  const handlers = createLarkEventHandlers(service);

  const response = handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: PRODUCT_TABLE_ID,
    action_list: [{ record_id: 'rec_async', action: 'record_added' }],
  });

  assert.deepEqual(response, {}, '事件响应不阻塞');
  assert.deepEqual(calls, [], '返回时还没开始处理（异步）');
  await flushDispatch();
  assert.equal(calls.length, 1, '下一拍才开始处理');
});

test('⑤ 没接线（service 上没有 tagQrCodes）→ 不抛错，并留下明确的排查线索', async () => {
  const { service, purchaseCalls } = createTagQrRecordingService();
  delete service.tagQrCodes;
  const handlers = createLarkEventHandlers(service);

  // ⚠️ 这条线索是 `logWarn`（→ console.warn），上面那个共用 helper 只收 console.log，
  //    所以这里本地收一份（info + warn）。
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => logs.push(String(line));
  console.warn = (line) => logs.push(String(line));
  try {
    assert.doesNotThrow(() => handlers['drive.file.bitable_record_changed_v1']({
      file_token: APP_TOKEN,
      table_id: PRODUCT_TABLE_ID,
      action_list: [{ record_id: 'rec_no_wire', action: 'record_added' }],
    }));
    await flushDispatch();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(purchaseCalls, []);
  assert.ok(
    logs.some((line) => line.includes('product.tag_qr.not_wired')),
    '没接线要说清楚，不能静默什么都不做',
  );
});

