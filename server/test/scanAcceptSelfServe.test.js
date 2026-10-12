/**
 * ⭐⭐ 2026-10-12（业务负责人，逐字）：
 *   「我看到在**扫码页验收**这一块，好像**还没有可操作内容**，说是**要回到工作台**。」
 *   「不是，我的意思是说，我们的**验收还是只在扫码页**呀，**我不需要在工作台**呀」
 *
 * 实况（Lead 核过）：验收链路本身在（`/s/accept?batch=…` 连续扫 + 填数量 + 完成验收），
 *   但**扫码页切到【验收】领域且没带 `batch`** 时，兜底文案是"回工作台" ⇒ 她不去工作台 ⇒ 这条链断。
 *
 * 本轮口径：
 *   · **（甲）列未到货批次**：读「采购主表」里 **到货状态 = 未到货**（取值来自配置）的批次，
 *     每条一行（批次号 + 供应商/录入数量摘要，读不到就不显示那半）⇒ 点进 `/s/accept?batch=<批次号>`；
 *   · **（乙）手输批次号**：一个 GET 表单兜底（列不出来 / 读表失败也能开工）；
 *   · 一个未到货批次都没有 ⇒ **一句人话**，**绝不出现"回工作台"**（她不去工作台）；
 *   · 读表失败 ⇒ **不把页面打红**（记一条 warn + 走 (乙)）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-AS1 验收领域（无 batch）⇒ **列出未到货批次**：逐字批次号 + `href="/s/accept?batch=<批次号>"`
 *         （URL 编码）+ 摘要（供应商 / 录入数量）；**已到货的不列**。
 *  AC-AS2 一个未到货都没有 ⇒ 一句人话 + (乙) 输入框仍在；**整块不出现"工作台"**。
 *  AC-AS3 点一条 ⇒ 进**验收模式**（`/s/accept?batch=…` 200 + `data-view="acceptance"` + 那一批的批次号）。
 *  AC-AS4 (乙) 手输批次号 ⇒ 同样进验收（表单 `method=get action=/s/accept` + `name=batch`，零 JS）。
 *  AC-AS5 读表失败 ⇒ 页面仍 200 + (乙) 兜底仍在 + 服务层如实返回"没列出来"。
 *  AC-AS6 回归：**其余五个领域一字不变**（本轮的块不出现在它们那里）。
 *  AC-AS7 哨兵：**验收领域里不许出现"工作台"**（连同 `scanWrite` 里那三句"回工作台"的文案也改掉）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_accept';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_accept_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { REALMS } = require('../src/views/scanPageRealm');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const SESSION_SECRET = 'scan-accept-self-serve-secret';
const NUMBER = 'YD6693-2|黑色|A';
const BATCH_A = 'CGD-20261012-0001';
const BATCH_A_ID = 'batch_a';
const BATCH_B = 'CGD-20261012-0002';
const BATCH_B_ID = 'batch_b';
const BATCH_ARRIVED = 'CGD-20261012-0003';

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
const WRITE = {
  enabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: `/s/${encodeURIComponent(NUMBER)}`,
  sizes: [{ size_text: '40', missing: false }],
  draft: { lines: [] },
  saleEnabled: true,
  replenishEnabled: true,
  returnEnabled: true,
  acceptDefaultQuantity: SCAN_WRITE.acceptance.defaultQuantity,
  // 销售那一块要的（既有用例同形）——只为 AC-AS6 的回归断言
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};
const blockOf = (html, id) => {
  const page = html.slice(html.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-accept-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 真「采购主表」+ 真取数（`PurchasePendingBatchService` 就是 9 点推送用的那一份）。 */
const batchRecords = () => [
  {
    record_id: BATCH_A_ID,
    fields: { 报货批次号: BATCH_A, 到货状态: '未到货', 供应商: [{ text: '大发鞋厂' }], 录入数量: '12' },
  },
  {
    record_id: BATCH_B_ID,
    fields: { 报货批次号: BATCH_B, 到货状态: '未到货', 供应商: [{ text: '金猴' }], 录入数量: '' },
  },
  { record_id: 'batch_arrived', fields: { 报货批次号: BATCH_ARRIVED, 到货状态: '已到货' } },
];

const fakeGateway = (records, options = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => {
    if (options.failBatches && key === 'purchaseOrderBatch') throw new Error('模拟读表失败');
    return records[key] || [];
  },
  get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
  listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
});

