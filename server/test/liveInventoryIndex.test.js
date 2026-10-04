const test = require('node:test');
const assert = require('node:assert');
const { LiveInventoryIndex, parseStockKey } = require('../src/services/liveInventoryIndex');

// 「库存键」是飞书侧公式：货号|颜色|类别|尺码。生产库 1086/1086 条都是这个格式。
//
// ⚠️ 夹具必须用**飞书原始 API 的字段形状**：
//   · 富文本/公式 → [{ text: '...', type: 'text' }]
//   · 关联字段   → [{ record_ids: ['rec...'], table_id: '...', text: '...' }]
// 用简写形状（{ id: 'rec...' } 或纯字符串）会让"整表被静默跳过"测不出来——
// 线上曾经因此把 1086 条全部跳过，每一单都回"库存里没有"。
const record = ({ id, stockKey, state = '门盒', product = 'prod_1', size = 'size_1' }) => ({
  record_id: id,
  fields: {
    库存键: [{ text: stockKey, type: 'text' }],
    所属状态: state,
    编号: [{ record_ids: [product], table_id: 'tbl_product', text: product, text_arr: [product], type: 'text' }],
    尺码: [{ record_ids: [size], table_id: 'tbl_size', text: size, text_arr: [size], type: 'text' }],
  },
});

const build = (records) => new LiveInventoryIndex({ records });

test('库存键解析：四段格式', () => {
  assert.deepEqual(parseStockKey('DN16|黑|A|40'), { itemNo: 'DN16', color: '黑', category: 'A', size: 40 });
});

test('库存键解析：段数不对、尺码不是数字、货号为空，一律返回 null（不猜）', () => {
  assert.equal(parseStockKey('DN16|黑|A'), null);
  assert.equal(parseStockKey('DN16|黑|A|40|extra'), null);
  assert.equal(parseStockKey('DN16|黑|A|四十'), null);
  assert.equal(parseStockKey('|黑|A|40'), null);
  assert.equal(parseStockKey(''), null);
  assert.equal(parseStockKey(undefined), null);
});

test('格式不符或状态未知的记录会被跳过并计数，不会被当成别的款', () => {
  const index = build([
    record({ id: 'r1', stockKey: 'DN16|黑|A|40' }),
    record({ id: 'r2', stockKey: '坏键' }),
    record({ id: 'r3', stockKey: 'DN16|黑|A|41', state: '未知状态' }),
  ]);
  assert.equal(index.skippedRecords, 2);
  assert.equal(index.find({ itemNo: 'DN16', size: 40 }).colors.length, 1);
});

test('一个货号只有一个颜色时，颜色可以直接定', () => {
  const index = build([
    record({ id: 'r1', stockKey: '26632|黑|A|37' }),
    record({ id: 'r2', stockKey: '26632|黑|A|37' }),
    record({ id: 'r3', stockKey: '26632|黑|A|37', state: '样品' }),
  ]);
  const found = index.find({ itemNo: '26632', size: 37 });
  assert.equal(found.colors.length, 1);
  assert.equal(found.colors[0].color, '黑');
  assert.equal(found.colors[0].doorBox, 2);
  assert.equal(found.colors[0].sample, 1);
  assert.equal(found.colors[0].warehouse, 0);
});

test('同一个货号尺码有多个颜色时，颜色交给卡片选（不猜）', () => {
  const index = build([
    record({ id: 'r1', stockKey: '26632|黑|A|37', product: 'prod_black' }),
    record({ id: 'r2', stockKey: '26632|棕|A|37', product: 'prod_brown' }),
  ]);
  const found = index.find({ itemNo: '26632', size: 37 });
  assert.deepEqual(found.colors.map((item) => item.color).sort(), ['棕', '黑']);
  assert.deepEqual(found.colors.map((item) => item.productRecordId).sort(), ['prod_black', 'prod_brown']);
});

test('颜色分组各自带着自己的货品与尺码关联（写销售明细要用）', () => {
  const index = build([
    record({ id: 'r1', stockKey: '26632|黑|A|37', product: 'prod_black', size: 'size_37' }),
  ]);
  const [entry] = index.find({ itemNo: '26632', size: 37 }).colors;
  assert.equal(entry.productRecordId, 'prod_black');
  assert.equal(entry.sizeRecordId, 'size_37');
  assert.deepEqual(entry.records['门盒'], ['r1']);
});

test('尺码在店里没有时，colors 为空，并给出同货号其他有货的尺码', () => {
  const index = build([
    record({ id: 'r1', stockKey: '26632|黑|A|36' }),
    record({ id: 'r2', stockKey: '26632|黑|A|38' }),
  ]);
  const found = index.find({ itemNo: '26632', size: 37 });
  assert.deepEqual(found.colors, []);
  assert.deepEqual(found.otherSizes, [{ size: 36, total: 1 }, { size: 38, total: 1 }]);
});

