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
const { createPaymentMethodsService } = require('../src/services/paymentMethodsService');
const { resetConfigTableCache } = require('../src/services/configTableCache');
const { createWorkbenchOrdersCache } = require('../src/services/workbenchOrdersCache');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { ORDER_SUPPORT_FIELD_KEYS } = require('../src/config/workbenchOrders');

/** 两张单、四条明细、**四条都挂着"待补样品"待办**（= 4 次 N+1，改前就是 4 次串行整表读）。 */
const pendingFixture = () => ({
  salesEntry: [
    { record_id: 'order_1', fields: { 写入状态: '成功', 销售单号: 'XSD-001' } },
    { record_id: 'order_2', fields: { 写入状态: '成功', 销售单号: 'XSD-002' } },
  ],
  salesDetail: [
    { record_id: 'detail_1', fields: { 销售单号: [{ record_ids: ['order_1'] }], 编号: [{ record_ids: ['product_1'] }], 尺码: [{ record_ids: ['size_38'] }], 履约状态: '已交付', 实收金额: 89 } },
    { record_id: 'detail_2', fields: { 销售单号: [{ record_ids: ['order_1'] }], 编号: [{ record_ids: ['product_1'] }], 尺码: [{ record_ids: ['size_39'] }], 履约状态: '已交付', 实收金额: 59 } },
    { record_id: 'detail_3', fields: { 销售单号: [{ record_ids: ['order_2'] }], 编号: [{ record_ids: ['product_2'] }], 尺码: [{ record_ids: ['size_38'] }], 履约状态: '未交付', 实收金额: 79 } },
    { record_id: 'detail_4', fields: { 销售单号: [{ record_ids: ['order_2'] }], 编号: [{ record_ids: ['product_2'] }], 尺码: [{ record_ids: ['size_39'] }], 履约状态: '未交付', 实收金额: 69 } },
  ],
  sizeManagement: [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: [{ record_ids: ['order_1'] }], 交易金额: 50, 支付方式: [{ record_ids: ['method_1'] }] } }],
  paymentMethod: [{ record_id: 'method_1', fields: { 交易方式: '微信' } }],
  product: [
    { record_id: 'product_1', fields: { 编号: 'P1', 颜色: '黑色' } },
    { record_id: 'product_2', fields: { 编号: 'P2', 颜色: '米白' } },
  ],
  // 「实时库存」：一双一条 —— 每款两个码各一进门盒（候选的判据用它，`candidatesFor` 只留门盒 > 0 的）
  liveInventory: [
    { record_id: 'live_1', fields: { 编号: [{ record_ids: ['product_1'] }], 尺码: [{ record_ids: ['size_38'] }], 所属状态: '门盒' } },
    { record_id: 'live_2', fields: { 编号: [{ record_ids: ['product_1'] }], 尺码: [{ record_ids: ['size_39'] }], 所属状态: '门盒' } },
    { record_id: 'live_3', fields: { 编号: [{ record_ids: ['product_2'] }], 尺码: [{ record_ids: ['size_38'] }], 所属状态: '门盒' } },
    { record_id: 'live_4', fields: { 编号: [{ record_ids: ['product_2'] }], 尺码: [{ record_ids: ['size_39'] }], 所属状态: '样品' } },
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

;

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

;

// ═══════════════════════════════════════════════════════════════════════════
// AC-P5 语义逐字一致：候选清单不允许漂
// ═══════════════════════════════════════════════════════════════════════════

;

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

;

// ═══════════════════════════════════════════════════════════════════════════
// AC-P7 **共享配置缓存不许被"精简读"污染**（2026-11-08 真实事故）
//   · 订单列表曾按需只取「支付方式.名称」一列，却把结果塞进**整表共享缓存**；
//   · 售后「可用于退款」/ 交割单「券关联」读的是同一份快照 ⇒
//     refundable 被误判为 true（本该拦的退款方式放行）、voucherRecordId 变空。
//   判据：订单列表那次读必须**整表（不带 fieldNames）**；读完后共享缓存里的退款限制/券关联仍正确。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P7 订单列表整表读支付方式配置 ⇒ 售后 refundable / 券关联不被精简快照吞掉', async () => {
  resetConfigTableCache();
  const fixture = pendingFixture();
  fixture.paymentMethod = [
    { record_id: 'method_wechat', fields: { 交易方式: '微信', 可用于退款: true, 团购券管理: [{ record_ids: ['voucher_1'] }] } },
    { record_id: 'method_icbc', fields: { 交易方式: '工商银行', 可用于退款: false } },
  ];
  const env = await buildService(fixture);
  // 冒充真飞书 API：**传了 fieldNames 就只回那几列**（这正是缓存被污染的条件）
  const rawListAll = env.fake.listAll.bind(env.fake);
  env.fake.listAll = async (key, callOptions = {}) => {
    const rows = await rawListAll(key, callOptions);
    const names = callOptions.fieldNames;
    if (!Array.isArray(names) || !names.length) return rows;
    return rows.map((row) => ({
      ...row,
      fields: Object.fromEntries(names
        .filter((name) => Object.prototype.hasOwnProperty.call(row.fields || {}, name))
        .map((name) => [name, row.fields[name]])),
    }));
  };
  try {
    await env.service.listOrders();
    const pmCall = env.fake.calls.filter((call) => call.key === 'paymentMethod').pop();
    assert.equal(pmCall.fieldNames, undefined,
      '支付方式必须整表读（共享配置缓存；不许只取名称列）');

    const paymentMethods = createPaymentMethodsService(env.fake);
    const refundable = await paymentMethods.listRefundable();
    assert.deepEqual(refundable.items.map((item) => item.name), ['微信'],
      '「可用于退款」限制不能被精简快照吞掉（工商银行必须仍被排除）');
    const detailed = await paymentMethods.listWithVouchers();
    assert.equal(detailed.items.find((item) => item.name === '微信').voucherRecordId, 'voucher_1',
      '券关联不能被精简快照吞掉');
  } finally {
    env.cleanup();
    resetConfigTableCache();
  }
});
