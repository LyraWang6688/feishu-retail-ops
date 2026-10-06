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
  assert.equal(stockStatusOf(entry({ 库存状态: '已写入' }), fields), '已写入');
  assert.equal(stockStatusOf(entry({ '确认状态（旧）': '已入账' }), fields), '');
  assert.equal(stockStatusOf(entry({ 库存状态: '  ' }), fields), '');
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
    stock: ['未扣减', '部分扣减', '已扣减', '扣减失败'],
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

test('⭐ 两代字面量：已入账（旧）与已写入（新）都算「账做完了」，别的都不算', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.deepEqual(POSTED_VALUES, ['已入账', '已写入']);
  assert.equal(isPosted('已入账'), true);
  assert.equal(isPosted('已写入'), true);
  // 单元格里多一个空格是同一个事实：不能因此把闸门关掉（本次事故的失败形状）。
  assert.equal(isPosted(' 已写入 '), true);
  assert.equal(isPosted('未写入'), false);
  assert.equal(isPosted('部分写入'), false);
  assert.equal(isPosted('写入失败'), false);
  assert.equal(isPosted(''), false);
  assert.equal(isPosted(undefined), false);
  // 6 处闸门的真实写法：isPosted(postedOf(...))
  assert.equal(isPosted(postedOf(entry({ '确认状态（旧）': '已入账' }), fields)), true);
  assert.equal(isPosted(postedOf(entry({ 资金状态: '已写入' }), fields)), true);
  assert.equal(isPosted(postedOf(entry({ 资金状态: '未写入' }), fields)), false);
  // 资金状态有值（未写入）时**不许**退回旧字段的「已入账」
  assert.equal(isPosted(postedOf(entry({ 资金状态: '未写入', '确认状态（旧）': '已入账' }), fields)), false);
});
