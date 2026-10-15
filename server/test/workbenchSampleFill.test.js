/**
 * ⭐⭐ 2026-10-11（业务负责人，20:30 逐条确认）：
 *   「**补样品的放在工作台的销售的订单列表**，里面不是有个**待完善**吗？如果**卖了样品的，
 *     没有说把门盒变成谁的**也放在这里……」
 *
 * 口径（Lead 已确认）：
 *   · 待办**复用既有事实**（不新造）：读 `data/lark_mvp_tasks` 里那批
 *     `type:'sample_replacement'`、`status:'pending'` 的任务（工作台交付路径本来就在写它，
 *     见 `routes/workbench.js:196-203`）；
 *   · `salesFollowupService.listOrders` **只读**多给 `sample_pending`；前端 `salesSectionOf`
 *     **先判它** ⇒ 进「待补充」；**其余三态判据一个字不动**；
 *   · 动作**必须走 `InventoryService.promoteToSample`**（不是 `transitionState`）：
 *     它与群卡片**共用同一个 `operationId('sample', salesDetailRecordId)`**
 *     （`inventoryService.js:351` / `:902-940`）⇒ **跨入口绝不重复挪**；固定 **1 双**；
 *     流水**带「关联销售」**（`:920` / `:982`）；
 *   · 补掉后把那条任务标 `completed`（顺手解决"群卡片还亮着"）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PS1  待补样品进「待补充」：`listOrders` 给出 `sample_pending`（含候选门盒尺码）。
 *  AC-PS1b 三态判据**只多一个输入**：既有分类逐条不变（前端纯函数）＋ 前后端判据**结论一致**。
 *  AC-PS2  卡片上出现【补样品】块：列候选门盒尺码；没有候选 ⇒ 人话、不给假按钮。
 *  AC-PS3  提交 ⇒ 走**既有 `promoteToSample`**：门盒→样品、**总量不变**、流水**带「关联销售」**且
 *          **变动数量 0**、任务标 `completed`、待办消失。
 *  AC-PS4  ⭐ **跨入口幂等**：工作台补过之后，群卡片那条路（`applyPreChosen` / 卡片动作）
 *           **不会重复挪**（同一个 `operationId`）。
 *  AC-PS5  拦住与幂等：没有门盒 ⇒ 400 人话 + **零写入**；不是待办 ⇒ 400；重复提交 ⇒ 回放不重复挪。
 *  AC-PS6  路由：走既有 `requireWorkbenchAccess` 闸门；成功/失败载荷形状。
 *  AC-PS7  既有哨兵不动（三态/订单列表的既有断言、群补样品链路）。
 *  AC-PS-E2E ⭐ **端到端**：真交付（卖出一双样品）→ 待办出现 → 工作台补掉 → 待办消失。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sample_fill_ws';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sample_fill_ws_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { InventoryService } = require('../src/services/inventoryService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SampleReplacementService } = require('../src/services/sampleReplacementService');
const { createSamplePendingService } = require('../src/services/samplePendingService');
const { createWorkbenchRouter } = require('../src/routes/workbench');

const SESSION_SECRET = 'sample-fill-ws-session-secret';
const LOGIN_ENV = 'LARK_WEB_SESSION_SECRET';
const DETAIL_ID = 'detail_1';
const PRODUCT_ID = 'prod_1';
const ORDER_ID = 'order_1';
const SIZE_WITH_BOX = 42;   // 门盒里还有一双（可以拿它补）
const SIZE_SOLD_SAMPLE = 40; // 卖掉的是这一码的样品（它已经没有门盒了）

// ── 夹具 ────────────────────────────────────────────────────────────────────
const seedTables = (overrides = {}) => ({
  salesEntry: [{
    record_id: ORDER_ID,
    // ⚠️ 「账做完了没有」= **资金状态**（`postedOf` 读的是 funds），不是销售状态
    fields: { 销售单号: 'XSD-20261011-0001', 销售状态: '已写入', 资金状态: '已写入', 履约状态: '已交付' },
  }],
  salesDetail: [{
    record_id: DETAIL_ID,
    fields: {
      销售单号: [ORDER_ID], 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_SOLD_SAMPLE}`],
      履约状态: '已交付', 实收金额: 399,
    },
  }],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { 收款方式: '微信' } }],
  paymentRecord: [{
    record_id: 'pay_1',
    fields: { 销售单号: [ORDER_ID], 收款方式: ['pm_wechat'], 收款金额: 399, 收款状态: '已收款' },
  }],
  product: [{
    record_id: PRODUCT_ID,
    fields: { 编号: 'YD6693-2|黑色|A', 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: 'A', 单价: 399 },
  }],
  sizeManagement: [
    { record_id: `size_${SIZE_SOLD_SAMPLE}`, fields: { 尺码: SIZE_SOLD_SAMPLE } },
    { record_id: `size_${SIZE_WITH_BOX}`, fields: { 尺码: SIZE_WITH_BOX } },
  ],
  liveInventory: [
    // 42 码还有一双门盒（**可以拿它补**）；40 码只剩样品（它的门盒已经被这一单卖掉）
    { record_id: 'live_42_box', fields: { 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_WITH_BOX}`], 所属状态: '门盒' } },
    { record_id: 'live_40_sample', fields: { 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_SOLD_SAMPLE}`], 所属状态: '样品' } },
  ],
  inventoryLedger: [],
  behavior: [{
    record_id: 'bh_to_sample',
    fields: { 行为名称: '门盒转样品', 行为编码: 'STOCK_DOORBOX_TO_SAMPLE', 库存方向: '不影响', 是否启用: true },
  }],
  ...overrides,
});

const createFakeGateway = (tables = seedTables()) => {
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
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    // 销售减少那一路上，卖掉的实时库存记录是**真的会被删**（一双一条）——网关照实支持；
    // ⚠️ 补样品那一路**只改状态、不新建不删**，由用例逐条断言（见 AC-PS3）。
    delete: async (key, id) => {
      const list = tables[key] || [];
      const index = list.findIndex((record) => record.record_id === id);
      if (index < 0) throw new Error(`记录不存在: ${key}/${id}`);
      const [removed] = list.splice(index, 1);
      writes.push({ op: 'delete', table: key, record_id: id });
      return { deleted: true, record: removed };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `sample-fill-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套"真的在跑"的工作台补样品链路：真库存引擎 + 真补样品任务存储 + 真接线。 */
