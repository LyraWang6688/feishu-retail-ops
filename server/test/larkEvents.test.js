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

test('① 私聊既有行为逐字不变：非文字消息仍然回同样那一条私聊文字', async () => {
  const { client, patched, created } = createCountingClient();
  const service = createRealService(client);

  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_seller' } },
    message: {
      chat_type: 'p2p', message_type: 'image', message_id: 'om_p2p_1',
      content: JSON.stringify({ image_key: 'img_x' }), create_time: '1759700000000',
    },
  });

  assert.equal(result.reason, 'unsupported_message_type');
  // 私聊那条路一个字节都没动：仍然是一条 `open_id` 收件人的纯文字，文案逐字相同。
  assert.equal(patched.length, 0, '私聊这条路不碰卡片更新');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].params, { receive_id_type: 'open_id' });
  assert.equal(created[0].data.receive_id, 'ou_seller');
  assert.equal(created[0].data.msg_type, 'text');
  assert.deepEqual(JSON.parse(created[0].data.content),
    { text: '机器人当前只接收销售文字；采购请使用采购表单。' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 「采购到货 → 拍照识别 → 入库」链路**已退场**（2026-10-05）
//
// 业务负责人删掉了「采购到货」表的「类型」「识别状态」「识别失败原因」三个字段，
// 并决定这条链路整体退场（改成纯对话驱动）。路由层因此把它从分派表里摘掉：
//   1) 判定函数本身仍然保留单测（config/purchaseArrivalIntake.js 这个开关模块
//      **刻意留着**，将来恢复「对话到货」时是现成的显式开关，且它钉住了
//      "空字符串不等于关闭"那个坑）；
//   2) 「采购到货」新增 → 不再分派给任何链路，只留一条排查日志；
//   3) 报货（supplier-report）**照常分派**：它是当前唯一的采购入口（关键回归）。
// ─────────────────────────────────────────────────────────────────────────────

// 表 ID 从 schema 读，测试里不再写死一份——换 Base 时测试自动跟着走。
const ARRIVAL_TABLE_ID = V1_BITABLE_SCHEMA.tables.purchaseArrival.tableId;
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

test('链路已退场：采购到货表的新增记录不再被分派，只留下排查线索', async () => {
  // 原先这条断言的是"开关默认开启 → 会分派到 arrival 链路"。识别链路退场后行为反转：
  // 一条都不分派（accept('arrival') 已经没有对应的处理分支了），并且要能区分
  // "链路已退场"与"表 ID 配错导致的静默失效"。
  const { service, accepted, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  const logs = await captureLogs(async () => {
    assert.doesNotThrow(() =>
      handlers['drive.file.bitable_record_changed_v1'](bitableEvent(ARRIVAL_TABLE_ID, 'rec_arrival_retired')),
    );
    await flushDispatch();
  });

  assert.deepEqual(accepted, [], '退场后到货表的新增不应触达任何采购链路');
  assert.deepEqual(packages, [], '连 acceptMany 都不该被调用');
  assert.ok(
    logs.some((line) => line.includes('lark.intake.arrival_retired') && line.includes('rec_arrival_retired')),
    `应留下排查线索 lark.intake.arrival_retired，实际日志：${logs.join(' | ')}`,
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
// 到货链路已退场（整包都不再分派），那条用例测的行为不存在了，删除；
// 上一条「链路已退场：…不再被分派」用的就是单条形态，这里再补一条"一包多条也不分派"。
test('一包里的多条到货记录同样一条都不分派（链路已退场）', async () => {
  const { service, packages } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  handlers['drive.file.bitable_record_changed_v1']({
    file_token: APP_TOKEN,
    table_id: ARRIVAL_TABLE_ID,
    action_list: [
      { record_id: 'arr_a', action: 'record_added' },
      { record_id: 'arr_b', action: 'record_added' },
    ],
  });
  await flushDispatch();

  assert.deepEqual(packages, []);
});

