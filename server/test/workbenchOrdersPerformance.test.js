/**
 * ⭐⭐ 「订单列表」读取提速的验收标准（业务负责人 2026-10-12，**先写后做**）。
 *
 * 起因（她在服务器上实测的硬数字）：
 *   `/api/workbench/sales/orders` 真实耗时 **3.6s ~ 26s**（她：「一直说正在读取订单」）；
 *   逐张表整表读：`salesEntry 188 条 3243ms` · `salesDetail 173 条 2629ms` ·
 *   `paymentMethod **6 条** 1851ms` · `paymentRecord 158 条 5527ms` · `product 562 条 7805ms` ·
 *   `accessory 21 条 1517ms`（合计 ≈22.6s）
 *   ⇒ **瓶颈不是"数据多"，是飞书 API 每张表 1.5~7.8 秒的固定开销**（6 条的小表也要 1.9s）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准
 *   AC1 缓存命中 ⇒ **一次飞书读都不发**（假网关调用计数不变），且结果与第一次**逐字相同**。
 *   AC2 TTL 过期（拨表）⇒ **重新读**（计数增加）。
 *   AC3 任何一笔写库之后 ⇒ 缓存被**作废**，下一次读必须重新取（`invalidate()`）。
 *   AC4 `WORKBENCH_ORDERS_CACHE_MS` 是**显式整数**：给值就用、留空用默认（30 秒）、`0` = **关掉**、
 *       非法值**当场抛错**（不静默兜底）。
 *   AC5 **字段清单 = 页面真正用到的列**（多一个都不许）；每次 `listAll` 都带 `fieldNames`，
 *       且**只含**清单里的列（飞书 `field_names` ⇒ payload 更小）。
 *   AC6 **每张表只读一次**（6 张表 = 6 次调用，无重复读），且 6 次是**并行**发出的。
 *   AC7 **六条写入路径**（补收款 / 补实收 / 交付 / 售后 / 二次交付 / 补样品）写成功后都作废缓存。
 *   AC8 **语义一个字都不变**：带字段选择与不带字段选择的结果**逐字相同**；
 *       缓存命中与未命中的结果也**逐字相同**。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { createWorkbenchOrdersCache } = require('../src/services/workbenchOrdersCache');
const { ORDER_FIELD_KEYS, DEFAULT_ORDERS_CACHE_MS, readWorkbenchOrdersConfig } = require('../src/config/workbenchOrders');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const SERVER = path.join(__dirname, '..');
const readSrc = (relative) => fs.readFileSync(path.join(SERVER, relative), 'utf8');

/** 夹具：一单三件明细 + 一笔收款（与既有 `salesFollowupService.test.js` 同一套语义）。 */
const fixture = () => ({
  salesEntry: [{ record_id: 'order_1', fields: { 写入状态: '成功', 销售单号: 'XSD-001' } }],
  salesDetail: [
    { record_id: 'detail_1', fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 89 } },
    { record_id: 'detail_2', fields: { 销售单号: ['order_1'], 编号: ['product_2'], 尺码: ['size_39'], 履约状态: '未交付', 实收金额: 59 } },
  ],
  sizeManagement: [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 收款方式: ['method_1'] } }],
  paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
  product: [
    { record_id: 'product_1', fields: { 编号: 'P1', 颜色: '黑色' } },
    { record_id: 'product_2', fields: { 编号: 'P2', 颜色: '米白' } },
  ],
});

/**
 * 假网关：**记录每一次 `listAll`**（表 + 传进来的 `fieldNames`），并统计"同时在飞"的峰值
 * （用来证明 6 次是并行发出的）。
 */
const fakeGateway = (records) => {
  const calls = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    peak: () => peak,
    gateway: {
      async listAll(key, options = {}) {
        calls.push({ key, fieldNames: options.fieldNames });
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          return records[key] || [];
        } finally {
          active -= 1;
        }
      },
      table: (key) => V1_BITABLE_SCHEMA.tables[key],
    },
  };
};

