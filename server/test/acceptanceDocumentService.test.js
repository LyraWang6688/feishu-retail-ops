'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcceptanceDocumentService } = require('../src/services/acceptanceDocumentService');

const task = {
  batch_no: 'CGD-20261123-0001',
  accepted_at: '2026-11-23T10:00:00.000Z',
  supplier_record_id: 's1',
  plan: [{ product_record_id: 'p1', item_no: '888-1', color: '茶褐色', size: 38, quantity: 2, actual: 1 }],
};

const harness = ({ mapping = [{ message_id: 'om_root', chat_id: 'oc_chat' }], write = null, mention = false } = {}) => {
  const calls = [];
  const store = { get: async () => ({ acceptance_document: {} }), update: async (_id, patch) => { calls.push(['mark', patch]); } };
  const webhooks = {
    store,
    mentionOperatorText: (openId, text) => (mention && openId ? `<at>${openId}</at>${text}` : text),
    writeSupplierImageAttachment: async (input) => {
      calls.push(['write', input]);
      return write || { written: true, record_id: 'batch1', file_name: '信踏-验收单.png' };
    },
    sendImage: async (...args) => { calls.push(['image', ...args]); return { messageId: 'om_img' }; },
    sendText: async (...args) => { calls.push(['text', ...args]); return { messageId: 'om_text' }; },
  };
  const batchLocator = { findByBatchNo: async () => mapping };
  const sync = { syncBatch: async (input) => { calls.push(['sync', input]); return { ok: true }; } };
  const service = createAcceptanceDocumentService({
    purchaseWebhooks: webhooks,
    batchLocator,
    supplyDocumentSync: sync,
    render: async () => Buffer.from('png'),
  });
  return { service, calls };
};

test('验收单：先追加我方单据 → 发原话题 → 同步云盘', async () => {
  const h = harness();
  const result = await h.service.deliver({
    batchNo: task.batch_no, batchRecordId: 'batch1', taskId: 'task1', task, supplierName: '信踏',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.deepEqual(h.calls.map((call) => call[0]), ['write', 'image', 'mark', 'text', 'sync']);
  assert.equal(h.calls[0][1].fileNameSuffix, '验收单');
  assert.equal(h.calls[1][1], 'oc_chat');
  assert.equal(h.calls[1][4].inThread, true);
  assert.equal(h.calls[4][1].batchNo, task.batch_no);
});

test('验收单：完成文字 @ 具体操作人', async () => {
  const h = harness({ mention: true });
  const result = await h.service.deliver({
    batchNo: task.batch_no, batchRecordId: 'batch1', taskId: 'task1', task, supplierName: '信踏', operatorOpenId: 'ou_operator',
  });
  assert.equal(result.ok, true);
  const textCall = h.calls.find((call) => call[0] === 'text');
  assert.match(textCall[2], /^<at>ou_operator<\/at>/);
});

test('验收单：没有话题映射时只追加并同步，不发群', async () => {
  const h = harness({ mapping: [] });
  const result = await h.service.deliver({
    batchNo: task.batch_no, batchRecordId: 'batch1', taskId: 'task1', task, supplierName: '信踏',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.deepEqual(h.calls.map((call) => call[0]), ['write', 'sync']);
});

test('验收单：我方单据写失败仍发群聊提醒，并保留附件失败原因', async () => {
  const h = harness({ write: { written: false, reason: 'no_batch_record' } });
  const result = await h.service.deliver({
    batchNo: task.batch_no, batchRecordId: 'batch1', taskId: 'task1', task, supplierName: '信踏',
  });
  assert.equal(result.ok, true);
  assert.equal(result.attachmentWritten, false);
  assert.equal(result.attachmentError, 'no_batch_record');
  assert.deepEqual(h.calls.map((call) => call[0]), ['write', 'image', 'mark', 'text', 'sync']);
});

test('验收单：上传附件抛错仍发群聊提醒', async () => {
  const calls = [];
  const webhooks = {
    store: { get: async () => ({ acceptance_document: {} }), update: async () => null },
    writeSupplierImageAttachment: async () => { throw new Error('上传采购原始图片成功但未返回 file_token'); },
    sendImage: async () => { calls.push('image'); return { messageId: 'om_img' }; },
    sendText: async () => { calls.push('text'); return { messageId: 'om_text' }; },
  };
  const service = createAcceptanceDocumentService({
    purchaseWebhooks: webhooks,
    batchLocator: { findByBatchNo: async () => [{ message_id: 'om_root', chat_id: 'oc_chat' }] },
    supplyDocumentSync: { syncBatch: async () => ({ ok: true }) },
    render: async () => Buffer.from('png'),
  });
  const result = await service.deliver({
    batchNo: task.batch_no, batchRecordId: 'batch1', taskId: 'task1', task, supplierName: '信踏',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.match(result.attachmentError, /file_token/);
  assert.deepEqual(calls, ['image', 'text']);
});

