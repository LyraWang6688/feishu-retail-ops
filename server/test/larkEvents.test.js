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
// 「采购到货 → 拍照识别 → 入库」开关（PURCHASE_ARRIVAL_INTAKE_ENABLED）
//
// 这条链路是临时的，随时可能停掉；下面覆盖三件事：
//   1) 判定函数本身：只有显式 'false' 算关，空串/未配/true 都算开；
//   2) 开关开 → 「采购到货」新增会被分派（现状不变）；
//   3) 开关关 → 「采购到货」不分派、不抛错，但**报货照常分派**（关键回归）。
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
  return {
    accepted,
    service: {
      purchaseWebhooks: {
        accept: async (kind, recordId) => {
          accepted.push([kind, recordId]);
        },
      },
    },
  };
};

// 临时改开关，测完必然还原——否则会污染同文件里后面的用例。
const withArrivalSwitch = async (value, run) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, PURCHASE_ARRIVAL_INTAKE_ENV_KEY);
  const previous = process.env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY];
  if (value === undefined) delete process.env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY];
  else process.env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY] = value;
  try {
    await run();
  } finally {
    if (had) process.env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY] = previous;
    else delete process.env[PURCHASE_ARRIVAL_INTAKE_ENV_KEY];
  }
};

// 捕获结构化日志行，用来断言"关掉时有排查线索"。
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

test('开关默认开启：采购到货表的新增记录会被分派到 arrival 链路', async () => {
  const { service, accepted } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  await withArrivalSwitch(undefined, async () => {
    assert.doesNotThrow(() =>
      handlers['drive.file.bitable_record_changed_v1'](bitableEvent(ARRIVAL_TABLE_ID, 'rec_arrival_default')),
    );
    await flushDispatch();
  });

  assert.deepEqual(accepted, [['arrival', 'rec_arrival_default']]);
});

test('开关关闭：采购到货表的新增记录不被分派，且不抛错', async () => {
  const { service, accepted } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  let logs = [];
  await withArrivalSwitch('false', async () => {
    logs = await captureLogs(async () => {
      assert.doesNotThrow(() =>
        handlers['drive.file.bitable_record_changed_v1'](bitableEvent(ARRIVAL_TABLE_ID, 'rec_arrival_off')),
      );
      await flushDispatch();
    });
  });

  assert.deepEqual(accepted, [], '关闭后不应再触达到货识别链路');
  assert.ok(
    logs.some((line) => line.includes('lark.intake.arrival_disabled') && line.includes('rec_arrival_off')),
    `关闭时应留下排查线索 lark.intake.arrival_disabled，实际日志：${logs.join(' | ')}`,
  );
});

test('开关关闭不影响报货：供应商报单新增记录仍然分派到 supplier-report', async () => {
  const { service, accepted } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  await withArrivalSwitch('FALSE', async () => {
    assert.doesNotThrow(() =>
      handlers['drive.file.bitable_record_changed_v1'](bitableEvent(REPORT_TABLE_ID, 'rec_report_off')),
    );
    await flushDispatch();
  });

  assert.deepEqual(accepted, [['supplier-report', 'rec_report_off']]);
});

test('开关开启时报货照常分派（现状不变）', async () => {
  const { service, accepted } = createRecordingService();
  const handlers = createLarkEventHandlers(service);

  await withArrivalSwitch(undefined, async () => {
    const handler = handlers['drive.file.bitable_record_changed_v1'];
    handler(bitableEvent(REPORT_TABLE_ID, 'rec_report_on'));
    handler(bitableEvent(ARRIVAL_TABLE_ID, 'rec_arrival_on_both'));
    await flushDispatch();
  });

  assert.deepEqual(accepted, [
    ['supplier-report', 'rec_report_on'],
    ['arrival', 'rec_arrival_on_both'],
  ]);
});

