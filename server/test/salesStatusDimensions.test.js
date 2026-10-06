// 「销售主表」四个状态维度：字段映射 + 「新字段空则退回旧字段」的双读取值。
//
// 背景：2026-10-06 业务负责人在生产「销售主表」新建了四个状态字段，并把旧的
// 「确认状态」改名成「确认状态（旧）」。代码按**字段名**找字段，改名后 6 处闸门
// 读到新建的空字段 → 全关闸。这一层把取值规则收到配置里，**判据仍留在调用点**。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_STATUS_FIELDS,
  LEGACY_SALES_STATUS_FIELDS,
  SALES_STATUS_VALUE_DOMAINS,
  postedOf,
  userActionOf,
  salesStatusOf,
  stockStatusOf,
  textOf,
} = require('../src/config/salesStatusDimensions');
const { textValue } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const entry = (fields) => ({ record_id: 'rec_1', fields });

test('字段名：四个新维度 + 两个旧字段名（字面量钉死，真表改名必须在这里改）', () => {
  assert.deepEqual(SALES_STATUS_FIELDS, {
    userAction: '确认状态', sales: '销售状态', funds: '资金状态', stock: '库存状态',
  });
  assert.deepEqual(LEGACY_SALES_STATUS_FIELDS, {
    legacyConfirm: '确认状态（旧）', legacyOrder: '订单状态',
  });
});

test('四个新字段名都指向 salesEntry 里真实存在的映射（只读 schema，不读真表）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  // 新字段：逐个对上 schema 的语义键。
  assert.equal(fields.userAction, SALES_STATUS_FIELDS.userAction);
  assert.equal(fields.sales, SALES_STATUS_FIELDS.sales);
  assert.equal(fields.funds, SALES_STATUS_FIELDS.funds);
  assert.equal(fields.stock, SALES_STATUS_FIELDS.stock);
  // 旧字段：schema 的 confirmStatus 必须指回「确认状态（旧）」——写那一路靠它不卡。
  assert.equal(fields.confirmStatus, LEGACY_SALES_STATUS_FIELDS.legacyConfirm);
  assert.equal(fields.orderStatus, LEGACY_SALES_STATUS_FIELDS.legacyOrder);
  // 映射值不能是空串（空串会让取值静默读到 undefined）。
  for (const name of Object.values({
    ...SALES_STATUS_FIELDS, ...LEGACY_SALES_STATUS_FIELDS,
  })) assert.ok(name.length > 0);
});

test('postedOf：新「资金状态」空 → 退回「确认状态（旧）」；有值 → 用新字段', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  // ① 新字段空（这就是今天的生产状态）→ 逐字退回旧字段今天的值。
  assert.equal(postedOf(entry({ '确认状态（旧）': '已入账' }), fields), '已入账');
  // ② 新字段有值 → 新字段优先，哪怕旧字段是别的值。
  assert.equal(postedOf(entry({ 资金状态: '已入账', '确认状态（旧）': '待确认' }), fields), '已入账');
  assert.equal(postedOf(entry({ 资金状态: '入账失败', '确认状态（旧）': '已入账' }), fields), '入账失败');
  // ③ 两个都空 → 空串（调用点 `!== '已入账'` 照旧关闸）。
  assert.equal(postedOf(entry({}), fields), '');
  assert.equal(postedOf(undefined, fields), '');
  // ④ 新字段只有空白 → 仍算"空"，必须退回旧字段（不能把空白当成有值）。
  assert.equal(postedOf(entry({ 资金状态: '   ', '确认状态（旧）': '已入账' }), fields), '已入账');
});

test('postedOf 不传 table 时用配置里的字段名（配置先行，不依赖调用方）', () => {
  assert.equal(postedOf(entry({ 资金状态: '已入账' })), '已入账');
  assert.equal(postedOf(entry({ '确认状态（旧）': '已入账' })), '已入账');
});

test('userActionOf / salesStatusOf：同样双读（新字段优先，空则退回旧字段）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(userActionOf(entry({ '确认状态（旧）': '待确认' }), fields), '待确认');
  assert.equal(userActionOf(entry({ 确认状态: '已取消', '确认状态（旧）': '待确认' }), fields), '已取消');
  assert.equal(userActionOf(entry({}), fields), '');

  assert.equal(salesStatusOf(entry({ 订单状态: '已完成' }), fields), '已完成');
  assert.equal(salesStatusOf(entry({ 销售状态: '部分交付', 订单状态: '已确认' }), fields), '部分交付');
  assert.equal(salesStatusOf(entry({}), fields), '');
});

test('stockStatusOf：新「库存状态」（这一维今天没有旧字段可退回）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(stockStatusOf(entry({ 库存状态: '已扣减' }), fields), '已扣减');
  assert.equal(stockStatusOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
  assert.equal(stockStatusOf(entry({ 库存状态: '  ' }), fields), '');
});

test('textOf 与 gateway.textValue 同义（配置层零依赖，不能悄悄换语义）', () => {
  const samples = ['已入账', '', null, undefined, 42, { text: 'A' }, { name: 'B' }, { value: 'C' }, {}, ['A', 'B'], []];
  for (const sample of samples) assert.equal(textOf(sample), textValue(sample), String(sample));
});

test('建议值域：四个维度都非空，且资金状态里必须有「已入账」（判据的口径）', () => {
  for (const [key, values] of Object.entries(SALES_STATUS_VALUE_DOMAINS)) {
    assert.ok(Array.isArray(values) && values.length, `${key} 值域不能为空`);
  }
  assert.ok(SALES_STATUS_VALUE_DOMAINS.funds.includes('已入账'));
  assert.ok(SALES_STATUS_VALUE_DOMAINS.userAction.includes('待确认'));
});
