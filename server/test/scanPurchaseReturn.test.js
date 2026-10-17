const { rendererSource } = require('./support/rendererSource');
/** ⚠️ 2026-10-12 旧断言改写（真机 bug：采购退货的「采购行为」原来写成了**库存**行为）：
 *  改前（逐字）：`assert.equal(SCAN_WRITE.purchaseReturn.behaviorCode, 'STOCK_PURCHASE_DECREASE');`
 *              ＋ `assert.deepEqual(entriesOf(h, 'purchaseOrderBatch')[0].fields['采购行为'], ['bh_return'], …);`
 *  改后（逐字）：behaviorCode ⇒ **'PURCHASE_RETURN'**；采购行为 ⇒ **['bh_return_purchase']**
 *                （夹具里那条 = 「退货」编码 `PURCHASE_RETURN`，真表 `所属环节=采购`）。
 *  理由：业务负责人 2026-10-12 逐字「**为什么你选成了采购增加了呢？**」——`STOCK_*` 是**库存环节**的行为 ✗。
 *        ⚠️ **库存那一边没动**：库存流水.库存行为仍是 `STOCK_PURCHASE_INCREASE/_DECREASE`（本文件里
 *        `库存行为 = ['bh_return']` 那条断言照旧 ✓）。
 */
/**
 * ⚠️ 2026-10-12 热修改写（**「采购明细.采购行为」是 Lookup = 只读**）：
 *  改前（逐字）：`assert.deepEqual(record.fields['采购行为'], ['bh_return'], '采购行为来自「行为管理」的退货编码');`
 *  改后（逐字）：`assert.equal('采购行为' in record.fields, false, '采购行为是 Lookup，不许写');`
 *  理由：她 2026-10-12 把这一列改成 **Lookup**（按「报货批次号」关联采购主表）⇒ 写入无效/可能整条失败；
 *        **读取照旧保留**（工作台采购查询靠它分流报货 / 退货）。⚠️ 退货明细的其余断言（数量=实退数 /
 *        批次号 / 幂等键 / 库存扣减）一条没放宽。
 */
