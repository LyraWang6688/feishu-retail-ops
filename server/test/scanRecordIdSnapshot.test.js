'use strict';

/**
 * ⭐⭐ 2026-10-14 真机 bug（她「还是慢」的真根，比 400 更根本）：
 *   她**二维码就是** `/r/{recordId}` 那条路 ⇒ 而那条路**压根不看货品快照** ✗
 *   ⇒ 部署后 `product_snapshot_hit: false`（total_ms 1559 / 3615，`feishu_reads: 1`）
 *   ⇒ 而且 `scan.snapshot.miss` **一条新的都没有**（因为那条路本来就不查快照 ✗）
 *
 *   现状（本文件先写先红）：`lookup()` 的 `recordId` 分支直接
 *   `readProductByRecordId()` ⇒ `gateway.get('product', recordId)` = **一次真飞书读** ✗
 *
 *   AC-RS1 ⭐ 按记录 ID 取货品 ⇒ **命中快照时不真读**（`get('product', …)` 0 次）+ `product_snapshot_hit: true`
 *   AC-RS2 ⭐ 预热后**连续两次**按记录 ID 查 ⇒ 两次都吃快照（都不真读）
 *   AC-RS3 ⭐ 快照**未就绪 / 没有这一条** ⇒ **照旧真读**（行为与今天逐字相同，不许猜 ✗）
 *   AC-RS4 快照命中时，视图与"真读那条记录"**同源**（编号/颜色一致 ⇒ 不是另一条记录）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_rs';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'rs_secret';

const { createScanPageService } = require('../src/services/scanPageService');

const RECORD_ID = 'rec_prod_1';
const NUMBER = 'JX505|咖色|B';

/** 一条「货品信息」记录（字段名走 schema 的物理列名）。 */
const productRecord = () => ({
  record_id: RECORD_ID,
  fields: {
    编号: NUMBER,
    颜色: '咖色',
    类别: 'B',
    货号: 'JX505',
    售价: 399,
  },
});

/** 假网关：**只记** `get('product', …)` 与 `listAll` 的调用次数（读路径的全部证据）。 */
const fakeGateway = ({ product = productRecord() } = {}) => {
  const calls = { getProduct: 0, listAll: [] };
  return {
    calls,
    table: (key) => ({ tableName: key, tableId: `tbl_${key}`, fields: {} }),
    listAll: async (key) => { calls.listAll.push(key); return []; },
    listFields: async () => [],
    get: async (key, id) => {
      if (key === 'product') { calls.getProduct += 1; return id === RECORD_ID ? product : null; }
      return null;
    },
  };
};

/** 注入一个"已就绪"的货品快照（`get()` 返回原始记录数组 ⇒ 含 record_id ✓）。 */
const readySnapshot = (records) => ({ get: () => ({ ready: true, reason: '', records, ageMs: 0 }) });
const coldSnapshot = (reason = 'not_ready') => ({ get: () => ({ ready: false, reason, records: null, ageMs: null }) });

const serviceFor = (gateway, { snapshot } = {}) => createScanPageService(gateway, {
  now: () => 1_700_000_000_000,
  snapshot: false,                 // 库存快照不用（本用例只管货品那条）
  productSnapshot: snapshot === undefined ? false : snapshot,
  startSnapshot: false,
});

test('AC-RS1 ⭐ 按记录 ID 取货品 ⇒ **命中快照时一次真读都不发生**', async () => {
  const gateway = fakeGateway();
  const service = serviceFor(gateway, { snapshot: readySnapshot([productRecord()]) });
  const timing = {};
  const view = await service.lookup({ recordId: RECORD_ID, requestId: 'r1', timing });
  assert.equal(view.found, true, `要能取到这一款：${JSON.stringify(view).slice(0, 200)}`);
  assert.equal(gateway.calls.getProduct, 0,
    `命中快照就**不许**再读「货品信息」（实际 ${gateway.calls.getProduct} 次 ✗）`);
  assert.equal(timing.product_snapshot_hit, true, 'timing 要如实标"吃了快照" ✓');
});

test('AC-RS2 ⭐ 预热后**连续两次**按记录 ID 查 ⇒ 两次都吃快照', async () => {
  const gateway = fakeGateway();
  const service = serviceFor(gateway, { snapshot: readySnapshot([productRecord()]) });
  const first = {};
  const second = {};
  await service.lookup({ recordId: RECORD_ID, requestId: 'r1', timing: first });
  await service.lookup({ recordId: RECORD_ID, requestId: 'r2', timing: second });
  assert.equal(first.product_snapshot_hit, true, '第一次要 hit ✓');
  assert.equal(second.product_snapshot_hit, true, '第二次也要 hit ✓（真机症状是它永远 false ✗）');
  assert.equal(gateway.calls.getProduct, 0, '两次都不该真读 ✓');
});

test('AC-RS3 ⭐ 快照未就绪 / 没这一条 ⇒ **照旧真读**（不许猜 ✗）', async () => {
  // ① 快照未就绪
  const cold = fakeGateway();
  const coldService = serviceFor(cold, { snapshot: coldSnapshot() });
  const coldTiming = {};
  const coldView = await coldService.lookup({ recordId: RECORD_ID, requestId: 'r3', timing: coldTiming });
  assert.equal(coldView.found, true, '未就绪时照旧真读、照旧取得到 ✓');
  assert.equal(cold.calls.getProduct, 1, `未就绪 ⇒ 真读 1 次（实际 ${cold.calls.getProduct}）`);
  assert.notEqual(coldTiming.product_snapshot_hit, true, '没吃快照就不许标 hit ✓');

  // ② 快照就绪、但里面没有这一条 ⇒ 也要真读
  const miss = fakeGateway();
  const missService = serviceFor(miss, { snapshot: readySnapshot([{ record_id: 'rec_other', fields: {} }]) });
  const missTiming = {};
  await missService.lookup({ recordId: RECORD_ID, requestId: 'r4', timing: missTiming });
  assert.equal(miss.calls.getProduct, 1, '快照里没这条 ⇒ 真读 1 次（不猜 ✗）');
  assert.notEqual(missTiming.product_snapshot_hit, true);
});

test('AC-RS4 快照命中 ⇒ 视图与"真读那条"同源（编号/颜色逐字一致）', async () => {
  const number = NUMBER;
  const viaSnapshot = fakeGateway();
  const snapshotView = await serviceFor(viaSnapshot, { snapshot: readySnapshot([productRecord()]) })
    .lookup({ recordId: RECORD_ID, requestId: 'r5', timing: {} });
  const viaRead = fakeGateway();
  const readView = await serviceFor(viaRead, { snapshot: false })
    .lookup({ recordId: RECORD_ID, requestId: 'r6', timing: {} });
  assert.equal(viaRead.calls.getProduct, 1, '对照组：没有快照时确实真读 ✓');
  for (const key of ['found', 'number', 'color', 'category_code']) {
    assert.deepEqual(snapshotView[key], readView[key], `快照命中与真读的「${key}」要逐字一致`);
  }
  assert.equal(snapshotView.number, number, '编号就是那条记录的编号 ✓');
});
