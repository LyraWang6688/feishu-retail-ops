// 「销售主表」四个状态维度：字段映射 + **单读新字段**的取值。
//
// 背景：2026-10-06 业务负责人在生产「销售主表」新建了四个状态字段，随后又**把两个旧字段
// 整列删掉**（「确认状态（旧）」「订单状态」——飞书删字段 = 连值一起删、不可恢复）。
// ⇒ 这一层只读新字段，**没有任何 legacy 回退**（旧列在真表里已不存在）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_STATUS_FIELDS,
  SALES_STATUS_VALUE_DOMAINS,
  SALES_STATUS_WRITE_VALUES,
  POSTED_VALUES,
  isPosted,
  postedOf,
  userActionOf,
  salesStatusOf,
  stockStatusOf,
  textOf,
} = require('../src/config/salesStatusDimensions');
const { textValue } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const entry = (fields) => ({ record_id: 'rec_1', fields });

test('字段名：四个状态维度（字面量钉死，真表改名必须在这里改）', () => {
  assert.deepEqual(SALES_STATUS_FIELDS, {
    userAction: '确认状态', sales: '销售状态', funds: '资金状态', stock: '库存状态',
  });
  for (const name of Object.values(SALES_STATUS_FIELDS)) assert.ok(name.length > 0);
});

test('schema 里不存在旧字段映射（旧列已被业务负责人删除，映射回去 = 闸门当场红）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(fields.confirmStatus, undefined);
  assert.equal(fields.orderStatus, undefined);
  // 四个新字段逐个对上 schema 的语义键。
  assert.equal(fields.userAction, SALES_STATUS_FIELDS.userAction);
  assert.equal(fields.sales, SALES_STATUS_FIELDS.sales);
  assert.equal(fields.funds, SALES_STATUS_FIELDS.funds);
  assert.equal(fields.stock, SALES_STATUS_FIELDS.stock);
});

test('postedOf：只读「资金状态」；旧字段名即使出现在记录里也不读', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(postedOf(entry({ 资金状态: '已写入' }), fields), '已写入');
  assert.equal(postedOf(entry({ 资金状态: '已入账' }), fields), '已入账');
  assert.equal(postedOf(entry({ 资金状态: '未写入' }), fields), '未写入');
  // 旧字段（真表里已经删了这列）——写进来也**不算数**：没有回退。
  assert.equal(postedOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
  // 空 / 只有空白 → 空串（调用点 `isPosted(...)` 照旧关闸）。
  assert.equal(postedOf(entry({}), fields), '');
  assert.equal(postedOf(entry({ 资金状态: '   ' }), fields), '');
  assert.equal(postedOf(undefined, fields), '');
});

test('postedOf 不传 table 时用配置里的字段名（配置先行，不依赖调用方）', () => {
  assert.equal(postedOf(entry({ 资金状态: '已写入' })), '已写入');
  assert.equal(postedOf(entry({ '确认状态（旧）': '已入账' })), '');
});

test('userActionOf / salesStatusOf / stockStatusOf：各自只读自己那一维', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(userActionOf(entry({ 确认状态: '已确认' }), fields), '已确认');
  assert.equal(userActionOf(entry({ '确认状态（旧）': '待确认' }), fields), '');
  assert.equal(userActionOf(entry({}), fields), '');

  assert.equal(salesStatusOf(entry({ 销售状态: '已写入' }), fields), '已写入');
  assert.equal(salesStatusOf(entry({ 订单状态: '已完成' }), fields), '');
  assert.equal(salesStatusOf(entry({}), fields), '');

  assert.equal(stockStatusOf(entry({ 库存状态: '已写入' }), fields), '已写入');
  assert.equal(stockStatusOf(entry({ 库存状态: '  ' }), fields), '');
  assert.equal(stockStatusOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
});

test('textOf 与 gateway.textValue 同义（配置层零依赖，不能悄悄换语义）', () => {
  const samples = ['已入账', '', null, undefined, 42, { text: 'A' }, { name: 'B' }, { value: 'C' }, {}, ['A', 'B'], []];
  for (const sample of samples) assert.equal(textOf(sample), textValue(sample), String(sample));
});

test('值域：就是业务负责人 2026-10-06 拍板的那四组（逐字钉死）', () => {
  assert.deepEqual(SALES_STATUS_VALUE_DOMAINS, {
    userAction: ['未确认', '已确认', '已取消', '待修改'],
    sales: ['未写入', '部分写入', '已写入', '写入失败'],
    funds: ['未写入', '已写入', '写入失败'],
    stock: ['未写入', '部分写入', '已写入', '写入失败'],
  });
});

test('代码要写的每一个值都落在同一维度的值域里（改一处忘另一处，这里当场红）', () => {
  for (const [dimension, values] of Object.entries(SALES_STATUS_WRITE_VALUES)) {
    const domain = SALES_STATUS_VALUE_DOMAINS[dimension];
    assert.ok(Array.isArray(domain) && domain.length, `${dimension} 没有值域`);
    for (const [name, value] of Object.entries(values)) {
      assert.ok(domain.includes(value), `${dimension}.${name}='${value}' 不在值域里`);
    }
  }
});

test('⭐ 两代字面量：已入账（她的老说法）与已写入（代码写的）都算「账做完了」，别的都不算', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.deepEqual(POSTED_VALUES, ['已入账', '已写入']);
  assert.equal(isPosted('已入账'), true);
  assert.equal(isPosted('已写入'), true);
  // 单元格里多一个空格是同一个事实：不能因此把闸门关掉（那次事故的失败形状）。
  assert.equal(isPosted(' 已写入 '), true);
  assert.equal(isPosted('未写入'), false);
  assert.equal(isPosted('部分写入'), false);
  assert.equal(isPosted('写入失败'), false);
  assert.equal(isPosted(''), false);
  assert.equal(isPosted(undefined), false);
  // 6 处闸门的真实写法：isPosted(postedOf(...))
  assert.equal(isPosted(postedOf(entry({ 资金状态: '已入账' }), fields)), true);
  assert.equal(isPosted(postedOf(entry({ 资金状态: '已写入' }), fields)), true);
  assert.equal(isPosted(postedOf(entry({ 资金状态: '未写入' }), fields)), false);
  // ⚠️ 旧列的「已入账」不再能救场：值已随那一列被删除，读它只会得到空 → 关闸。
  assert.equal(isPosted(postedOf(entry({ '确认状态（旧）': '已入账' }), fields)), false);
});