/**
 * 扫码页「采购领域 ·【退货】」的验收用例（业务负责人 2026-10-11 定：**和"报货"逻辑一样，也走扫码**）。
 *
 * 她的口径（逐字）：
 *   「在扫码页的**采购领域**（`/s/{编号}?from=purchase`）加【**退货**】：扫标签码 → 列这一款各尺码
 *   ⚠️ 2026-10-11 晚（业务负责人批准六领域）：原「采购」领域已拆成 **补货 / 退货** 两个领域
 *     ⇒ 本文件里的路由 URL 从 `?from=purchase` 改成 **`?from=purchase_return`**（页面上的退货表单
 *     一字未变；已退役的 `?from=purchase` 现在会回落销售）。
 *    → **选尺码 + 填退货数量** → 生成【采购退货】」；
 *   「⚠️ **与现有的「一键补货」同形**（现在那里只有补货报单）⇒ 复用同页面/同会话/同幂等风格」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-R1 采购领域出现【退货】表单：与【一键补货】**同形**（同一 POST 端点 / 勾尺码 + 填数量 /
 *        零 JS / 带自己的幂等键），动作名、字段名、幂等键前缀**全部来自配置**。
 *  AC-R2 提交退货 ⇒ ①「采购明细」写退货明细（数量 = 实退数；**「采购行为」是 Lookup，不写**、
 *        带「报货批次号」关联）；②「报货批次」建一行，**只写 批次号 + 幂等键**——
 *        🔴 **不写「到货状态」**（她自己 2026-10-07 的退货口径：留空 ⇒ 9 点推送看不见它）。
 *  AC-R3 退货批次**不进**「到货验收情况」面板（`PurchaseQueryService.listPurchaseArrivals`
 *        按"有到达状态"过滤）；也不进 9 点「未到货」候选（那一处按 `到货状态 = 未到货` 过滤）。
 *  AC-R4 **真扣库存**（走既有 `InventoryService`，不新写一套）：按退货口径
 *        `STOCK_PURCHASE_DECREASE` 的 consumes（门盒 + 样品 + 仓库）逐尺码扣；写「库存流水」；
 *        重放**不重复扣**。
 *  AC-R5 **超库存**（她认的历史业务行为）：「退能退的 + 差额如实回报」——报 5 双、库存 3 双 ⇒
 *        明细写 **3**、库存扣 3、结果里 `shortfall = 2`、页面人话说明少了 2 双；**不退成负数**。
 *  AC-R5b **一双都退不成**（库存 0）⇒ **拦住、一个字都不写**（批次行 / 明细行 / 库存都不动），
 *        页面给人话 —— 不写一条"空退货批次"。
 *  AC-R6 **幂等**：同一把提交键连点两次（含并发）⇒ 只写一次（批次 1 行、每条明细 1 行、
 *        库存只扣一次），第二次把上一次的结果还给她。
 *  AC-R6b **重试沿用已冻结的批次号与计划**：中途失败后重试 ⇒ ① **不重新取号**（批次号不变）；
 *        ② 已经写过的明细**不写第二遍**；③ 没写完的接着写；④ 库存最终只扣一次。
 *  AC-R7 **入口隔离**：整条退货链路**不读写** `data/lark_mvp_tasks/`（群聊入口的任务记录）；
 *        退货自己的任务落 `data/scan_return_tasks`（配置给）。
 *  AC-R8 **源码哨兵：扫码侧没有第二套写库 / 没有第二套库存**——
 *        `scanWriteService.js` 里没有 `gateway.create/update/delete`、不 construct `InventoryService`；
 *        库存只经 `InventoryService`（新薄方法 `applyPurchaseReturn`）。
 *  AC-R9 **失败有人话**：内部错误（表名 / 字段名 / record_id 一类）**不回显**，
 *        页面只给配置好的通用人话；业务话（库存不够那类）原样给她。
 *  AC-R10 **退货单出图**：走既有「按供应商出图 → 发群 → 回填「报货批次.单据」」那条路，
 *        只换标题/文件名后缀（来自配置）——幂等键、批次号都在。
 *
 * ⚠️ 本文件用的是**真的** `InventoryService` / `PurchaseOrderBatchService` / 真扫码会话与写服务，
 *    只有飞书那一层（网关 / IM 出图）是内存替身 —— 所以"库存真的动了"是跑出来的。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService` / `purchaseWebhookService` 在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_return_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_return_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
// ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）：退货那条也转后台 ⇒ 回读端状态前先等"在飞的后台那一跑" ✓
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_SECRET = 'scan-return-test-session-secret';

const NUMBER = 'YD6693-2|黑色|A';
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: 'YD6693-2',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    单价: 399,
    供应商: ['sup_1'],
  },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 一双「实时库存」记录（三种状态都要能被采购退货扣掉）。 */
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
  // 41 码三种状态各一双（采购退货 consumes = 门盒 + 样品 + 仓库 ⇒ 三双都能退）；
  // 42 码只有一双门盒。
  liveInventory: [
    liveUnit('live_41_box', 41, '门盒'),
    liveUnit('live_41_sample', 41, '样品'),
    liveUnit('live_41_store', 41, '仓库'),
    liveUnit('live_42_box', 42, '门盒'),
  ],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE' } },
    // ⭐⭐ 2026-10-12 改（真 bug）：采购退货的「**采购行为**」= 采购环节的「**退货**」
    //    （编码 `PURCHASE_RETURN`，真表 `所属环节=采购`）—— **不是**库存环节的「采购减少」✗。
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    // 库存引擎那条**库存行为**仍然要留着（扣库存走它，一行没动 ✓）：
    // 「退货那条既有行为：既是「报货信息.采购行为」也是库存引擎认的「库存行为」」——**前半句已不成立**，
    //  2026-10-12 起两者是**两条不同的行为记录**（采购环节 / 库存环节）。
    {
      record_id: 'bh_return',
      fields: {
        行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true,
      },
    },
  ],
  supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } }],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
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
    // 扣库存会把「实时库存」里那几条记录删掉（既有库存引擎的语义）；别的表不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      const before = (tables[key] || []).length;
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id, removed: before - (tables[key]).length });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-return-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的扫码退货链路：真写服务 + 真会话 + 真库存引擎 + 真批次服务，
 * 只有出图（IM）和批次号源是替身/配置。
 */
