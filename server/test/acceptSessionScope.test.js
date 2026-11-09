'use strict';

/**
 * ⭐ 2026-11-10（业务负责人）：工作台验收会话按「用户 + 批次 + 供应商」隔离。
 * 扫码页旧链路不传 sessionKey ⇒ 仍是「一人一份」原行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const BATCH = 'CGD-TEST-0001';
const ROWS = [
  { record_id: 'r_s1', product_record_id: 'p1', size: 40, quantity: 2, supplier_record_id: 's1', supplier_name: '供应商A' },
  { record_id: 'r_s2', product_record_id: 'p2', size: 40, quantity: 3, supplier_record_id: 's2', supplier_name: '供应商B' },
];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'accept-scope-'));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const makeService = (store) => createScanArrivalService({
  config: SCAN_WRITE.acceptance,
  purchaseQuery: { listPurchaseRequests: async () => ROWS },
  // start 不碰 conversation；这里给一个空实现即可（finish 不在本用例范围）
  arrivalConversation: {},
  store,
});

test('AC-ISO1 ⭐ 同一用户、同一批次、不同供应商 ⇒ 两份独立会话，互不覆盖', async () => {
  const store = new JsonTaskStore({ dir: tempDir(), idField: 'session_id' });
  const arrival = makeService(store);
  const openId = 'ou_same_user';

  const a = await arrival.start({ openId, batchNo: BATCH, supplierRecordId: 's1', sessionKey: `${BATCH}::s1` });
  const b = await arrival.start({ openId, batchNo: BATCH, supplierRecordId: 's2', sessionKey: `${BATCH}::s2` });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.session.session_id, b.session.session_id, '两份会话 id 不同 ✓');
  assert.notEqual(a.session.rows[0].product_record_id, b.session.rows[0].product_record_id, '各自只装自己的明细 ✓');

  const gotA = await arrival.get(openId, `${BATCH}::s1`);
  const gotB = await arrival.get(openId, `${BATCH}::s2`);
  assert.equal(gotA.session_id, a.session.session_id);
  assert.equal(gotB.session_id, b.session.session_id);
  assert.equal(gotA.supplier_record_id, 's1');
  assert.equal(gotB.supplier_record_id, 's2');
});

test('AC-ISO2 ⭐ 同一用户、同一批次+供应商 ⇒ 复用同一份会话（刷新不丢已填）', async () => {
  const store = new JsonTaskStore({ dir: tempDir(), idField: 'session_id' });
  const arrival = makeService(store);
  const openId = 'ou_same_user';
  const first = await arrival.start({ openId, batchNo: BATCH, supplierRecordId: 's1', sessionKey: `${BATCH}::s1` });
  const second = await arrival.start({ openId, batchNo: BATCH, supplierRecordId: 's1', sessionKey: `${BATCH}::s1` });
  assert.equal(second.reused, true);
  assert.equal(second.session.session_id, first.session.session_id);
});

test('AC-ISO3 ⭐ 扫码页旧链路（不传 sessionKey）仍是「一人一份」：同批复用、换批才换会话', async () => {
  const store = new JsonTaskStore({ dir: tempDir(), idField: 'session_id' });
  const arrival = makeService(store);
  const openId = 'ou_legacy_scan';
  const a = await arrival.start({ openId, batchNo: BATCH });
  const b = await arrival.start({ openId, batchNo: BATCH });
  assert.equal(b.reused, true, '同批复用（扫描到一半刷新不丢）✓');
  assert.equal(b.session.session_id, a.session.session_id);
  // 旧链路换批 ⇒ 还是同一个 sessionId（覆盖），与原行为一致
  const c = await arrival.start({ openId, batchNo: 'CGD-TEST-0002' });
  assert.equal(c.session.session_id, a.session.session_id, '旧链路一人一份（换批覆盖）✓');
});