const createHarness = (options = {}) => {
  const gateway = options.gateway || createFakeGateway(seedTables(options.tables || {}));
  const inventoryDir = tempDir('inventory');
  const sampleDir = options.sampleDir || tempDir('sample-tasks');
  const inventory = options.inventory || new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const sampleStore = new JsonTaskStore({ dir: sampleDir, idField: 'task_id' });
  const samplePending = createSamplePendingService({ gateway, inventory, store: sampleStore });
  const followup = new SalesFollowupService({
    gateway, inventory, samplePending,
    store: new JsonTaskStore({ dir: tempDir('followup'), idField: 'task_id' }),
  });
  return {
    gateway, inventory, sampleStore, samplePending, followup,
    tables: gateway._tables,
    cleanup: () => { rmDir(inventoryDir); rmDir(sampleDir); },
  };
};

/** 落一条"待补样品"任务（形状与 `SampleReplacementService.notifySampleReplacements` 一致）。 */
const seedPendingTask = (h, overrides = {}) => h.sampleStore.create({
  task_id: `sample_${crypto.createHash('sha256').update(DETAIL_ID).digest('hex').slice(0, 20)}`,
  type: 'sample_replacement',
  status: 'pending',
  sender_open_id: 'ou_seller',
  sales_detail_record_id: DETAIL_ID,
  product_record_id: PRODUCT_ID,
  product_number: 'YD6693-2',
  consumed_live_record_ids: ['live_40_box_sold'],
  ...overrides,
});

const ledgerOf = (h) => h.tables.inventoryLedger || [];
const stateOf = (h, size) => (h.tables.liveInventory || [])
  .filter((record) => String(record.fields['尺码']) === `size_${size}`)
  .map((record) => record.fields['所属状态'])
  .sort();