const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const returnDir = options.returnDir || tempDir('return-task');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const realInventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const orderBatches = new PurchaseOrderBatchService({ gateway });
  const renders = [];
  const deliveries = [];
  const webhooks = options.webhooks || {
    deliverSupplierImages: async (taskId, task, posting, deliveryOptions) => {
      deliveries.push({ taskId, posting, options: deliveryOptions, draft: task?.draft });
      return { sent: [], failed: [], thread_root_message_id: '' };
    },
  };
  let batchNoCalls = 0;
  const batchNoGenerator = options.batchNoGenerator || {
    runExclusive: async (work) => work(),
    next: async () => {
      batchNoCalls += 1;
      return { batchNo: `CGD-20261011-000${batchNoCalls}` };
    },
  };
  const purchaseReturn = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    // 允许用例把库存引擎包一层（例：模拟"第一次调用失败"的瞬时故障）——包装对象必须
    // 建在**同一套** gateway / 库存任务目录上，否则断言会数到另一个 harness 的流水。
    inventory: options.wrapInventory ? options.wrapInventory(realInventory) : (options.inventory || realInventory),
    orderBatches,
    webhooks,
    batchNoGenerator,
    store: new JsonTaskStore({ dir: returnDir, idField: 'task_id' }),
    now: options.now,
  });
  const write = createScanWriteService({
    gateway,
    sessions,
    purchaseReturnService: purchaseReturn,
    // 本文件不碰补货 / 销售那两条链路：给一对不会落盘的替身，免得误写工作区。
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: tempDir('replenish'), idField: 'task_id' }),
  });
  return {
    gateway,
    sessions,
    inventory: realInventory,
    orderBatches,
    purchaseReturn,
    write,
    renders,
    deliveries,
    batchNoCalls: () => batchNoCalls,
    tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(returnDir); },
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
/** 这一轮退货的幂等键（会话还没建时 = 第 1 轮那把，纯函数算出来 —— 与页面同一条口径）。 */
const returnKey = async (harness, openId) => harness.write.sessions
  .submitKeyFor(openId, await harness.sessions.get(openId), 'purchase_return');
/** 退货表单 → 服务入参（与页面同名：`return_sizes` + `return_qty_<尺码>`）。 */
const entries = (...pairs) => pairs.map(([size, quantity]) => ({ size, quantity }));
const ledgerTotal = (harness) => entriesOf(harness, 'inventoryLedger')
  .reduce((sum, record) => sum + Number(record.fields['变动数量'] || 0), 0);

