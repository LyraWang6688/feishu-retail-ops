'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SalesCorrectionService, shanghaiStartOfWindow, personOpenIds } = require('../src/services/salesCorrectionService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const F = V1_BITABLE_SCHEMA.tables;
const NOW = Date.parse('2026-11-28T10:00:00+08:00');
const master = (id, overrides = {}) => ({
  record_id: id,
  fields: {
    [F.salesEntry.fields.orderNo]: 'XSD-20261128-0001',
    [F.salesEntry.fields.recordedAt]: NOW - 2 * 60 * 60 * 1000,
    [F.salesEntry.fields.writeStatus]: '成功',
    [F.salesEntry.fields.sender]: [{ id: 'ou_a', name: '甲' }],
    [F.salesEntry.fields.afterSalesCount]: 0,
    [F.salesEntry.fields.afterSalesType]: [],
    [F.salesEntry.fields.gift]: '',
    [F.salesEntry.fields.accessory]: '',
    [F.salesEntry.fields.accessoryAmount]: 0,
    [F.salesEntry.fields.totalAmount]: 180,
    ...overrides,
  },
});
const detail = (id, overrides = {}) => ({
  record_id: id,
  fields: {
    [F.salesDetail.fields.salesEntry]: [{ record_ids: ['sale_1'] }],
    [F.salesDetail.fields.product]: [{ record_ids: ['prod_1'] }],
    [F.salesDetail.fields.size]: [{ record_ids: ['size_42'] }],
    [F.salesDetail.fields.actualAmount]: 180,
    [F.salesDetail.fields.tradeType]: [],
    ...overrides,
  },
});
const payment = (id, amount = 180, status = '已收款') => ({
  record_id: id,
  fields: { [F.paymentRecord.fields.salesEntry]: [{ record_ids: ['sale_1'] }], [F.paymentRecord.fields.amount]: amount, [F.paymentRecord.fields.status]: status, [F.paymentRecord.fields.method]: [] },
});

