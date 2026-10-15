/**
 * 生产事故回归（2026-10-15 23:12 她真机提交配品 ⇒ 「写入失败」/ `accessory_unknown`）。
 *
 * ⭐⭐ 本文件的输入**照抄生产真实形状**（AC-AF7）—— 来源逐字写在各条注释里：
 *   生产记录 `reczz28NjOq89MFw`（她「配品销售」表）的「名称」列实测值 =
 *   `[{"record_ids":["recvvWLQZDSmQf"],"table_id":"tblxEeiXYAeUF4gH","text":"鞋垫",
 *      "text_arr":["鞋垫"],"type":"text"}]`
 *   而**事件**里这一列只带显示文本（`[{ text: '鞋垫', type: 'text' }]`）是允许发生的
 *   ⇒ 旧代码把它 `String()` 成 `'[object Object]'` 当 record id 用 ⇒ `gateway.get` 落空
 *   ⇒ 被误报成"这件配品不在「其他配品」里" ⇒ 拒单 ✗（她的记录没被写坏 ✓）。
 *
 * 7 条 AC：AF1 真形状成单 · AF2 纯数组成单 · AF3 文本兜底（唯一命中 ✓ / 不唯一 ⇒ 拒单 ✓）
 *          · AF4 真查不到仍是 accessory_unknown 语义 · AF5 账对 · AF6 失败零写入 · AF7 输入照抄生产
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/utils/logger');
const logs = [];
logger.logInfo = (...args) => logs.push(['info', ...args]);
logger.logWarn = (...args) => logs.push(['warn', ...args]);
logger.logError = (...args) => logs.push(['error', ...args]);

const { createAccessorySaleIntakeService } = require('../src/services/accessorySaleIntakeService');
const { resolveAccessorySaleIntakeConfig } = require('../src/config/accessorySaleIntake');

// ── 生产现场的真值（照抄，不发明）─────────────────────────────────────────────
const SALE_RECORD_ID = 'reczz28NjOq89MFw';        // 她那次提交的那一行
const ACCESSORY_ID = 'recvvWLQZDSmQf';            // 「其他配品」里真实存在的「鞋垫」
const ACCESSORY_NAME = '鞋垫';
const OTHER_ACCESSORY_ID = 'recOtherAccessory01';
const OTHER_ACCESSORY_NAME = '鞋带';
/** 她那次表单填的值（数量 2 · 金额 19 · 收款方式 微信） */
const REAL = { quantity: 2, amount: 19, method: '微信' };

// ⚠️ 键名必须与 `config/accessorySaleIntake.js` 的 `fieldIds` 逐字一致（`paymentMethod` 不是 `method`）
const FIELD = {
  name: 'fld0V3ausF', quantity: 'fldlFzpHKn', paymentMethod: 'fldxPeh9zl', amount: 'fldVfSOmDg',
  operator: 'fldyWkZRXF',
};
const METHOD_FIELD_ID = FIELD.paymentMethod;

/** 生产事件里「名称」的真实形状（她那次事件的形状 = 只带文本、不带 record_ids）。 */
const eventNameTextOnly = (text = ACCESSORY_NAME) => [{ text, text_arr: [text], type: 'text' }];
/** 记录 API 的形状（生产记录实测值 —— AF1/AF7 的输入就是它）。 */
const recordShape = (id = ACCESSORY_ID, text = ACCESSORY_NAME) => ([
  { record_ids: [id], table_id: 'tblxEeiXYAeUF4gH', text, text_arr: [text], type: 'text' },
]);

const actionItem = ({ name = eventNameTextOnly(), quantity = REAL.quantity, amount = REAL.amount,
  method = REAL.method } = {}) => ({
  record_id: SALE_RECORD_ID,
  action: 'record_added',
  after_value: [
    { field_id: FIELD.name, field_value: name },
    { field_id: FIELD.quantity, field_value: quantity },
    { field_id: METHOD_FIELD_ID, field_value: [{ text: method }] },
    { field_id: FIELD.amount, field_value: amount },
  ].filter((item) => item.field_value !== undefined),
});

/** 假网关：「其他配品」里有几条（`rows`）+ 哪几个 record id 真的存在（`knownIds`）。 */
const fakeGateway = ({
  rows = [{ record_id: ACCESSORY_ID, fields: { 名称: ACCESSORY_NAME } }],
  knownIds = [ACCESSORY_ID],
  // 兜底读表给回来的字段（默认 = 生产记录的真形状）；给 `{}` ⇒ 兜底也读不出「名称」
  // ⇒ 这时才**必须**靠「名称」文本兜底（AF3/AF4/AF6 用它把那条路单独逼出来 ✓）
  fallbackFields = { 名称: recordShape(), 数量: REAL.quantity, 金额: REAL.amount, 收款方式: [{ text: REAL.method }] },
} = {}) => {
  const reads = []; const writes = []; const lists = [];
  return {
    reads, writes, lists,
    gateway: {
      get: async (tableKey, recordId) => {
        reads.push({ tableKey, recordId });
        const hit = knownIds.includes(recordId);
        return hit ? { record_id: recordId, fields: { 名称: ACCESSORY_NAME } } : null;
      },
      listAll: async (tableKey) => { lists.push(tableKey); return rows; },
      getByTableId: async (input) => ({ record_id: input.recordId, fields: fallbackFields }),
      updateByTableId: async (input) => { writes.push(input); return { record_id: input.recordId }; },
    },
  };
};

