'use strict';

/**
 * 2026-11-20：采购批次不再有「到货状态」。
 * 新建批次写「发生行为 = 报货」；验收成功后改为「入库」并写到货日。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');


process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-arrival-status-'));
const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const BATCH_NO = 'CGD-20261007-0007';
const BATCH_RECORD_ID = 'bat_1';
const sizeLink = (size) => [`size_${size}`];

const mapFields = (tableKey, semanticValues) => {
  const schema = V1_BITABLE_SCHEMA.tables[tableKey];
  const out = {};
  Object.entries(semanticValues || {}).forEach(([key, value]) => {
    const fieldName = schema?.fields?.[key];
    if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
    if (value !== undefined) out[fieldName] = value;
  });
  return out;
};

const makeGateway = (records = {}) => {
  const writes = [];
  return {
    writes,
    table,
    get: async (tableKey, recordId) => (records[tableKey] || []).find((r) => r.record_id === recordId) || null,
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement') return [{ record_id: 'size_38', fields: { 尺码: 38 } }];
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ tableKey, op: 'create', fields });
      const record = { record_id: `new_${tableKey}_${(records[tableKey] || []).length + 1}`, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId: record.record_id, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      writes.push({ tableKey, op: 'update', recordId, fields: patch });
      const record = (records[tableKey] || []).find((r) => r.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    uploadAttachment: async () => 'file_token_1',
  };
};

test('⑦ 新建报货批次：只写报货行为，不写到货状态', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [], purchaseRequest: [] });
  const store = new JsonTaskStore({ dir: tempDir() });
  const service = new PurchaseWebhookService({
    gateway,
    store,
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: { 编号: '8088黑', 供应商: [{ record_ids: ['sup_1'] }] } } }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '金猴' } } }),
    },
    inventory: { applyPurchase: async () => ({}) },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'k' }) },
        message: { create: async () => ({ code: 0 }), reply: async () => ({ code: 0 }) },
      },
    },
    images: { render: async () => Buffer.from('png') },
  });
  const taskId = 'scan_replenish_arrival_status';
  const task = await store.create({
    task_id: taskId, kind: 'scan_replenish', status: 'posting',
    draft: {
      is_batch: true, operator_open_id: 'ou_1', supplier_record_id: 'sup_1',
      items: [{ product_record_id: 'prod_1', item_no: '8088', color: '黑色', size: 38, quantity: 2, behavior_record_id: 'beh_1' }],
    },
  });
  await service.publishPurchaseRequest(taskId, task);
  const batches = await gateway.listAll('purchaseOrderBatch');
  assert.equal(batches.length, 1);
  assert.equal('到货状态' in batches[0].fields, false, '不再写到货状态');
  assert.deepEqual(batches[0].fields['发生行为'], ['beh_1'], '仍是报货行为');
});

test('⑧ 验收成功：发生行为改入库 + 写点击验收时间；不再写到货状态', async () => {
  const records = { purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 发生行为: ['beh_report'] } }] };
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway });
  const result = await service.markArrived(BATCH_NO, {
    behaviorRecordId: 'beh_inbound', arrivalDate: '2026-11-20T07:00:00.000Z', correlation: {},
  });
  assert.equal(result.updated, true);
  const fields = (await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields;
  assert.deepEqual(fields['发生行为'], ['beh_inbound']);
  assert.equal(fields['到货日'], Date.parse('2026-11-20T07:00:00.000Z'), '飞书日期字段收毫秒时间戳');
  assert.equal('到货状态' in fields, false);
});

test('⑧ 找不到批次：只 warn 不抛', async () => {
  const gateway = makeGateway({ purchaseOrderBatch: [] });
  const service = new PurchaseOrderBatchService({ gateway });
  const result = await service.markArrived('CGD-20261007-9999', { behaviorRecordId: 'beh_inbound', arrivalDate: 'x' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'no_batch_record');
});

test('⑧ 到货日不是合法时间：不写半截，返回 invalid_arrival_date', async () => {
  const records = { purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 发生行为: ['beh_report'] } }] };
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway });
  const result = await service.markArrived(BATCH_NO, { behaviorRecordId: 'beh_inbound', arrivalDate: 'not-a-date' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'invalid_arrival_date');
  assert.deepEqual((await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields['发生行为'], ['beh_report']);
});

test('writeAcceptance：实际数量 / 货单金额 / 差异分析照写，不写到货状态', async () => {
  const records = { purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO } }] };
  const gateway = makeGateway(records);
  const service = new PurchaseOrderBatchService({ gateway });
  const result = await service.writeAcceptance({
    batchNo: BATCH_NO, batchRecordId: BATCH_RECORD_ID,
    actualQuantity: 3, actualAmount: 1680,
    differenceAnalysis: '应到 3 双 / 实到 3 双 / 多到 0 双', correlation: {},
  });
  assert.equal(result.updated, true);
  const fields = (await gateway.get('purchaseOrderBatch', BATCH_RECORD_ID)).fields;
  assert.equal(fields['实际数量'], 3);
  assert.equal(fields['货单金额'], 1680);
  assert.equal(fields['差异分析'], '应到 3 双 / 实到 3 双 / 多到 0 双');
  assert.equal('到货状态' in fields, false);
});

test('到货状态彻底退场：无映射 / 无方法', () => {
  const fields = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(fields.arrivalStatus, undefined);
  assert.equal(PurchaseOrderBatchService.prototype.setArrivalStatus, undefined);
  assert.equal(PurchaseOrderBatchService.prototype.markPending, undefined);
});
