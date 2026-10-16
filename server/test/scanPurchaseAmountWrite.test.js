'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ 「**退货整单金额落表**」（§5-③ 写入）的验收用例。
 *
 * 依据（业务负责人**逐字** + 裁决）：
 *   · 2026-10-14 晚：「**退货整单金额（必填），与补货同一套配置**」
 *     ＋「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
 *   · **2026-10-15 裁决 ⓐ**：列名 = **复用「发生金额」**
 *     ⇒ `purchaseOrderBatch.actualAmount`（`config/v1BitableSchema.js` 已有映射，**不改 schema**）
 *   · Lead 的 **ⓐ+ⓓ**：**退货这条现在写**；**补货那条先不写**（那一列会被"到货核对"写同一行同一列，
 *     只读核过 ⇒ 待她裁；TODO 留在 `routes/scanPage.js` 里写清了原因）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PAW1 **退货**：非空金额提交 ⇒ 那一行「发生金额」**逐字**等于她填的数（Number，写进真列名）。
 *  AC-PAW2 **空 / 非数字 ⇒ 400 + 人话 + 零写入**（在**页面这条路由**上拦；写入口一次都不进）。
 *  AC-PAW3 **幂等**：同一把 `submitKey`（串行两跑 + 并发两跑）⇒ **恰一个批次行**、金额值唯一、第二跑 `reused`。
 *  AC-PAW4 🔴 **落表失败 ⇒ 如实报失败（不许假成功）**：金额没写进去 ⇒ `ok:false` + 人话；
 *         此时**只有批次行**（明细 0 / 库存流水 0）；**同一把键重试**接着写 ⇒ 全落 + 金额在 ✓。
 *  AC-PAW5 **只写这一列**：那次 `update` 的 fields **只有**「发生金额」（不碰「实际数量」「到货状态」）。
 *  AC-PAW6 **补货那条不写**（源码哨兵）：`writeOrderAmount` 的调用方**只有** `purchaseReturnService`；
 *         `purchaseWebhookService`（补货/报货建行那条）里**没有**它 ✓。
 *
 * ⚠️ 用的是**真的** `PurchaseReturnService` / `PurchaseOrderBatchService` / `InventoryService` /
 *    真扫码会话与写服务；只有飞书那一层（网关 / 出图）是内存替身 —— 所以"表里那一列真变了"是跑出来的 ✓
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_paw_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'paw_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';
const AMOUNT = '399';

const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A', 单价: 399, 供应商: ['sup_1'],
  },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id, fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});
const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
  liveInventory: [liveUnit('live_41_box', 41), liveUnit('live_41_sample', 41, '样品'), liveUnit('live_41_store', 41, '仓库')],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    { record_id: 'bh_return', fields: { 行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
  ],
  supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } }],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）——与 `scanPurchaseReturn.test.js` 同一套。 */
