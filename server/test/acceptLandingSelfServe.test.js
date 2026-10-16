require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 2026-10-12（业务负责人真机 + Lead 追到的日志）：
 *   她：「报单之后点验收 ⇒ 就提示这个，我不知道啥意思」。
 *   日志：`GET /accept` ⇒ **400** ⇒ 页面上是 `texts.acceptBatchMissingBody`
 *     「这一页没带报货批次号：回【验收】领域选一个批次（或填批次号）再进来。」
 *
 * ⇒ **自相矛盾**：她**就是**从【验收】领域进来的，落地页却让她"回验收领域" ✗；
 *   而且她截图那一页**没有输入框** ⇒ 那句"或填批次号"在那一页**根本做不到** ✗。
 * 根因：那两块（列未到货批次 + 手输兜底）当时**只**在【有编号的领域页】渲染
 *   （`routes/scanPage.js` 的 `realm === ACCEPTANCE_REALM && !acceptance` 分支），
 *   而领域条里【验收】的落点是**落地页** `/accept` ⇒ 两条路没接上。
 *
 * 本轮口径：`GET /accept`（无 batch）⇒ **直接给自助块**（复用既有那一个渲染块，**不复制实现**），
 *   并且**两条前缀（`/s`、`/r`）下都要成立**（链接用挂载点拼，**不写死 `/s/`**）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-AL1 `GET /accept`（无 batch）⇒ **200**，列出未到货批次（批次号逐字 + `href="/s/accept?batch=…"`）。
 *  AC-AL2 同一页里有**手输兜底表单**（`method="get" action="/s/accept" name="batch"`，零 JS）。
 *  AC-AL3 哨兵：落地页里**不出现**「回【验收】领域」（也不出现 `acceptBatchMissingBody` 原文）。
 *  AC-AL4 点一条 ⇒ 进验收模式（`/s/accept?batch=…` 200 + `data-view="acceptance"` + `data-batch=`）。
 *  AC-AL5 一个未到货都没有 ⇒ **200** + 一句人话 + 手输兜底仍在。
 *  AC-AL6 读表失败 ⇒ 页面仍 **200** + 手输兜底在（**不红**）。
 *  AC-AL7 手输一个**不对的**批次号 ⇒ 仍是人话（4xx，**不 500**）。
 *  AC-AL8 回归：**有编号的领域页**（`/s/{编号}?from=accept`）那块自助块**逐字不变**。
 *  AC-AL9 `/r/accept`（无 batch）⇒ 200，且链接/表单都指向 **`/r/accept`**（不写死 `/s/`）。
 *  AC-AL10 结构性：落地页**复用**同一个渲染块（源码哨兵：`renderAcceptanceSelfServe` 里调
 *         `acceptPendingBlockHtml`；路由里 `pendingBatches()` **只有一处**）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_landing';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_landing_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-landing-secret';
