const test = require('node:test');
const assert = require('node:assert/strict');
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
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
  const service = {
    handleCardAction: async (event) => {
      received = event;
      return {};
    },
    sendText: async () => undefined,
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

test('failed result-text delivery does not relabel a successful card action as posting failure', async () => {
  const messages = [];
  const handlers = createLarkEventHandlers({
    handleCardAction: async () => ({ toast: { type: 'success', content: '销售已确认' } }),
    sendText: async (_openId, message) => {
      messages.push(message);
      throw new Error('message delivery failed');
    },
  });
  handlers['card.action.trigger']({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale_pending', draft_id: 'sale_1' } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages, ['销售已确认']);
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

