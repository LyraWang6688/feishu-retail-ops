'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcurementModifyDelivery } = require('../src/services/procurementModifyDelivery');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PROCUREMENT_PAGE } = require('../src/config/procurementPage');
const { documentFileNameOf } = require('../src/services/supplierSplitService');

test('修改交付：删掉旧我方单据、复用原话题根、发送更新文案', async () => {
  const fileName = documentFileNameOf('供应商A', PROCUREMENT_PAGE.modify.documentFileNameSuffix);
  const calls = { updates: [], deliveries: [] };
  const gateway = { update: async (table, id, values) => calls.updates.push({ table, id, values }) };
  const delivery = createProcurementModifyDelivery({
    gateway,
    schema: V1_BITABLE_SCHEMA,
    config: PROCUREMENT_PAGE,
    purchaseWebhooks: {
      deliverSupplierImages: async (taskId, task, posting, options) => {
        calls.deliveries.push({ taskId, task, posting, options });
        return { sent: ['供应商A'], failed: [] };
      },
    },
    orderBatches: {
      findByBatchNo: async () => ({
        record_id: 'b1',
        fields: { 我方单据: [{ file_token: 'old', name: fileName }, { file_token: 'other', name: 'other.png' }] },
      }),
    },
    batchLocator: { findByBatchNo: async () => [{ message_id: 'msg-root' }] },
    now: () => 1,
  });
  const result = await delivery.deliver({
    batchNo: 'CGD-1', batchRecordId: 'b1', openId: 'ou_a',
    items: [{ product_record_id: 'p1', supplier_record_id: 's1', supplier_name: '供应商A', size: 40, quantity: 2, item_no: 'A1', color: '黑' }],
    totalQuantity: 2,
  });
  assert.equal(result.sent[0], '供应商A');
  assert.deepEqual(calls.updates[0], { table: 'purchaseOrderBatch', id: 'b1', values: { document: [{ file_token: 'other' }] } });
  assert.equal(calls.deliveries[0].options.threadRootMessageId, 'msg-root');
  assert.equal(calls.deliveries[0].options.noticeText, '采购单已更新');
  assert.equal(calls.deliveries[0].task.draft.items[0].quantity, 2);
});
