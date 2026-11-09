'use strict';

/**
 * ⭐ 2026-11-10（业务负责人方案）：「供应商」Lookup（名称） vs 「已到货供应商」（记录 id）
 * 的集合比较 —— 验收完一家就把该 supplier_record_id 追加进关联字段；两集合相等 =
 * 这一批所有供应商都验完（调用方再写「已到货」）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const table = (key) => V1_BITABLE_SCHEMA.tables[key];

const makeGateway = (records) => {
  const writes = [];
  return {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((r) => r.record_id === recordId) || null,
    listAll: async (tableKey) => records[tableKey] || [],
    update: async (tableKey, recordId, semanticValues) => {
      const schema = table(tableKey);
      const record = (records[tableKey] || []).find((r) => r.record_id === recordId);
      const fields = {};
      for (const [key, value] of Object.entries(semanticValues || {})) {
        const field = schema.fields[key];
        fields[field] = value;
        // 真实飞书读回形状（已确认）：[{ record_ids: [...] }]；写入仍是字符串数组。
        if (record) {
          record.fields[field] = field === schema.fields.arrivedSuppliers
            ? [{ record_ids: value }]
            : value;
        }
      }
      writes.push({ tableKey, recordId, fields });
      return { record: { record_id: recordId, fields } };
    },
  };
};

const recordsOf = () => ({
  purchaseOrderBatch: [{
    record_id: 'batch_1',
    fields: {
      报货批次号: 'CGD-TEST-0001',
      // Lookup 生产实测形状：名称 + 逗号分隔元素，没有 record_ids
      供应商: [{ text: '一代千金', type: 'text' }, { text: ',', type: 'text' }, { text: '信踏', type: 'text' }],
      已到货供应商: [],
    },
  }],
  supplier: [
    { record_id: 'sup_a', fields: { 供应商名称: '一代千金' } },
    { record_id: 'sup_b', fields: { 供应商名称: '信踏' } },
  ],
});

test('AC-AS1 ⭐ Lookup 名称 → record_id 集合；追加已到货供应商；两家齐全才 all_arrived', async () => {
  const records = recordsOf();
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway });

  const before = await service.readSupplierArrivalState({ batchNo: 'CGD-TEST-0001' });
  assert.equal(before.ok, true);
  assert.deepEqual(before.lookup_names, ['一代千金', '信踏'], 'Lookup 名称归一化（去掉逗号分隔元素）✓');
  assert.deepEqual(before.expected_ids, ['sup_a', 'sup_b'], '名称映射成 supplier record_id ✓');
  assert.deepEqual(before.arrived_ids, []);
  assert.equal(before.all_arrived, false);

  const first = await service.addArrivedSupplier({ batchNo: 'CGD-TEST-0001', supplierRecordId: 'sup_a' });
  assert.equal(first.updated, true);
  assert.equal(first.all_arrived, false, '只验完一代千金 ⇒ 还未全到货 ✓');
  assert.deepEqual(first.arrived_ids, ['sup_a']);
  assert.deepEqual(gateway.writes[0].fields['已到货供应商'], ['sup_a'], '写入关联字段 = record_id 字符串数组 ✓');

  const second = await service.addArrivedSupplier({ batchNo: 'CGD-TEST-0001', supplierRecordId: 'sup_b' });
  assert.equal(second.all_arrived, true, '两家都验完 ⇒ all_arrived ✓');
  assert.deepEqual(second.arrived_ids, ['sup_a', 'sup_b']);
  assert.deepEqual(gateway.writes[1].fields['已到货供应商'], ['sup_a', 'sup_b']);
});

test('AC-AS2 ⭐ Lookup 名称在供应商管理里找不到 ⇒ 不猜、不标已到货（missing_names 交给调用方告警）', async () => {
  const records = recordsOf();
  records.purchaseOrderBatch[0].fields['供应商'] = [
    { text: '一代千金', type: 'text' }, { text: ',', type: 'text' }, { text: '新供应商（未建档）', type: 'text' },
  ];
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway });
  const state = await service.readSupplierArrivalState({ batchNo: 'CGD-TEST-0001' });
  assert.deepEqual(state.missing_names, ['新供应商（未建档）'], '认不出的名称如实列出 ✓');
  assert.deepEqual(state.expected_ids, ['sup_a'], '只映射认得出的 ✓');
  const result = await service.addArrivedSupplier({ batchNo: 'CGD-TEST-0001', supplierRecordId: 'sup_a' });
  assert.equal(result.all_arrived, false, '有名称认不出 ⇒ 不标已到货（不猜）✓');
  assert.deepEqual(result.missing_names, ['新供应商（未建档）']);
});
