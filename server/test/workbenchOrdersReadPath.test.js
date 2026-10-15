/**
 * ⭐⭐ 「订单列表」读路径的**调用次数契约**（2026-10-16，性能 bug 现场，**先写判据后改实现**）。
 *
 * ── 现场（生产 PM2 日志，业务负责人那次"数据加载慢"）─────────────────────────────
 *   `GET /sales/orders` 的 `http.request.completed.duration_ms` 最慢五条：
 *   **42317 / 32824 / 31045 / 27478 / 27462 ms**（27~42 秒）。
 *   同一份日志里**没有**这个接口的分段耗时事件（`grep` 过：本接口只有 `read_retry` /
 *   `order_skipped` 两条 warn，**没有任何 timing 事件**）⇒ 只能把"打了几次飞书"数出来。
 *
 * ── 我数出来的（改前）──────────────────────────────────────────────────────
 *   · **基础 6 次**（并行）：`salesEntry` / `salesDetail` / `paymentMethod` /
 *     `paymentRecord` / `product` / `sizeManagement` —— 这一半**没问题**（`Promise.all`）。
 *   · 🔴 **N+1（串行）**：**每一条"待补样品"明细**都会经
 *     `SalesFollowupService.buildOrdersList` → `samplePending.candidatesFor` →
 *     `InventoryService.sampleReplacementCandidates` **再整表读一次 `liveInventory`**；
 *     而这几读在 `Promise.all(orderDetails.map(async …))` 里**逐个 await**
 *     ⇒ **串行** N 次。
 *   · 量级：她 2026-10-12 那条通知里 `sample`（待补样品）**= 8** ⇒ 8 次串行整表读
 *     「实时库存」（一双一行、店里最大的一张表）⇒ **20~40 秒**，与线上 27~42 秒同量级。
 *
 * ── 本文件的判据（**改前真红 / 改后真绿**）──────────────────────────────────
 *   AC-P1 一次请求里 `liveInventory` **最多整表读一次**（无论有几条待补样品待办）。
 *   AC-P2 一次请求里**没有重复整表读**（任何一张表都不许被读两次）。
 *   AC-P3 每次读都**按需取字段**（`liveInventory` 只要 编号/尺码/所属状态 三列）。
 *   AC-P4 整表读总次数**不超过 N**（`READ_CALL_BUDGET`，把"不许再长回去"钉死）。
 *   AC-P5 **语义逐字一致**：改前后 `sample_pending_lines[].candidates` 逐字相同
 *         —— 同一批 `liveInventory` 记录算出来的结果必须一个字节都不差。
 *   AC-P6 快照读**失败**时如实退回逐条读（不静默丢待办、不假装成功）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { createWorkbenchOrdersCache } = require('../src/services/workbenchOrdersCache');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { ORDER_SUPPORT_FIELD_KEYS } = require('../src/config/workbenchOrders');

/** 两张单、四条明细、**四条都挂着"待补样品"待办**（= 4 次 N+1，改前就是 4 次串行整表读）。 */
const pendingFixture = () => ({
  salesEntry: [
    { record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-001' } },
    { record_id: 'order_2', fields: { 资金状态: '已写入', 销售单号: 'XSD-002' } },
  ],
  salesDetail: [
    { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 89 } },
    { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_39'], 履约状态: '已交付', 实收金额: 59 } },
    { record_id: 'detail_3', fields: { 销售单号: ['order_2'], 编号: ['product_2'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 79 } },
    { record_id: 'detail_4', fields: { 销售单号: ['order_2'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '未交付', 实收金额: 69 } },
  ],
  sizeManagement: [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 收款方式: ['method_1'] } }],
  paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
  product: [
    { record_id: 'product_1', fields: { 编号: 'P1', 颜色: '黑色' } },
    { record_id: 'product_2', fields: { 编号: 'P2', 颜色: '米白' } },
  ],
  // 「实时库存」：一双一条 —— 每款两个码各一进门盒（候选的判据用它，`candidatesFor` 只留门盒 > 0 的）
  liveInventory: [
    { record_id: 'live_1', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '门盒' } },
    { record_id: 'live_2', fields: { 编号: ['product_1'], 尺码: ['size_39'], 所属状态: '门盒' } },
    { record_id: 'live_3', fields: { 编号: ['product_2'], 尺码: ['size_38'], 所属状态: '门盒' } },
    { record_id: 'live_4', fields: { 编号: ['product_2'], 尺码: ['size_39'], 所属状态: '样品' } },
  ],
});

/** 假网关：记录每一次 `listAll`（表 + `fieldNames`），可按表注入失败。 */
const fakeGateway = (records, options = {}) => {
  const calls = [];
  const failFor = options.failFor || new Set();
  return {
    calls,
    async listAll(key, callOptions = {}) {
      calls.push({ key, fieldNames: callOptions.fieldNames });
      await new Promise((resolve) => setImmediate(resolve));
      if (failFor.has(key)) throw new Error(`"${key}" 读取失败（夹具故意）`);
      return records[key] || [];
    },
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
  };
};

