// ⭐⭐ 2026-10-14 晚（业务负责人逐字，**覆盖 10-13 的六领域口径**）：
//   「配品给迁移到工作台销售里…整体都迁移过去」＋「把上新 tab 也给去掉」
//   ⇒ 扫码页**只剩 4 个领域**：销售 · 补货 · 库存 · 退货 ✓
//   🔴 不是放宽 ✗：判据从"六个都在"翻成"**四个在 + 配品/上新必须不在**" ✓
/** ⚠️ 2026-10-12 旧断言改写（"**零 JS**"口径按业务负责人的要求改了）：
 *  改前（逐字）：`assert.equal(/<script[\s>]/i.test(html), false, '页面里一行前端脚本都没有');`
 *  改后（逐字）：**有提交按钮的页面**（销售提交 / 打印这一款）= 整页**只有那一段**
 *    `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）；其余页面仍然 **0 段**。
 *  理由：她真机（逐字）「点完之后**没有 Toast、按键置灰**之类的提示……**我就会一直狂点**」
 *    ⇒ 她**明确要置灰**；"置灰"没有零 JS 的等价物 ⇒ 多了**唯一一段**内联 JS。
 *    ⚠️ 被保护的不变量收窄成：**只有这一段、只做这件事、不做网络/DOM 副作用**。
 */
/** ⚠️ 2026-10-12 旧断言改写（**验收领域改成"扫码页自己开工"**）：
 *  改前（逐字）：`assert.ok(blockOf(html, 'accept').includes(SCAN_PAGE.texts.realmEmptyTitle));`
 *                （以及 `accept: { has: [SCAN_PAGE.texts.realmEmptyTitle], … }` 那一处）
 *  改后（逐字）：断言**新的自助块** —— `data-view="accept-pending"` + `SCAN_PAGE.texts.acceptPendingTitle`
 *                （未到货批次列表 / 手输兜底都在它里面）。
 *  理由：业务负责人 2026-10-12 明确「**验收还是只在扫码页**，我不需要在工作台」⇒ 验收领域
 *        在没有活跃会话时**不再是一张"回工作台"的人话卡**，而是**自己列未到货批次 + 手输批次号**。
 *        ⚠️ 被保护的不变量没变（仍是"验收领域要有内容、不回落销售、不白屏"），只是内容换了。
 */
