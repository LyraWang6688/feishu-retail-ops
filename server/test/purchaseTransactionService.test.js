'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseTransactionService } = require('../src/services/purchaseTransactionService');

const makeGateway = () => {
  const calls = [];
  const records = [];
  return {
    calls,
    records,
    table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
    get: async (key, id) => (key === 'supplier' && id === 'sup_1'
      ? { record_id: id, fields: { 供应商名称: '信踏' } } : null),
    listByFilter: async () => records.slice(),
    create: async (key, values) => {
      calls.push({ key, values });
      const row = { record_id: 'rec_tx_1', fields: values };
      records.push(row);
      return { recordId: row.record_id };
    },
  };
};

test('AC-PT1 验收写 P交易明细：只写交易明细ID + 报货批次号', async () => {
  const gateway = makeGateway();
  const service = createPurchaseTransactionService({ gateway });
  const result = await service.writeForSupplier({
    batchNo: 'CGD-20261118-0002', batchRecordId: 'batch_1', supplierRecordId: 'sup_1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.transaction_detail_id, 'CGD-20261118-0002-信踏');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].key, 'paymentTransaction');
  assert.deepEqual(gateway.calls[0].values, {
    transactionDetailId: 'CGD-20261118-0002-信踏',
    batchNo: ['batch_1'],
  });
});

test('AC-PT2 同一批次/供应商重复写 ⇒ 按交易明细ID回查跳过', async () => {
  const gateway = makeGateway();
  const service = createPurchaseTransactionService({ gateway });
  await service.writeForSupplier({
    batchNo: 'CGD-20261118-0002', batchRecordId: 'batch_1', supplierRecordId: 'sup_1',
  });
  const again = await service.writeForSupplier({
    batchNo: 'CGD-20261118-0002', batchRecordId: 'batch_1', supplierRecordId: 'sup_1',
  });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already_synced');
  assert.equal(gateway.calls.length, 1);
});

test('AC-PT3 缺少批次或供应商 ⇒ 跳过，不盲写', async () => {
  const gateway = makeGateway();
  const service = createPurchaseTransactionService({ gateway });
  assert.equal((await service.writeForSupplier({ batchNo: 'CGD-1', batchRecordId: 'b', supplierRecordId: '' })).skipped, true);
  assert.equal((await service.writeForSupplier({ batchNo: 'CGD-1', batchRecordId: '', supplierRecordId: 'sup_1' })).skipped, true);
  assert.equal(gateway.calls.length, 0);
});