// ── 路由夹具（AC-R1 / AC-R5 页面 / AC-R9 页面）───────────────────────────────
const sessionCookie = (openId = 'ou_return_route') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 0,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 0 }], total: 0, missing: true },
    { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-11 16:50',
  product_record_id: 'prod_1',
  ...overrides,
});
const formApp = (harness, lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup },
    gateway: harness.gateway,
    writeService: harness.write,
  }));
  return app;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-R1 【退货】表单：与【一键补货】同形，全部来自配置
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R1 【退货】领域里是退货表单：与【一键补货】同形（同一 POST 端点 / 勾尺码+填数量 / 自带幂等键）', async () => {
  login();
  const h = createHarness();
  try {
    // 判据在配置里（动作名 / 字段名 / 幂等键前缀 / 开关）
    assert.equal(SCAN_WRITE.actions.purchaseReturn, 'return_purchase');
    assert.equal(SCAN_WRITE.fields.returnSizes, 'return_sizes');
    assert.equal(SCAN_WRITE.fields.returnQuantityPrefix, 'return_qty_');
    // ⭐ 2026-10-12 改（真机 bug）：采购环节的「退货」= `PURCHASE_RETURN`
    //    （原来是库存环节的「采购减少」`STOCK_PURCHASE_DECREASE` ✗ —— 库存那条链路一行没动 ✓）
    assert.equal(SCAN_WRITE.purchaseReturn.behaviorCode, 'PURCHASE_RETURN');
    assert.equal(SCAN_WRITE.purchaseReturn.enabled, true);
    assert.ok(SCAN_WRITE.session.returnKeyPrefix.startsWith('scan_return'));

    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}`;
      const cookie = { cookie: sessionCookie() };
      // ① 退货领域（`?from=purchase_return`）：只有退货那半 —— 勾尺码 + 每码一个数量输入
      //    ⚠️ 2026-10-11 晚（六领域）口径：原「采购」领域已拆成 补货 / 退货 两块
      //      ⇒ 原先这一条断言"同一页上**两个表单都在**（补货 + 退货）"，现在改成
      //      "各自在自己那一块"（下面 ② 补货那块照旧钉着）。
      const returnHtml = await (await fetch(`${pageUrl}?from=purchase_return`, { headers: cookie })).text();
      // ⚠️ 2026-10-13 **改写**（逐字）：她把这一块从「退货表单」换成了「**配品页**」
      //    改前：这里断言页面上有 `action=return_purchase` / `return_sizes` / `return_qty_41` / `生成采购退货`
      //    改后：断言这一页 = **配品页**（没有可选配品 ⇒ 人话空态卡）；
      //         退货**能力没删**：`returnFormHtml` 仍在渲染层里（下面的源码哨兵）✓
      //    去向：退货链路的行为断言在本文件 **AC-R2…R10**（直接调 `submitPurchaseReturn`，6 条均绿）✓
      // 2026-10-14 re-pointed: purchase_return is the RETURNS form again (add-ons moved to `accessory`)
      assert.ok(returnHtml.includes('data-view="purchase-return"'), 'this page is the returns form');
      assert.equal(returnHtml.includes(SCAN_WRITE.fields.accessory), false, 'the add-on select is NOT on the returns page (its own realm now)');
      const rendererSrc = rendererSource();
      assert.ok(rendererSrc.includes('returnFormHtml'), '退货表单的**能力保留**（returnFormHtml 仍在）✓');
      assert.equal(returnHtml.includes('退货说明'), false);
      assert.equal(returnHtml.includes(`name="action" value="${SCAN_WRITE.actions.replenish}"`), false,
        '退货那一块里不许混进补货表单（两块已分开）');

      // ② 补货领域（`?from=replenish`）：补货那半照旧（同一个 POST 端点、同形）
      const replenishHtml = await (await fetch(`${pageUrl}?from=replenish`, { headers: cookie })).text();
      assert.match(replenishHtml, new RegExp(`name="action" value="${SCAN_WRITE.actions.replenish}"`));
      assert.match(replenishHtml, /name="sizes" value="41"/);
      assert.equal(replenishHtml.includes(`name="action" value="${SCAN_WRITE.actions.purchaseReturn}"`), false,
        '补货那一块里不许混进退货表单（两块已分开）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R2 明细 + 批次行（只写批次号 + 幂等键，不写「到货状态」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R2 提交退货 ⇒「采购明细」退货明细（行为列不写：Lookup 只读）+「报货批次」只写批次号+幂等键', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_return_2';
    const result = await h.write.submitPurchaseReturn({
      openId,
      submitKey: await returnKey(h, openId),
      productRecordId: 'prod_1',
      number: NUMBER,
      entries: entries([41, 2], [42, 1]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.shortfall, 0, '库存够 ⇒ 没有差额');
    assert.equal(result.taken_count, 3);
    assert.equal(result.request_count, 2);
    assert.equal(result.batch_no, 'CGD-20261011-0001');

    // ① 明细行：数量 = 实退数、挂在同一个报货批次上（⚠️ 「采购行为」列**不再写**：它是 Lookup）
    const requests = entriesOf(h, 'purchaseRequest');
    assert.equal(requests.length, 2);
    const bySize = new Map(requests.map((record) => [String(record.fields['尺码']), record]));
    assert.equal(bySize.get('size_41').fields['数量'], 2);
    assert.equal(bySize.get('size_42').fields['数量'], 1);
    for (const record of requests) {
      assert.deepEqual(record.fields['编号'], ['prod_1']);
      // 🔴 2026-10-12 热修：Lookup（只读）⇒ 退货明细也不许写这一列
      assert.equal('采购行为' in record.fields, false, '采购行为是 Lookup，不许写');
    }
    // ⭐⭐ 2026-10-12（她确认要写）：退货那一档写**主表**行（明细由它 Lookup 带出）
    // ⭐ 2026-10-17：主表行为列真表已改名「发生行为」（她逐字）
    assert.deepEqual(entriesOf(h, 'purchaseOrderBatch')[0].fields['发生行为'], ['bh_return_purchase'],
      '主表「采购行为」= 采购退货那一档');
    for (const record of requests) {
      assert.equal('采购行为' in record.fields, false, '采购行为是 Lookup，不许写');
      assert.ok(record.fields['幂等键'], '每条退货明细都有幂等键（既有 createOnceByKey 的判据）');
      assert.deepEqual(record.fields['报货批次号'], [entriesOf(h, 'purchaseOrderBatch')[0].record_id],
        '退货明细必须挂「报货批次号」（退货单 PNG 才有落点）');
    }

    // ② 批次行：只写 批次号 + 幂等键 —— 🔴 没有「到货状态」这一列的值
    const batches = entriesOf(h, 'purchaseOrderBatch');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].fields['报货批次号'], 'CGD-20261011-0001');
    assert.ok(batches[0].fields['幂等键']);
    assert.equal(Object.prototype.hasOwnProperty.call(batches[0].fields, '到货状态'), false,
      '退货批次不写「到货状态」（她的口径：留空 ⇒ 9 点推送看不见它）');
    // 配置的批次号生成器只被问过一次
    assert.equal(h.batchNoCalls(), 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R3 退货批次不进「到货验收情况」面板
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R3 退货批次不进「到货验收情况」面板（到达状态为空的行被既有过滤掉）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_return_3';
    await h.write.submitPurchaseReturn({
      openId, submitKey: await returnKey(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([42, 1]),
    });
    // 再报一条**采购申请**的批次（有到达状态）作为对照 —— 面板只该看见它。
    const requestTables = h.gateway._tables;
    requestTables.purchaseOrderBatch = [
      ...requestTables.purchaseOrderBatch,
      { record_id: 'batch_purchase', fields: { 报货批次号: 'CGD-20261011-0099', 到货状态: '未到货', 幂等键: 'purchase_batch:x' } },
    ];
    const query = createPurchaseQueryService(h.gateway);
    const arrivals = await query.listPurchaseArrivals();
    assert.deepEqual(arrivals.map((row) => row.batch_no), ['CGD-20261011-0099'],
      '退货批次没有到达状态 ⇒ 既有的 `filter(row => row.arrival_status)` 把它挡在面板外');
    // 9 点推送的候选取值也是「未到货」（同一处口径）
    const pending = arrivals.filter((row) => row.arrival_status === '未到货');
    assert.equal(pending.length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R4 真扣库存（门盒 + 样品 + 仓库）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R4 真扣库存：41 码三种状态各一双全退（consumes=门盒+样品+仓库），重放不重复扣', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_return_4';
    const key = await returnKey(h, openId);
    const result = await h.write.submitPurchaseReturn({
      openId, submitKey: key, productRecordId: 'prod_1', number: NUMBER, entries: entries([41, 3]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // 三种状态的三双都被扣掉 ⇒ 41 码一条不剩
    assert.deepEqual(
      entriesOf(h, 'liveInventory').map((record) => record.record_id),
      ['live_42_box'],
      '退货口径 consumes = 门盒 + 样品 + 仓库 ⇒ 41 码三双全扣',
    );
    // 库存流水：一条，变动数量 = 3，库存行为 = 退货那条既有行为
    const ledger = entriesOf(h, 'inventoryLedger');
    assert.equal(ledgerTotal(h), 3);
    for (const record of ledger) assert.deepEqual(record.fields['库存行为'], ['bh_return']);
    // 幂等：同一把键再提交 → 库存不再动
    const again = await h.write.submitPurchaseReturn({
      openId, submitKey: key, productRecordId: 'prod_1', number: NUMBER, entries: entries([41, 3]),
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(ledgerTotal(h), 3, '重放不重复扣库存');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R5 超库存：退能退的 + 差额如实回报
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R5 超库存：报 5 双、库存 3 双 ⇒ 明细写 3、差额 2 如实回报（不退成负数、不静默少退）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_return_5';
    const result = await h.write.submitPurchaseReturn({
      openId, submitKey: await returnKey(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 5]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.taken_count, 3);
    assert.equal(result.shortfall, 2);
    assert.deepEqual(result.shortfalls, [{ size: 41, declared: 5, available: 3, taken: 3, shortfall: 2 }]);
    const request = entriesOf(h, 'purchaseRequest')[0];
    assert.equal(request.fields['数量'], 3, '写的是实退数（不是她填的 5）');
    assert.equal(ledgerTotal(h), 3, '库存按实退数扣');
    assert.equal(entriesOf(h, 'liveInventory').length, 1, '41 码三双扣完，只剩 42 那一条');

    // 页面人话：说清退了几双、少了几双
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`;
      const html = await (await fetch(pageUrl, { headers: { cookie: sessionCookie(openId) } })).text();
      // ⚠️ 2026-10-13：页面已换成配品页 ⇒ **不再从页面抠 submit_key**（抠不到会 TypeError）
      void html;
      const key = await returnKey(h, openId);
      // ⭐⭐ 2026-10-14 晚**成对翻新**（业务负责人**逐字**）：「**退货整单金额（必填），
      //   与补货同一套配置**」＋「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
      //   改前（逐字）：`body` 里只有 `action` / `submit_key` / `return_sizes` / `return_qty_42`
      //                ⇒ **没有** `purchase_amount`
      //   改后（逐字）：加一行 `purchase_amount: '399'`（退货这一单的整单总额）
      //   依据：她 2026-10-14 晚那两句（整单金额必填）⇒ 空金额会被 400 拦住（那一条在新用例
      //        `scanPurchaseAmountRequired.test.js` 里单独钉 ✓）；这一条测的是
      //        **非空 ⇒ 照旧能提交**，所以**判据一个字都没放宽** ✓。
      const response = await fetch(pageUrl, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: SCAN_WRITE.actions.purchaseReturn, submit_key: key, return_sizes: '42', return_qty_42: '1',
          purchase_amount: '399',
        }).toString(),
      });
      assert.equal(response.status, 200);
      const doneHtml = await response.text();
      // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
      //   改前逐字（成功页上给批次号 + 条数）：
      //     `assert.match(doneHtml, /采购退货已生成/);`
      //     `// 第一笔（服务级）用的是第 1 轮的键 ⇒ 页面这一次是**新一轮**的批次号（0002）。`
      //     `assert.match(doneHtml, /CGD-20261011-0002/);`
      //     `assert.match(doneHtml, /采购退货：1 条/);`
      //   改后逐字（**先回统一成功页** ⇒ 批次号这一刻还没取；改"等后台那一跑跑完再读表"：
      //     第二批**真的**建出来 ⇒ 判据**更强**：先回她 **且** 真落库 ✓）：
      //     `assert.ok(doneHtml.includes(SCAN_PAGE.saleSuccess.message), …);`
      //     `assert.equal(doneHtml.includes('采购退货已生成'), false, …);`
      //     `await waitForPendingPurchaseBackgrounds();`
      //     `assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 2, …);`
      //     `assert.equal(entriesOf(h, 'purchaseRequest').length, 2, …);`
      //   依据：业务负责人 2026-10-16 逐字「**补货、退货还有验收，它都是异步的**……
      //     用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』」
      //     （＋ `purchaseAsyncAcceptance.test.js` 的 AC-ASY1：先回成功页 ⇒ 等后台 ⇒ 数据真落库 ✓）。
      assert.ok(doneHtml.includes(SCAN_PAGE.saleSuccess.message),
        '成功页 = 配置里那一句统一文案（异步：批次号要等后台那一跑 ✓）');
      assert.equal(doneHtml.includes('采购退货已生成'), false,
        '🔴 异步之后成功页**不许**再说"已生成"（批次号这一刻还不存在 ✗）');
      await waitForPendingPurchaseBackgrounds();
      assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 2,
        '⭐ 等后台那一跑 ⇒ 第二批**真的**建出来（先回成功页 ≠ 没写 ✓）');
      assert.equal(entriesOf(h, 'purchaseRequest').length, 2, '第二批的退货明细也写了 ✓');
    });
  } finally { h.cleanup(); }
});