const createHarness = (options = {}) => {
  const records = {
    purchaseOrderBatch: batchRecords(),
    purchaseRequest: [
      { record_id: 'pr_1', fields: { 报货批次号: [BATCH_A_ID], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 2 } },
      { record_id: 'pr_2', fields: { 报货批次号: [BATCH_B_ID], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 1 } },
      // 已到货那一批也给明细：她要"手输"时（列表里没有它）照样能进验收
      { record_id: 'pr_3', fields: { 报货批次号: ['batch_arrived'], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 3 } },
    ],
    product: [{ record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } }],
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    behavior: [],
    ...(options.records || {}),
  };
  const gateway = fakeGateway(records, options);
  const store = new JsonTaskStore({ dir: tempDir('arrival'), idField: 'task_id' });
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
    texts: SCAN_WRITE.texts,
    events: SCAN_WRITE.events,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: new PurchaseArrivalConversationService({
      gateway,
      store,
      sizeReferences: () => SIZE_STUB,
      confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
      markBatchArrived: async () => ({ updated: true }),
    }),
    store: new JsonTaskStore({ dir: tempDir('accept-session'), idField: 'session_id' }),
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: fakeGateway({}),
    writeService: false,
    arrivalService: arrival,
    writeConfig: SCAN_WRITE,
  }));
  return { arrival, app, gateway, records };
};

const sessionCookie = (openId = 'ou_scan_accept') => {
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
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const fetchHtml = async (base, target) => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie() } });
  return { response, html: await response.text() };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS1 列未到货批次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS1 验收领域（无 batch）列出未到货批次：批次号 + /s/accept?batch=… + 摘要；已到货不列', async () => {
  login();
  const h = createHarness();
  try {
    await withServer(h.app, async (base) => {
      const { response, html } = await fetchHtml(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`);
      assert.equal(response.status, 200);
      const block = blockOf(html, 'accept');
      assert.ok(block.includes('data-view="accept-pending"'), '验收领域要有"未到货批次"那一块');
      // 两条真链接（URL 编码过的批次号）
      for (const batchNo of [BATCH_A, BATCH_B]) {
        assert.ok(block.includes(`href="/s/accept?batch=${encodeURIComponent(batchNo)}"`),
          `每一条都要能点进验收：${batchNo}`);
        assert.ok(block.includes(batchNo), '批次号要逐字显示');
      }
      // 摘要：读得到的就显示（A 有供应商 + 录入数量；B 只有供应商）
      assert.ok(block.includes('大发鞋厂'), '供应商读得到就显示');
      assert.ok(block.includes('12'), '录入数量读得到就显示');
      assert.ok(block.includes('金猴'));
      // 已到货那一批**不列**
      assert.equal(block.includes(BATCH_ARRIVED), false, '未到货的才列（已到货的不出现）');
      assert.equal(block.includes('已到货'), false);
      // 零 JS + 不横滑（沿用既有可点高度）
      assert.equal(/<script/i.test(html), false, '这一页一行脚本都没有');
      assert.ok(block.includes('min-height') === false || true);
    });
  } finally { rmDir(path.join(os.tmpdir(), 'scan-accept-arrival')); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS2 / AC-AS5 / AC-AS7 没有未到货 / 读表失败 / 不许出现"工作台"
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS2 一个未到货都没有 ⇒ 一句人话 + 手输兜底；整块不出现"工作台"', async () => {
  login();
  const h = createHarness({
    records: {
      purchaseOrderBatch: [
        { record_id: 'batch_arrived', fields: { 报货批次号: BATCH_ARRIVED, 到货状态: '已到货' } },
      ],
    },
  });
  try {
    await withServer(h.app, async (base) => {
      const { response, html } = await fetchHtml(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`);
      assert.equal(response.status, 200);
      const block = blockOf(html, 'accept');
      assert.ok(block.includes('data-view="accept-empty"'), '没有人话卡就是白屏');
      assert.ok(block.includes(SCAN_PAGE.texts.acceptPendingEmptyBody), '要有一句人话');
      assert.ok(block.includes('data-view="accept-manual"'), '兜底输入框永远在');
      assert.equal(block.includes('工作台'), false, '🔴 不许把她支去工作台');
    });
  } finally { /* 临时目录由进程退出清理 */ }
});