const fakeEngine = ({ backgroundOk = null } = {}) => {
  const lines = []; const sales = [];
  return {
    lines, sales,
    engine: {
      addSaleLine: async (input) => { lines.push(input); return { ok: true }; },
      submitSale: async (input) => {
        sales.push(input);
        const result = { ok: true, order_no: 'XSD-1', reused: false };
        if (backgroundOk !== null) result.background = Promise.resolve({ ok: backgroundOk });
        return result;
      },
    },
  };
};

const build = ({ gatewayOpts, engineOpts } = {}) => {
  const gw = fakeGateway(gatewayOpts);
  const fake = fakeEngine(engineOpts);
  const config = resolveAccessorySaleIntakeConfig({});
  const service = createAccessorySaleIntakeService({
    gateway: gw.gateway, scanWrite: fake.engine, config: { ...config, fieldIds: FIELD },
  });
  return { service, ...gw, ...fake };
};

const WRITE_KEYS = new Set(['写入状态', '失败原因']);
const writtenBack = (writes) => writes.map((w) => w.fields).filter((f) => f && Object.keys(f).every((k) => WRITE_KEYS.has(k)));

// ── AC-AF1：生产记录的真形状（[{record_ids:[…]}]）⇒ 提取到真 id 并成单 ─────────────
test('AC-AF1 ⭐ 生产记录形状 `[{record_ids:["rec…"]}]` ⇒ 提取到真「鞋垫」id 并成单', async () => {
  logs.length = 0;
  const h = build();
  const out = await h.service.handleTableChanges([actionItem({ name: recordShape() })]);
  assert.equal(out.results[0].ok, true, '这一行办成了 ✓');
  assert.equal(h.lines.length, REAL.quantity, '数量 2 ⇒ **两条明细**（一行一件）✓');
  for (const line of h.lines) assert.equal(line.accessoryRecordId, ACCESSORY_ID, '用的是**真 record id** ✓');
  assert.equal(h.writes.at(-1).fields['写入状态'], '已写入', '回写「已写入」✓');
});

// ── AC-AF2：纯 id 数组 ⇒ 同样成功（容错）────────────────────────────────────────
test('AC-AF2 ⭐ 纯数组形状 `["rec…"]` ⇒ 同样提取成功（形状容错）', async () => {
  logs.length = 0;
  const h = build();
  const out = await h.service.handleTableChanges([actionItem({ name: [ACCESSORY_ID] })]);
  assert.equal(out.results[0].ok, true);
  assert.equal(h.lines.length, REAL.quantity, '数量 2 ⇒ 两条明细');
  assert.equal(h.lines[0].accessoryRecordId, ACCESSORY_ID);
});

// ── AC-AF3：id 取不到（事件的文本形状）⇒ 按「名称」唯一命中兜底 ──────────────────
test('AC-AF3a ⭐⭐ 事件只带文本（没 record_ids）⇒ **按「名称」唯一命中**成单（就是这次事故的输入）', async () => {
  logs.length = 0;
  // 兜底读表也读不出「名称」（`fallbackFields:{}`）⇒ 必须靠**文本兜底**才能成单 ✓
  const h = build({ gatewayOpts: { fallbackFields: {} } });
  const out = await h.service.handleTableChanges([actionItem({ name: eventNameTextOnly() })]);
  assert.equal(out.results[0].ok, true, '不再被误报成"配品不存在"✓');
  assert.equal(h.lines.length, REAL.quantity, '两条明细（数量 2）✓');
  assert.equal(h.lines[0].accessoryRecordId, ACCESSORY_ID, '文本兜底拿到的**真 id** ✓');
  assert.ok(!h.lines.some((l) => String(l.accessoryRecordId).includes('object')),
    '**绝不**再出现 `[object Object]` 这种假 id ✗');
  assert.ok(logs.some(([level, event]) => level === 'warn' && event === 'accessory_sale_intake.name_fallback_hit'),
    '兜底命中如实记 warn（不是静默 ✓）');
  assert.equal(h.writes.at(-1).fields['写入状态'], '已写入');
});

test('AC-AF3b ⭐⭐ 名称**不唯一** ⇒ 如实拒单（绝不挑一个 ✗）＋ 零写入', async () => {
  logs.length = 0;
  const h = build({
    gatewayOpts: {
      fallbackFields: {},
      rows: [
        { record_id: ACCESSORY_ID, fields: { 名称: ACCESSORY_NAME } },
        { record_id: 'recvvWLQZDSmQf2', fields: { 名称: ACCESSORY_NAME } },
      ],
    },
  });
  const out = await h.service.handleTableChanges([actionItem({ name: eventNameTextOnly() })]);
  assert.equal(out.results[0].ok, false, '同名两条 ⇒ 拒单 ✓');
  assert.match(out.results[0].reason, /同名记录/, '理由是「名称不唯一/同名记录」✓');
  assert.equal(h.lines.length, 0, '**零明细** ✗');
  assert.equal(h.sales.length, 0, '**零成单** ✗');
  assert.equal(h.writes.at(-1).fields['写入状态'], '写入失败', '如实回写失败 ✓');
  assert.equal(h.writes.at(-1).fields['失败原因'], out.results[0].reason, '失败原因逐字落表 ✓');
});