test('AC-R5b 一双都退不成（库存 0）⇒ 拦住、一个字都不写（不建空批次）', async () => {
  const h = createHarness({ tables: seedTables({ liveInventory: [] }) });
  try {
    const openId = 'ou_return_5b';
    const result = await h.write.submitPurchaseReturn({
      openId, submitKey: await returnKey(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 3]),
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'return_stock_empty');
    assert.match(result.message, /一双都没有|退不了/);
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 0, '不建空退货批次');
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '不写明细');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 0, '不写库存流水');
    assert.equal(entriesOf(h, 'liveInventory').length, 0);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R6 幂等（连点两次 / 并发）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R6 幂等：同一把键连点两次（含并发）⇒ 只写一次，第二次把结果还给她', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_return_6';
    const key = await returnKey(h, openId);
    const input = {
      openId, submitKey: key, productRecordId: 'prod_1', number: NUMBER, entries: entries([41, 1], [42, 1]),
    };
    const [first, second] = await Promise.all([
      h.write.submitPurchaseReturn(input),
      h.write.submitPurchaseReturn(input),
    ]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal([first, second].filter((item) => item.reused === true).length, 1,
      '并发两次里恰有一次是"把上一次的结果还给她"');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1);
    assert.equal(entriesOf(h, 'purchaseRequest').length, 2);
    assert.equal(ledgerTotal(h), 2, '库存只扣一次');
    const third = await h.write.submitPurchaseReturn(input);
    assert.equal(third.reused, true);
    assert.equal(third.batch_no, first.batch_no || second.batch_no);
  } finally { h.cleanup(); }
});

