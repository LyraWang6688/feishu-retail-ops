const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchService, resolveSalesRange } = require('../src/services/v1WorkbenchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SALES_QUERY_MAX_RANGE_DAYS } = require('../src/config/workbenchQuery');

// 「销售查询」的验收标准（她 2026-10-06：**不只查今日**，要能按某日、按区间）：
//   ① date=某日 → 只那一天的已确认明细；
//   ② from/to → **含首尾**的区间；
//   ③ 老的 /sales/today（不传参数）行为不变 = 今天；
//   ④ 日期写错 / 范围太大 → 明确报错（400），不是静默返回空。
const SIZES = [38, 40].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const day = (iso) => Date.parse(`${iso}T10:00:00+08:00`);
const gatewayFor = (records) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZES : records[key] || []),
});
const sale = (id, iso, amount) => ({
  record_id: id,
  fields: { 编号: ['p1'], 尺码: ['size_38'], 销售单号: ['o1'], 销售日: day(iso), 成交金额: amount },
});
const FIXTURE = {
  salesDetail: [sale('d1', '2026-09-01', 100), sale('d2', '2026-09-05', 200), sale('d3', '2026-09-10', 300)],
  salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-001', 资金状态: '已写入' } }],
  product: [{ record_id: 'p1', fields: { 编号: 'XHB8095|全黑|A', 货号: 'XHB8095', 颜色: '全黑' } }],
};

test('resolveSalesRange：某日 / 区间 / 都不传（今天）都收敛成 [from, to]', () => {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  assert.deepEqual(resolveSalesRange({ date: '2026-09-05' }), { from: '2026-09-05', to: '2026-09-05', date: '2026-09-05' });
  assert.deepEqual(resolveSalesRange({ from: '2026-09-01', to: '2026-09-10' }),
    { from: '2026-09-01', to: '2026-09-10', date: '' });
  assert.deepEqual(resolveSalesRange({}), { from: today, to: today, date: today });
  // 只给一端 → 当成单日，不猜另一端。
  assert.deepEqual(resolveSalesRange({ from: '2026-09-05' }), { from: '2026-09-05', to: '2026-09-05', date: '2026-09-05' });
});

test('resolveSalesRange：日期格式错 / 起止颠倒 / 超过上限 → 400 并说明原因', () => {
  for (const [input, pattern] of [
    [{ date: '2026/09/05' }, /格式必须是 YYYY-MM-DD/],
    [{ from: '2026-09-10', to: '2026-09-01' }, /开始日期不能晚于结束日期/],
    [{ from: '2026-01-01', to: '2027-01-01' }, /一次最多查询/],
  ]) {
    assert.throws(() => resolveSalesRange(input), (error) => error.statusCode === 400 && pattern.test(error.message));
  }
  assert.equal(SALES_QUERY_MAX_RANGE_DAYS, 92, '上限是配置项，不是写死的字面量');
});

test('销售查询：按某日只返回那一天，按区间含首尾', async () => {
  const service = createWorkbenchService(gatewayFor(FIXTURE));

  const oneDay = await service.getSalesReport({ date: '2026-09-05' });
  assert.deepEqual(oneDay.rows.map((row) => row.record_id), ['d2']);
  assert.equal(oneDay.date, '2026-09-05');
  assert.equal(oneDay.is_range, false);
  assert.equal(oneDay.summary.receivable_amount, 200);

  const range = await service.getSalesReport({ from: '2026-09-01', to: '2026-09-05' });
  assert.deepEqual(range.rows.map((row) => row.record_id).sort(), ['d1', 'd2'], '首尾两天都要在');
  assert.equal(range.is_range, true);
  assert.equal(range.date, '');
  assert.equal(range.from, '2026-09-01');
  assert.equal(range.to, '2026-09-05');
  assert.equal(range.summary.detail_count, 2);
  assert.equal(range.summary.receivable_amount, 300);
});