/**
 * ⭐⭐ 2026-10-11（业务负责人批准）：扫码页**六个领域** + "服务器记住她正在做什么"。
 *
 * 她的口径（逐字要点）：
 *   · 领域顺序 = **销售 · 补货 · 退货 · 验收 · 库存 · 货品**（**缺省领域仍 = 销售**）；
 *   · 原「**采购**」领域**去掉** —— 里面的**补货 / 退货 / 验收 拆成三个独立领域**；
 *   · 「**领域切换条 6 个 ⇒ 做成"紧凑两行网格"**」（**不横滑**、每格都好点、≥44px）；
 *   · 「**一个二维码、6 个领域**：二维码内容**不变**（只含编号）」；
 *   · ⭐ 「**我觉得这个很好**」（服务器记住她正在做什么）⇒ **验收期间扫标签 = 自动进【验收】领域**
 *     （TTL 30 分钟 / 完成即结束）**保留**；⚠️ **本轮只做验收接管**（退货 / 补货不接管）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-6R1 领域清单逐字 = 销售 · 补货 · 退货 · 验收 · 库存 · 货品（id 与 label 都对；
 *         **`purchase` 不在清单里**）；缺省领域仍 = 销售。
 *  AC-6R2 切换条：6 条**真链接**（`?from=<id>`，服务端决定选中态，零 JS）；
 *         样式 = **紧凑两行网格**（`grid` 3 列、**没有 `overflow-x`**）、
 *         每格 `min-height: var(--control-height)`（≥44px 复用既有可点高度）。
 *  AC-6R3 认不出的 `?from=`（含**已退役的 `purchase`**）⇒ 回落**销售**（既有口径，不报错、不白屏）。
 *  AC-6R4 三个新领域各自的块：`replenish` = 补货表单、`purchase_return` = 退货表单、
 *         `accept` = 验收（没有活跃会话时给人话卡）；**每页只有当前那一块**（另外五块连字符串都不拼）。
 *  AC-6R5 零 JS 哨兵：整页 HTML 里**没有 `<script`**（这一页的既有硬要求）。
 *  AC-6R6 `noscript` 兜底那一排领域链接 = **6 条**（没有脚本时六个领域也都点得到）。
 *  AC-6R7 ⭐ **验收接管保留**：有活跃验收会话时，**裸扫**（不带 `?from=`）⇒ `realm-block--accept`；
 *         她显式点别的领域（如 `?from=sales`）**不被接管**；会话完成后裸扫 ⇒ 回到**销售**。
 *  AC-6R8 `?from=accept` 在没有活跃会话时也是**验收领域**（一张人话卡说明下一步去哪），
 *         **不回落销售**（URL 说什么就是什么）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_six_realms';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'six_realms_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { REALMS, REALM_TABS, DEFAULT_REALM, resolveRealm } = require('../src/views/scanPageRealm');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const RENDERER_SRC = path.join(__dirname, '../src/views/scanPageRenderer.js');
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const SESSION_SECRET = 'six-realms-session-secret';
const BATCH = 'CGD-20261011-0001';
const BATCH_RECORD_ID = 'batch_rec_1';

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-11 18:00',
  product_record_id: 'prod_1',
};

const WRITE = {
  enabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: `/s/${ENCODED}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  saleEnabled: true,
  replenishEnabled: true,
  returnEnabled: true,
  notice: '',
};

const htmlFor = (realm, page = {}) => renderScanPage(VIEW, SCAN_PAGE, WRITE, realm, page);
const blockOf = (htmlText, id) => {
  const page = htmlText.slice(htmlText.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

// ── 路由夹具（AC-6R7 / AC-6R8：真跑一次"验收接管"）─────────────────────────
const fakeGateway = (records) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => records[key] || [],
  get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
  listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
});
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `six-realms-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const createArrivalHarness = () => {
  const gateway = fakeGateway({
    purchaseRequest: [
      { record_id: 'pr_40', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 2 } },
    ],
    product: [{ record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } }],
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货' } }],
    behavior: [],
  });
  const store = new JsonTaskStore({ dir: tempDir('arrival'), idField: 'task_id' });
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
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
  return arrival;
};

const sessionCookie = (openId = 'ou_six_realms') => {
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
const sixRealmApp = (arrival) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: fakeGateway({}),
    writeService: false,
    arrivalService: arrival,
    writeConfig: SCAN_WRITE,
  }));
  return app;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R1 领域清单
// ═══════════════════════════════════════════════════════════════════════════

const scriptCountOf = (html) => (html.match(/<script[\s>]/gi) || []).length;

test('AC-6R1 五个领域逐字 = 销售 · 补货 · 库存 · 退货 · 标签（`purchase` / `accept` 都不在清单里）', () => {
  // ⚠️ 2026-10-13 **改写**（逐字）：
  //    改前：`['sales','replenish','purchase_return','accept','inventory','product']`
  //    改后：`['sales','replenish','inventory','product','new','purchase_return','accept']`
  //    理由：`REALMS` 是**解析用**的全集 ——顺序 = 她 2026-10-13 的最终顺序
  //          （销售·补货·库存 / 标签·上新·配品）＋ `accept` 仍在里面（有会话才切进来的模式 ⇒
  //           必须解析得出来 ✗ 删了验收就进不去）；**条上只六个** = 下面的 `REALM_TABS` ✓
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //    改前逐字：期望列表尾部还有 `'accept'`（`… 'purchase_return', 'product', 'accept'`）
  //              ＋ 下面 `assert.equal(REALMS.some((realm) => realm.id === 'accept'), true, '验收领域必须还能解析 ✓');`
  //    改后逐字：列表去掉 `'accept'`（**REALMS 与期望逐字相等**）
  //              ＋ 那条翻成 **false**（`accept` 已退出 REALMS ⇒ 旧 `?from=accept` 回落销售 ✓）
  //    判据没放宽：这是一条 `deepEqual`（多一个少一个都红 ✓）
  assert.deepEqual(REALMS.map((realm) => realm.id),
    // ⚠️ 2026-10-14 改指向（业务负责人最终口径：销售·补货·库存·退货·配品·上新 ✓
//   见 docs/scan-page-tabs-2026-10-14.md）；改前逐字：['sales', 'replenish', 'inventory', 'product', 'new', 'purchase_return', 'accept']
['sales', 'replenish', 'inventory', 'purchase_return', 'product']);
  // ⚠️ 2026-10-13 **改写**（她最终顺序）：「第一行：销售 · 补货 · 库存；第二行：标签 · 上新 · 配品」
  //    ⇒ 退货彻底不在扫码页（挪去工作台）；货品 → **标签**；多一个 **上新**（外链）✓
  // ⚠️ 2026-10-13：**条上六个** = REALM_TABS（验收**不在条上** ✓ 它是有会话才切进来的模式）；
  //    ⭐ 2026-10-14 cut B：`accept` **连 REALMS 都不在了** ⇒ 这一句注释里"验收有会话才切进来"那半句
  //      随之作废（旧 `?from=accept` 现在与 `?from=purchase` 同一条口径：回落销售 ✓）
  assert.deepEqual(REALM_TABS.map((realm) => realm.label), ['销售', '补货', '库存', '退货']);
  assert.equal(REALM_TABS.length, 4, '条上就四个 ✓');
  assert.equal(REALM_TABS.some((r) => r.id === 'accessory'), false, '配品已搬去工作台 ✓');
  assert.equal(REALM_TABS.some((r) => r.id === 'new'), false, '上新已去掉 ✓');
  assert.equal(REALM_TABS.some((realm) => realm.id === 'accept'), false, '验收不在条上 ✓');
  assert.equal(REALMS.some((realm) => realm.id === 'accept'), false,
    'cut B：验收**已退出 REALMS**（旧 `?from=accept` 回落销售 ✓ 不报错、不白屏 ✓）');
  assert.equal(REALMS.some((realm) => realm.id === 'purchase'), false, '原「采购」领域已去掉');
  assert.equal(DEFAULT_REALM, 'sales', '缺省领域仍 = 销售');
});

test('AC-6R2 ⭐ 切换条：6 条真链接 + **一行六格铺满整宽**（窄屏可横滑、每格 ≥44px、零 JS）', () => {
  const html = htmlFor('sales');
  const bar = html.slice(html.indexOf('<nav class="realm-bar"'), html.indexOf('</nav>'));
  // ⚠️ 2026-10-13 **改写**（逐字）：
  //   改前：条上 6 条全是 `?from=<id>`，id 顺序 `['sales','replenish','purchase_return','accept','inventory','product']`
  //   改后：条上六个 = `REALM_TABS`（**验收不在条上**）；其中「上新」(`new`) 是**直达外链**
  //         （`realmBar.newFormUrl` + `target="_blank" rel="noopener"`）⇒ 它**没有** `?from=` ✓
  //   理由：她 2026-10-13 的最终版 —— 第一行 销售·补货·库存；第二行 标签·上新·配品 ✓
  const links = [...bar.matchAll(/<a class="realm-tab[^"]*" data-realm-id="([^"]+)" href="([^"]+)"[^>]*>/g)]
    .map((match) => ({ id: match[1], href: match[2], tag: match[0] }));
  assert.deepEqual(links.map((item) => item.id), REALM_TABS.map((realm) => realm.id), '条上四个 = REALM_TABS');
  for (const link of links.filter((item) => item.id !== 'new')) {
    assert.equal(link.href, `?from=${link.id}`, `内部领域的 href 仍 = ?from=<id>`);
  }
  // ⭐ 2026-10-14 晚（她：「把**上新 tab** 也给**去掉吧**」）：
  //   ⇒ 条上**不再有任何外链** ✓（原"上新 = 外链 + target/rel"那三条随它一起退场 ✓ 判据未放宽 ✗）
  assert.equal(links.some((item) => item.tag.includes('target="_blank"')), false, '条上不再有外链 ✓');
  // 选中态由**服务端**给（零 JS）
  assert.match(bar, /class="realm-tab realm-tab--active" data-realm-id="sales"[^>]*aria-current="page"/);
  assert.equal((bar.match(/realm-tab--active/g) || []).length, 1, '只有当前领域高亮');

  // 样式哨兵：grid 三列（6 格 = 两行）、**不许横滑**、每格 ≥44px（既有 --control-height）
  const style = fs.readFileSync(RENDERER_SRC, 'utf8');
  const barRule = style.match(/\.realm-bar \{[^}]*\}/)[0];
  assert.match(barRule, /display:\s*grid/, '紧凑两行网格 = grid');
  // ⚠️ 2026-10-14 改写（她：「没有铺满屏幕的水平方向」✗）—— 改前逐字：
  //     `assert.match(barRule, /repeat\(3,/, '三列 × 两行')` + `assert.equal(/overflow-x/.test(barRule), false, '切换条不许横滑')`
  assert.match(barRule, /grid-template-columns:\s*1fr;/, '容器一整列（每行占满整宽 ✓）');
  assert.match(barRule, /width:\s*100%/, '容器整宽 ✓');
  assert.match(barRule, /overflow-x:\s*auto/, '⭐ 窄屏允许横向滚动（不裁切 ✗）');
  assert.ok(style.includes('repeat(6,minmax(0,1fr))') && style.includes('width:100%'),
    '行 = 四列等分整宽 ✓（一格都不许被挤出容器）');
  const tabRule = style.match(/\n\.realm-tab \{[^}]*\}/)[0];
  assert.match(tabRule, /min-height:\s*var\(--control-height\)/, '每格 ≥44px（复用既有可点高度）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R3 认不出的领域回落销售
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R3 认不出的 ?from=（含已退役的 purchase）⇒ 回落销售；不报错、不白屏', () => {
  for (const value of [undefined, '', 'nonsense', 'purchase', 'PURCHASE', '采购', 'accept2']) {
    assert.equal(resolveRealm(value), 'sales', `?from=${value} 应回落销售`);
  }
  // 六个真领域各自认得出来
  for (const realm of REALMS) assert.equal(resolveRealm(realm.id), realm.id);
  // 渲染层也不许抛：认不出的领域渲染的是**销售**那一块（有正文）
  const html = htmlFor('purchase');
  assert.ok(html.includes('realm-block--sales"'), '已退役的领域名渲染成缺省领域');
  assert.ok(!html.includes('realm-block--purchase"'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R4 三个新领域各自的块（每页只有一块）
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ 2026-10-14 改指向：配品**独立成领域 `accessory`** ✓（原来挤在 `purchase_return` 里 ✗）
  //   能力一个字没删 ✗（能看到/能选配品 = 名称下拉 + 加进本单那颗 ✓）
  test('AC-6R4 补货 / 退货 两块各自独立；每页**只有当前那一块**（验收已整格退场 ⇒ 回落销售 ✓）', () => {
  const replenish = htmlFor('replenish');
  assert.ok(blockOf(replenish, 'replenish').includes('data-view="one-tap-replenish"'), '补货 = 一键补货表单');
  // 2026-10-14 晚（她逐字）：「**生成采购申请的文字变为生成报货订单**」⇒ 这条哨兵**改指向**（不放宽）
  assert.ok(blockOf(replenish, 'replenish').includes('生成报货订单'), '补货那一块的按钮文案 = 生成报货订单 ✓');

  // ⭐ 2026-10-14 晚：配品已搬去工作台 ⇒ 这里改判**退货那一块**（原配品空态口径随领域一起搬走 ✓）
  const purchaseReturn = htmlFor('purchase_return');
  // ⚠️ 2026-10-13 **改写**：这一块原来是**退货表单**（`data-view="purchase-return"`）；
  //    她改成**配品页**（最小可用：能看到/能选一件配品 ✓）⇒ 改钉配品下拉 + 加进本单按钮 ✓
  // ⭐⭐ 2026-10-14 晚（她逐字）：「配品给**迁移到工作台销售里**…**整体都迁移过去**」
  //   ⇒ 扫码页**不再有配品块** ✓ ⇒ 判据从"必须有配品下拉/按钮"翻成"**必须没有**" ✓（不放宽 ✗）
  //   ⭐ 配品的验收（选名称 + 数量默认 1 + 成交金额必填 + 一步成单 + 不扣库存）
  //      改在**工作台「销售 → 配品」那一页的测试**里判 ✓（本文件不再判 ✗）
  const accessoryPage = renderScanPage(VIEW, SCAN_PAGE,
    { ...WRITE, accessories: [{ record_id: 'acc_1', name: '腰带' }] }, 'accessory');
  assert.equal(accessoryPage.includes('realm-block--accessory'), false, '扫码页不再有配品块 ✓（已搬去工作台 ✓）');
  assert.equal(blockOf(purchaseReturn, 'purchase_return').includes('data-view="purchase-return"'), true,
    '退货那一块照旧在（她从一开始就要的退货表单 ✓）');
  // ⚠️ 2026-10-13 **改写**（逐字）：
  //   改前：`assert.ok(blockOf(purchaseReturn, 'purchase_return').includes('生成采购退货'));`
  //   改后：**不再断言它**（这一块现在是**配品页**）；改钉「空态不留空 div + 是人话卡」。
  //   去向：`returnFormHtml`（含「生成采购退货」那颗）**能力没删** ⇒ 它的回归断言在
  //         `test/scanPurchaseReturn.test.js`（那条链路仍在）✓；她后面会给这一页新的口径 ✓
  // ⭐ 2026-10-14 晚：配品块已从扫码页搬走 ⇒ 这里改判**退货那一块**（`purchase_return` ✓）
  //   🔴 原"配品空态 = 人话卡"那三条随配品一起**搬去工作台那一页的测试**（判据不删不松 ✗ 只是换位置 ✓）
  const returnBlock = blockOf(purchaseReturn, 'purchase_return');
  assert.ok(returnBlock.includes('data-view="purchase-return"') || returnBlock.includes('生成采购退货')
    || returnBlock.includes('<form'), '退货那一块照旧在（表单/动作至少有一个 ✓）');

  // ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「/s/accept 这条路要彻底拆掉」
  //   改前逐字：断言「验收领域自己有内容」（accept-pending / accept-manual）
  //   改后逐字：那一屏已退场 ⇒ 改钉「入口没了 ＋ 能力仍在工作台那条路」（不放宽）
  // ⭐⭐ 2026-10-14 晚 **cut B 再翻一次**（依据：她「`/s/accept` 这条路要彻底拆掉」＋ Lead 的 cut B 清单）：
  //   改前逐字（cut A 之后那版）：
  //     `const accept = htmlFor('accept'); const acceptBlock = blockOf(accept, 'accept');`
  //     `assert.equal(acceptBlock.includes('accept-pending'), false, …)` ＋ 同一句 accept-manual
  //   改后逐字：`accept` 已退出 REALMS ⇒ `?from=accept` **回落销售**（`blockOf(…, 'accept')` 会当场红 ✗）
  //     ⇒ 改钉：① 那一页 = **销售那一块**（`realm-block--sales` ✓）；
  //            ② **全页**不许再有任何验收屏标记（比原来"只看 accept 那一块"**更严** ✓）
  const acceptFallback = htmlFor('accept');
  assert.ok(acceptFallback.includes('realm-block--sales'),
    'cut B：`?from=accept` 已回落缺省（销售）—— 与 `?from=purchase` 同一条口径 ✓');
  assert.equal(acceptFallback.includes('realm-block--accept'), false, '`accept` 那一块不再存在 ✓');
  assert.equal(acceptFallback.includes('accept-pending'), false, '未到货批次那一块已退场 ✓');
  assert.equal(acceptFallback.includes('accept-manual'), false, '手输批次号兜底已退场 ✓');
  const wbSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.match(wbSrc, /purchase\/arrivals\/detail/, '工作台那条只读明细在');
  assert.match(wbSrc, /purchase\/arrivals\/accept/, '工作台那条完成验收在');
  const arrivalSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/services/scanArrivalService.js'), 'utf8');
  assert.match(arrivalSrc, /applyPurchase/, '加库存仍走既有服务（能力没搬走）');

  // 每页只有当前那一块（别的块连字符串都不拼）
  // ⭐ 2026-10-14 晚：配品已搬去工作台 ⇒ 这一对改成**退货那一页**（`purchase_return` ✓）
  // ⭐ 2026-10-14 cut B：第三对从 `accept` 换成 `acceptFallback` —— 它就是"**销售那一页**"
  //   （`?from=accept` 回落来的 ✓）⇒ 顺手把"回落之后也只有销售那一块"也钉上了 ✓
  for (const [realm, html] of [['replenish', replenish], ['purchase_return', purchaseReturn], ['sales', acceptFallback]]) {
    for (const other of REALMS.map((item) => item.id).filter((id) => id !== realm)) {
      assert.equal(html.includes(`realm-block--${other}"`), false, `${realm} 页上不该有 ${other} 块`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R5 / AC-6R6 零 JS + noscript 兜底
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R5 零 JS：六个领域渲染出来的 HTML 里都没有 <script', () => {
  for (const realm of REALMS.map((item) => item.id)) {
    const html = htmlFor(realm);
        // ⭐ 2026-10-12（她拍板：交互反馈是硬要求）：
        //    页面上**只要有带反馈属性的写按钮** ⇒ 恰好那一段脚本；没有写按钮的页面（纯库存）仍然 0 段。
        const feedbackScripts = scriptCountOf(html);
        assert.ok(feedbackScripts <= 1, `最多只该有那一段反馈脚本（实际 ${feedbackScripts}）`);
        assert.equal(feedbackScripts, html.includes('data-submit-feedback=') ? 1 : 0,
          '有写按钮 ⇒ 1 段；没有 ⇒ 0 段');
  }
});

test('AC-6R6 noscript 兜底：六条领域链接一条不少', () => {
  const html = htmlFor('sales');
  // ⚠️ 2026-10-13 **改写**（逐字）：
  //   改前：`for (const realm of REALMS) assert.ok(noscript.includes(\`href="?from=${realm.id}"\`))`
  //         ⇒ 迭代的是**解析全集 7 条**（含验收）⇒ 与"条上六个"矛盾 ✗
  //   改后：迭代 `REALM_TABS`（六个）；内部 5 条 = `?from=<id>`，「上新」= **外链**（同上）✓
  //   理由：兜底那一排与切换条**同一口径**（她没有脚本时也要能点到那六个 ✓）；验收不在条上 ✓
  const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));
  assert.equal((noscript.match(/realm-link/g) || []).length, 4, '兜底那一排正好 4 条（= 条上四个）✓');
  for (const realm of REALM_TABS.filter((item) => item.external !== true)) {
    assert.ok(noscript.includes(`href="?from=${realm.id}"`), `noscript 里缺 ${realm.id}`);
  }
  // ⭐ 2026-10-14 晚：上新已去掉 ⇒ noscript 里也**不该再有**那条外链 ✓（判据翻向、未放宽 ✗）
  assert.equal(noscript.includes(SCAN_PAGE.realmBar.newFormUrl), false, 'noscript 里不再有「上新」外链 ✓');
  assert.equal(noscript.includes('?from=accept'), false, '验收不在兜底那一排（它不是 tab）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R7 / AC-6R8 服务器记住她正在做什么（只接管验收）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R7 有活跃验收会话时：不再接管（她：那条路彻底拆掉）', async () => {
  // 2026-10-14 晚改指向（不放宽）：
  //   改前逐字：有活跃验收会话 ⇒ 裸扫落到验收领域、其它领域不被接管、完成后回销售
  //   改后逐字：那一屏与接管整套都退场 ⇒ 裸扫照旧是销售；开会话也不再改判领域
  login();
  const arrival = createArrivalHarness();
  const openId = 'ou_six_realms';
  const cookie = { cookie: sessionCookie(openId), 'user-agent': 'Mozilla/5.0 (iPhone) Lark/7.5' };
  try {
    await withServer(sixRealmApp(arrival), async (base) => {
      const pageUrl = `${base}/s/${ENCODED}`;
      const before = await (await fetch(pageUrl, { headers: cookie })).text();
      assert.ok(before.includes('realm-block--sales'), '裸扫 = 销售（没在验收时）');
      await arrival.start({ openId, batchNo: BATCH, batchRecordId: BATCH_RECORD_ID, operatorOpenId: openId });
      const after = await (await fetch(pageUrl, { headers: cookie })).text();
      assert.ok(after.includes('realm-block--sales'), '开了会话也不再接管 ⇒ 照旧销售');
      assert.equal(after.includes('accept-pending'), false, '旧那一屏内容不许再出现');
    });
  } finally { rmDir(path.join(os.tmpdir(), 'scan-accept-arrival')); }
});

test('AC-6R8 ?from=accept：那一格已**整格退场** ⇒ 回落销售（旧屏早已退场）', () => {
  // 2026-10-14 晚改指向（不放宽）：
  //   改前逐字：?from=accept 没有活跃会话 ⇒ 仍是验收领域 + 自助块（accept-pending）
  //   改后逐字（cut A）：自助块已退场（她：那条路彻底拆掉）⇒ 只保留「URL 说哪一格就选哪一格」
  // ⭐⭐ 2026-10-14 晚 **cut B 再翻一次**（依据：她「`/s/accept` 这条路要彻底拆掉」＋ Lead 的 cut B 清单）：
  //   改前逐字：`assert.ok(html.includes('realm-block--accept'), 'URL 说哪一格就选哪一格（照旧）');`
  //             ＋ `blockOf(html, 'accept')` 那两条
  //   改后逐字：`assert.ok(html.includes('realm-block--sales'), 'accept 已退出 REALMS ⇒ 回落缺省（销售）');`
  //             ＋ 全页不许有验收屏标记（`blockOf(…, 'accept')` 会当场红 ✗ ⇒ 换成全页断言 ✓）
  //   依据：cut A 拆路、cut B 拆领域 ⇒ 旧 `?from=accept` 与 `?from=purchase` **同一条口径** ✓；
  //     判据没放宽：原来只查 accept 那一块，现在查**整页**都不许有那些标记（更严 ✓）
  login();
  const arrival = createArrivalHarness();
  return withServer(sixRealmApp(arrival), async (base) => {
    const html = await (await fetch(`${base}/s/${ENCODED}?from=accept`, {
      headers: { cookie: sessionCookie('ou_six_realms_8') },
    })).text();
    assert.ok(html.includes('realm-block--sales'), 'accept 已退出 REALMS ⇒ 回落缺省（销售）✓');
    assert.equal(html.includes('realm-block--accept'), false, '`accept` 那一块不存在了 ✓');
    assert.equal(html.includes('accept-pending'), false, '自助块已退场 ✓');
    assert.equal(html.includes('accept-manual'), false, '手输兜底已退场 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R9（2026-10-14）：**带 ?from= 进来 ⇒ 片段必须真的不一样 + 那一格选中**
//   线上日志显示：客户端取数据时把 from 丢了（`?data=1`）⇒ 片段永远是默认领域 ⇒ "点了没反应" ✗
//   这条从**服务端渲染**侧钉住：同一份视图，`from` 不同 ⇒ 片段不同、选中格不同 ✓
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R9 ⭐ `from` 不同 ⇒ 片段真的不同，且那一格呈选中态（她"看得见的变化"✓）', () => {
  const sales = htmlFor('sales');
  const inventory = htmlFor('inventory');
  // ① 片段不同（证明"渲染真的按领域走" ✓ —— 若哪天又变成同一份，这条会红 ✓）
  assert.notEqual(sales, inventory, '带 from=inventory 的片段必须 ≠ 带 from=sales 的片段 ✓');
  assert.ok(sales.length !== inventory.length || sales !== inventory, '长度或内容至少一处不同 ✓');
  // ② 选中态在**对的那一格**（服务端定 ✓ 零 JS）
  assert.match(inventory, /class="realm-tab realm-tab--active" data-realm-id="inventory"[^>]*aria-current="page"/,
    '库存这一格必须高亮 ✓');
  assert.match(sales, /class="realm-tab realm-tab--active" data-realm-id="sales"[^>]*aria-current="page"/,
    '销售这一格必须高亮 ✓');
  // ⚠️ 只数 **class 属性里**的高亮（页内 CSS 里也有 `realm-tab--active` 字样 ⇒ 直接 match 会数成 2 ✗）
  assert.equal((inventory.match(/class="realm-tab[^"]*realm-tab--active/g) || []).length, 1, '只能有一个高亮 ✓');
  // ③ 认不出的 from ⇒ 回落销售（不报错、不白屏 ✓ 回归）
  const unknown = htmlFor('purchase');
  assert.match(unknown, /class="realm-tab realm-tab--active" data-realm-id="sales"/, '认不出 ⇒ 回落销售 ✓');
});
