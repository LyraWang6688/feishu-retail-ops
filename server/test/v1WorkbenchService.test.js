const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');

const day = Date.parse('2026-09-25T10:00:00+08:00');
const gatewayFor = (records) => ({ listAll: async (key) => records[key] || [] });

test('two shoes in one order retain their own receivables and count the receipt once', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'd1', fields: { 编号: ['p1'], 尺码: 36, 数量: 1, 销售单号: ['o1'], 销售日: [{ text: String(day) }], 成交金额: [{ text: '100' }], 应收金额: 120 } },
      { record_id: 'd2', fields: { 编号: ['p2'], 尺码: 37, 数量: 1, 销售单号: ['o1'], 销售日: day, 成交金额: 150, 应收金额: 200 } },
      { record_id: 'undated', fields: { 编号: ['p1'], 尺码: 38, 数量: 1, 销售单号: ['o2'], 应收金额: 99 } },
    ],
    salesEntry: [
      { record_id: 'o1', fields: { 销售单号: 'XSD-001', 确认状态: '已入账' } },
      { record_id: 'o2', fields: { 销售单号: 'XSD-002', 确认状态: '已入账' } },
    ],
    paymentRecord: [{ record_id: 'r1', fields: { 关联销售单: ['o1'], 支付方式: ['m1'], 收款金额: 250 } }],
    paymentMethod: [{ record_id: 'm1', fields: { 收款方式: '现金' } }],
    product: [
      { record_id: 'p1', fields: { 编号: '93827黑' } },
      { record_id: 'p2', fields: { 编号: '2115米' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.deepEqual(report.rows.map((row) => row.receivable_amount), [100, 150]);
  assert.deepEqual(report.rows.map((row) => row.list_amount), [120, 200]);
  assert.equal(report.summary.order_count, 1);
  assert.equal(report.summary.receivable_amount, 250);
  assert.equal(report.summary.paid_amount, 250);
  assert.equal(report.rows[0].paid_amount, undefined);
});

test('order send time is the fallback sale date; no date on either record is excluded', async () => {
  const gateway = gatewayFor({
    salesDetail: [
      { record_id: 'fallback', fields: { 销售单号: ['o1'], 数量: 1 } },
      { record_id: 'unknown', fields: { 销售单号: ['o2'], 数量: 1 } },
    ],
    salesEntry: [
      { record_id: 'o1', fields: { 确认状态: '已入账', 发送时间: day } },
      { record_id: 'o2', fields: { 确认状态: '已入账' } },
    ],
  });
  const report = await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' });
  assert.deepEqual(report.rows.map((row) => row.record_id), ['fallback']);
  assert.equal(report.summary.receivable_amount, null);
});

test('today sales separates platform pending vouchers from received cash', async () => {
  const gateway = gatewayFor({
    salesDetail: [{ record_id: 'd1', fields: { 销售单号: ['o1'], 数量: 1, 销售日: day, 成交金额: 254.4 } }],
    salesEntry: [{ record_id: 'o1', fields: { 确认状态: '已入账' } }],
    paymentRecord: [
      { record_id: 'r1', fields: { 关联销售单: ['o1'], 收款金额: 169, 收款状态: '已收清', 支付方式: ['m1'] } },
      { record_id: 'r2', fields: { 关联销售单: ['o1'], 收款金额: 85.4, 收款状态: '待平台结算', 支付方式: ['m2'] } },
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
