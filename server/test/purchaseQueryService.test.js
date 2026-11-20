const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeLinkFields } = require('./support/linkReadShape');

// 「尺码」是指向「尺码管理」的关联字段，读取时要能从关联记录解析回整数。
const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const makeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZE_RECORDS : (records[key] || []).map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }))),
});

test('listPurchaseRequests maps fields and filters by batchNo', async () => {
  // ⚠️ 2026-10-07：到货状态**从「报货批次」那一行读**（「具体信息」的同名列已被
  // 业务负责人从生产表删除，schema 映射与读取点同步删掉了）。所以这台假 Base 里，
  // 「到货状态」挂在**批次记录**上 —— 断言口径没变（行上显示的就是这一批的到货状态）。
  const gateway = makeGateway({
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: [{ record_ids: ['prod_1'] }], 尺码: sizeLink(36), 数量: 2, 报单时间: 1758844800000 } },
      { record_id: 'req_2', fields: { 报货批次号: ['batch_2'], 编号: [{ record_ids: ['prod_2'] }], 尺码: sizeLink(37), 数量: 1, 报单时间: 1758931200000 } },
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: [{ record_ids: ['sup_1'] }] } },
      { record_id: 'prod_2', fields: { 编号: '9099黑', 供应商: [{ record_ids: ['sup_2'] }] } },
    ],
    behavior: [
      { record_id: 'behavior_order', fields: { 行为名称: '报货', 行为编码: 'PURCHASE_ORDER' } },
      { record_id: 'behavior_in', fields: { 行为名称: '入库', 行为编码: 'PURCHASE_IN' } },
    ],
    purchaseOrderBatch: [
      { record_id: 'batch_1', fields: { 报货批次号: 'BH-001', 供应商: [{ record_ids: ['sup_1'] }], 发生行为: ['behavior_in'], 到货日: '2026-11-20T07:00:00.000Z' } },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 供应商: [{ record_ids: ['sup_2'] }], 发生行为: ['behavior_order'] } },
    ],
  });
  const service = createPurchaseQueryService(gateway);

  const all = await service.listPurchaseRequests();
  assert.equal(all.length, 2);
  assert.equal(all[0].batch_no, 'BH-002');
  assert.equal(all[0].product_number, '9099黑');
  assert.equal(all[0].size, 37);
  assert.equal(all[0].quantity, 1);
  assert.equal(all[0].behavior_code, 'PURCHASE_ORDER');
  assert.equal(all[0].behavior_name, '报货');
  assert.equal(all[0].supplier_record_id, 'sup_2');
  const filtered = await service.listPurchaseRequests({ batchNo: 'BH-001' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].batch_no, 'BH-001');

  assert.equal(all.find((row) => row.record_id === 'req_1').behavior_code, 'PURCHASE_IN');
});

test('AC-BATCH1 按批次读：走「供应主表.采购明细」link + getBatch，不整表读 purchaseRequest', async () => {
  const records = {
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: [{ record_ids: ['batch_1'] }], 编号: [{ record_ids: ['prod_1'] }], 尺码: sizeLink(36), 数量: 2 } },
    ],
    product: [{ record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: [{ record_ids: ['sup_1'] }] } }],
    purchaseOrderBatch: [{
      record_id: 'batch_1',
      fields: { 报货批次号: 'BH-001', 采购明细: [{ record_ids: ['req_1'] }], 发生行为: ['behavior_order'] },
    }],
  };
  const calls = { fullPurchaseReads: 0, batchGets: [] };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'purchaseRequest') { calls.fullPurchaseReads += 1; throw new Error('must not read full purchaseRequest'); }
      if (key === 'sizeManagement') return SIZE_RECORDS;
      return (records[key] || []).map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
    },
    getBatch: async (key, ids) => {
      calls.batchGets.push({ key, ids });
      return (records[key] || []).filter((row) => ids.includes(row.record_id))
        .map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
    },
  };
  const service = createPurchaseQueryService(gateway);
  const rows = await service.listPurchaseRequestsForBatch({ batchNo: 'BH-001' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, 'req_1');
  assert.equal(rows[0].size, 36);
  assert.equal(calls.fullPurchaseReads, 0, '不许整表读 purchaseRequest');
  assert.deepEqual(calls.batchGets, [{ key: 'purchaseRequest', ids: ['req_1'] }]);
});