test('货号在库存里完全没有时，colors 与 otherSizes 都为空', () => {
  const found = build([]).find({ itemNo: '不存在', size: 40 });
  assert.deepEqual(found.colors, []);
  assert.deepEqual(found.otherSizes, []);
});

test('补样品候选只列门盒有余量的尺码，并可排除刚卖掉的那几双', () => {
  const index = build([
    record({ id: 'r1', stockKey: 'DN16|黑|A|36' }),
    record({ id: 'r2', stockKey: 'DN16|黑|A|38' }),
    record({ id: 'r3', stockKey: 'DN16|黑|A|38' }),
    record({ id: 'r4', stockKey: 'DN16|黑|A|40', state: '样品' }),
    record({ id: 'r5', stockKey: 'DN16|黑|A|42', state: '仓库' }),
  ]);
  assert.deepEqual(index.sampleReplacementCandidates('DN16'), [
    { size: 36, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    { size: 38, doorBoxCount: 2, sampleCount: 0, warehouseCount: 0 },
    { size: 40, doorBoxCount: 0, sampleCount: 1, warehouseCount: 0 },
    { size: 42, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
  ]);
  assert.deepEqual(index.sampleReplacementCandidates('DN16', { excludeRecordIds: ['r1'] }), [
    { size: 38, doorBoxCount: 2, sampleCount: 0, warehouseCount: 0 },
    { size: 40, doorBoxCount: 0, sampleCount: 1, warehouseCount: 0 },
    { size: 42, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
  ]);
});

test('库存记录缺少货品或尺码关联时跳过，不能凭空造出关联', () => {
  const index = build([
    { record_id: 'r1', fields: { 库存键: 'DN16|黑|A|40', 所属状态: '门盒', 编号: [], 尺码: [{ id: 'size_1' }] } },
    { record_id: 'r2', fields: { 库存键: 'DN16|黑|A|40', 所属状态: '门盒', 编号: [{ id: 'prod_1' }], 尺码: [] } },
  ]);
  assert.equal(index.skippedRecords, 2);
  assert.deepEqual(index.find({ itemNo: 'DN16', size: 40 }).colors, []);
});

test('补样品候选按货品记录（货号 + 颜色）取，绝不跨颜色', () => {
  const index = build([
    record({ id: 'r1', stockKey: 'DN16|黑|A|36', product: 'prod_black' }),
    record({ id: 'r2', stockKey: 'DN16|黑|A|38', product: 'prod_black' }),
    record({ id: 'r3', stockKey: 'DN16|米|A|38', product: 'prod_beige' }),
  ]);
  assert.deepEqual(index.sampleReplacementCandidatesForProduct('prod_black'), [
    { size: 36, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    { size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
  ]);
  assert.deepEqual(index.sampleReplacementCandidatesForProduct('prod_beige'), [
    { size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
  ]);
  assert.deepEqual(index.sampleReplacementCandidatesForProduct(''), []);
  assert.deepEqual(index.sampleReplacementCandidatesForProduct('不存在'), []);
});

test('关联字段按飞书原始 API 形状解析：record_ids 里的 record_id 必须认出来', () => {
  // 回归：曾经只认 { id } / { record_id }，导致整表 1086 条被静默跳过。
  const index = build([record({ id: 'r1', stockKey: 'DN16|黑|A|40', product: 'rec_product', size: 'rec_size' })]);
  assert.equal(index.skippedRecords, 0, '原始 API 形状的记录不该被跳过');
  const found = index.find({ itemNo: 'DN16', size: 40 });
  assert.equal(found.colors[0].productRecordId, 'rec_product');
  assert.equal(found.colors[0].sizeRecordId, 'rec_size');
});

test('简写形状也认（CLI 导出 / 手写夹具）', () => {
  const simple = (id, stockKey, product, size) => ({
    record_id: id, fields: { 库存键: stockKey, 所属状态: '门盒', 编号: [{ id: product }], 尺码: [{ id: size }] },
  });
  const index = build([simple('r1', 'DN16|黑|A|40', 'p1', 's1')]);
  assert.equal(index.skippedRecords, 0, '简写形状同样要认，避免又反过来只认一种');
  assert.equal(index.find({ itemNo: 'DN16', size: 40 }).colors[0].productRecordId, 'p1');
});

test('关联字段为空时跳过并计数，不猜', () => {
  const index = build([
    { record_id: 'r1', fields: { 库存键: [{ text: 'DN16|黑|A|40' }], 所属状态: '门盒', 编号: [], 尺码: [] } },
  ]);
  assert.equal(index.skippedRecords, 1);
});