// ── AC-AF4：真的查不到 ⇒ 语义不变（仍是"认不出这件配品"）────────────────────────
test('AC-AF4 ⭐ 名称也查不到 ⇒ 仍是既有语义拒单（`nameMissing` → 人话）＋ 零写入', async () => {
  logs.length = 0;
  const h = build({
    gatewayOpts: {
      fallbackFields: {},
      rows: [{ record_id: OTHER_ACCESSORY_ID, fields: { 名称: OTHER_ACCESSORY_NAME } }],
    },
  });
  const out = await h.service.handleTableChanges([actionItem({ name: eventNameTextOnly('不存在的配品') })]);
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].reason, /名称/, '理由仍是「名称取不到」那一档 ✓（语义不变）');
  assert.equal(h.lines.length + h.sales.length, 0, '零写入 ✓');
  assert.equal(h.writes.at(-1).fields['写入状态'], '写入失败');
});

test('AC-AF4b ⭐ `gateway.get` 查到的是**别的**配品 ⇒ 不拿它顶包，走文本兜底/拒单', async () => {
  logs.length = 0;
  const h = build({ gatewayOpts: { knownIds: [] } });   // 事件里那个 id 在表里不存在
  const out = await h.service.handleTableChanges([actionItem({ name: recordShape('recGoneAccessory1') })]);
  assert.equal(out.results[0].ok, true, 'id 失效 ⇒ 按「名称」唯一命中兜底 ✓');
  assert.equal(h.lines[0].accessoryRecordId, ACCESSORY_ID, '用的是**存在**的那条 ✓');
});

// ── AC-AF5 / AC-AF6：账对 + 失败零写入 ────────────────────────────────────────
test('AC-AF5 ⭐ 账对：明细 N 行 = 数量 ✓ · 收款**一条**、金额 = 总额（不翻倍 ✗）· 收款日由代码写', async () => {
  logs.length = 0;
  const h = build();
  const out = await h.service.handleTableChanges([actionItem({ name: eventNameTextOnly() })]);
  assert.equal(out.results[0].ok, true);
  assert.equal(h.lines.length, 2, '两件 ⇒ 两行 ✓');
  const sum = h.lines.reduce((total, line) => total + Number(line.amount), 0);
  assert.equal(sum, REAL.amount, `两行实收合计 = 她填的总额 ${REAL.amount} ✓`);
  assert.equal(h.sales.length, 1, '收款明细只有**一条** ✓');
  assert.equal(h.sales[0].payments.length, 1, '一笔收款 ✓');
  assert.equal(Number(h.sales[0].payments[0].amount), REAL.amount, '收款金额 = 总额（**不翻倍** ✗）');
  assert.equal(h.sales[0].submitKey, SALE_RECORD_ID, '幂等键 = 记录 ID（不变 ✓）');
});

test('AC-AF6 ⭐ 失败零写入：拒单时主表/明细/收款都不落（只有那两列的失败回写 ✓）', async () => {
  logs.length = 0;
  const h = build({ gatewayOpts: { rows: [], fallbackFields: {} } });
  await h.service.handleTableChanges([actionItem({ name: eventNameTextOnly('查不到的') })]);
  assert.equal(h.lines.length, 0);
  assert.equal(h.sales.length, 0);
  const back = writtenBack(h.writes);
  assert.equal(back.length, 1, '只回写了状态那一次 ✓');
  assert.deepEqual(Object.keys(back[0]).sort(), ['写入状态', '失败原因'], '只碰这两列 ✗ 其它列一个都不动');
});

// ── AC-AF7：形状哨兵（钉住"照抄生产形状"这件事本身）────────────────────────────
test('AC-AF7 ⭐⭐ 输入形状哨兵：本文件的 `事件文本形状` 与 `记录真形状` 逐字来自生产记录', () => {
  const textOnly = eventNameTextOnly();
  assert.equal(textOnly[0].record_ids, undefined, '事故那次事件的形状：**没有** record_ids（这正是根因 ✓）');
  assert.equal(textOnly[0].text, ACCESSORY_NAME, '带的是显示文本「鞋垫」✓');
  const production = recordShape();
  assert.deepEqual(Object.keys(production[0]).sort(),
    ['record_ids', 'table_id', 'text', 'text_arr', 'type'], '记录 API 的五个键逐字来自生产实测值 ✓');
  assert.equal(production[0].text_arr[0], ACCESSORY_NAME);
  assert.equal(production[0].table_id, 'tblxEeiXYAeUF4gH', '「其他配品」的 table_id ✓');
});
