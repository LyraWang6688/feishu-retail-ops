'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchasePaymentDetailService } = require('../src/services/purchasePaymentDetailService');

const makeGateway = ({ existing = [] } = {}) => {
  const created = [];
  const filters = [];
  const gateway = {
    get: async (table, id) => {
      if (table === 'supplier') return { record_id: id, fields: { 供应商名称: '信踏' } };
      return null;
    },
    listByFilter: async (table, formula) => { filters.push({ table, formula }); return existing; },
    create: async (table, fields, options) => {
      created.push({ table, fields, options });
      return { recordId: 'p_detail_1' };
    },
  };
  return { gateway, created, filters };
};

test('AC-PD1 验收按供应商写 P发生明细：批次号-供应商名、发生额、关联字段', async () => {
  const h = makeGateway();
  const result = await createPurchasePaymentDetailService({ gateway: h.gateway }).writeForSupplier({
    batchNo: 'CGD-20261117-0002',
    batchRecordId: 'batch_1',
    supplierRecordId: 'supplier_1',
    amount: 455,
  });
  assert.equal(result.created, true);
  assert.equal(result.transaction_detail_id, 'CGD-20261117-0002-信踏');
  const written = h.created[0].fields;
  assert.equal(written.transactionDetailId, 'CGD-20261117-0002-信踏');
  assert.equal(written.amount, 455);
  assert.ok(Array.isArray(written.supplier), '供应商走关联字段');
  assert.ok(Array.isArray(written.batchNo), '报货批次号走关联字段');
  assert.equal(Object.hasOwn(written, 'behavior'), false, '发生行为是 Lookup，不写');
  assert.equal(Object.hasOwn(written, 'balance'), false, '最新余额留空，不写');
});

test('AC-PD2 同一批次/供应商重复写 ⇒ 按交易明细ID回查跳过', async () => {
  const h = makeGateway({ existing: [{ record_id: 'existing' }] });
  const result = await createPurchasePaymentDetailService({ gateway: h.gateway }).writeForSupplier({
    batchNo: 'CGD-20261117-0002', batchRecordId: 'batch_1',
    supplierRecordId: 'supplier_1', amount: 455,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already_synced');
  assert.equal(h.created.length, 0);
  assert.ok(h.filters[0].formula.includes('CGD-20261117-0002-信踏'));
});

test('AC-PD3 缺少供应商/批次/金额 ⇒ 不写', async () => {
  const h = makeGateway();
  const service = createPurchasePaymentDetailService({ gateway: h.gateway });
  assert.equal((await service.writeForSupplier({ batchNo: 'CGD-1', batchRecordId: 'b', amount: 10 })).skipped, true);
  assert.equal((await service.writeForSupplier({ batchNo: 'CGD-1', supplierRecordId: 's', amount: 10 })).skipped, true);
  assert.equal((await service.writeForSupplier({ batchNo: 'CGD-1', batchRecordId: 'b', supplierRecordId: 's' })).skipped, true);
  assert.equal(h.created.length, 0);
});
