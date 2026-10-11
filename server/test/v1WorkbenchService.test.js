const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const day = Date.parse('2026-09-25T10:00:00+08:00');
// 「尺码」已改为关联「尺码管理」：夹具必须给关联 ID，并让假网关能查到尺码表。
const SIZES = [36, 37, 38].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const gatewayFor = (records) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZES : records[key] || []),
});

test('two shoes in one order retain their own receivables and count the receipt once', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'd1', fields: { 编号: ['p1'], 尺码: ['size_36'], 数量: 1, 销售单号: ['o1'], 销售日: [{ text: String(day) }], 实收金额: [{ text: '100' }], 销售单价: 120 } },
      { record_id: 'd2', fields: { 编号: ['p2'], 尺码: ['size_37'], 数量: 1, 销售单号: ['o1'], 销售日: day, 实收金额: 150, 销售单价: 200 } },
      { record_id: 'undated', fields: { 编号: ['p1'], 尺码: ['size_38'], 数量: 1, 销售单号: ['o2'], 销售单价: 99 } },
    ],
    salesEntry: [
      { record_id: 'o1', fields: { 销售单号: 'XSD-001', '资金状态': '已写入' } },
      { record_id: 'o2', fields: { 销售单号: 'XSD-002', '资金状态': '已写入' } },
    ],
    paymentRecord: [{ record_id: 'r1', fields: { 关联销售单: ['o1'], 收款方式: ['m1'], 收款金额: 250 } }],
    paymentMethod: [{ record_id: 'm1', fields: { 收款方式: '现金' } }],
    product: [
      { record_id: 'p1', fields: { 编号: '93827黑' } },
      { record_id: 'p2', fields: { 编号: '2115米' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.deepEqual(report.rows.map((row) => row.receivable_amount), [100, 150]);
  assert.deepEqual(report.rows.map((row) => row.list_amount), [120, 200]);
  assert.deepEqual(report.rows.map((row) => row.size).sort(), [36, 37]);
  assert.equal(report.summary.order_count, 1);
  assert.equal(report.summary.receivable_amount, 250);
  assert.equal(report.summary.paid_amount, 250);
  assert.equal(report.rows[0].paid_amount, undefined);
});

test('a row whose size link is broken does not break the whole query', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'ok', fields: { 编号: ['p1'], 尺码: ['size_36'], 销售单号: ['o1'], 销售日: day, 实收金额: 100 } },
      // 关联为空：这条明细读不出尺码，但不能让整页查询失败。
      { record_id: 'broken', fields: { 编号: ['p1'], 尺码: [], 销售单号: ['o1'], 销售日: day, 实收金额: 100 } },
    ],
    salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-001', '资金状态': '已写入' } }],
    product: [{ record_id: 'p1', fields: { 编号: '93827黑' } }],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  const sizeById = new Map(report.rows.map((row) => [row.record_id, row.size]));

  assert.equal(report.rows.length, 2);
  assert.equal(sizeById.get('ok'), 36);
  assert.equal(sizeById.get('broken'), null);
});

// ⭐ 2026-10-08：赠品的落点从「销售明细」搬到「销售主表」⇒ 工作台这一列改读**那一单**。
// 不改的话：明细那一列已被她整列删除，`asText` 会静默返回空串（这一列无声变空）。
test('赠品列读的是销售主表那一行（整单一条，同单多行显示同一串）', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'd1', fields: { 编号: ['p1'], 尺码: ['size_36'], 销售单号: ['o1'], 销售日: day, 实收金额: 100 } },
      { record_id: 'd2', fields: { 编号: ['p2'], 尺码: ['size_37'], 销售单号: ['o1'], 销售日: day, 实收金额: 150 } },
    ],
    salesEntry: [{ record_id: 'o1', fields: {
      销售单号: 'XSD-001', 资金状态: '已写入', 赠品: '鞋垫一双、袜子一双' } }],
    product: [
      { record_id: 'p1', fields: { 编号: '93827黑' } },
      { record_id: 'p2', fields: { 编号: '2115米' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.deepEqual(report.rows.map((row) => row.gift), ['鞋垫一双、袜子一双', '鞋垫一双、袜子一双']);
});

test('live inventory resolves sizes from the link and filters by the numeric size', async () => {
  const gateway = gatewayFor({
    liveInventory: [
      { record_id: 'l1', fields: { 编号: ['p1'], 尺码: ['size_36'], 所属状态: '门盒' } },
      { record_id: 'l2', fields: { 编号: ['p1'], 尺码: ['size_37'], 所属状态: '门盒' } },
      { record_id: 'l3', fields: { 编号: ['p1'], 尺码: ['size_37'], 所属状态: '门盒' } },
    ],
    product: [{ record_id: 'p1', fields: { 编号: '93827黑' } }],
  });
  const all = await createWorkbenchService(gateway).getLiveInventory();
  const filtered = await createWorkbenchService(gateway).getLiveInventory({ size: '37' });

  assert.deepEqual(all.rows.map((row) => [row.size, row.quantity]).sort(), [[36, 1], [37, 2]]);
  assert.deepEqual(filtered.rows.map((row) => [row.size, row.quantity]), [[37, 2]]);
});

test('order creation time is the fallback sale date; no date on either record is excluded', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'fallback', fields: { 销售单号: ['o1'], 数量: 1 } },
      { record_id: 'unknown', fields: { 销售单号: ['o2'], 数量: 1 } },
    ],
    salesEntry: [
      { record_id: 'o1', fields: { '资金状态': '已写入', 录单日: day } },
      { record_id: 'o2', fields: { '资金状态': '已写入' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.deepEqual(report.rows.map((row) => row.record_id), ['fallback']);
  assert.equal(report.summary.receivable_amount, null);
});

test('today sales separates platform pending vouchers from received cash', async () => {
  const gateway = gatewayFor({
    salesDetail: [{ record_id: 'd1', fields: { 销售单号: ['o1'], 数量: 1, 销售日: day, 实收金额: 254.4 } }],
    salesEntry: [{ record_id: 'o1', fields: { '资金状态': '已写入' } }],
    paymentRecord: [
      { record_id: 'r1', fields: { 关联销售单: ['o1'], 收款金额: 169, 收款状态: '已收款', 收款方式: ['m1'] } },
      { record_id: 'r2', fields: { 关联销售单: ['o1'], 收款金额: 85.4, 收款状态: '待平台结算', 收款方式: ['m2'] } },
    ],
    paymentMethod: [
      { record_id: 'm1', fields: { 收款方式: '微信' } },
      { record_id: 'm2', fields: { 收款方式: '抖音团购券' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.equal(report.summary.paid_amount, 169);
  assert.equal(report.summary.platform_pending_amount, 85.4);
  assert.deepEqual(report.summary.payment_summary, { 微信: 169 });
});