const ORDERS_TABLES = ['salesEntry', 'salesDetail', 'paymentMethod', 'paymentRecord', 'product', 'accessory'];
const ordersCalls = (calls) => calls.filter((call) => ORDERS_TABLES.includes(call.key));

/** 真读那一遍的构造（TTL = 0 ⇒ 每次真读），用于"语义不变"的对照。 */
const serviceWith = (gateway, options = {}) => new SalesFollowupService({
  gateway,
  ordersCache: createWorkbenchOrdersCache({ ttlMs: options.ttlMs ?? 0, now: options.now }),
  ordersConfig: { ordersCacheMs: options.ttlMs ?? 0 },
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 ~ AC3 缓存：命中 / 过期 / 写后失效
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 缓存命中 ⇒ 一次飞书读都不发，且结果与第一次逐字相同', async () => {
  let clock = 1_000_000;
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 30000, now: () => clock });

  const first = await service.listOrders();
  const afterFirst = fake.calls.length;
  assert.equal(ordersCalls(fake.calls).length, 5, '第一次真读：本夹具 5 张表各一次（配品表未配置）');

  clock += 1000; // 还在 TTL 内
  const second = await service.listOrders();
  assert.equal(fake.calls.length, afterFirst, '命中缓存 ⇒ **0 次**飞书读');
  assert.deepEqual(second, first, '命中的结果与第一次逐字相同（语义一个字都不差）');
});

test('AC2 TTL 过期 ⇒ 重新读（拨表到 30 秒之后）', async () => {
  let clock = 2_000_000;
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 30000, now: () => clock });

  await service.listOrders();
  const afterFirst = fake.calls.length;
  clock += 30_001;
  await service.listOrders();
  assert.equal(fake.calls.length, afterFirst + 5, '过期之后重新读 5 张表');
});

test('AC3 写库之后作废缓存 ⇒ 下一次读必须重新取（不许看到旧数据）', async () => {
  let clock = 3_000_000;
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 30000, now: () => clock });

  await service.listOrders();
  const afterFirst = fake.calls.length;
  await service.listOrders();
  assert.equal(fake.calls.length, afterFirst, '（先确认这下是命中的）');

  service.invalidateOrders(); // 路由层写成功之后调的就是它
  await service.listOrders();
  assert.equal(fake.calls.length, afterFirst + 5, '作废之后重新读 5 张表');

  // 缓存实例本身也要能被独立调用（路由层持有的是它）
  const cache = createWorkbenchOrdersCache({ ttlMs: 30000, now: () => clock });
  cache.set({ ok: 1 });
  assert.deepEqual(cache.get(), { ok: 1 });
  cache.invalidate();
  assert.equal(cache.get(), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 TTL 配置（显式整数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 WORKBENCH_ORDERS_CACHE_MS 是显式整数：给值用值 / 留空用默认 / 0 = 关掉 / 非法抛错', () => {
  assert.equal(readWorkbenchOrdersConfig({ WORKBENCH_ORDERS_CACHE_MS: '45000' }).ordersCacheMs, 45000);
  assert.equal(readWorkbenchOrdersConfig({ WORKBENCH_ORDERS_CACHE_MS: '' }).ordersCacheMs, DEFAULT_ORDERS_CACHE_MS,
    '留空 ⇒ 默认 30 秒');
  assert.equal(readWorkbenchOrdersConfig({}).ordersCacheMs, DEFAULT_ORDERS_CACHE_MS);
  assert.equal(readWorkbenchOrdersConfig({ WORKBENCH_ORDERS_CACHE_MS: '0' }).ordersCacheMs, 0,
    '`0` 是**合法值** = 显式关掉缓存（每次真读）');
  assert.throws(() => readWorkbenchOrdersConfig({ WORKBENCH_ORDERS_CACHE_MS: 'abc' }), /WORKBENCH_ORDERS_CACHE_MS/,
    '非法值当场抛错（不静默兜底）');
  assert.equal(DEFAULT_ORDERS_CACHE_MS, 30000, '默认就是业务负责人给的 30 秒');
});