const NUMBER = 'YD6693-2|黑色|A';
const BATCH_A = 'CGD-20261012-0001';
const BATCH_A_ID = 'batch_a';

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-12 16:00',
  product_record_id: 'prod_1',
};
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-landing-${label}-`));

const batchRecords = () => [
  { record_id: BATCH_A_ID, fields: { 报货批次号: BATCH_A, 到货状态: '未到货', 供应商: [{ text: '大发鞋厂' }], 录入数量: '12' } },
  { record_id: 'batch_arrived', fields: { 报货批次号: 'CGD-20261012-0003', 到货状态: '已到货' } },
];

const createHarness = (options = {}) => {
  const records = {
    purchaseOrderBatch: options.noPending ? [] : batchRecords(),
    purchaseRequest: [{ record_id: 'pr_1', fields: { 报货批次号: [BATCH_A_ID], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 2 } }],
    product: [{ record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } }],
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    behavior: [],
  };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (options.failBatches && key === 'purchaseOrderBatch') throw new Error('模拟读表失败');
      return records[key] || [];
    },
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
  };
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
    texts: SCAN_WRITE.texts,
    events: SCAN_WRITE.events,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: new PurchaseArrivalConversationService({
      gateway,
      store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
      sizeReferences: () => SIZE_STUB,
      confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
      markBatchArrived: async () => ({ updated: true }),
    }),
    store: new JsonTaskStore({ dir: tempDir('session'), idField: 'session_id' }),
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // ⭐ 照 `app.js` 的样子：**同一个 router 实例**挂两个前缀（`/s` 与 `/r`）。
  const router = createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: { table: () => ({ fields: {} }), listAll: async () => [], get: async () => null },
    writeService: false,
    arrivalService: arrival,
    writeConfig: SCAN_WRITE,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return { app, arrival };
};

const sessionCookie = (openId = 'ou_accept_landing') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000 })).toString('base64url');
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
const get = async (base, target) => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie() } });
  return { response, html: await response.text() };
};

// ── AC-AL1 / AC-AL2 ───────────────────────────────────────────────────────
/**
 * ⭐⭐ 2026-10-14 晚（业务负责人口径）：**「`/s/accept` 这条路要彻底拆掉」**
 *
 * ⚠️ **本文件原样保留夹具，只把"验收落地页必须存在"那一族断言**（改前逐字：GET /s/accept ⇒ 200 +
 *    列未到货批次 + 手输兜底 + 进验收模式 …）**改成"必须不存在"** ✓（**不是整份删覆盖** ✗）：
 *    · 路由里**没有** `/accept` 注册 ✓
 *    · 渲染层里**没有**验收那一块的标记（`data-view="acceptance"` / `accept-pending`）✓
 *    · 旧 `?from=accept` **回落销售**（`resolveRealm` 既有口径 ✓ 不报错 ✓）
 *    · **仍成立、照旧不许动**的：加库存走 `InventoryService.applyPurchase` ✓ ·
 *      工作台 `POST /api/workbench/purchase/arrivals/confirm` ✓ · 工作台「采购 → 验收」那屏 ✓
 */
const SRC_DIR = path.join(__dirname, '../src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

test('AC-OFF1 🔴 路由里**没有** `/accept` 注册（扫码页那条路已彻底拆掉）', () => {
  const routes = readSrc('routes/scanPage.js');
  assert.equal(/router\.(get|post)\('\/accept'/.test(routes), false,
    '改前逐字：router.get(\'/accept\'…) 存在 ✓ ⇒ 改后：**必须没有** ✓（依据：她 2026-10-14 晚「这条路要彻底拆掉」）');
});

test('AC-OFF2 🔴 渲染层里**没有**验收那一块的标记（`data-view="acceptance"` / `accept-pending`）', () => {
  const renderer = rendererSource();
  assert.equal(renderer.includes('data-view="acceptance"'), false, '改前逐字：必须有 data-view="acceptance" ✗ ⇒ 改后：必须没有 ✓');
  assert.equal(renderer.includes('accept-pending'), false, '改前逐字：自助块 data-view="accept-pending" ✗ ⇒ 改后：必须没有 ✓');
  assert.equal(/renderAcceptance(Page|DonePage|SelfServe)/.test(renderer), false, '三个验收渲染函数随验收一起退场 ✓');
});

test('AC-OFF3 🔴 旧 `?from=accept` **回落销售**（不报错、不白屏）', () => {
  const { resolveRealm } = require('../src/views/scanPageRealm');
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //   改前逐字：`assert.equal(resolveRealm('accept'), 'accept', 'cut A：领域还在（cut B 删它时才变 sales ✓ 不提前谎报 ✗）');`
  //   改后逐字：`assert.equal(resolveRealm('accept'), 'sales', 'cut B：accept 已退出 REALMS ⇒ 按既有口径回落缺省 ✓');`
  //   依据：cut A 拆的是"路"，cut B 拆的是**领域本身** ⇒ `accept` 现在与 `?from=purchase` /
  //     `?from=accessory` / `?from=new` **同一条口径**：认不出的值回落缺省（销售），不报错、不白屏 ✓
  assert.equal(resolveRealm('accept'), 'sales', 'cut B：accept 已退出 REALMS ⇒ 按既有口径回落缺省 ✓');
  assert.equal(resolveRealm('bogus'), 'sales', '认不出的一律回落缺省（既有口径一字不动 ✓）');
});

test('AC-OFF4 ✅ 仍成立、照旧不许动的（共享能力没跟着删）', () => {
  const routes = readSrc('routes/workbench.js');
  assert.match(routes, /router\.post\('\/purchase\/arrivals\/confirm'/, '工作台"确认到货"接口照旧 ✓');
  const renderer = rendererSource();
  assert.ok(renderer.length > 0);
  const inventory = readSrc('services/inventoryService.js');
  assert.match(inventory, /applyPurchase/, '加库存仍只走 `InventoryService.applyPurchase` ✓');
});