// ── 路由夹具 ────────────────────────────────────────────────────────────────
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env[LOGIN_ENV] = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_workbench') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const workbenchApp = (h) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ followup: h.followup, gateway: h.gateway }));
  return app;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS1 / AC-PS1b 待办进「待补充」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS1 待补样品进「待补充」：listOrders 给出 sample_pending（含候选门盒尺码）', async () => {
  const h = createHarness();
  try {
    await seedPendingTask(h);
    const result = await h.followup.listOrders();
    const order = result.orders.find((item) => item.record_id === ORDER_ID);
    assert.equal(order.sample_pending, true, '这一单有待补样品待办');
    assert.equal(order.sample_pending_lines.length, 1);
    const [line] = order.sample_pending_lines;
    assert.equal(line.detail_record_id, DETAIL_ID);
    assert.equal(line.product_record_id, PRODUCT_ID);
    // 候选 = **还有门盒的尺码**（42 码 1 双；40 码的门盒已经被这一单卖掉了）
    assert.deepEqual(line.candidates.map((item) => item.size), [SIZE_WITH_BOX]);
    assert.equal(line.candidates[0].doorBoxCount, 1);
    // 没任务的单/没错 = false（只读字段，绝不误报）
    const clean = await createHarness().followup.listOrders();
    assert.equal(clean.orders[0].sample_pending, false);
    assert.deepEqual(clean.orders[0].sample_pending_lines, []);
  } finally { h.cleanup(); }
});