const callCount = (calls, key) => calls.filter((call) => call.key === key).length;

/** 一次性把 service 装好：真 `InventoryService`（只要 gateway）+ 真 `SamplePendingService`（临时任务目录）。 */
const buildService = async (records, options = {}) => {
  const fake = fakeGateway(records, options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-perf-'));
  const store = new JsonTaskStore({ dir, idField: 'task_id' });
  for (const detailId of options.pendingDetailIds || []) {
    await store.create({
      task_id: `sample_${detailId}`,
      type: 'sample_replacement',
      status: 'pending',
      sales_detail_record_id: detailId,
      // 与夹具的货品对应：detail_1/2 → product_1；detail_3/4 → product_2
      product_record_id: Number(detailId.split('_')[1]) <= 2 ? 'product_1' : 'product_2',
    });
  }
  // ⚠️ **不注入 `samplePending`** —— 让 `SalesFollowupService` 按**生产同路**自己装配
  //    （`this.delivery.inventory` + `sampleTaskDir`）⇒ 这条判据钉住的正是线上那条路
  //    （样例：`routes/workbench.js:65` 就是 `new SalesFollowupService({ ordersCache, ordersConfig })`）。
  const service = new SalesFollowupService({
    gateway: fake,
    sampleTaskDir: dir,
    ordersCache: createWorkbenchOrdersCache({ ttlMs: 0 }),
    ordersConfig: { ordersCacheMs: 0 },
  });
  return { fake, service, store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const PENDING_ALL_FOUR = ['detail_1', 'detail_2', 'detail_3', 'detail_4'];

/**
 * 「一次请求最多打几次飞书」的**预算**（防回归的硬上限）：
 *   · 5 张业务表 + 1 张尺码表 + **至多 1 次**「实时库存」快照 = **7 次**
 *   · ⚠️ 待补样品有 4 条，**也要** ≤ 7（改前的实际数字是 **11** = 5 + 2×尺码 + 4×实时库存）
 */
const READ_CALL_BUDGET = 7;

// ═══════════════════════════════════════════════════════════════════════════
// AC-P1 / P2 / P4 「实时库存」只读一次 + 没有重复整表读 + 总次数上限
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P1 四条待补样品 ⇒「实时库存」仍然只整表读一次（改前是 4 次串行）', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: PENDING_ALL_FOUR });
  try {
    const result = await env.service.listOrders();
    assert.equal(result.orders.filter((order) => order.sample_pending).length, 2,
      '夹具前提：两张单都挂了待补样品待办');
    assert.equal(callCount(env.fake.calls, 'liveInventory'), 1,
      '「实时库存」一次请求只许整表读一次（N 条待办 ⇒ 改前 N 次串行读）');
  } finally {
    env.cleanup();
  }
});

test('AC-P2 没有任何一张表被整表读两次（调用序里不许出现重复表名）', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: PENDING_ALL_FOUR });
  try {
    await env.service.listOrders();
    const keys = env.fake.calls.map((call) => call.key);
    assert.deepEqual(keys, [...new Set(keys)],
      `每张表至多读一次；实际调用序：${keys.join(' → ')}`);
  } finally {
    env.cleanup();
  }
});

