'use strict';

/**
 * 测试 Base 真写回归（**可跳过**）：扫码页「一单多货」→ 补货 → 采购主表/明细**真的写进去**。
 *
 * 背景（业务负责人 2026-10-29 授权解冻）：`multiItemWriters().purchase` 曾把扁平 payload 直接当 task 传给
 * `publishPurchaseRequest` ⇒ `task.draft` undefined ⇒ `is_batch` 崩溃 ⇒ 页面成功但零写入。
 * 本用例从**项目代码**走完整链路（不 mock 写入件）：
 *   `multiItemOrderService.submitDraft` → `scanWriteService.multiItemWriters().purchase`
 *   → `publishPurchaseRequest` → 飞书测试 Base。
 *
 * ⚠️ 只在**授权测试 Base**上跑（CI 没凭证 ⇒ 明确 skip，不算通过）：
 *   `FEISHU_TARGET_ENV=test node --test --test-concurrency=1 test/realbase/scanMultiItemReplenishWrite.test.js`
 * ⚠️ 会真写测试 Base（采购主表 + 采购明细），并按测试口径**不删除**（业务负责人：测试数据不用删 ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
for (const candidate of [path.join(repoRoot, '.env'), path.join(__dirname, '..', '..', '.env')]) {
  if (fs.existsSync(candidate)) { require('dotenv').config({ path: candidate, quiet: true }); break; }
}

const HAS_REAL_APP_CREDS = Boolean(process.env.LARK_AGENT_APP_ID && process.env.LARK_AGENT_APP_SECRET);
const SKIP = (() => {
  if (!process.env.FEISHU_V1_E2E_TEST_APP_TOKEN) return '缺 FEISHU_V1_E2E_TEST_APP_TOKEN（测试 Base）⇒ 明确跳过';
  if (!process.env.FEISHU_V1_BITABLE_APP_TOKEN) return '缺 FEISHU_V1_BITABLE_APP_TOKEN ⇒ 明确跳过';
  if (process.env.FEISHU_V1_BITABLE_APP_TOKEN !== process.env.FEISHU_V1_E2E_TEST_APP_TOKEN) {
    return '目标 Base ≠ 授权测试 Base ⇒ 拒绝跑（安全闸门）';
  }
  if (!HAS_REAL_APP_CREDS) return '缺真实应用凭证（CI 没有 .env）⇒ 明确跳过';
  return '';
})();

const silent = { logInfo: () => {}, logWarn: () => {}, logError: () => {} };
const textOf = (value) => (value == null ? '' : Array.isArray(value) ? value.map(textOf).filter(Boolean).join(',')
  : typeof value === 'object' ? String(value.text ?? value.name ?? value.value ?? value.link ?? '') : String(value));
const linkIds = (value) => (Array.isArray(value) ? value.flatMap((one) => one?.record_ids || []) : []);
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-multi-realbase-${tag}-`));

test('AC-SMF-RB 测试 Base 真写：一单多货补货 ⇒ 采购主表 +1 / 采购明细 +N / 同键重放不重复写', { skip: SKIP || false }, async () => {
  const { V1BitableGateway } = require('../../src/services/v1BitableGateway');
  const { V1_BITABLE_SCHEMA } = require('../../src/config/v1BitableSchema');
  const { createScanWriteService } = require('../../src/services/scanWriteService');
  const { SCAN_WRITE } = require('../../src/config/scanWrite');
  const { createScanSessionService } = require('../../src/services/scanSessionService');
  const { createMultiItemOrderService } = require('../../src/services/multiItemOrderService');
  const { resolveMultiItemOrderConfig } = require('../../src/config/multiItemOrder');
  const { JsonTaskStore } = require('../../src/infrastructure/jsonTaskStore');

  const gateway = new V1BitableGateway();
  const P = V1_BITABLE_SCHEMA.tables.product.fields;
  const D = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
  const B = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;

  // 从测试 Base「货品信息」取 ≥2 个货品（真实数据；不编造）
  const products = (await gateway.listAll('product'))
    .map((row) => ({
      recordId: row.record_id,
      itemNo: textOf(row.fields?.[P.itemNo]),
      number: textOf(row.fields?.[P.number]),
      color: textOf(row.fields?.[P.color]),
      supplierId: linkIds(row.fields?.[P.supplier])[0] || '',
    }))
    .filter((one) => one.recordId && one.itemNo)
    .slice(0, 2);
  assert.equal(products.length, 2, '测试 Base 至少要有 2 个货品才能验「一单多货」');

  const workDir = tmpDir('run');
  const taskStore = new JsonTaskStore({ dir: path.join(workDir, 'tasks'), idField: 'task_id' });
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: path.join(workDir, 'sessions') });
  const write = createScanWriteService({ gateway, config: SCAN_WRITE, sessions, purchaseStore: taskStore });
  const writers = write.multiItemWriters();
  const engine = createMultiItemOrderService({
    sessions, config: resolveMultiItemOrderConfig({}), writers, logger: silent,
  });

  try {
    const openId = 'ou_scan_multi_realbase';
    const opened = await engine.openDraft({ openId, chain: 'replenish' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const orderKey = opened.orderKey;
    for (const product of products) {
      const added = await engine.addItem({
        openId, chain: 'replenish', orderKey,
        item: {
          product_record_id: product.recordId, number: product.number, item_no: product.itemNo,
          color: product.color, supplier_record_id: product.supplierId,
        },
      });
      assert.equal(added.ok, true, JSON.stringify(added));
    }
    const sizeOf = (index) => String(process.env.FEISHU_V1_E2E_SIZE || (index === 0 ? '39' : '41'));
    await engine.setEntries({ openId, chain: 'replenish', orderKey, productRecordId: products[0].recordId, entries: [{ size: sizeOf(0), quantity: 1 }] });
    await engine.setEntries({ openId, chain: 'replenish', orderKey, productRecordId: products[1].recordId, entries: [{ size: sizeOf(1), quantity: 2 }] });

    const behavior = await writers.behavior('replenish');
    const first = await engine.submitDraft({ openId, chain: 'replenish', orderKey, submitKey: orderKey, behavior });
    assert.equal(first.ok, true, `提交失败：${JSON.stringify(first)}`);
    assert.equal(first.reused, false);

    // 同键重放 ⇒ 幂等（引擎直接 returned reused，不再写）
    const again = await engine.submitDraft({ openId, chain: 'replenish', orderKey, submitKey: orderKey, behavior });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);

    // 从**本地任务进度**回查批次记录（既有 publish 会把 batch_record_id 写回）
    const task = await taskStore.get(first.plan.taskId);
    const batchRecordId = task?.posting_progress?.batch_record_id || '';
    assert.ok(batchRecordId, '既有 publish 必须把批次记录 id 写回本地任务（否则又是假成功）');
    const batch = await gateway.get('purchaseOrderBatch', batchRecordId);
    assert.ok(batch, '采购主表必须真有这一行');
    const batchNo = textOf(batch.fields?.[B.batchNo]);
    assert.match(batchNo, /^CGD-\d{8}-\d{4}$/, `批次号要有效（实际：${batchNo}）`);

    // 采购明细：按批次号回查，行数 = plan 的明细数；数量/尺码/货品要对上
    const rows = await gateway.listByFilter('purchaseRequest', `CurrentValue.[${D.batchNo}]="${batchNo}"`);
    assert.equal(rows.length, first.summary.detail_count, `采购明细行数应 = ${first.summary.detail_count}（实际 ${rows.length}）`);
    const pairs = rows.map((row) => `${textOf(row.fields?.[D.size])}:${textOf(row.fields?.[D.quantity])}`).sort();
    assert.deepEqual(pairs, [`${sizeOf(0)}:1`, `${sizeOf(1)}:2`].sort(), '明细的尺码/数量必须与提交的一致');

    // 重放不重复写：再查一次，批次/明细数量都不变
    const rowsAgain = await gateway.listByFilter('purchaseRequest', `CurrentValue.[${D.batchNo}]="${batchNo}"`);
    assert.equal(rowsAgain.length, rows.length, '同 submitKey 重放不许重复写明细');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