test('AC-PS1b 前端三态只多一个输入：既有分类逐条不变（同一份判据）', async () => {
  const modules = loadFrontendModules();
  const module = await modules.orders;
  const base = {
    fulfillment_status: '已交付', payment_status: '已收款',
    details: [{ product: 'X', color: '黑', size: 40, requires_size: true }],
    payments: [{ method: '微信' }],
  };
  // 既有判据逐条不变（都不带 sample_pending）
  assert.equal(module.salesSectionOf(base), 'afterSales', '信息齐 + 钱货两清 ⇒ 已两清那一栏');
  assert.equal(module.salesSectionOf({ ...base, fulfillment_status: '未交付' }), 'pending');
  assert.equal(module.salesSectionOf({ ...base, payments: [] }), 'supplement');
  assert.equal(module.salesSectionOf({ ...base, details: [] }), 'supplement');
  // ⭐ 新增：有待补样品 ⇒ 进「待补充」（**先判它**）
  assert.equal(module.salesSectionOf({ ...base, sample_pending: true }), 'supplement',
    '卖了样品没指定门盒 ⇒ 待补充（其余判据不动）');
  assert.equal(module.salesSectionOf({ ...base, sample_pending: false }), 'afterSales');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS2 卡片上的【补样品】块
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS2 卡片上出现【补样品】块：列候选门盒尺码；没有候选 ⇒ 人话、不给假按钮', async () => {
  const modules = loadFrontendModules();
  const [module, config] = await Promise.all([modules.orders, modules.ordersConfig]);
  const order = {
    record_id: ORDER_ID, order_no: 'XSD-1', fulfillment_status: '已交付', payment_status: '已收款',
    details: [{ record_id: DETAIL_ID, product: 'YD6693-2', color: '黑色', size: 40, requires_size: true, actual_amount: 399 }],
    payments: [{ method: '微信', amount: 399, status: '已收款' }],
    sample_pending: true,
    sample_pending_lines: [{
      detail_record_id: DETAIL_ID, product_record_id: PRODUCT_ID, product_number: 'YD6693-2', size: 40,
      candidates: [{ size: 42, doorBoxCount: 1 }],
    }],
  };
  const html = module.orderDetailHtml(order, { methods: ['微信'] });
  assert.ok(html.includes('data-action-block="sample-fill"'), '卡片上要有【补样品】块');
  assert.ok(html.includes(`data-detail="${DETAIL_ID}"`), '按明细提交');
  assert.ok(html.includes(`value="${SIZE_WITH_BOX}"`), '候选尺码来自服务端（42）');
  assert.ok(html.includes('data-action="submit-sample-fill"'), '有一颗提交按钮');
  assert.equal(/<table/i.test(html), false, '手机上不许用表格');
  // 没有候选 ⇒ 人话（不是空 select、也不是点了没反应的按钮）
  const noCandidate = module.orderDetailHtml({
    ...order,
    sample_pending_lines: [{ ...order.sample_pending_lines[0], candidates: [] }],
  }, { methods: ['微信'] });
  assert.ok(noCandidate.includes(config.ORDERS_TEXTS.sampleFillNoCandidate), '要说清"没有可用的门盒"');
  assert.equal(noCandidate.includes('data-action="submit-sample-fill"'), false, '没有候选就不给按钮');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS3 补掉：走既有 promoteToSample（总量不变 + 流水带关联销售）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS3 提交 ⇒ 门盒→样品、总量不变、流水带「关联销售」且变动数量 0、任务 completed、待办消失', async () => {
  const h = createHarness();
  try {
    await seedPendingTask(h);
    const before = stateOf(h, SIZE_WITH_BOX);
    assert.deepEqual(before, ['门盒']);

    h.gateway.writes.length = 0;
    const result = await h.followup.fillSample({
      detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, operatorOpenId: 'ou_1', requestId: 'req_1',
    });
    // ⭐ 补样品只改「所属状态」：**不新建、不删除**实时库存（总量不变的第二重证据）
    assert.equal(h.gateway.writes.some((write) => write.table === 'liveInventory'
      && (write.op === 'create' || write.op === 'delete')), false, '补样品不许新建/删除实时库存');
    assert.deepEqual(h.gateway.writes.filter((write) => write.table === 'liveInventory')
      .map((write) => write.op), ['update'], '只更新了那一条的状态');
    assert.deepEqual(h.gateway.writes.filter((write) => write.table === 'liveInventory')[0].fields,
      { 所属状态: '样品' }, '只把「所属状态」改成样品');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.size, SIZE_WITH_BOX);

    // ① 那一双 门盒 → 样品；② 总量不变（记录条数不变）
    assert.deepEqual(stateOf(h, SIZE_WITH_BOX), ['样品']);
    assert.equal(stateOf(h, SIZE_WITH_BOX).length, before.length, '总量不变');
    assert.deepEqual(stateOf(h, SIZE_SOLD_SAMPLE), ['样品'], '别处一个都没动');
    // ③ 流水：一条、「变动数量」= 0、**带「关联销售」**（= 那条销售明细）
    assert.equal(ledgerOf(h).length, 1);
    assert.equal(ledgerOf(h)[0].fields['变动数量'], 0);
    assert.deepEqual(ledgerOf(h)[0].fields['关联销售'], [DETAIL_ID], '补样品流水必须挂在那条销售明细上');
    assert.deepEqual(ledgerOf(h)[0].fields['库存行为'], ['bh_to_sample']);
    // ④ 任务 completed；⑤ 待办从订单列表消失
    const task = await h.sampleStore.get(`sample_${crypto.createHash('sha256').update(DETAIL_ID).digest('hex').slice(0, 20)}`);
    assert.equal(task.status, 'completed');
    assert.equal(task.result.size, SIZE_WITH_BOX);
    const after = await h.followup.listOrders();
    assert.equal(after.orders[0].sample_pending, false, '补掉之后待办消失');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS4 跨入口幂等（本轮最硬的一条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS4 跨入口幂等：工作台补过之后，群卡片那条路不会重复挪第二双', async () => {
  const h = createHarness();
  try {
    await seedPendingTask(h);
    await h.followup.fillSample({ detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, operatorOpenId: 'ou_1' });
    assert.equal(ledgerOf(h).length, 1);

    // 群那条路（确认卡片上已经选好门盒的那一支）：同一个 detail ⇒ **同一个 operationId** ⇒ 回放
    const replacement = new SampleReplacementService({
      gateway: h.gateway, inventory: h.inventory,
      store: h.sampleStore,
      sendCardToTask: async () => null, updateCard: async () => true,
    });
    const handled = await replacement.applyPreChosen([
      { salesDetailRecordId: DETAIL_ID, productRecordId: PRODUCT_ID, size: SIZE_WITH_BOX },
    ]);
    assert.equal(handled.has(DETAIL_ID), true);
    assert.equal(ledgerOf(h).length, 1, '不重复写流水');
    assert.deepEqual(stateOf(h, SIZE_WITH_BOX), ['样品'], '不重复挪第二双（门盒里已经没有了）');

    // 群卡片动作那条路：任务已 completed ⇒ 走终态分支，不再挪
    const response = await replacement.handleCardAction(
      { action: 'choose_sample_replacement', draft_id: `sample_${crypto.createHash('sha256').update(DETAIL_ID).digest('hex').slice(0, 20)}`, size: SIZE_WITH_BOX },
      {}, 'ou_seller',
    );
    assert.match(String(response?.toast?.content || response?.card?.elements?.[0]?.content || ''), /./, '有明确回执');
    assert.equal(ledgerOf(h).length, 1, '仍然只有一条流水');
    assert.deepEqual(stateOf(h, SIZE_WITH_BOX), ['样品']);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS5 拦住 / 幂等
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS5 没有门盒 / 不是待办 / 重复提交：三种情况都如实处理', async () => {
  const h = createHarness();
  try {
    await seedPendingTask(h);
    // ① 没有门盒的尺码 ⇒ 拦住 + 零写入
    await assert.rejects(() => h.followup.fillSample({
      detailRecordId: DETAIL_ID, size: SIZE_SOLD_SAMPLE, operatorOpenId: 'ou_1',
    }), /门盒/);
    assert.equal(ledgerOf(h).length, 0, '一个字都没写');
    assert.deepEqual(stateOf(h, SIZE_SOLD_SAMPLE), ['样品']);
    assert.equal((await h.sampleStore.get(`sample_${crypto.createHash('sha256').update(DETAIL_ID).digest('hex').slice(0, 20)}`)).status,
      'pending', '待办还在（她换一个码还能补）');

    // ② 不是待办明细 ⇒ 拦住
    await assert.rejects(() => h.followup.fillSample({
      detailRecordId: 'detail_not_pending', size: SIZE_WITH_BOX, operatorOpenId: 'ou_1',
    }), /待办|补过/);

    // ③ 重复提交同一条 ⇒ 幂等回放（不重复挪）
    const first = await h.followup.fillSample({ detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, operatorOpenId: 'ou_1' });
    assert.equal(first.ok, true);
    const second = await h.followup.fillSample({ detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, operatorOpenId: 'ou_1' });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, '已经补过 ⇒ 回放');
    assert.equal(ledgerOf(h).length, 1);
    assert.deepEqual(stateOf(h, SIZE_WITH_BOX), ['样品']);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS6 路由（闸门 + 载荷）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS6 路由 POST /api/workbench/sales/sample-fill：走既有闸门、成功与失败载荷', async () => {
  login();
  const h = createHarness();
  try {
    await seedPendingTask(h);
    await withServer(workbenchApp(h), async (base) => {
      const url = `${base}/api/workbench/sales/sample-fill`;
      // 未登录 ⇒ 401（共享闸门语义不变）
      const anonymous = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(anonymous.status, 401);
      // 缺 size ⇒ 400 + 人话（一个字都不写）
      const missing = await fetch(url, {
        method: 'POST',
        headers: { cookie: sessionCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ detailRecordId: DETAIL_ID, requestId: crypto.randomUUID() }),
      });
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /尺码/);
      assert.equal(ledgerOf(h).length, 0);
      // 正常 ⇒ 200 + 载荷
      const ok = await fetch(url, {
        method: 'POST',
        headers: { cookie: sessionCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, requestId: crypto.randomUUID() }),
      });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.success, true);
      assert.equal(body.size, SIZE_WITH_BOX);
      assert.ok(body.message, '给她一句话');
      assert.equal(ledgerOf(h).length, 1);
      // 没门盒 ⇒ 400（她填的/选的错），且不再写
      const noBox = await fetch(url, {
        method: 'POST',
        headers: { cookie: sessionCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ detailRecordId: 'detail_x', size: 99, requestId: crypto.randomUUID() }),
      });
      assert.equal(noBox.status, 400);
      assert.equal(ledgerOf(h).length, 1);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS-E2E 端到端：真交付 → 待办出现 → 补掉 → 待办消失
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS-E2E 端到端：交付卖掉一双样品 ⇒ 自动记待办 ⇒ 工作台补掉 ⇒ 待办消失', async () => {
  // 这一单卖的就是**样品**（40 码没有门盒、只有样品）⇒ 交付后必然产生补样品的事
  const gateway = createFakeGateway(seedTables({
    salesDetail: [{
      record_id: DETAIL_ID,
      fields: { 销售单号: [ORDER_ID], 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_SOLD_SAMPLE}`], 履约状态: '未交付' },
    }],
    behavior: [
      // 交付要扣库存 ⇒ 「销售减少」这条行为必须在（方向=减少、已启用）
      { record_id: 'bh_sale', fields: { 行为名称: '销售减少', 行为编码: 'STOCK_SALE_DECREASE', 库存方向: '减少', 是否启用: true } },
      // 补样品要用「门盒转样品」（方向=不影响、已启用）
      { record_id: 'bh_to_sample', fields: { 行为名称: '门盒转样品', 行为编码: 'STOCK_DOORBOX_TO_SAMPLE', 库存方向: '不影响', 是否启用: true } },
    ],
    // ⚠️ 这一条用例先走"样品被卖"：40 码只有样品 ⇒ 销售扣减会吃掉它
    liveInventory: [
      { record_id: 'live_40_sample', fields: { 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_SOLD_SAMPLE}`], 所属状态: '样品' } },
      { record_id: 'live_42_box', fields: { 编号: [PRODUCT_ID], 尺码: [`size_${SIZE_WITH_BOX}`], 所属状态: '门盒' } },
    ],
  }));
  const h = createHarness({ gateway });
  try {
    // ① 真交付：卖出那双样品
    const delivery = new SalesDeliveryService({ gateway: h.gateway, inventory: h.inventory });
    const delivered = await delivery.deliver({ salesEntryRecordId: ORDER_ID, detailRecordIds: [DETAIL_ID] });
    assert.equal(delivered.failures.length, 0, JSON.stringify(delivered.failures));
    assert.deepEqual(delivered.sampleReplacements.map((item) => item.salesDetailRecordId), [DETAIL_ID],
      '这一单卖掉了样品 ⇒ 产生一条"要补样品"的事实');

    // ② 落待办（工作台那条路：没有群上下文 ⇒ 卡片发不出去，但任务照样落盘）
    const notifier = new SampleReplacementService({
      gateway: h.gateway, inventory: h.inventory, store: h.sampleStore,
      sendCardToTask: async () => null, updateCard: async () => true,
    });
    await notifier.notifySampleReplacements(delivered, 'ou_seller');
    const task = await h.sampleStore.get(`sample_${crypto.createHash('sha256').update(DETAIL_ID).digest('hex').slice(0, 20)}`);
    assert.equal(task?.status, 'pending', '待办落了（status=pending）');

    // ③ 订单列表里出现待办（进「待补充」）
    const before = await h.followup.listOrders();
    assert.equal(before.orders[0].sample_pending, true);
    assert.deepEqual(before.orders[0].sample_pending_lines[0].candidates.map((item) => item.size), [SIZE_WITH_BOX]);

    // ④ 工作台补掉
    const filled = await h.followup.fillSample({
      detailRecordId: DETAIL_ID, size: SIZE_WITH_BOX, operatorOpenId: 'ou_seller',
    });
    assert.equal(filled.ok, true, JSON.stringify(filled));
    assert.deepEqual(stateOf(h, SIZE_WITH_BOX), ['样品'], '拿 42 码的门盒补成了样品');
    assert.equal(ledgerOf(h).length, 2, '一条销售减少 + 一条门盒转样品');

    // ⑤ 待办消失
    const after = await h.followup.listOrders();
    assert.equal(after.orders[0].sample_pending, false, '待办消失');
    assert.equal((await h.sampleStore.get(task.task_id)).status, 'completed');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PS7 既有哨兵不动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PS7 既有哨兵不动：群补样品链路与三态判据的既有断言文件都还在、且没被改弱', () => {
  for (const file of ['sampleReplacementRecovery.test.js', 'orderThreeStates2026_10_11.test.js',
    'workbenchOrders.test.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, file)), true, `${file} 必须还在`);
  }
  const threeStates = fs.readFileSync(path.join(__dirname, 'orderThreeStates2026_10_11.test.js'), 'utf8');
  assert.match(threeStates, /salesSectionOf\(ORDER\), 'pending'/, '既有的三态断言逐字还在');
  const sampleRecovery = fs.readFileSync(path.join(__dirname, 'sampleReplacementRecovery.test.js'), 'utf8');
  assert.match(sampleRecovery, /notifySampleReplacements/, '群/工作台补样品链路的哨兵还在');
});

// ── 前端模块加载（与既有工作台用例同一套做法）────────────────────────────────
function loadFrontendModules() {
  const WORKBENCH = path.join(__dirname, '../public/workbench');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-fill-front-'));
  const copy = (from, to, replacements = []) => {
    let source = fs.readFileSync(path.join(WORKBENCH, from), 'utf8');
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'", true]]);
  copy('config/orders.js', 'ordersConfig.mjs', [
    ["from './links.js'", "from './links.mjs'", true],
    ["from './query.js'", "from './query.mjs'", true],
  ]);
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/ui.js', 'ui.mjs', [
    ["from './api-client.js'", "from './api-client.mjs'", true],
  ]);
  copy('config/domains.js', 'domains.mjs', [
    ["from './links.js'", "from './links.mjs'", true],
    ["from './query.js'", "from './query.mjs'", true],
  ]);
  copy('features/orders/index.js', 'orders.mjs', [
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
    ["from '../../config/orders.js'", "from './ordersConfig.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { orders: load('orders'), ordersConfig: load('ordersConfig') };
}
const { pathToFileURL } = require('node:url');