const makeHarness = () => {
  const writes = [];
  const rows = { salesEntry: [master('sale_1')], salesDetail: [detail('detail_1')], paymentRecord: [payment('pay_1')], behavior: [] };
  const gateway = {
    table: (key) => F[key],
    get: async (key, id) => (rows[key] || []).find((row) => row.record_id === id) || null,
    listAll: async (key) => rows[key] || [],
    update: async (key, id, values) => {
      writes.push({ op: 'update', key, id, values });
      const row = (rows[key] || []).find((item) => item.record_id === id);
      if (row) {
        const mapped = {};
        for (const [field, value] of Object.entries(values || {})) mapped[F[key]?.fields?.[field] || field] = value;
        row.fields = { ...row.fields, ...mapped };
      }
    },
    create: async (key, values) => { writes.push({ op: 'create', key, values }); return { recordId: 'created_1' }; },
    delete: async (key, id) => { writes.push({ op: 'delete', key, id }); },
  };
  const baseOrder = {
    record_id: 'sale_1', order_no: 'XSD-20261128-0001', recorded_at: NOW - 2 * 60 * 60 * 1000,
    total_amount: 180, paid_amount: 180, pending_amount: 0, receivable_amount: 180,
    details: [{ record_id: 'detail_1', product: '60182', color: '黑色', size: 42, size_record_id: 'size_42', actual_amount: 180, fulfillment_status: '已交付' }],
    payments: [{ record_id: 'pay_1', amount: 180, status: '已收款', method: '微信' }],
  };
  const followup = {
    listOrders: async () => ({ orders: [baseOrder], methods: ['微信', '支付宝'] }),
    ordersCache: { invalidate() {} },
  };
  const inventory = {
    sizeReferences: {
      resolveLinkedCell: async (cell) => ({ size: 42, recordId: (cell || [])[0]?.record_ids?.[0] || '' }),
      resolveByNumber: async (size) => ({ recordId: 'size_' + size }),
    },
    correctSaleDetailSize: async (input) => ({ inventory: 'row_swapped', ledger: 'updated', input }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-correction-'));
  const service = new SalesCorrectionService({
    gateway, followup, inventory, now: () => NOW,
    store: new JsonTaskStore({ dir, idField: 'task_id' }), auditDir: dir,
    references: { resolvePaymentMethod: async () => ({ recordId: 'method_wechat' }), resolveSalesTradeType: async () => ({ recordId: 'trade_cash' }) },
  });
  return { service, gateway, rows, writes, dir };
};

test('确认单：只列 5 天、写入成功、无售后，并区分本人/管理员', async () => {
  const h = makeHarness();
  const own = await h.service.list({ actor: { openId: 'ou_a' } });
  assert.equal(own.orders.length, 1);
  assert.equal(own.orders[0].can_edit, true);
  assert.equal(own.orders[0].editable, true);

  const other = await h.service.list({ actor: { openId: 'ou_b' } });
  assert.equal(other.orders[0].can_edit, false);

  const admin = await h.service.list({ actor: { roleNames: ['管理员'] } });
  assert.equal(admin.orders[0].can_edit, true);

  h.rows.salesEntry[0].fields[F.salesEntry.fields.recordedAt] = NOW - 6 * 24 * 60 * 60 * 1000;
  assert.equal((await h.service.list({ actor: { openId: 'ou_a' } })).orders.length, 0);

  h.rows.salesEntry[0].fields[F.salesEntry.fields.recordedAt] = NOW - 2 * 60 * 60 * 1000;
  h.rows.salesEntry[0].fields[F.salesEntry.fields.afterSalesCount] = 1;
  const blocked = await h.service.list({ actor: { openId: 'ou_a' } });
  assert.equal(blocked.orders[0].editable, false);
  assert.deepEqual(blocked.orders[0].blocked_reasons, ['after_sales']);
});

test('确认单：金额更正原地改明细 + 主表总额', async () => {
  const h = makeHarness();
  const result = await h.service.correct({
    submitKey: 'correction-key-1',
    salesEntryRecordId: 'sale_1',
    details: [{ recordId: 'detail_1', size: 42, actualAmount: '150' }],
    payments: [{ recordId: 'pay_1', method: '微信', amount: '150' }],
    gift: '袜子',
    accessory: '',
    accessoryTotal: '0',
  }, { actor: { openId: 'ou_a' }, requestId: 'req-1' });
  assert.equal(result.ok, true);
  assert.ok(h.writes.some((write) => write.key === 'salesDetail' && write.id === 'detail_1' && String(write.values.actualAmount) === '150'));
  assert.ok(h.writes.some((write) => write.key === 'salesEntry' && write.id === 'sale_1' && write.values.totalAmount === 150));
  assert.ok(h.writes.some((write) => write.key === 'salesEntry' && write.id === 'sale_1' && write.values.gift === '袜子'));
});

test('确认单：同 submitKey 重放不重复写；窗口按上海自然日计算', async () => {
  const h = makeHarness();
  const payload = {
    submitKey: 'correction-key-2', salesEntryRecordId: 'sale_1',
    details: [{ recordId: 'detail_1', size: 42, actualAmount: '150' }],
    payments: [{ recordId: 'pay_1', method: '微信', amount: '150' }], gift: '', accessory: '', accessoryTotal: '0',
  };
  await h.service.correct(payload, { actor: { openId: 'ou_a' } });
  const before = h.writes.length;
  const replay = await h.service.correct(payload, { actor: { openId: 'ou_a' } });
  assert.equal(replay.ok, true);
  assert.equal(h.writes.length, before);
  assert.equal(shanghaiStartOfWindow(NOW, 5), Date.parse('2026-11-24T00:00:00+08:00'));
  assert.deepEqual(personOpenIds([{ id: 'ou_a' }, { open_id: 'ou_b' }]), ['ou_a', 'ou_b']);
});