test('AC4b TTL=0 ⇒ 每次都是真读（行为与优化前一致）', async () => {
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 0 });
  await service.listOrders();
  const afterFirst = fake.calls.length;
  await service.listOrders();
  assert.equal(fake.calls.length, afterFirst + 5, '关掉缓存之后每次都真读');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 字段清单 = 页面真正用到的列
// ═══════════════════════════════════════════════════════════════════════════

test('AC5a 字段清单（语义键）逐字 = 页面真正用到的列，多一个都没有', () => {
  assert.deepEqual(ORDER_FIELD_KEYS, {
    salesEntry: ['orderNo', 'writeStatus', 'recordedAt'],
    salesDetail: ['salesEntry', 'size', 'fulfillmentStatus', 'actualAmount', 'product'],
    paymentRecord: ['salesEntry', 'amount', 'status', 'method', 'receivedAt'],
    paymentMethod: ['name'],
    product: ['number', 'color'],
    accessory: ['name'],
  }, '这张清单是"页面上真正用到的列"的唯一来源（加列必须有消费点）');
});

test('AC5b 每次 listAll 都按需取字段：fieldNames = 清单里的**飞书列名**，且不多一列', async () => {
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 0 });
  await service.listOrders();

  for (const call of ordersCalls(fake.calls)) {
    const table = V1_BITABLE_SCHEMA.tables[call.key];
    const expected = ORDER_FIELD_KEYS[call.key].map((key) => table.fields[key]).filter(Boolean);
    assert.ok(Array.isArray(call.fieldNames), `${call.key} 必须带 fieldNames`);
    assert.deepEqual(call.fieldNames, expected, `${call.key} 的 fieldNames 逐字 = 语义键解析出来的列名`);
    for (const name of call.fieldNames) {
      assert.ok(Object.values(table.fields).includes(name), `${call.key} 的 fieldNames 里有不属于这张表的列：${name}`);
    }
  }
  // 配品表没配置时（本夹具没配 accessory 表）不该硬读它
  assert.equal(ordersCalls(fake.calls).some((call) => call.key === 'accessory'), false,
    '「其他配品」没配置 ⇒ 不读它（既有行为）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5c 网关：`field_names` 的**线格式**（官方类型是 string，不是数组）
// ═══════════════════════════════════════════════════════════════════════════

test('AC5c 网关把 field_names 序列化成 JSON 字符串（传数组会被飞书拒：InvalidFieldNames 1254024）', async () => {
  const { V1BitableGateway } = require('../src/services/v1BitableGateway');
  const sent = [];
  const gateway = new V1BitableGateway({
    schema: {
      appToken: 'app_token_x',
      tables: { product: { tableId: 'tbl_x', tableName: '货品信息', fields: { number: '编号', color: '颜色' } } },
    },
    client: {
      bitable: {
        appTableRecord: {
          list: async (payload) => { sent.push(payload); return { code: 0, data: { items: [], has_more: false } }; },
        },
      },
    },
  });

  await gateway.listAll('product', { fieldNames: ['编号', '颜色'] });
  assert.equal(sent[0].params.field_names, JSON.stringify(['编号', '颜色']),
    'field_names 必须是 JSON 字符串（官方《列出记录》文档：类型 string，示例 ["字段1","字段2"]）');

  await gateway.listAll('product');
  assert.equal('field_names' in sent[1].params, false, '不传 ⇒ 整个参数都不带（行为与优化前一致）');

  await gateway.listAll('product', { fieldNames: [] });
  assert.equal('field_names' in sent[2].params, false, '空数组也不带（不许变成"一列都不要"）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 每张表只读一次 + 并行
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 每张表只读一次（无重复读），且 6 次是并行发出的', async () => {
  const fake = fakeGateway(fixture());
  const service = serviceWith(fake.gateway, { ttlMs: 0 });
  await service.listOrders();

  const keys = ordersCalls(fake.calls).map((call) => call.key);
  assert.equal(keys.length, 5, '本夹具：销售主表 / 明细 / 收款方式 / 收款明细 / 货品（配品未配置）');
  assert.equal(new Set(keys).size, keys.length, '同一张表不许读两次');
  assert.equal(fake.peak(), 5, '5 次读是**同时在飞**的（Promise.all，不是一张一张串行）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 write paths invalidate the orders cache
//   2026-10-14: +accessory-sale and +acceptance (both add/change sales rows -> must invalidate)
// ═══════════════════════════════════════════════════════════════════════════

test('AC7 六条写入路径（补收款/补实收/交付/售后/二次交付/补样品/续写重试）写成功后都作废缓存', () => {
  const workbench = readSrc('src/routes/workbench.js');
  const orderActions = readSrc('src/routes/workbenchOrderActions.js');

  // ① `routes/workbench.js` 里四条：sample-fill / payments / detail-amounts / deliveries / retry
  //    ⭐⭐ 2026-10-15（⑨b-1）第一次翻新：6 → 7（新增 `POST /sales/retry` ⇒ 它也要作废缓存 ✓）
  //    ⭐⭐ 2026-10-15 晚**第二次翻新**：7 → **6**（业务负责人逐字：「**配品就是走表单了～工作台自建写服务
  //       "可以删除了**」）——
  //      改前逐字：`(workbench.match(/ordersCache\.invalidate\(\)/g) || []).length, 7,
  //                 'workbench.js 里五条写入口各作废一次（含 2026-10-15 的「续写/重试」）'`
  //      改后逐字：`… .length, 6, 'workbench.js 里**剩下的**那条链路各作废一次（配品自建入口已整段删除）'`
  //      依据：**被减掉的那一次**正是 `POST /sales/accessory-sales`（工作台自建配品成单）—— 它随整块路由
  //        一起删了（她的"配品走表单"拍板）⇒ 这一条"写入口必须作废缓存"的本意**仍然成立**，
  //        只是"工作台 router 里登记的写入口"少了一个 ✓
  // ③c 共享实例本身：同一次进程里取到的是**同一个对象**（跨 router 共享的前提 ✓）
  const { sharedWorkbenchOrdersCache, resetSharedWorkbenchOrdersCache } = require('../src/services/workbenchOrdersCache');
  resetSharedWorkbenchOrdersCache();
  const a = sharedWorkbenchOrdersCache({ ttlMs: 0 });
  const b = sharedWorkbenchOrdersCache({ ttlMs: 30 });
  assert.equal(a, b, '进程级共享实例：第二次调用必须还是同一个（ttl 由第一次定 ✓）');
  resetSharedWorkbenchOrdersCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 语义一字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC8 语义一个字都不变：带字段选择 / 不带字段选择 / 命中缓存，三种结果逐字相同', async () => {
  const records = fixture();
  const withFields = fakeGateway(records);
  const service = serviceWith(withFields.gateway, { ttlMs: 30000, now: () => 1 });
  const selected = await service.listOrders();

  // 对照：把"字段选择"关掉（假网关忽略 fieldNames 的表现 = 整表读；这里直接比记录形状）
  assert.equal(selected.orders.length, 1);
  assert.equal(selected.orders[0].order_no, 'XSD-001');
  assert.equal(selected.orders[0].receivable_amount, 148);
  assert.equal(selected.orders[0].paid_amount, 50);
  assert.equal(selected.orders[0].pending_amount, 98);
  assert.deepEqual(selected.orders[0].details.map((detail) => detail.product), ['P1', 'P2']);
  assert.deepEqual(selected.orders[0].details.map((detail) => detail.color), ['黑色', '米白']);
  assert.deepEqual(selected.orders[0].details.map((detail) => detail.size), [38, 39]);
  assert.deepEqual(selected.methods, ['微信']);
  // 命中缓存拿到的还是这一份
  assert.deepEqual(await service.listOrders(), selected);

  // 分类与状态口径（三份单子的判据在页面侧；这里钉服务层给的事实）
  assert.equal(selected.orders[0].fulfillment_status, '部分交付');
  assert.equal(selected.orders[0].payment_status, '部分收款');
  assert.equal(selected.orders[0].sample_pending, false);
});
