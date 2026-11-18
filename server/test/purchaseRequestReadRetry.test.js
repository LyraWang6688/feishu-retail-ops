'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PURCHASE_REQUEST_READ_RETRY } = require('../src/config/purchaseRequestReadRetry');
const { createPurchaseDetailIdAllocator, readPurchaseRequestsForBatch } = require('../src/services/purchaseDetailId');

test('PURCHASE-RETRY1 配置：最多 6 次，1s 起，封顶 15s', () => {
  assert.deepEqual(PURCHASE_REQUEST_READ_RETRY, {
    maxRetries: 5, baseDelayMs: 1000, factor: 2, maxDelayMs: 15000,
  });
});

test('PURCHASE-RETRY2 采购明细分配器自己读 purchaseRequest 时带 retry', async () => {
  let seen = null;
  const gateway = {
    table: () => ({ fields: { batchNo: '报货批次号', detailId: '采购明细ID' } }),
    listAll: async (table, options) => {
      seen = { table, options };
      return [];
    },
  };
  const allocator = createPurchaseDetailIdAllocator({ gateway });
  const cursor = await allocator.open({ batchRecordId: 'batch_1', batchNo: 'CGD-TEST-0001' });
  assert.equal(cursor.peek(), 1);
  assert.deepEqual(seen, { table: 'purchaseRequest', options: { retry: PURCHASE_REQUEST_READ_RETRY } });
});

test('PURCHASE-RETRY3 采购明细快照按批次精确读，失败才整表回退', async () => {
  const calls = [];
  const gateway = {
    table: () => ({ fields: { batchNo: '报货批次号' } }),
    listByFilter: async (table, filter, options) => {
      calls.push({ table, filter, options });
      return [{ record_id: 'detail_1' }];
    },
    listAll: async () => { throw new Error('should not fallback'); },
  };
  const rows = await readPurchaseRequestsForBatch({ gateway, batchRecordId: 'batch1' });
  assert.deepEqual(rows, [{ record_id: 'detail_1' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].filter, /CurrentValue\.\[报货批次号\]="batch1"/);
  assert.deepEqual(calls[0].options, { retry: PURCHASE_REQUEST_READ_RETRY });
});

test('PURCHASE-RETRY4 采购写库/查询/待办读 purchaseRequest 都挂统一 retry 或精确读', () => {
  const root = path.join(__dirname, '..', 'src', 'services');
  const webhook = fs.readFileSync(path.join(root, 'purchaseWebhookService.js'), 'utf8');
  assert.match(webhook, /readPurchaseRequestsForBatch/, '采购写库必须用按批次精确读');
  for (const file of ['purchasePendingBatchService.js', 'purchaseQueryService.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /PURCHASE_REQUEST_READ_RETRY/, `${file} 必须引用统一配置`);
    assert.match(source, /retry: PURCHASE_REQUEST_READ_RETRY/, `${file} 的 purchaseRequest 读必须带 retry`);
  }
});
