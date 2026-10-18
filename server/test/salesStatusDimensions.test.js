// 「销售主表」写入状态：字段映射 + 取值语义（2026-10-18 新模型）。
//
// 业务负责人改表：删除 确认/销售/资金/库存 四个状态列，统一为「写入状态」
// （成功 / 失败 / 部分失败 / 未完成）。旧维度名只为兼容读取方保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WRITE_STATUS_FIELD,
  WRITE_STATUS_VALUES,
  SALES_STATUS_FIELDS,
  SALES_STATUS_WRITE_VALUES,
  postedOf,
  writeStatusOf,
  isPosted,
  userActionOf,
  salesStatusOf,
  stockStatusOf,
  fundsStatusOf,
  textOf,
} = require('../src/config/salesStatusDimensions');
const { textValue } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const entry = (fields) => ({ record_id: 'rec_1', fields });

test('字段名：唯一的「写入状态」；旧四维都指向它（兼容读取）', () => {
  assert.equal(WRITE_STATUS_FIELD, '写入状态');
  assert.deepEqual(WRITE_STATUS_VALUES, ['成功', '失败', '部分失败', '未完成']);
  for (const name of Object.values(SALES_STATUS_FIELDS)) assert.equal(name, '写入状态');
});

test('schema 映射到「写入状态」；旧四列映射已删除', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(fields.writeStatus, '写入状态');
  for (const old of ['userAction', 'sales', 'funds', 'stock', 'confirmStatus', 'orderStatus']) {
    assert.equal(fields[old], undefined, `旧映射 ${old} 不该再存在`);
  }
});

test('writeStatusOf / postedOf：只读「写入状态」；空值与历史记录 → 空串', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  assert.equal(writeStatusOf(entry({ 写入状态: '成功' }), fields), '成功');
  assert.equal(writeStatusOf(entry({ 写入状态: '部分失败' }), fields), '部分失败');
  assert.equal(writeStatusOf(entry({ 资金状态: '已写入' }), fields), '', '新模型只认写入状态');
  assert.equal(writeStatusOf(entry({}), fields), '');
  assert.equal(writeStatusOf(entry({ 写入状态: '   ' }), fields), '');
  assert.equal(writeStatusOf(undefined, fields), '');
  assert.equal(postedOf(entry({ 写入状态: '成功' }), fields), '成功');
  assert.equal(postedOf(entry({ 写入状态: '部分失败' }), fields), '部分失败');
  // 用户口径：不需要兼容历史记录 ⇒ 旧列名一律不读。
  assert.equal(postedOf(entry({ 资金状态: '已写入' }), fields), '');
});

test('isPosted：只有「成功」算完成（部分失败/失败/未完成都不算）', () => {
  assert.equal(isPosted('成功'), true);
  assert.equal(isPosted(' 成功 '), true);
  assert.equal(isPosted('部分失败'), false);
  assert.equal(isPosted('失败'), false);
  assert.equal(isPosted('未完成'), false);
  assert.equal(isPosted(''), false);
});

test('旧词义映射：userAction / sales / stock / funds 都从写入状态派生', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  const of = (status) => entry({ 写入状态: status });
  assert.equal(userActionOf(of('成功'), fields), '已确认');
  assert.equal(userActionOf(of('未完成'), fields), '未确认');
  assert.equal(userActionOf(of(''), fields), '');

  assert.equal(salesStatusOf(of('成功'), fields), '已写入');
  assert.equal(salesStatusOf(of('部分失败'), fields), '部分写入');
  assert.equal(salesStatusOf(of('失败'), fields), '写入失败');
  assert.equal(salesStatusOf(of('未完成'), fields), '未写入');
  assert.equal(stockStatusOf(of('成功'), fields), '已写入');
  assert.equal(fundsStatusOf(of('部分失败'), fields), '部分写入');
  assert.equal(fundsStatusOf(of(''), fields), '');
});

test('写入值常量：成功 / 部分失败 / 失败 / 未完成', () => {
  const W = SALES_STATUS_WRITE_VALUES.writeStatus;
  assert.deepEqual(W, { pending: '未完成', done: '成功', partial: '部分失败', failed: '失败' });
});

test('textOf 与 gateway.textValue 同义（配置层零依赖，不能悄悄换语义）', () => {
  const samples = ['成功', '', null, undefined, 42, { text: 'A' }, { name: 'B' }, { value: 'C' }, {}, ['A', 'B'], []];
  for (const sample of samples) assert.equal(textOf(sample), textValue(sample), String(sample));
});
