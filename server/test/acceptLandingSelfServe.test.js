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
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, target) => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie() } });
  return { response, html: await response.text() };
};

// ── AC-AL1 / AC-AL2 ───────────────────────────────────────────────────────
test('AC-AL1/AL2 GET /accept（无 batch）⇒ 200 + 列出未到货批次（可点）+ 手输兜底表单', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, '/s/accept');
    assert.equal(response.status, 200, '她点【验收】进来必须是 200（改前是 400 + 一句"回验收领域"）');
    // ① 列出未到货批次：批次号逐字 + 可点链接（URL 编码）
    assert.ok(html.includes(BATCH_A), `要列出未到货批次 ${BATCH_A}`);
    assert.ok(html.includes(`href="/s/accept?batch=${encodeURIComponent(BATCH_A)}"`),
      '那一条必须是可点的链接，指向 /s/accept?batch=<批次号>');
    assert.ok(html.includes('data-view="accept-pending"'), '用的就是既有那块"未到货批次"');
    assert.ok(html.includes('已到货') === false || html.includes('CGD-20261012-0003') === false,
      '已到货的批次不许列进来');
    // ② 手输兜底：真的有一个输入框（她截图那页**没有输入框**）
    assert.ok(html.includes('data-view="accept-manual"'), '必须有手输兜底那一块');
    assert.ok(/<form method="get" action="\/s\/accept"[^>]*>/.test(html), '手输表单 = GET /s/accept');
    assert.ok(html.includes('name="batch"'), '输入框的字段名必须是 batch');
  });
});

// ── AC-AL3 哨兵 ───────────────────────────────────────────────────────────
test('AC-AL3 哨兵：落地页里**不出现**「回【验收】领域」（那句自相矛盾的话）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, '/s/accept');
    assert.equal(html.includes('回【验收】领域'), false, '她就是从【验收】进来的，不许再让她"回【验收】"');
    assert.equal(html.includes(SCAN_WRITE.texts.acceptBatchMissingBody), false,
      '那句"没带批次号…回验收领域"不许出现在落地页上');
    // 也不许把她支去工作台（既有 AC-AS7 的口径）
    assert.equal(html.includes('工作台'), false);
  });
});

// ── AC-AL4 ────────────────────────────────────────────────────────────────
test('AC-AL4 点一条 ⇒ 进验收模式（200 + data-view="acceptance" + 那一批的批次号）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH_A)}`);
    assert.equal(response.status, 200, `点一条要能进验收（${response.status}）`);
    assert.ok(html.includes('data-view="acceptance"'), '进的是验收模式那一块');
    assert.ok(html.includes(`data-batch="${BATCH_A}"`), '身上要带这一批的批次号');
  });
});

// ── AC-AL5 / AC-AL6 ───────────────────────────────────────────────────────
test('AC-AL5 一个未到货都没有 ⇒ 200 + 一句人话 + 手输兜底仍在', async () => {
  login();
  const h = createHarness({ noPending: true });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, '/s/accept');
    assert.equal(response.status, 200);
    assert.ok(html.includes(SCAN_PAGE.texts.acceptPendingEmptyBody), '一句人话（一个未到货都没有）');
    assert.ok(html.includes('data-view="accept-manual"'), '手输兜底仍在（照样能开工）');
  });
});

test('AC-AL6 读表失败 ⇒ 页面仍 200 + 手输兜底在（不把页面打红）', async () => {
  login();
  const h = createHarness({ failBatches: true });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, '/s/accept');
    assert.equal(response.status, 200, '读表失败也只是"没列出来"，不许 500');
    assert.ok(html.includes('data-view="accept-manual"'), '兜底输入框必须在');
    assert.equal(html.includes(SCAN_PAGE.texts.errorTitle), false, '不许变成"系统出错"页');
  });
});

// ── AC-AL7 ────────────────────────────────────────────────────────────────
test('AC-AL7 手输一个不对的批次号 ⇒ 仍是人话（4xx 不是 500）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, '/s/accept?batch=NOPE-9999');
    assert.ok(response.status >= 400 && response.status < 500,
      `不该 500（实际 ${response.status}）`);
    // 契约：**4xx + 一张看得懂的人话卡**（不白屏、不 5xx、不回显内部细节）。
    assert.ok(/<section class="card state-msg">/.test(html), '必须是一张人话卡（不是白屏）');
    assert.match(html, /<h1>[^<]+<\/h1>/, '要有标题');
    assert.match(html, /<p>[^<]+<\/p>/, '要有正文（"这个批次找不到"这类）');
    assert.equal(/未配置语义字段|TypeError|at .*\.js:\d+/.test(html), false, '不许把内部错误甩给她');
  });
});

// ── AC-AL8 回归 ───────────────────────────────────────────────────────────
test('AC-AL8 回归：**有编号的领域页**（/s/{编号}?from=accept）那块自助块逐字不变', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`);
    assert.equal(response.status, 200);
    assert.ok(html.includes('realm-block--accept'), '仍渲染验收领域那一块');
    assert.ok(html.includes(`href="/s/accept?batch=${encodeURIComponent(BATCH_A)}"`), '批次链接逐字不变');
    assert.ok(html.includes('data-view="accept-manual"'), '手输兜底逐字不变');
  });
});

// ── AC-AL9 两条前缀 ───────────────────────────────────────────────────────
test('AC-AL9 /r/accept（无 batch）⇒ 200，且链接与表单都指向 /r/accept（不写死 /s/）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, '/r/accept');
    assert.equal(response.status, 200, '记录 ID 那条前缀下也要成立');
    assert.ok(html.includes(BATCH_A), '同样列出未到货批次');
    assert.ok(html.includes(`href="/r/accept?batch=${encodeURIComponent(BATCH_A)}"`),
      '链接必须走**当前挂载前缀**（/r），不许写死 /s/');
    assert.ok(/<form method="get" action="\/r\/accept"[^>]*>/.test(html), '手输表单也要 POST/GET 回 /r/accept');
    assert.equal(html.includes('href="/s/accept?batch='), false, '不许把 /r 上的她踢回 /s');
  });
});

// ── AC-AL10 结构哨兵 ──────────────────────────────────────────────────────
test('AC-AL10 结构性：落地页**复用**同一块（同一渲染函数；路由里 pendingBatches 只有一处）', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
  assert.ok(/const renderAcceptanceSelfServe[\s\S]{0,600}acceptPendingBlockHtml\(/.test(renderer),
    '自助落地页必须**复用** `acceptPendingBlockHtml`（不许复制一份列表/表单实现）');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.equal((route.match(/pendingBatches\(/g) || []).length, 1,
    '`pendingBatches()` 只该有**一处**（领域页与落地页共用）');
});
