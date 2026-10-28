/**
 * 采购页读模型**纯函数**判据（AC-P2..P8，见 `docs/procurement-page-real-2026-10-28.md`）。
 *
 * 钉住的口径（2026-10-28 业务负责人确认）：
 *   · 补货只查「销售明细」；库存数量 = 0；销售日 = 今天 00:00 往前 3 个自然日（上海时区，不含今天）；
 *   · 交易类型判据复用 salesMovements（现货 SALE_CASH / 预订 SALE_PREPAID），认不出 ⇒ 不计入、不猜；
 *   · 上新 = 上架日期今天；按记录 ID 分组；类别缺失**不猜**；顶部统计**只有「新增货品」**。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcurementPageConfig } = require('../src/config/procurementPage');
const {
  buildReplenishView, replenishWindow, dayIso, dayStart,
} = require('../src/services/procurementPageData');
const { buildNewProductsView, todayWindow } = require('../src/services/procurementPageNewProductsData');

const config = buildProcurementPageConfig({});
const SH = (iso) => Date.parse(`${iso}+08:00`);
// 2026-10-28 09:00（上海）= 测试的"现在"
const NOW = SH('2026-10-28T09:00:00');

const F = Object.freeze({
  product: '编号', size: '尺码', soldAt: '销售日', stockQuantity: '库存数量', tradeType: '交易类型',
  number: '编号', itemNo: '货号', color: '颜色', category: '类别', supplier: '供应商', createdAt: '上架日期',
});
const link = (...ids) => ids.map((id) => ({ record_ids: [id], text: id }));
const salesRow = ({ product = 'recA', size = 39, soldAt = SH('2026-10-27T12:00:00'), stock = 0, trade = 'SALE_CASH', text = '' } = {}) => ({
  record_id: `row_${Math.random().toString(36).slice(2, 8)}`,
  fields: {
    [F.product]: link(product), [F.size]: size, [F.soldAt]: soldAt, [F.stockQuantity]: stock,
    [F.tradeType]: link(trade), ...(text ? { [F.tradeType]: text } : {}),
  },
});
const product = ({ id = 'recA', number = '86822', itemNo = '86822', color = '黑色', category = 'A', supplier = 'recS', createdAt = NOW } = {}) => ({
  record_id: id,
  fields: {
    [F.number]: number, [F.itemNo]: itemNo, [F.color]: color, [F.category]: category,
    [F.supplier]: link(supplier), [F.createdAt]: createdAt,
  },
});
const tradeCode = (cell) => {
  const ids = String(JSON.stringify(cell)).match(/SALE_\w+/g) || [];
  return ids[0] || '';
};
// 补货视图的 products 入参是**已归一化**的 DTO（getBatch 形状由 procurementProductEnricher 归一化）
const productDto = ({ id = 'recA', number = '86822', itemNo = '86822', color = '黑色', supplier = 'recS' } = {}) => ({
  productRecordId: id, number, itemNo, color, supplierRecordId: supplier,
});
const dtoMap = (products) => new Map(products.map((one) => (one.productRecordId
  ? [one.productRecordId, one]
  : [one.record_id, productDto({ id: one.record_id, itemNo: one.fields?.[F.itemNo], number: one.fields?.[F.number], color: one.fields?.[F.color] })])));
const view = (records, products = [productDto()]) => buildReplenishView({
  records, products: dtoMap(products), fields: F, config, now: NOW,
  tradeTypeCodeOf: tradeCode,
});

// ── AC-P2 三天窗口（上海时区）─────────────────────────────────────────────
test('AC-P2 补货窗口 = [今天 00:00 - 3 天, 现在]：上海时区边界（业务负责人 2026-10-29 口径）', () => {
  const range = replenishWindow(NOW, config);
  assert.equal(range.start, SH('2026-10-25T00:00:00'), '开始 = 今天 00:00 往前 3 个自然日');
  assert.equal(range.end, NOW, '结束 = 此刻（含今天已发生的销售）');
  assert.equal(range.from, '2026-10-25');
  assert.equal(range.to, '2026-10-28', '结束日期 = 今天');
});

test('AC-P2 边界：3 天前 00:00 起 / 现在之内都计入；3 天前 23:59:59 与「未来」不计入', () => {
  const inWindow = view([salesRow({ soldAt: SH('2026-10-27T23:59:59') })]);
  assert.equal(inWindow.stats.prepaidPending + inWindow.stats.spotSold, 1);
  const todayPartial = view([salesRow({ soldAt: SH('2026-10-28T08:59:59') })]);
  assert.equal(todayPartial.stats.spotSold, 1, '今天 00:00 之后、现在之前的销售必须计入');
  const nowEdge = view([salesRow({ soldAt: SH('2026-10-28T09:00:00') })]);
  assert.equal(nowEdge.stats.spotSold, 0, '「现在」这一刻本身不计入（右开区间）');
  const tooOld = view([salesRow({ soldAt: SH('2026-10-24T23:59:59') })]);
  assert.equal(tooOld.stats.spotSold, 0);
  const firstInclusive = view([salesRow({ soldAt: SH('2026-10-25T00:00:00') })]);
  assert.equal(firstInclusive.stats.spotSold, 1);
});

test('AC-P2b 跨月 / 跨年 / 闰年：日期运算自动进位（不手写月份边界）', () => {
  const cases = [
    ['2026-11-02T09:00:00', '2026-10-30', '2026-11-02'], // 跨月：11-02 00:00 - 3 天 = 10-30
    ['2026-12-01T00:30:00', '2026-11-28', '2026-12-01'], // 跨月：12-01 - 3 天 = 11-28
    ['2027-01-02T09:00:00', '2026-12-30', '2027-01-02'], // 跨年：01-02 - 3 天 = 上年 12-30
    ['2026-03-02T09:00:00', '2026-02-27', '2026-03-02'], // 平年 2 月
    ['2028-03-02T09:00:00', '2028-02-28', '2028-03-02'], // 闰年 2 月（2-29 存在）
    ['2026-01-01T00:10:00', '2025-12-29', '2026-01-01'], // 元旦跨年
  ];
  for (const [nowIso, from, to] of cases) {
    const range = replenishWindow(SH(nowIso), config);
    assert.equal(range.from, from, `${nowIso} 的开始日期`);
    assert.equal(range.to, to, `${nowIso} 的结束日期`);
  }
});

// ── AC-P3 库存 = 0 过滤 ───────────────────────────────────────────────────
test('AC-P3 库存数量 = 0 才计入：>0 / 空 / 认不出 一律不计入', () => {
  const rows = [
    salesRow({ stock: 0 }), salesRow({ stock: 2 }),
    { record_id: 'r1', fields: { [F.product]: link('recA'), [F.size]: 39, [F.soldAt]: NOW, [F.tradeType]: link('SALE_CASH') } },
    { record_id: 'r2', fields: { [F.product]: link('recA'), [F.size]: 40, [F.soldAt]: NOW, [F.stockQuantity]: 'abc', [F.tradeType]: link('SALE_CASH') } },
  ];
  const result = view(rows);
  assert.equal(result.stats.spotSold, 1);
  assert.equal(result.skippedRows, 3);
});

// ── AC-P4 现货 / 预订计数（判据来自 salesMovements）─────────────────────────
test('AC-P4 交易类型：SALE_CASH → 现货已售，SALE_PREPAID → 预订待补；认不出不计入', () => {
  const records = [
    salesRow({ size: 39, trade: 'SALE_CASH' }), salesRow({ size: 39, trade: 'SALE_CASH' }),
    salesRow({ size: 39, trade: 'SALE_PREPAID' }),
    salesRow({ size: 40, trade: 'SALE_PREPAID' }), salesRow({ size: 40, trade: 'SALE_PREPAID' }),
    salesRow({ size: 41, trade: 'SALE_RETURN' }),
  ];
  const result = view(records);
  assert.deepEqual(result.stats, { spotSold: 2, prepaidPending: 3, productCount: 1 });
  const sizes = result.groups[0].sizes;
  assert.deepEqual(sizes.map((row) => [row.size, row.spotSold, row.prepaidSold]), [
    [39, 2, 1], [40, 0, 2],
  ]);
  assert.equal(result.skippedRows, 1);
});

test('AC-P4 关联记录里认不出编码、显示文本是「现货/预订」⇒ 仍按 salesMovements 的标签映射', () => {
  const records = [
    { record_id: 'x1', fields: { [F.product]: link('recA'), [F.size]: 39, [F.soldAt]: SH('2026-10-27T12:00:00'), [F.stockQuantity]: 0, [F.tradeType]: [{ text: '预订' }] } },
  ];
  const result = buildReplenishView({
    records, products: new Map([['recA', productDto()]]), fields: F, config, now: NOW,
    tradeTypeCodeOf: (cell) => {
      const text = JSON.stringify(cell);
      return text.includes('预订') ? 'SALE_PREPAID' : '';
    },
  });
  assert.equal(result.stats.prepaidPending, 1);
});

// ── AC-P5 分组 / 排序 / 标题字段 ──────────────────────────────────────────
test('AC-P5 按货品记录ID分组；组排序 = 预订降序 → 现货降序 → 货号升序；尺码升序', () => {
  const products = [
    product({ id: 'recA', itemNo: 'B002' }), product({ id: 'recB', itemNo: 'A001' }), product({ id: 'recC', itemNo: 'C003' }),
  ];
  const records = [
    salesRow({ product: 'recA', size: 41, trade: 'SALE_PREPAID' }),
    salesRow({ product: 'recA', size: 39, trade: 'SALE_PREPAID' }),
    salesRow({ product: 'recB', size: 40, trade: 'SALE_CASH' }),
    salesRow({ product: 'recC', size: 42, trade: 'SALE_PREPAID' }),
    salesRow({ product: 'recC', size: 43, trade: 'SALE_CASH' }),
  ];
  const result = view(records, products);
  assert.deepEqual(result.groups.map((group) => group.productRecordId), ['recA', 'recC', 'recB']);
  assert.deepEqual(result.groups[0].sizes.map((row) => row.size), [39, 41]);
  assert.equal(result.stats.productCount, 3);
  // 记录ID 只作内部主键；标题所需的 货号/颜色 都在字段里（页面自己拼「货号 · 颜色」）
  assert.equal(result.groups[0].itemNo, 'B002');
  assert.equal(result.groups[0].color, '黑色');
});

// ── AC-P6/P7/P8 上新 ─────────────────────────────────────────────────────
test('AC-P6 上新窗口 = [今天 00:00, 明天 00:00)；昨天 23:59:59 不计入', () => {
  const range = todayWindow(NOW, config);
  assert.equal(range.start, SH('2026-10-28T00:00:00'));
  assert.equal(range.end, SH('2026-10-29T00:00:00'));
  const records = [
    product({ id: 'recToday', createdAt: SH('2026-10-28T00:00:00') }),
    product({ id: 'recYesterday', createdAt: SH('2026-10-27T23:59:59') }),
  ];
  const result = buildNewProductsView({ records, fields: F, config, now: NOW });
  assert.equal(result.stats.productCount, 1);
  assert.equal(result.groups[0].productRecordId, 'recToday');
});

test('AC-P7 尺码与默认值：A → 普通 38-44 / 特殊 45-48；B → 普通 36-40 / 特殊 34/35/41/42/43', () => {
  const records = [product({ id: 'recA', category: 'A' }), product({ id: 'recB', category: 'B' })];
  const result = buildNewProductsView({ records, fields: F, config, now: NOW });
  const byId = new Map(result.groups.map((group) => [group.productRecordId, group]));
  assert.deepEqual(byId.get('recA').sizes.normal, [38, 39, 40, 41, 42, 43, 44]);
  assert.deepEqual(byId.get('recA').sizes.special, [45, 46, 47, 48]);
  assert.deepEqual(byId.get('recB').sizes.normal, [36, 37, 38, 39, 40]);
  assert.deepEqual(byId.get('recB').sizes.special, [34, 35, 41, 42, 43]);
  assert.deepEqual(byId.get('recA').defaults, { normal: 1, special: 0 });
});

test('AC-P7 类别缺失 ⇒ 不猜：categoryMissing=true + 空尺码 + 空 category（不默认 A）', () => {
  const records = [product({ id: 'recNone', category: '' }), product({ id: 'recX', category: 'C' })];
  const result = buildNewProductsView({ records, fields: F, config, now: NOW });
  for (const group of result.groups) {
    assert.equal(group.categoryMissing, true);
    assert.equal(group.category, '');
    assert.deepEqual(group.sizes, { normal: [], special: [] });
  }
});

test('AC-P8 上新顶部统计**只有「新增货品」**（不得出现新增颜色数 / 普通码待采购）', () => {
  const records = [product({ id: 'recA', category: 'A' }), product({ id: 'recB', category: 'B' })];
  const result = buildNewProductsView({ records, fields: F, config, now: NOW });
  assert.deepEqual(Object.keys(result.stats), ['productCount']);
  assert.equal(result.stats.productCount, 2);
});

test('dayStart / dayIso：上海时区 00:00 与跨 UTC 日期都正确', () => {
  assert.equal(dayStart(SH('2026-10-28T00:30:00'), 480), SH('2026-10-28T00:00:00'));
  // 上海 10-28 07:00 = UTC 10-27 23:00 ⇒ 上海日期仍是 10-28
  assert.equal(dayIso(SH('2026-10-28T07:00:00'), 480), '2026-10-28');
});