test('AC-R6b 中途失败后重试：不重新取号、已写过的明细不写第二遍、库存最终只扣一次', async () => {
  const returnDir = tempDir('return-retry');
  let failedOnce = false;
  // 库存引擎第一次调用就失败（模拟瞬时故障）——批次行与第一条明细那时已经写成。
  // ⚠️ 包装对象建在**这个 harness 自己的**库存引擎上（否则流水会写到别的 harness 里）。
  const h = createHarness({
    returnDir,
    wrapInventory: (real) => ({
      applyPurchaseReturn: async (...args) => {
        if (!failedOnce) { failedOnce = true; throw new Error('模拟库存引擎瞬时故障'); }
        return real.applyPurchaseReturn(...args);
      },
    }),
  });
  try {
    const openId = 'ou_return_6b';
    const key = await returnKey(h, openId);
    const input = {
      openId, submitKey: key, productRecordId: 'prod_1', number: NUMBER, entries: entries([41, 1], [42, 1]),
    };
    const firstAttempt = await h.write.submitPurchaseReturn(input);
    assert.equal(firstAttempt.ok, false, '第一次如实失败（不许把半途当成功）');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '批次行已经建成');

    const retry = await h.write.submitPurchaseReturn(input);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(h.batchNoCalls(), 1, '重试不重新取号');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '不建第二个批次');
    assert.equal(entriesOf(h, 'purchaseRequest').length, 2, '两条明细各一条，不重复');
    assert.equal(ledgerTotal(h), 2, '库存最终只扣一次');
    assert.equal(entriesOf(h, 'liveInventory').length, 2);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R7 入口隔离（不碰群聊那条链路的本地任务）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R7 入口隔离：退货只写扫码自己的目录，`data/lark_mvp_tasks/` 一个字节不动', async () => {
  const taskDir = path.join(DATA_DIR, 'lark_mvp_tasks');
  const before = fs.existsSync(taskDir) ? fs.readdirSync(taskDir).sort() : [];
  const h = createHarness();
  try {
    const openId = 'ou_return_7';
    await h.write.submitPurchaseReturn({
      openId, submitKey: await returnKey(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]),
    });
  } finally { h.cleanup(); }
  const after = fs.existsSync(taskDir) ? fs.readdirSync(taskDir).sort() : [];
  assert.deepEqual(after, before, '群聊入口的任务记录目录不许被扫码退货动到');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R8 源码哨兵：没有第二套写库 / 没有第二套库存
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R8 源码哨兵：scanWriteService 不直连写库、不 construct 库存；库存只在 InventoryService', () => {
  const raw = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');
  // 注释里提到这些词是**对的**（那里写的正是"绝不碰它"）⇒ 先剥注释再看代码。
  const writeService = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const pattern of [
    /gateway\.(create|update|delete)\s*\(/,
    /new\s+InventoryService/,
    /\.applyPurchaseReturn\s*\(/,
    /liveInventory|inventoryLedger/,
  ]) {
    assert.equal(pattern.test(writeService), false, `scanWriteService.js 出现了不该有的东西：${pattern}`);
  }
  // 复用点必须在（否则就是"另写一套"）
  assert.match(writeService, /purchaseReturnService/);
  assert.match(writeService, /createPurchaseReturnService/);
  // 复用点必须在（否则就是"另写一套"）
  assert.match(raw, /purchaseReturn/);

  // 新增的退货 service：库存只经 InventoryService 的薄方法
  const service = fs.readFileSync(path.join(SERVER_SRC, 'services', 'purchaseReturnService.js'), 'utf8');
  assert.match(service, /applyPurchaseReturn/);
  assert.match(service, /createOnceByKey/);
  assert.match(service, /createForReturnBatch/);
  assert.equal(/gateway\.(update|delete)\s*\(/.test(service), false,
    '退货 service 自己不 update/delete 业务表（写入全部经既有件）');

  // 库存引擎里的退货入口：新薄方法，不改既有数量通路
  const inventory = fs.readFileSync(path.join(SERVER_SRC, 'services', 'inventoryService.js'), 'utf8');
  assert.match(inventory, /async applyPurchaseReturn\(/);
  assert.match(inventory, /purchaseReturnSourceId/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R9 失败有人话
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R9 失败有人话：内部错误（表名/字段名/record_id）不回显，页面只给配置好的通用人话', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_return_9';
    // 模拟飞书侧的内部错误（字段名 + record_id 都在里面，属于不许回显的那一类）
    const originalCreate = h.gateway.create;
    h.gateway.create = async (key, values) => {
      if (key === 'purchaseRequest') throw Object.assign(new Error('FieldNameNotFound: 数量 (record_id: rec_1)'), { bitableRejected: true });
      return originalCreate(key, values);
    };
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`;
      const html = await (await fetch(pageUrl, { headers: { cookie: sessionCookie(openId) } })).text();
      // ⚠️ 2026-10-13：页面已换成配品页 ⇒ **不再从页面抠 submit_key**（抠不到会 TypeError）
      void html;
      const key = await returnKey(h, openId);
      // ⭐⭐ 2026-10-14 晚**成对翻新**（同 AC-R5 那一条依据，业务负责人**逐字**）：
      //   「**退货整单金额（必填），与补货同一套配置**」
      //   改前（逐字）：`body` 里只有 `action` / `submit_key` / `return_sizes` / `return_qty_41`
      //                ⇒ **没有** `purchase_amount`
      //   改后（逐字）：加一行 `purchase_amount: '399'`（**先过整单金额那道必填闸门**，
      //                才能走到"写库失败 ⇒ 500 + 人话"这一段 —— 它测的是**内部错误不回显**）
      //   依据：她 2026-10-14 晚那两句 ⇒ 补货 / 退货同一套必填；**判据一个字都没放宽** ✓
      //        （"内部细节不回显"那两条断言逐字照旧 ✓）。
      const response = await fetch(pageUrl, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: SCAN_WRITE.actions.purchaseReturn, submit_key: key, return_sizes: '41', return_qty_41: '1',
          purchase_amount: '399',
        }).toString(),
      });
      assert.equal(response.status, 200, '异步：她**先拿到成功页**（写库丢给后台那一跑 ✓）');
      const done = await response.text();
      // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
      //   改前逐字（写库失败是**同步**的 ⇒ 页面 500 + 人话）：
      //     `assert.equal(response.status, 500, '写库失败 → 500 + 人话页（不是静默、也不是 200 假成功）');`
      //     `assert.match(failed, /这一步没成功/);`
      //     `assert.equal(/FieldNameNotFound|record_id|数量 \(record_id/.test(failed), false, '内部细节不回显');`
      //   改后逐字（异步：**失败不再从这一页出去**；但"如实、可查、绝不假装写成了"一条都没少）：
      //     · 页面 = 统一成功页 ⇒ 内部细节**照样一个字都不回显** ✓（这条判据**更强**了：那一页
      //       本来就只有配置里那一句 ✓）；
      //     · 后台那一跑如实失败 ⇒ **可查**：会话 `purchaseReturn.last_error` 落内部原因
      //       （＋ 后台件一条 `purchase.write.background.failed` warn ✓ 不静默 ✗）；
      //     · **零写入**：明细一条都没有 ✓。
      //   依据：业务负责人 2026-10-16 逐字「补货、退货还有验收，它都是异步的……都是一个成功页」
      //     ＋ `purchaseAsyncAcceptance.test.js` 的 **AC-ASY3**（后台失败 ⇒ `markFailed` ＋ `ok:false`，
      //     **绝不吞成成功** ✗）—— 判据**没有放宽**：失败仍必须可查、且不许写成功任何一条 ✗。
      assert.ok(done.includes(SCAN_PAGE.saleSuccess.message), '成功页 = 那一句统一文案 ✓');
      assert.equal(/FieldNameNotFound|record_id|数量 \(record_id/.test(done), false,
        '内部细节**照样不回显**（不给到她眼前 ✗）');
      await waitForPendingPurchaseBackgrounds();
      const session = await h.write.sessions.get(openId);
      const lastError = String(session?.purchaseReturn?.last_error || '');
      assert.ok(lastError.length > 0,
        '⭐ 后台那一跑失败必须**留痕可查**（会话 `last_error` ✓ —— 别静默吞掉 ✗）');
      assert.equal(/FieldNameNotFound|record_id|rec_1/.test(lastError), false,
        '落档的那一句也是**配置好的通用人话**（内部细节照样不许进去 ✗）');
      assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '写库失败 ⇒ 明细**零写入** ✓');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R10 退货单出图（既有出图链路，只换标题/文件名后缀）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R10 退货单出图：走既有 deliverSupplierImages，标题/后缀来自配置，posting 带批次身份', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_return_10';
    const result = await h.write.submitPurchaseReturn({
      openId, submitKey: await returnKey(h, openId), productRecordId: 'prod_1', number: NUMBER,
      entries: entries([41, 1]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.deliveries.length, 1, '出图那一步被调用了一次');
    const [delivery] = h.deliveries;
    assert.equal(delivery.options.title, SCAN_WRITE.purchaseReturn.imageTitle);
    assert.equal(delivery.options.fileNameSuffix, SCAN_WRITE.purchaseReturn.fileNameSuffix);
    assert.equal(delivery.posting.batch_no, result.batch_no);
    assert.equal(delivery.posting.batch_record_id, result.batch_record_id);
    assert.equal(delivery.posting.request_ids.length, result.request_count, 'posting 里的明细就是这一次写下的那些');
    // 图上的明细数量 = 实退数（不是她填的申报数）
    assert.deepEqual(delivery.draft.items.map((item) => item.quantity), [1]);
    assert.equal(delivery.draft.supplier_record_id, 'sup_1');
  } finally { h.cleanup(); }
});
