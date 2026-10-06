// 「销售主表」四个状态维度：字段映射 + 值域 + **单读**取值。
//
// 业务负责人 2026-10-06 定的口径（原话）：
//   「你需要负责的是新的 4 个字段……我需要知道的是：用户有没有点击确认按钮，
//     有没有写进销售明细、收款明细、库存流水以及实时库存」
//   「旧的两个字段不用管，代码里也不需要了，schema 可以留着」
// ⇒ 四个字段记的是四个"做没做到"的检查点；**不双读、不 legacy 兜底、不回填**。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_STATUS_FIELDS,
  SALES_STATUS_DIMENSIONS,
  SALES_STATUS_VALUES,
  SALES_STATUS_VALUE_DOMAINS,
  assertStatusValue,
  statusPatch,
  userActionOf,
  salesStatusOf,
  fundsStatusOf,
  stockStatusOf,
  textOf,
} = require('../src/config/salesStatusDimensions');
const { textValue } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const entry = (fields) => ({ record_id: 'rec_1', fields });

test('字段名 + 语义键：字面量钉死（真表改名必须在这里改）', () => {
  assert.deepEqual(SALES_STATUS_FIELDS, {
    userAction: '确认状态', sales: '销售状态', funds: '资金状态', stock: '库存状态',
  });
  assert.deepEqual(SALES_STATUS_DIMENSIONS, {
    userAction: 'userAction', sales: 'sales', funds: 'funds', stock: 'stock',
  });
});

test('四个维度的字段名都指向 salesEntry 里真实存在的映射（只读 schema，不读真表）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  for (const dimension of Object.keys(SALES_STATUS_DIMENSIONS)) {
    assert.equal(fields[dimension], SALES_STATUS_FIELDS[dimension], dimension);
    assert.ok(SALES_STATUS_FIELDS[dimension].length > 0);
  }
});

test('值域就是"达成情况"：四个维度各自的取值，字面量钉死', () => {
  assert.deepEqual(SALES_STATUS_VALUES.userAction,
    { PENDING: '未确认', CONFIRMED: '已确认', CANCELLED: '已取消', TO_MODIFY: '待修改' });
  assert.deepEqual(SALES_STATUS_VALUES.sales,
    { NONE: '未写入', PARTIAL: '部分写入', WRITTEN: '已写入', FAILED: '写入失败' });
  assert.deepEqual(SALES_STATUS_VALUES.funds,
    { NONE: '未写入', WRITTEN: '已写入', FAILED: '写入失败' });
  assert.deepEqual(SALES_STATUS_VALUES.stock,
    { NONE: '未扣减', PARTIAL: '部分扣减', DONE: '已扣减', FAILED: '扣减失败' });
  // 数组形态（= 建议的写入顺序 = 飞书选项的显示顺序）由值域派生，不会两处不一致。
  for (const [dimension, values] of Object.entries(SALES_STATUS_VALUE_DOMAINS)) {
    assert.deepEqual(values, Object.values(SALES_STATUS_VALUES[dimension]), dimension);
    assert.ok(values.length > 0);
  }
});

test('assertStatusValue：值域外的值一律拒绝（写错的值会永久留在飞书选项里）', () => {
  assert.equal(assertStatusValue('funds', '已写入'), '已写入');
  assert.equal(assertStatusValue('funds', ''), '');
  assert.equal(assertStatusValue('funds', null), '');
  // 旧口径的值不再被接受 —— 它已经不属于这四个字段的值域。
  assert.throws(() => assertStatusValue('funds', '已入账'), /只能是：未写入 \/ 已写入 \/ 写入失败/);
  assert.throws(() => assertStatusValue('userAction', '入账中'), /确认状态/);
  assert.throws(() => assertStatusValue('stock', '已写入'), /必须是|只能是/);
  assert.throws(() => assertStatusValue('nope', 'x'), /未知的销售状态维度/);
});

test('statusPatch：给出"语义键 → 值"的写入载荷，且必须是 schema 里配过的语义键', () => {
  assert.deepEqual(statusPatch('funds', '已写入'), { funds: '已写入' });
  assert.deepEqual(statusPatch('stock', '已扣减'), { stock: '已扣减' });
  // 空值 = 不写（"留空"本身是合法状态，不该被翻译成一个空字符串写进去）。
  assert.deepEqual(statusPatch('sales', ''), { sales: '' });
  assert.throws(() => statusPatch('sales', 'done'), /销售状态/);
});

test('单读：只认自己那一列，**不退回旧字段**（旧字段有值也不算数）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  // 新字段有值 → 读它。
  assert.equal(fundsStatusOf(entry({ 资金状态: '已写入', '确认状态（旧）': '已入账' }), fields), '已写入');
  assert.equal(userActionOf(entry({ 确认状态: '已确认', '确认状态（旧）': '待确认' }), fields), '已确认');
  assert.equal(salesStatusOf(entry({ 销售状态: '部分写入', 订单状态: '已完成' }), fields), '部分写入');
  assert.equal(stockStatusOf(entry({ 库存状态: '部分扣减' }), fields), '部分扣减');
  // 🔴 只有旧字段 → 一律空串：这就是"旧字段不用管"落到代码上的样子。
  assert.equal(fundsStatusOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
  assert.equal(userActionOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
  assert.equal(salesStatusOf(entry({ 订单状态: '已完成' }), fields), '');
  // 空 / 空白 / 缺记录 → 空串。
  assert.equal(fundsStatusOf(entry({ 资金状态: '   ' }), fields), '');
  assert.equal(fundsStatusOf(entry({}), fields), '');
  assert.equal(fundsStatusOf(undefined, fields), '');
});

test('不传 table 时用配置里的字段名（配置先行，不依赖调用方）', () => {
  assert.equal(fundsStatusOf(entry({ 资金状态: '已写入' })), '已写入');
  assert.equal(fundsStatusOf(entry({ '确认状态（旧）': '已入账' })), '');
  assert.equal(userActionOf(entry({ 确认状态: '已取消' })), '已取消');
  assert.equal(salesStatusOf(entry({ 销售状态: '写入失败' })), '写入失败');
  assert.equal(stockStatusOf(entry({ 库存状态: '扣减失败' })), '扣减失败');
});

test('textOf 与 gateway.textValue 同义（配置层零依赖，不能悄悄换语义）', () => {
  const samples = ['已写入', '', null, undefined, 42, { text: 'A' }, { name: 'B' }, { value: 'C' }, {}, ['A', 'B'], []];
  for (const sample of samples) assert.equal(textOf(sample), textValue(sample), String(sample));
});