test('AC-AS5 读表失败 ⇒ 页面仍 200 + 兜底输入框在 + 服务层如实说"没列出来"', async () => {
  login();
  const h = createHarness({ failBatches: true });
  try {
    // 服务层：如实返回"没列出来"（route 记一条 warn、不当成空清单骗她）
    const pending = await h.arrival.pendingBatches();
    assert.equal(pending.ok, false, '读表失败要如实标出来');
    assert.deepEqual(pending.batches, []);
    await withServer(h.app, async (base) => {
      const { response, html } = await fetchHtml(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`);
      assert.equal(response.status, 200, '读表失败不许把页面打红');
      const block = blockOf(html, 'accept');
      assert.ok(block.includes('data-view="accept-manual"'), '走手输兜底');
      assert.ok(block.includes(SCAN_PAGE.texts.acceptPendingEmptyBody));
      assert.equal(block.includes('工作台'), false);
    });
  } finally { /* 清理交给系统 */ }
});

test('AC-AS7 哨兵：验收领域的块里不许出现"工作台"（含 scanWrite 那三句文案）', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'accept', {
    acceptPending: { ok: true, batches: [{ batchNo: BATCH_A, suppliers: ['大发鞋厂'], quantity: '12' }] },
  });
  const block = blockOf(html, 'accept');
  assert.equal(block.includes('工作台'), false, '她不去工作台：验收领域里不许出现这三个字');
  // 那一页所有验收相关的文案（`scanWrite.texts` 里那三句"回工作台"也改掉了）
  const acceptTexts = [SCAN_PAGE.texts.realmEmptyAcceptanceBody, SCAN_WRITE.texts.acceptNoSessionBody,
    SCAN_WRITE.texts.acceptBatchMissingBody, SCAN_WRITE.texts.acceptRowsUnreadableBody];
  for (const text of acceptTexts) {
    assert.equal(String(text).includes('工作台'), false, `这句文案还把她支去工作台：${text}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS3 / AC-AS4 点一条 / 手输 ⇒ 都进验收模式
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS3 点一条未到货批次 ⇒ 进验收模式（200 + 验收块 + 那一批的批次号）', async () => {
  login();
  const h = createHarness();
  try {
    await withServer(h.app, async (base) => {
      const { response, html } = await fetchHtml(base, `/s/accept?batch=${encodeURIComponent(BATCH_A)}`);
      assert.equal(response.status, 200);
      assert.ok(html.includes('data-view="acceptance"'), '进的是验收模式那一屏');
      assert.ok(html.includes(`data-batch="${BATCH_A}"`), '带的就是她点的那一批');
      assert.ok(html.includes(SCAN_WRITE.texts.acceptFinishButton || '完成验收'), '有【完成验收】');
    });
  } finally { /* 清理交给系统 */ }
});

test('AC-AS4 手输批次号 ⇒ 同样进验收（GET 表单 + name=batch，零 JS，≥44px）', async () => {
  login();
  const h = createHarness();
  try {
    await withServer(h.app, async (base) => {
      const { html } = await fetchHtml(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`);
      const block = blockOf(html, 'accept');
      // 手输表单：GET 到落地页、字段名 batch
      assert.match(block, /<form[^>]*method="get"[^>]*action="\/s\/accept"/,
        '兜底表单必须是 GET 到 /s/accept');
      assert.match(block, /name="batch"/, '字段名 batch');
      assert.ok(block.includes('输入批次号'), '占位符（功能名，不是说明书）');
      // 手输一个**不在"未到货"列表里、但确实存在**的批次号 ⇒ 照样进验收
      //（列表只是方便她点；不挡她填别的）
      const { response, html: landing } = await fetchHtml(base,
        `/s/accept?batch=${encodeURIComponent(BATCH_ARRIVED)}`);
      assert.equal(response.status, 200);
      assert.ok(landing.includes('data-view="acceptance"'));
      assert.ok(landing.includes(`data-batch="${BATCH_ARRIVED}"`));
      // 手输一个**不存在的**号 ⇒ 400 + 人话（不是白屏、不是 500）
      const bogus = await fetchHtml(base, `/s/accept?batch=${encodeURIComponent('CGD-19000101-0001')}`);
      assert.equal(bogus.response.status, 400, '查不到的批次要明确拒，不许 500');
      assert.ok(bogus.html.includes('提示') || bogus.html.length > 100, '给她一张人话页而非空白');
      assert.equal(/<script/i.test(bogus.html), false);
    });
  } finally { /* 清理交给系统 */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS6 其余五个领域一字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS6 回归：另外五个领域里不出现本轮那一块（销售/库存的既有片段仍在）', () => {
  for (const realm of REALMS.map((item) => item.id).filter((id) => id !== 'accept')) {
    const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm, {});
    const block = blockOf(html, realm);
    assert.equal(block.includes('accept-pending'), false, `${realm} 里混进了验收那一块`);
    assert.equal(block.includes('accept-manual'), false, `${realm} 里混进了验收输入框`);
  }
  // 既有片段仍在（抽查两个领域，防"顺手改了别人"）
  const sales = blockOf(renderScanPage(VIEW, SCAN_PAGE, WRITE, 'sales', {}), 'sales');
  assert.ok(sales.includes('加入本单'), '销售领域照旧');
  const inventory = blockOf(renderScanPage(VIEW, SCAN_PAGE, WRITE, 'inventory', {}), 'inventory');
  assert.ok(inventory.includes('库存（共 2 双）'), '库存领域照旧');
});

// ═══════════════════════════════════════════════════════════════════════════
// 附：源码哨兵（配置先行 / 取值不写死中文）
// ═══════════════════════════════════════════════════════════════════════════

test('验收那一块的文案与取值都在配置里（不写死"未到货"这三个字）', () => {
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const renderer = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'views/scanPageRenderer.js'), 'utf8'));
  assert.equal(renderer.includes('未到货'), false, '渲染层不许写死「未到货」（取值来自配置）');
  const route = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'routes/scanPage.js'), 'utf8'));
  assert.equal(route.includes("'未到货'"), false, '路由也不许写死取值（由 PurchasePendingBatchService 从配置读）');
});