test('销售查询：区间里没有任何已确认明细 → 空行，不报错', async () => {
  const service = createWorkbenchService(gatewayFor(FIXTURE));
  const report = await service.getSalesReport({ from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(report.rows, []);
  assert.equal(report.summary.detail_count, 0);
  assert.equal(report.summary.receivable_amount, 0);
});

test('getTodaySales 仍然等价于「按某日=今天」，老接口的响应形状不变', async () => {
  const service = createWorkbenchService(gatewayFor(FIXTURE));
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const report = await service.getTodaySales({ date: '2026-09-10' });
  assert.equal(report.date, '2026-09-10');
  assert.deepEqual(report.rows.map((row) => row.record_id), ['d3']);
  const fallback = await service.getTodaySales();
  assert.equal(fallback.date, today, '不传日期时仍然默认今天');
});

test('货品选择器：按货号/编号/颜色过滤，返回 record_id 供库存接口用', async () => {
  const service = createWorkbenchService(gatewayFor(FIXTURE));
  const all = await service.findProducts({ keyword: '' });
  assert.deepEqual(all.rows, [{ record_id: 'p1', product_number: 'XHB8095|全黑|A', item_no: 'XHB8095', color: '全黑' }]);
  assert.equal((await service.findProducts({ keyword: 'xhb' })).total, 1, '大小写不敏感');
  assert.equal((await service.findProducts({ keyword: '不存在' })).total, 0);
});

test('库存数量：按货号+尺码统计三种「所属状态」的记录条数（一双一条）', async () => {
  const service = createWorkbenchService(gatewayFor({
    ...FIXTURE,
    liveInventory: [
      { record_id: 'l1', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒' } },
      { record_id: 'l2', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒' } },
      { record_id: 'l3', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '样品' } },
      { record_id: 'l4', fields: { 编号: ['p1'], 尺码: ['size_40'], 所属状态: '门盒' } },
      { record_id: 'l5', fields: { 编号: ['other'], 尺码: ['size_38'], 所属状态: '门盒' } },
    ],
  }));

  const levels = await service.getInventoryStockLevels({ productRecordId: 'p1', size: '38' });
  assert.deepEqual(levels.rows, [{ state: '门盒', quantity: 2 }, { state: '样品', quantity: 1 }, { state: '仓库', quantity: 0 }]);
  assert.equal(levels.total, 3, '别的货号 / 别的尺码都不算进来');

  const withoutSize = await service.getInventoryStockLevels({ productRecordId: 'p1' });
  assert.equal(withoutSize.total, 4, '不传尺码 = 这个货号的全部状态');
});

test('库存数量：缺少货号 / 尺码不是正整数 → 400', async () => {
  const service = createWorkbenchService(gatewayFor(FIXTURE));
  await assert.rejects(service.getInventoryStockLevels({ productRecordId: '' }),
    (error) => error.statusCode === 400 && /货号/.test(error.message));
  await assert.rejects(service.getInventoryStockLevels({ productRecordId: 'p1', size: '四十二' }),
    (error) => error.statusCode === 400 && /尺码必须是正整数/.test(error.message));
});

test('品类清单：读「实时库存」的「品类」公式列，空的整条跳过', async () => {
  const service = createWorkbenchService(gatewayFor({
    ...FIXTURE,
    liveInventory: [
      { record_id: 'l1', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒', 品类: '休闲鞋' } },
      { record_id: 'l2', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒', 品类: '休闲鞋' } },
      { record_id: 'l3', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '仓库', 品类: '单鞋' } },
      { record_id: 'l4', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒' } },
    ],
  }));

  const categories = await service.listInventoryCategories();
  assert.deepEqual(categories.rows, [{ category: '休闲鞋', quantity: 2 }, { category: '单鞋', quantity: 1 }]);
});

test('实时库存行带上「品类」，供换季调整按品类批量分组', async () => {
  const service = createWorkbenchService(gatewayFor({
    ...FIXTURE,
    liveInventory: [
      { record_id: 'l1', fields: { 编号: ['p1'], 尺码: ['size_38'], 所属状态: '门盒', 品类: '休闲鞋' } },
    ],
  }));
  const inventory = await service.getLiveInventory();
  assert.equal(inventory.rows[0].category, '休闲鞋');
});