test('AC-P4 整表读总次数不超过预算（4 条待办也 ≤ 7 次；改前是 11 次）', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: PENDING_ALL_FOUR });
  try {
    await env.service.listOrders();
    assert.ok(env.fake.calls.length <= READ_CALL_BUDGET,
      `整表读次数 ${env.fake.calls.length} 超预算 ${READ_CALL_BUDGET}（按表：${JSON.stringify(
        env.fake.calls.reduce((acc, call) => ({ ...acc, [call.key]: (acc[call.key] || 0) + 1 }), {}))}）`);
  } finally {
    env.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P3 按需取字段（快照读也要带 fieldNames）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P3 「实时库存」快照按需取字段：只要 编号/尺码/所属状态 三列', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: PENDING_ALL_FOUR });
  try {
    await env.service.listOrders();
    const liveCalls = env.fake.calls.filter((call) => call.key === 'liveInventory');
    assert.equal(liveCalls.length, 1, '前提：只读一次');
    const expected = ORDER_SUPPORT_FIELD_KEYS.liveInventory
      .map((key) => V1_BITABLE_SCHEMA.tables.liveInventory.fields[key]).filter(Boolean);
    assert.deepEqual(liveCalls[0].fieldNames, expected,
      '「实时库存」只用 编号/尺码/所属状态（多一列都不许）');
    assert.ok(expected.length > 0, '这张清单必须解析得出飞书列名（不许退回整表读）');
  } finally {
    env.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P5 语义逐字一致：候选清单不允许漂
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P5 待补样品的候选清单逐字不变（同一批「实时库存」记录 ⇒ 同样的行/字段/顺序）', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: PENDING_ALL_FOUR });
  try {
    const result = await env.service.listOrders();
    const lines = result.orders.flatMap((order) => order.sample_pending_lines || []);
    assert.equal(lines.length, 4, '四条明细各一条待补样品行（N+1 的那 4 个点）');
    for (const line of lines) {
      // ⚠️ 调用方（`salesFollowupService`）**只留门盒 > 0 的码**（既有口径，一个字没动）⇒
      //    product_2 的 39 码在「实时库存」里是**样品**（门盒 0）⇒ 不出现在这里；
      //    product_1 两个码都是门盒 ⇒ 两个都在。
      const expected = line.product_record_id === 'product_2'
        ? [{ size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }]
        : [
          { size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
          { size: 39, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
        ];
      assert.deepEqual(line.candidates, expected,
        `候选清单必须逐字一致（product=${line.product_record_id}）`);
    }
    // 🔴 「逐字一致」的另一半：**同一个** `InventoryService` 判据换个入口算，结果必须相同
    //    （快照路 vs 逐条路 —— 这是本次改动唯一可能漂的地方）
    const service2 = new SalesFollowupService({
      gateway: env.fake, sampleTaskDir: env.dir,
      ordersCache: createWorkbenchOrdersCache({ ttlMs: 0 }), ordersConfig: { ordersCacheMs: 0 },
    });
    const again = await service2.listOrders();
    assert.deepEqual(again, result, '快照路与逐条路算出来的整份结果必须逐字相同');
    // 「卖掉的那一双是样品」⇒ 39 码不计入门盒候选（既有口径，一个字都没动）
    assert.equal(result.orders.every((order) => order.details.every((detail) => detail.size != null)), true,
      '明细的尺码仍照常解析出来');
  } finally {
    env.cleanup();
  }
});

test('AC-P5b 没有待办时 ⇒ 一次「实时库存」都不读（既有行为，不许为优化多读）', async () => {
  const env = await buildService(pendingFixture(), { pendingDetailIds: [] });
  try {
    const result = await env.service.listOrders();
    assert.equal(result.orders.some((order) => order.sample_pending), false, '没有待办');
    assert.equal(callCount(env.fake.calls, 'liveInventory'), 0,
      '没有待补样品 ⇒ 连快照都不读（零额外请求）');
    assert.ok(env.fake.calls.length <= READ_CALL_BUDGET, '总数仍在预算内');
  } finally {
    env.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P6 快照读失败 ⇒ 如实退回逐条读（不静默丢待办、不假装成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P6 快照读失败 ⇒ 退回逐条读（待办照旧看得见，候选照旧算得出来）', async () => {
  // 第一次读失败、后续成功：模拟"快照那一次恰好撞上瞬时错误"
  const records = pendingFixture();
  let liveAttempts = 0;
  const calls = [];
  const gateway = {
    calls,
    async listAll(key, options = {}) {
      calls.push({ key, fieldNames: options.fieldNames });
      await new Promise((resolve) => setImmediate(resolve));
      if (key === 'liveInventory') {
        liveAttempts += 1;
        if (liveAttempts === 1) throw new Error('1254607 Data not ready（夹具故意）');
      }
      return records[key] || [];
    },
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-perf-'));
  const store = new JsonTaskStore({ dir, idField: 'task_id' });
  for (const detailId of PENDING_ALL_FOUR) {
    await store.create({
      task_id: `sample_${detailId}`, type: 'sample_replacement', status: 'pending',
      sales_detail_record_id: detailId,
      product_record_id: Number(detailId.split('_')[1]) <= 2 ? 'product_1' : 'product_2',
    });
  }
  const service = new SalesFollowupService({
    gateway,
    sampleTaskDir: dir,
    ordersCache: createWorkbenchOrdersCache({ ttlMs: 0 }),
    ordersConfig: { ordersCacheMs: 0 },
  });
  try {
    const result = await service.listOrders();
    const lines = result.orders.flatMap((order) => order.sample_pending_lines || []);
    assert.equal(lines.length, 4, '快照失败不许把待办丢掉（退回逐条读 ⇒ 待办照旧）');
    // 按明细 id 取那一条（订单列表最后 `.reverse()` 过 ⇒ 不能假定顺序）
    const line1 = lines.find((line) => line.detail_record_id === 'detail_1');
    assert.ok(line1, 'detail_1 的待办照旧在（没被静默丢掉）');
    assert.deepEqual(line1.candidates, [
      { size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
      { size: 39, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
    ], '退回逐条读时候选清单同样逐字一致（detail_1 是 product_1）');
    // 快照那一次失败之后，逐条读各自成功 ⇒「实时库存」被读了 1（失败）+ 4（逐条）
    assert.equal(calls.filter((call) => call.key === 'liveInventory').length, 5,
      '如实退回逐条读：快照 1 次（失败）+ 每条待办自己读 1 次');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