const createFakeGateway = (tables = seedTables(), options = {}) => {
  const writes = [];
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((record) => String(record.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, record_id: record.record_id, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      if (options.failUpdateOnce && key === 'purchaseOrderBatch' && options.failUpdateOnce.armed) {
        options.failUpdateOnce.armed = false;
        throw new Error('模拟飞书 update 瞬时故障');
      }
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `paw-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套"真的在跑"的退货链路（真写服务 + 真会话 + 真库存引擎 + 真批次服务；只飞书那层是替身）。 */
const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables(), options.gatewayOptions || {});
  const dirs = [tempDir('session'), tempDir('inventory'), tempDir('return'), tempDir('replenish')];
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: dirs[0] });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: dirs[1], idField: 'operation_id' }),
  });
  const orderBatches = new PurchaseOrderBatchService({ gateway });
  const purchaseReturn = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    inventory,
    orderBatches,
    store: new JsonTaskStore({ dir: dirs[2], idField: 'task_id' }),
    webhooks: { deliverSupplierImages: async () => ({ sent: [], failed: [], thread_root_message_id: '' }) },
    batchNoGenerator: { runExclusive: async (work) => work(), next: async () => ({ batchNo: 'CGD-20261015-0001' }) },
  });
  const write = createScanWriteService({
    gateway,
    sessions,
    purchaseReturnService: purchaseReturn,
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: dirs[3], idField: 'task_id' }),
  });
  return {
    gateway,
    sessions,
    inventory,
    orderBatches,
    purchaseReturn,
    write,
    tables: gateway._tables,
    cleanup: () => dirs.forEach(rmDir),
  };
};

const entries = (...pairs) => pairs.map(([size, quantity]) => ({ size, quantity }));
const batchesOf = (h) => h.tables.purchaseOrderBatch || [];
const submitKeyOf = async (h, openId) => h.write.sessions
  .submitKeyFor(openId, await h.sessions.get(openId), 'purchase_return');
/** 那一次「写「发生金额」」的网关记录（**只看这一列**）。 */
const amountWritesOf = (h) => h.gateway.writes
  .filter((write) => write.op === 'update' && write.table === 'purchaseOrderBatch'
    && Object.prototype.hasOwnProperty.call(write.fields, '发生金额'));

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW1 非空 ⇒ 那一行「发生金额」逐字 = 她填的数
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW1 ⭐ 退货非空金额 ⇒ 批次行「发生金额」**逐字**等于她填的数（Number，写进真列名）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_paw_1';
    const result = await h.write.submitPurchaseReturn({
      openId, submitKey: await submitKeyOf(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]), orderAmount: AMOUNT,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const batches = batchesOf(h);
    assert.equal(batches.length, 1, '恰一个退货批次行');
    // 🔴 判据（逐字）：那一列就是她填的那个数
    assert.equal(batches[0].fields['发生金额'], Number(AMOUNT), '「发生金额」= 她填的数（Number）✓');
    // 老口径不许被碰：退货批次**仍然不写「到货状态」**（她 2026-10-07 的口径）
    assert.equal('到货状态' in batches[0].fields, false, '退货批次照旧不写「到货状态」✓');
    // 明细 / 库存照旧（这次改动一个字节都没动它们）
    assert.equal((h.tables.purchaseRequest || []).length, 1, '退货明细照写 ✓');
    assert.equal((h.tables.inventoryLedger || []).length, 1, '库存照扣 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW2 空 / 非数字 ⇒ 400 + 人话 + 零写入（页面那条路由）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW2 空 ⇒ 400 + 人话 + 零写入；**非数字**也拦（要落数字列 ⇒ 放过去就是假成功 ✗）', async () => {
  const express = require('express');
  const crypto = require('node:crypto');
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = 'paw-route-secret';
  const { createScanPageRouter } = require('../src/routes/scanPage');
  const cookieOf = (openId) => {
    const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 't', exp: Date.now() + 36e5 })).toString('base64url');
    return `workbench_session=${payload}.${crypto.createHmac('sha256', 'paw-route-secret').update(payload).digest('base64url')}`;
  };
  const write = createHarness();
  const calls = [];
  const spy = {
    sessions: { get: async () => null, submitKeyFor: () => 'k', setLastRealm: async () => {} },
    submitPurchaseReturn: async (args) => { calls.push(args); return { ok: true, reused: false, batch_no: 'B', request_count: 1 }; },
    submitReplenish: async (args) => { calls.push(args); return { ok: true, reused: false, batch_no: 'B', request_count: 1 }; },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ found: true, number: NUMBER, product_record_id: 'prod_1' }) },
    gateway: {},
    writeService: spy,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (value) => fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`, {
      method: 'POST',
      headers: { cookie: cookieOf('ou_paw_2'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: SCAN_WRITE.actions.purchaseReturn, submit_key: 'k', return_sizes: '41', return_qty_41: '1',
        [SCAN_WRITE.fields.purchaseAmount]: value,
      }).toString(),
    });
    // ① 空（字段不带）
    const empty = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`, {
      method: 'POST',
      headers: { cookie: cookieOf('ou_paw_2'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: SCAN_WRITE.actions.purchaseReturn, submit_key: 'k', return_sizes: '41', return_qty_41: '1',
      }).toString(),
    });
    assert.equal(empty.status, 400, '空金额 ⇒ 400（#561 的老判据一字未动 ✓）');
    assert.ok((await empty.text()).includes(SCAN_WRITE.texts.purchaseAmountMissingTitle), '人话来自配置 ✓');
    // ② 非数字（"¥399" / "abc"）⇒ 也 400 + **另一句**人话
    const invalid = await post('¥399');
    assert.equal(invalid.status, 400, '非数字 ⇒ 400（新增：要落数字列 ✓）');
    assert.ok((await invalid.text()).includes(SCAN_WRITE.texts.purchaseAmountInvalidTitle), '人话来自配置 ✓');
    assert.equal((await post('abc')).status, 400, '"abc" 也拦 ✓');
    // ③ **零写入**：写入口一次都没进（拦在任何写之前 ✓）
    assert.deepEqual(calls, [], '空 / 非数字 ⇒ 写入口一次都不许进（零写入 ✓）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    write.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW3 幂等：同一把 submitKey（串行 + 并发）只写一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW3 ⭐ 幂等：同一把 `submitKey`（串行两跑 + 并发两跑）⇒ 恰一个批次、金额不重复写坏', async () => {
  // ① 串行两跑
  const serial = createHarness();
  try {
    const openId = 'ou_paw_3a';
    const input = {
      openId, submitKey: await submitKeyOf(serial, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]), orderAmount: AMOUNT,
    };
    const first = await serial.write.submitPurchaseReturn(input);
    const second = await serial.write.submitPurchaseReturn(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.reused, true, '第二跑 = "这一单刚才已经交过了"（既有幂等路径 ✓）');
    assert.equal(batchesOf(serial).length, 1, '只建一个批次 ✓');
    assert.equal(batchesOf(serial)[0].fields['发生金额'], Number(AMOUNT), '金额仍是那个数 ✓');
    assert.equal(amountWritesOf(serial).length, 1, '「发生金额」**只写了一次**（重放不再写 ✓）');
    assert.equal((serial.tables.purchaseRequest || []).length, 1, '明细只一条 ✓');
    assert.equal((serial.tables.inventoryLedger || []).length, 1, '库存只扣一次 ✓');
  } finally { serial.cleanup(); }

  // ② 并发两跑
  const concurrent = createHarness();
  try {
    const openId = 'ou_paw_3b';
    const input = {
      openId, submitKey: await submitKeyOf(concurrent, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]), orderAmount: AMOUNT,
    };
    const [a, b] = await Promise.all([
      concurrent.write.submitPurchaseReturn(input),
      concurrent.write.submitPurchaseReturn(input),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal([a, b].filter((item) => item.reused === true).length, 1, '并发两跑里恰有一次是"还她上一次的结果"');
    assert.equal(batchesOf(concurrent).length, 1, '并发也只建一个批次 ✓');
    assert.equal(batchesOf(concurrent)[0].fields['发生金额'], Number(AMOUNT));
    assert.equal(amountWritesOf(concurrent).length, 1, '金额只写一次 ✓');
    assert.equal((concurrent.tables.inventoryLedger || []).length, 1, '库存只扣一次 ✓');
  } finally { concurrent.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW4 落表失败 ⇒ 如实报失败（不许假成功）＋ 同键重试接着写
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW4 🔴 金额没写进去 ⇒ 如实报失败（**不许假成功**）；同键重试接着写 ⇒ 金额在、明细在、库存扣', async () => {
  const failOnce = { armed: true };
  const h = createHarness({ gatewayOptions: { failUpdateOnce: failOnce } });
  try {
    const openId = 'ou_paw_4';
    const input = {
      openId, submitKey: await submitKeyOf(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]), orderAmount: AMOUNT,
    };
    const failed = await h.write.submitPurchaseReturn(input);
    // ① 如实失败（不是 200、不是"看起来成功"）
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.equal(failed.code, 'return_write_failed', '失败码 = 既有那条（页面按它走 500 + 人话 ✓）');
    assert.equal(failed.message, SCAN_WRITE.texts.purchaseReturnAmountWriteFailedBody,
      '人话来自配置（说清"没写进去 + 再点一次会接着这一批写"）✓');
    // ② 那一刻**只有批次行**（金额没落、明细/库存都没动 ⇒ 没有半截账）
    assert.equal(batchesOf(h).length, 1, '批次行建了（重试的落点 ✓）');
    assert.equal('发生金额' in batchesOf(h)[0].fields, false, '金额确实没写进去（如实）');
    assert.equal((h.tables.purchaseRequest || []).length, 0, '明细一条都没写 ✓');
    assert.equal((h.tables.inventoryLedger || []).length, 0, '库存一针都没动 ✓');

    // ③ 同一把键重试 ⇒ 接着这一批写（不建第二条批次、金额落上、明细/库存补齐）
    const retry = await h.write.submitPurchaseReturn(input);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(batchesOf(h).length, 1, '重试**不建第二个批次** ✓');
    assert.equal(batchesOf(h)[0].fields['发生金额'], Number(AMOUNT), '重试把金额写上了 ✓');
    assert.equal((h.tables.purchaseRequest || []).length, 1, '明细补齐 ✓');
    assert.equal((h.tables.inventoryLedger || []).length, 1, '库存扣一次 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW5 只写这一列（不碰「实际数量」「到货状态」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW5 ⭐ 那次写入**只碰「发生金额」一列**（不写「实际数量」/「到货状态」/时间列）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_paw_5';
    await h.write.submitPurchaseReturn({
      openId, submitKey: await submitKeyOf(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]), orderAmount: AMOUNT,
    });
    const amountWrites = amountWritesOf(h);
    assert.equal(amountWrites.length, 1);
    assert.deepEqual(Object.keys(amountWrites[0].fields), ['发生金额'],
      '那一次 update 的 fields **只有**「发生金额」（一个多写的列都不许有 ✓）');
    // 时间字段纪律（她 2026-10-06）：代码不写任何时间列
    for (const forbidden of ['创建时间', '更新时间', '到货日']) {
      assert.equal(forbidden in amountWrites[0].fields, false, `不许写时间列：${forbidden} ✗`);
    }
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAW6 补货那条**不写**（源码哨兵 + 服务层行为）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAW6 ⭐ 补货那条**不写**这一列：`writeOrderAmount` 的调用方只有退货那条路（一处 ✓）', () => {
  const callers = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/writeOrderAmount\s*\(/.test(source)) callers.push(path.relative(SERVER_SRC, full));
    }
  };
  walk(SERVER_SRC);
  // 定义处（batch service）＋ 唯一调用方（退货那条路）
  assert.deepEqual(callers.sort(), ['services/purchaseOrderBatchService.js', 'services/purchaseReturnService.js'],
    '`writeOrderAmount` 只能被**退货**那条路调（补货 / 报货 / 到货核对都不许调 ✓）');
  // 补货（报货）建行那条链路里**没有**它 —— 那一列会被到货核对写，两边都写就打架（待她裁 ✓）
  const webhook = fs.readFileSync(path.join(SERVER_SRC, 'services', 'purchaseWebhookService.js'), 'utf8');
  assert.equal(/writeOrderAmount/.test(webhook), false, '补货/报货那条链路里不许出现 writeOrderAmount ✗');
  // 到货核对那条**一个字没动**（它照旧只写它自己那两列）
  const batchService = fs.readFileSync(path.join(SERVER_SRC, 'services', 'purchaseOrderBatchService.js'), 'utf8');
  assert.match(batchService, /if \(quantityValue !== null\) values\.actualQuantity = quantityValue;/,
    '到货核对的写入点逐字未动 ✓');
  assert.match(batchService, /if \(amountValue !== null\) values\.actualAmount = amountValue;/,
    '到货核对照旧写「发生金额」（**没有**加"已有值不覆盖"——那条要她裁 ✗）');
});
