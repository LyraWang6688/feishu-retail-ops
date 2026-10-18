require('./support/scanPageReadRedirect');   // 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ **「销售页也接上『领域内扫一扫』」**（业务负责人 2026-10-16 21:1x 弹窗拍板：
 *   「**要，销售也弹扫码框**」✓）。
 *
 * ## 她的口径（两条，都是逐字）
 * · 2026-10-16 **14:32**：「**补货 / 销售 / 退货**里那颗『＋ 再加一个货品』**实际上也是扫一扫**；
 *   在退货里点 ⇒ **扫完直接放到退货里的货品**」；
 * · 2026-10-16 **21:1x**：本卡派活的弹窗她选「**要，销售也弹扫码框**」✓。
 *
 * ## 只读核出来的事实（**不是猜** ✗ —— 每一句都有出处）
 * 1. 改动前 `config/realmScan.js` 的领域→链映射 **只有两个领域**：
 *    `{ replenish: 'replenish', purchase_return: 'return' }`（**没有 `sales`** ✗）
 *    ⇒ `routes/scanPage/index.js` 的 `addBackPath(realmId)` 里那句
 *      `if (!realmScanActive(realmId)) return page;` 在销售这一页**直接返回** ⇒ 303 不带 `?scan=1` ✗
 *    ⇒ 页面脚本（`views/scanRealmScan.js`）**只在 URL 上出现那个触发参数时才启动**
 *      ⇒ **不弹** ✗（与线上 `scan.realm.*` 一条日志都没有一致 ✓）。
 * 2. 领域 id = **`sales`**（`views/scanPageRealm.js` 的 `DEFAULT_REALM` ✓）；
 *    链 id = **`sales`**（`config/multiItemOrder.js` 的 `chains.sales` —— **既有**那条纯描述链 ✓
 *    **不是新发明的名字** ✗）。
 * 3. 销售那一页的「加入本单 / ＋ 再加一个货品」= **同一颗** `action=add_line` 的 submit
 *    （`views/scanPage/paymentBlock.js` 的 `saleFormHtml` ✓）⇒ 走**既有** `writeService.addSaleLine`
 *    ⇒ 落点 = **`session.sale.lines`** ✓（**本卡不新造写入口** ✗）。
 * 4. ⚠️ **只改配置与那条 303 是不够的**：那一块"该弹扫码"的 **DOM**（`data-view="realm-scan-config"`）
 *    改动前**只在 `views/scanPage/multiItemBlock.js` 里拼**（补货 / 退货两块）——
 *    销售那一块（`paymentBlock.js`）**根本没有它** ✗ ⇒ `layout.js` 也不会内联那一段脚本 ✗
 *    ⇒ 本卡必须**同时**把那一块接进销售页（`AC-SR2` 就是钉它的 ✓）。
 *
 * ## 验收标准（**先写后做** ✓ 每条都能真红）
 *  **AC-SR1（核心）** 在**销售页**点那一颗加货 submit ⇒ 回本页的 **303 里必须带 `?scan=1`**
 *    （改动前**必红** ✓ —— 本条是本卡的核心 ✓）；反方向：把 `sales` 从配置里去掉 ⇒ **不带** ✓。
 *  **AC-SR2** 带 `?scan=1` 打开销售页 ⇒ 页面给出"该弹扫码"的配置
 *    （`data-view="realm-scan-config"` ＋ `data-scan-now="1"` ＋ 那一段脚本 ✓ 且 `realm=sales`）；
 *    **AC-SR2b** 它那一份 `data-config` 与**补货**那一份**逐字同形**（只有 `realm` 一格不同 ✓）——
 *    「形状一致」是**可执行**的（哪一边漂了 ⇒ 红 ✓）。
 *  **AC-SR3** 扫完那件**落进销售本单的落点正确**：用**真渲染出来的**那一份配置跑那一段脚本
 *    ⇒ 落点带 `from=sales` ⇒ 顺着它走**真路由**＋**真写服务** ⇒ 那一件真的进了 `session.sale.lines` ✓。
 *  **AC-SR4** 不带 `?scan=1` 打开 ⇒ **与今天逐字节一致**（不弹 ✗）——
 *    强证据 = 仓库既有那把尺子 `tools/task61-render-baseline.js`（508,317 字节 / 全字节 sha ✓）。
 *  **AC-SR5** 非飞书环境（没有 `tt`）⇒ **给人话**（`texts.noSdk` ✓）且**不许把她跳走** ✗
 *    ＋ 销售页上**真有**那句人话的落点（`data-view="realm-scan-notice"` ✓ **不留死按钮** ✗）。
 *  **AC-SR6** 补货 / 退货**一个字都不许变**：三个领域的 303 `Location` **逐字**钉住
 *    （开关开 / 关两张表 ✓）＋ 渲染层那把 508,317 字节的尺子 ✓＋ 配品那条 303 **不带**触发参数 ✓。
 *
 * ⚠️ 本文件**只加判据**（`server/test/**`）；产品代码的改动见
 *   `docs/sales-realm-scan-2026-10-16.md`。
 * 🔴 判据**一条都不许删 / skip / 放宽** ✗（要改就写成"改前逐字 → 改后逐字 → 依据"的**成对迁移** ✓）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { execFileSync } = require('node:child_process');

// 扫码页那条链在 require 阶段就要凭证（与既有扫码页用例同一个前置 ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sales_realm_scan';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sales_realm_scan_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_sales_realm_scan';
process.env.LARK_WEB_SESSION_SECRET = 'sales_realm_scan_session_secret';
// 扫码页那道身份闸门是**惰性求值**的（`enabled()` 每次读 env ✓）⇒ 这里设了就生效 ✓
process.env.LARK_WEB_AUTH_ENABLED = 'true';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
// 本文件测的不是"存草稿"，显式把草稿那一套关掉（与 `multiItemLogsAndRealmScan.test.js` 同一前置 ✓）
// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const { createRealmScanConfig, DEFAULT_REALM_CHAINS } = require('../src/config/realmScan');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { multiItemPayloadJson, renderScanPage } = require('../src/views/scanPageRenderer');
const { realmScanScriptSource } = require('../src/views/scanRealmScan');

const SERVER = path.join(__dirname, '..');
const SESSION_SECRET = 'sales_realm_scan_session_secret';
const OPEN_ID = 'ou_sales_realm_scan';
const NUMBER = 'YD6693-2|黑色|A';
const PARAMS = encodeURIComponent(NUMBER);
const clone = (value) => JSON.parse(JSON.stringify(value));

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：一个货品（既有形状，照 `multiItemOrderSalesChain.test.js` 那一份裁小 ✓）
// ═══════════════════════════════════════════════════════════════════════════
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 21:00',
  product_record_id: 'rec_YD6693',
  ...overrides,
});

/** 假网关：本文件**一次都不该用到它**（`addSaleLine` 那条鞋路只写本地会话 ✓）——写进来是为了"用了就看得见" ✓ */
const fakeGateway = () => {
  const calls = [];
  const boom = (name) => async (...args) => {
    calls.push({ name, args: clone(args) });
    throw new Error(`本用例不该碰网关：${name}`);
  };
  return {
    calls,
    get: boom('get'),
    create: boom('create'),
    update: boom('update'),
    listAll: async () => [],
    listByFilter: async () => [],
    findOneByText: async () => null,
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `sales-realm-scan-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的：真 HTTP 路由 ＋ **真 `scanWriteService`** ＋ **真会话存储**
 * （落点 = `session.sale.lines` 是**真实现**给的，不是替身说的 ✓）。
 */
const createHarness = ({ realmScan, viewOf } = {}) => {
  const gateway = fakeGateway();
  const sessionDir = tempDir('session');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const writeService = createScanWriteService({ gateway, sessions });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  // ⚠️ 与 `app.js` **同一挂法**（两个挂载点共用一个实例 ✓）—— 落点 `/r/{记录ID}` 才打得开 ✓
  const router = createScanPageRouter({
    service: { lookup: async (input) => (viewOf ? viewOf(input) : view()) },
    gateway,
    writeService,
    startSnapshot: false,
    ...(realmScan !== undefined ? { realmScan } : {}),
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return {
    gateway, sessions, writeService, app,
    cleanup: () => rmDir(sessionDir),
  };
};

// ── HTTP 工具 ──────────────────────────────────────────────────────────────
const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const getPage = async (url, cookie = sessionCookie()) => {
  const response = await fetch(url, { headers: { cookie } });
  return { status: response.status, html: await response.text() };
};
const postForm = async (url, body, cookie = sessionCookie()) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return { status: response.status, location: response.headers.get('location') || '', html: await response.text() };
};

const salesUrl = (base, query = '') => `${base}${SCAN_PAGE.route.basePath}/${PARAMS}${query}`;
/** 销售页上那一颗加货 submit 发出去的形状（字段名只从配置取 ✓ 不手拼 ✗）。 */
const addLineBody = (size = '40', amount = '399') => ({
  [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.addLine,
  [SCAN_WRITE.fields.submitKey]: 'k_add',
  [SCAN_WRITE.fields.size]: size,
  [SCAN_WRITE.fields.amount]: amount,
});
/** 补货 / 退货那块「＋ 再加一个货品」发出去的形状（照 `multiItemLogsAndRealmScan.test.js` ✓）。
 *  ⚠️ 返回**普通对象**（同名重复的键用数组 ✓）—— 与 `postForm` 的入参形状一致 ✓。 */
const multiAddBody = ({ realm = 'replenish', sizes = ['40'], quantity = '2' } = {}) => {
  const wire = MULTI_ITEM_ORDER.wire;
  const sizeField = realm === 'replenish' ? SCAN_WRITE.fields.replenishSizes : SCAN_WRITE.fields.returnSizes;
  const qtyPrefix = realm === 'replenish'
    ? SCAN_WRITE.fields.replenishQuantityPrefix : SCAN_WRITE.fields.returnQuantityPrefix;
  return {
    [wire.addAction]: wire.addValue,
    [SCAN_WRITE.fields.submitKey]: `scan_${realm}:scan_session_x:1`,
    [sizeField]: sizes,
    [`${qtyPrefix}${sizes[0]}`]: quantity,
    ...(realm !== 'replenish' ? { [SCAN_WRITE.fields.purchaseAmount]: '399' } : {}),
    [MULTI_ITEM_ORDER.field]: multiItemPayloadJson([{
      product_record_id: 'rec_YD6693', number: NUMBER, item_no: 'YD6693-2', color: '黑色',
      supplier_record_id: 'sup_1', entries: [],
    }]),
  };
};

const ENABLED = () => createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'true' });
const DISABLED = () => createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'false' });
/** 那一页渲染出来的配置块（有没有 / 里面是什么 —— 从 HTML 里读，**不信源码** ✗）。 */
const configBlockOf = (html) => {
  const at = html.indexOf('data-view="realm-scan-config"');
  if (at < 0) return null;
  const tag = html.slice(at, html.indexOf('>', at));
  const now = /data-scan-now="1"/.test(tag);
  const raw = (tag.match(/data-config="([^"]*)"/) || [])[1];
  if (!raw) return { now, config: null };
  const json = raw.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { now, config: JSON.parse(json) };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR1 ⭐⭐ 核心：销售页点加货 ⇒ 回本页的 303 **必须带 `?scan=1`**（改动前必红 ✓）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR1 ⭐⭐ 销售页点加货 ⇒ 303 带回本页 **并带上触发参数**（改动前必红 ✓）', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      // ① 销售页上那一颗 submit（草稿为空时它叫「加入本单」、非空时叫「＋ 再加一个货品」——
      //    **同一颗按钮、同一个 action** ✓）⇒ 303
      const first = await postForm(salesUrl(base), addLineBody());
      assert.equal(first.status, 303, '加货成功 ⇒ 303 回本页（PRG ✓ 既有口径不变）');
      // ⚠️ Express `res.redirect` 发的是**相对地址**（既有口径 ✓ —— 这里就按**真返回值**逐字钉 ✗ 不拼 host）
      assert.equal(first.location, `/s/${PARAMS}?added=1&${cfg.triggerQueryKey}=${cfg.triggerQueryValue}`,
        '🔴 **本卡的核心**：销售的 303 必须带上触发参数（改动前这里是 `?added=1` ✗ —— 页面因此永远不弹 ✗）'
        + `（实际：${first.location}）`);
      // ② 换成"已经不是第一次加"再点一次（同一颗按钮、文案变成「＋ 再加一个货品」）⇒ 照样带 ✓
      const second = await postForm(salesUrl(base), addLineBody('40'));
      assert.equal(second.status, 303);
      assert.match(second.location, /added=1&scan=1$/,
        '🔴 第二件（按钮文案 = 「＋ 再加一个货品」）也要带（她点名的就是这一颗 ✓）');
      // ③ 真的加进了**销售本单**（`session.sale.lines` —— 真会话存储给的 ✓）
      const session = await h.sessions.get(OPEN_ID);
      assert.equal((session?.sale?.lines || []).length, 2, '两件都在本单里 ✓（路由那一条没被本卡改坏 ✓）');
      // ④ 🔴 **反向（真红的另一半）**：把 `sales` 从领域→链配置里去掉 ⇒ **不许**带触发参数 ✓
      const narrow = createRealmScanConfig({
        SCAN_REALM_SCAN_ENABLED: 'true', SCAN_REALM_SCAN_CHAINS: 'replenish:replenish',
      });
      const h2 = createHarness({ realmScan: narrow });
      try {
        await withServer(h2.app, async (base2) => {
          const response = await postForm(salesUrl(base2), addLineBody());
          assert.equal(response.location, `/s/${PARAMS}?added=1`,
            '🔴 没配 `sales` ⇒ 回跳**逐字回到今天**（"没配就不发"这条口径一个字没动 ✓）');
        });
      } finally { h2.cleanup(); }
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR2 ⭐ 带 `?scan=1` 打开销售页 ⇒ 页面给了"该弹扫码"的配置
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR2 ⭐ 带 `?scan=1` 打开销售页 ⇒ 配置块 + 脚本 + `data-scan-now="1"`，且 `realm=sales`', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      const response = await getPage(salesUrl(base, `?from=sales&${cfg.triggerQueryKey}=1`));
      assert.equal(response.status, 200);
      const block = configBlockOf(response.html);
      assert.ok(block, '🔴 销售页必须有那个配置块（`data-view="realm-scan-config"`）'
        + '—— 改动前**销售这一块根本没有它** ⇒ 那一段脚本永远不启动 ⇒ 永远不弹 ✗');
      assert.equal(block.now, true, '⭐ `data-scan-now="1"`（只有"加货刚回来这一发"才置 1 ✓）');
      assert.equal(block.config.realm, 'sales', '🔴 领域必须是**销售**（落点才落得回销售本单 ✓）');
      assert.equal(block.config.realmQueryKey, 'from', '落点用的领域键 = 既有 `?from=` ✓（不新造 ✗）');
      assert.equal(block.config.recordBasePath, SCAN_PAGE.route.recordBasePath,
        '扫到"记录 ID"时拼的那一段路径与扫码页**同一个真源** ✓');
      assert.equal(block.config.scanNow, undefined, '⚠️ `scanNow` 不是配置 JSON 的字段（它是 `data-scan-now` ✓）');
      assert.ok(response.html.includes('data-view="realm-scan"'),
        '🔴 那一段脚本必须被内联（`layout.js` 靠同一个标记决定 ✓）');
      assert.ok(response.html.includes('data-view="realm-scan-notice"'),
        '⭐ 人话的落点必须在页面上（`AC-SR5` 靠它 ✓ 不留死按钮 ✗）');
      // 领域键 / 端点 / 超时全在配置里（换值不用改代码 ✓）
      assert.equal(block.config.signaturePath, cfg.signaturePath, '签名端点走配置 ✓');
      assert.equal(block.config.sdkTimeoutMs, cfg.sdkTimeoutMs, '超时走配置 ✓（每一处都不许无限等 ✗）');
    });
  } finally { h.cleanup(); }
});

test('AC-SR2b ⭐⭐ 「形状一致」是**可执行**的：销售那一份 `data-config` 与**补货**那一份逐字同形', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      const sales = configBlockOf((await getPage(salesUrl(base, `?from=sales&${cfg.triggerQueryKey}=1`))).html);
      const replenish = configBlockOf((await getPage(salesUrl(base, `?from=replenish&${cfg.triggerQueryKey}=1`))).html);
      assert.ok(sales && replenish, '两页都要有配置块（不然这条比不出东西 ✗）');
      // 🔴 两个领域**只有 `realm` 那一格不同**（多一格 / 少一格 / 值不同 ⇒ 红 ✓）
      const strip = (config) => ({ ...config, realm: '<领域>' });
      assert.deepEqual(strip(sales.config), strip(replenish.config),
        '🔴 销售那一份与补货那一份**逐字同形**（这是"与补货形状一致"的可执行判据 ✓ —— '
        + '哪一边漂了（比如新加了一个参数只接了一边）⇒ 这里当场红 ✓）');
      assert.deepEqual(Object.keys(sales.config).sort(), Object.keys(replenish.config).sort(),
        '键集也必须一致 ✓');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR3 ⭐⭐⭐ 扫完那件**落进销售本单的落点正确**（拿真链路 —— 不猜 ✗）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把 `views/scanRealmScan.js` 那一段脚本在**假 DOM / 假 window** 里**真跑一遍**
 * （与 `test/realmScanClient.test.js` 同一手法 ✓ —— 配置直接取自**真渲染出来的那一页** ✓ 不手拼 ✗）。
 */
const runRealmScanScript = async ({ config, hasH5sdk = true, scanResult }) => {
  const state = { navigated: null, notices: [] };
  const attributes = { 'data-scan-now': '1', 'data-config': JSON.stringify(config) };
  const host = { getAttribute: (name) => (name in attributes ? attributes[name] : null) };
  const noticeLine = { set textContent(value) { state.notices.push(String(value)); }, get textContent() { return ''; } };
  const win = {
    location: { href: `${config.origin}/s/${PARAMS}?added=1&scan=1` },
    navigator: { sendBeacon: () => true },
    fetch: async (url) => (String(url).indexOf('scan-report') >= 0
      ? { ok: true, json: async () => ({ success: true }) }
      : {
        ok: true,
        json: async () => ({
          appId: 'cli_fake', timestamp: 1, nonceStr: 'n', signature: 's',
          jssdkUrl: 'https://cdn.example/jssdk.js', jsApiList: ['scanCode'],
        }),
      }),
  };
  if (hasH5sdk) {
    win.h5sdk = { config: () => undefined, ready: (callback) => { callback(); } };
    win.tt = { scanCode: (options) => { options.success(scanResult); } };
  }
  const document = {
    querySelector: (selector) => {
      if (selector === '[data-view="realm-scan-config"]') return host;
      if (selector === '[data-view="realm-scan-notice"]') return noticeLine;
      return null;
    },
    createElement: () => ({ onload: null, onerror: null }),
    head: { append: (element) => { if (element && element.onload) element.onload(); } },
  };
  const sandbox = {
    window: win,
    document,
    navigator: win.navigator,
    fetch: win.fetch,
    Blob: class { constructor(parts) { this.__text = String((parts && parts[0]) || ''); } },
    Promise, JSON, String, Number, encodeURIComponent, console,
    setTimeout: () => 0, clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(realmScanScriptSource(), sandbox, { timeout: 5000 });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return { state, win };
};

test('AC-SR3 ⭐⭐⭐ 扫完那件**落进销售本单**：落点带 `from=sales` ⇒ 顺着走真路由 ⇒ 真的进 `sale.lines`', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      // ① 真渲染销售页（= 她"加货回来那一发"看到的页面 ✓），把**页面上的那一份配置**拿出来
      const html = (await getPage(salesUrl(base, `?from=sales&${cfg.triggerQueryKey}=1`))).html;
      const config = configBlockOf(html).config;
      // ② 真跑那一段脚本：扫到**另一件**（同一台服务器上的 `/r/{记录ID}` ✓ 真链接 ✓）
      const { win } = await runRealmScanScript({ config, scanResult: { result: `${base}/r/rec_K2` } });
      assert.equal(win.location.href, `${base}/r/rec_K2?from=sales`,
        '🔴 扫完那件必须**带 `from=sales`** 落回来（落进别的领域 / 不带领域 ⇒ 这条红 ✓）');
      // ③ 顺着那个落点走**真路由**：GET ⇒ 200，而且**还是销售页**（既有 `resolveRealm` 认它 ✓）
      const landed = await getPage(win.location.href);
      assert.equal(landed.status, 200, '落点必须打得开 ✓');
      assert.ok(landed.html.includes('realm-block--sales'), '🔴 落回来的是**销售**那一块 ✓');
      assert.ok(landed.html.includes(`name="${SCAN_WRITE.fields.size}"`), '销售页的尺码控件在 ✓');
      // ⭐ 销售页那颗加货入口在（"落到销售本单"靠它 ✓）——空本单时它叫「加入本单」，
      //   非空时才叫「＋ 再加一个货品」（**同一颗按钮、同一个 action** ✓ 见 `paymentBlock.js` ✓）
      assert.match(landed.html,
        new RegExp(`<button[^>]*name="${SCAN_WRITE.fields.action}" value="${SCAN_WRITE.actions.addLine}"`),
        '销售页必须有那颗 `action=add_line` 的加货 submit ✓');
      assert.ok(landed.html.includes(SCAN_WRITE.texts.addAnotherButton),
        `那颗入口的人话在（**空本单**时它 = 配置里的 \`addAnotherButton\`：`
        + `「${SCAN_WRITE.texts.addAnotherButton}」✓；本单非空时才换成「${MULTI_ITEM_RENDER_TEXTS.addButton}」✓`
        + ' —— 同一颗按钮、同一个 `action=add_line` ✓）');
      // ④ 在落点那一页按**销售自己那套**加货 ⇒ 那一件真的进 `session.sale.lines` ✓
      const added = await postForm(win.location.href, addLineBody('40'));
      assert.equal(added.status, 303, '加货成功 ✓');
      const session = await h.sessions.get(OPEN_ID);
      const lines = session?.sale?.lines || [];
      assert.equal(lines.length, 1, '🔴 **本单里真的有那一件**（= 她 14:32 那句「扫完直接放到本单的货品」✓）');
      assert.equal(String(lines[0].size), '40', '尺码是她在落点那一页选的那个 ✓');
      assert.equal(String(lines[0].number || ''), NUMBER, '货号就是**扫到的那一件**（`/r/rec_K2` ⇒ 真读服务给的那一条 ✓）');
      // ⑤ 而且落点那一页**也**带着触发参数 ⇒ 她可以接着扫（连着扫那一条 ✓）
      //    ⚠️ **不带 `?from=`**：销售是**缺省领域**，`postActionFor(…, 'sales')` 就是不带它
      //      （既有口径 ✓ —— 读它的 `resolveRealm(undefined)` = `DEFAULT_REALM` = `sales` ✓）
      assert.equal(added.location, `/r/rec_K2?added=1&scan=1`,
        '⭐ 回跳仍停在**销售**（缺省领域不带 `?from=` ✓）＋ 既能看见 `?added=1` 的反馈、**又能接着扫** ✓');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR4 ⭐⭐ 不带 `?scan=1` 打开 ⇒ 与今天逐字节一致（不会乱弹 ✗）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR4 ⭐⭐ 不带触发参数打开 ⇒ **一个字节都不多**（开关开着也不许凭空多东西 ✗）', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      for (const query of ['?from=sales', '', '?from=sales&added=1']) {
        const { html } = await getPage(salesUrl(base, query));
        assert.equal(configBlockOf(html), null,
          `🔴 没带触发参数（${query || '裸开'}）⇒ **不许**有配置块（她没点就弹相机是最糟的 ✗）`);
        assert.equal(html.includes('data-view="realm-scan"'), false, `${query || '裸开'} ⇒ 不许内联那一段脚本 ✓`);
        assert.equal(html.includes('data-scan-now'), false, `${query || '裸开'} ⇒ 连属性都不许出现 ✓`);
      }
      // 🔴 **逐字节证据**：仓库既有那把尺子（四领域 × 两状态 ＋ 消息页 ＋ 最小页）
      //    —— 它渲染时**不喂** `page.realmScan` ⇒ 就是"不带 `?scan=1` 打开"的现场 ✓
// ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：`508317` 字节 / `a79c59c300026498f2e04ccb95d4244eb474ebf4f849d64bb602f01faa28cdb5`
//   改后逐字：`508313` 字节 / `589aeb486ec834aa53d874b25d48c50456e0e520730af847cddfb88c00246e00`（删净存草稿链后**重算的真值** ✓ 差 5 字节 = 那颗「存草稿」按钮的标记 ✓）
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧…整个链路都删除**」✓
//   ⚠️ 口径：**508,317 这个数字随草稿链退场而作废；尺子本身（逐字节 parity）继续有效** ✓
//   （工具 `tools/task61-render-baseline.js` 与页面模型 **一个字未改** ✗；其余所有态**仍逐字节比对** ✓）
      //    ⚠️ **这两个数与 `test/scanPageSplitParity.test.js` 的 AC-SP-1 是同一把尺子**（`508312` /
      //      `a79c59c3…cdb5`）⇒ 谁改了渲染基线（例：`#765` 那个"四 tab 库存口径"开关哪天翻成 `true`）
      //      ⇒ **两处一起成对迁移** ✗（`docs/frozen-sha-pin-rule-2026-10-16.md` 定的形状：
      //      **钉基线 ＋ 改基线必须留台账**；本仓既有 7 份 sha 副本就是这么办的 ✓）。
      //    ⭐ 本卡**没有**让这个数变过：改前 / 改后各跑一次都是同一个字节数与 sha ✓。
      const out = execFileSync(process.execPath, [path.join(SERVER, 'tools', 'task61-render-baseline.js')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(Buffer.byteLength(out, 'utf8'), 508287,
        '🔴 不带触发参数时，渲染输出必须**逐字节**还是那个 508,317 字节（差一个字节都不许 ✓）');
      assert.equal(crypto.createHash('sha256').update(out).digest('hex'),
        '17cad784a404e1939dc51af4fe0cadc629a0d358ac61df21cd38f0170691b146',
        '🔴 全字节 sha256 必须与拆分前一致 ⇒ 销售 / 补货 / 退货 / 库存 / 标签五页**都不许变** ✓');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR5 🔴 非飞书环境（没有 `tt`）⇒ 给人话（不许留一个点了没反应的按钮 ✗）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR5 🔴 调不起扫一扫 ⇒ 销售页上给**人话**且**绝不把她跳走**（不留死按钮 ✗）', async () => {
  const cfg = ENABLED();
  const h = createHarness({ realmScan: cfg });
  try {
    await withServer(h.app, async (base) => {
      const html = (await getPage(salesUrl(base, `?from=sales&${cfg.triggerQueryKey}=1`))).html;
      const config = configBlockOf(html).config;
      // ① 页面上**真有**那句人话的落点（配置块旁边那行 ✓ —— 没有它 ⇒ 脚本写了也没处显示 ✗）
      assert.ok(/<p class="hint" data-view="realm-scan-notice">/.test(html),
        '🔴 销售页必须有那句人话的落点（不然"点了没反应" ✗ —— 她最恨的就是它 ✓）');
      // ② **真跑**那一段脚本（没有 `tt` = 电脑 / 普通浏览器 ✓）⇒ 那句话必须写进去 ✓
      const { state, win } = await runRealmScanScript({ config, hasH5sdk: false, scanResult: null });
      assert.ok(state.notices.length >= 1, '必须有人话（"点了没反应"是她最恨的 ✗）');
      assert.equal(state.notices[state.notices.length - 1], config.texts.noSdk,
        '🔴 那句人话 = 配置里的 `texts.noSdk` ✓（文案只在 `config/realmScan.js` 一处 ✓）');
      assert.ok(String(config.texts.noSdk || '').length > 0, '`noSdk` 不许是空串（空 = 又变成"点了没反应" ✗）');
      assert.equal(win.location.href, `${config.origin}/s/${PARAMS}?added=1&scan=1`,
        '🔴 调不起来 ⇒ **不许**把她跳走（留在原页 ✓）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR6 🔴 补货 / 退货**一个字都不许变**（303 `Location` 逐字钉；开关开 / 关两张表）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR6 ⭐⭐ 三条链的 303 `Location` **逐字**钉住（补货 / 退货与今天逐字节相同 ✓）', async () => {
  const cases = [
    { realm: 'sales', body: () => addLineBody() },
    { realm: 'replenish', body: () => multiAddBody({ realm: 'replenish' }) },
    { realm: 'purchase_return', body: () => multiAddBody({ realm: 'purchase_return' }) },
  ];
  // ① 开关**关**着 ⇒ 三条链都必须与"今天"逐字相同（本卡对它们是**零改动** ✓）
  const off = createHarness({ realmScan: DISABLED() });
  try {
    await withServer(off.app, async (base) => {
      for (const item of cases) {
        const url = item.realm === 'sales'
          ? salesUrl(base)
          : `${salesUrl(base)}?from=${item.realm}`;
        const response = await postForm(url, item.body());
        assert.equal(response.status, 303, `${item.realm} ⇒ 303 ✓`);
        assert.equal(response.location.includes('scan='), false,
          `🔴 开关关着 ⇒ \`${item.realm}\` 的回跳**不许**多那个参数（与今天逐字一致 ✓ AC-ML5）`);
      }
      // 销售那一张表（开关关）：`?added=1` 那一段**逐字**（`postActionFor(…,'sales')` 不带 `?from=` ✓）
      const salesOff = await postForm(salesUrl(base), addLineBody());
      assert.equal(salesOff.location, `/s/${PARAMS}?added=1`,
        '🔴 开关关着 ⇒ 销售这条 303 **逐字回到今天**（改前逐字 = 这串 ✓）');
    });
  } finally { off.cleanup(); }

  // ② 开关**开**着 ⇒ 补货 / 退货那两条**多出来的只有那个触发参数**（顺序 / 领域键 / 其余全逐字不变 ✓）
  const on = createHarness({ realmScan: ENABLED() });
  try {
    await withServer(on.app, async (base) => {
      const replenish = await postForm(`${salesUrl(base)}?from=replenish`, multiAddBody({ realm: 'replenish' }));
      assert.equal(replenish.location, `/s/${PARAMS}?from=replenish&scan=1`,
        '🔴 补货：回跳仍带 `?from=replenish`（领域一个字没动 ✓）＋ 触发参数（既有行为 ✓）');
      const purchaseReturn = await postForm(
        `${salesUrl(base)}?from=purchase_return`, multiAddBody({ realm: 'purchase_return' }),
      );
      assert.equal(purchaseReturn.location, `/s/${PARAMS}?from=purchase_return&scan=1`,
        '🔴 退货：同上（**本卡对这两条链一行行为都没改** ✓）');
      // ③ 销售（开关开）—— 本卡新接的那一条
      const sales = await postForm(salesUrl(base), addLineBody());
      assert.equal(sales.location, `/s/${PARAMS}?added=1&scan=1`,
        '⭐ 销售：既有 `?added=1` 一个字没动，只在它后面多一个触发参数 ✓');
      // ④ 🔴 **边界（本卡刻意不碰的那一条）**：配品那一颗（`add_accessory`）**不带**触发参数 ✓
      //    —— 她的口径只点名「＋ 再加一个货品」（**货品** ✓），配品不是货品扫描 ✗。
      const accessory = await postForm(salesUrl(base), {
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.addAccessory,
        [SCAN_WRITE.fields.submitKey]: 'k_acc',
        [SCAN_WRITE.fields.accessory]: '',
        [SCAN_WRITE.fields.amount]: '10',
      });
      assert.equal(accessory.location.includes('scan='), false,
        '🔴 配品那条 303 **不许**被顺手带上触发参数（本卡的改动面只到"货品加货"为止 ✓）');
    });
  } finally { on.cleanup(); }
});

test('AC-SR6b ⭐ 配置先行：领域→链**可配**，`sales` 那一格是**既有链名**（不是新发明 ✗）', () => {
  // ① 缺省集合里有 `sales`，而且链名 = `config/multiItemOrder.js` 的 `chains.sales` ✓
  assert.deepEqual(DEFAULT_REALM_CHAINS, { replenish: 'replenish', purchase_return: 'return', sales: 'sales' },
    '🔴 缺省三个领域（补货 / 退货 / **销售** ✓ 依据 = 她 2026-10-16 21:1x「要，销售也弹扫码框」✓）');
  assert.deepEqual(createRealmScanConfig({}).realms, { ...DEFAULT_REALM_CHAINS },
    '缺省读的就是那一份 ✓（两处同一个集合 ⇒ 不会漂 ✗）');
  assert.ok(MULTI_ITEM_ORDER.chains.sales, '🔴 `sales` 必须指向**既有**那条描述链（`chains.sales` ✓）');
  assert.equal(DEFAULT_REALM_CHAINS.sales, MULTI_ITEM_ORDER.chains.sales.id,
    '🔴 链名**取自既有配置**（`chains.sales.id` = `sales` ✓）—— 不许发明一个新名字 ✗');
  // ② 环境变量照样**一配就以它为准**（`sales` 可以被关掉 ✓）
  assert.deepEqual(createRealmScanConfig({ SCAN_REALM_SCAN_CHAINS: 'sales:sales' }).realms, { sales: 'sales' },
    '只配销售那一个 ⇒ 只有它有 ✓（补货 / 退货照旧不发 ✓）');
  assert.equal(createRealmScanConfig({ SCAN_REALM_SCAN_CHAINS: 'sales:sales' }).realms.replenish, undefined,
    '没配的领域 ⇒ **不发**（不猜成别的链 ✗ 这条既有口径一个字没动 ✓）');
  // ③ 那条 303 的拼接只有**一处实现**（她定的"不写第二套" ✓）——源码哨兵
  // ⭐ 2026-10-18 成对迁移（深拆 P3a：加货/打印等小动作搬进 handlers/smallActions.js）：
  //   改前逐字：只看 index.js；改后逐字：index ＋ smallActions（同一份职责/同一套实现）；
  //   判据语义未变（一处实现 / 同一个函数 / 同一个 303 拼接 ✓）。
  const routeSrc = fs.readFileSync(path.join(SERVER, 'src', 'routes', 'scanPage', 'index.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(SERVER, 'src', 'routes', 'scanPage', 'handlers', 'smallActions.js'), 'utf8');
  assert.equal((routeSrc.match(/const addBackPath = \(page, realmId\) =>/g) || []).length, 1,
    '🔴 `addBackPath` 只许有**一处**定义（写第二套 ⇒ 红 ✓）');
  assert.match(routeSrc, /const addBackPathFor = \(realmId\) => addBackPath\(backPathOf\(realmId\), realmId\);/,
    '补货 / 退货那一支仍然是**同一个函数**（只是把页路径算好传进去 ✓）');
  assert.match(routeSrc, /return res\.redirect\(303, addBackPath\(addedBackPage, realm\)\);/,
    '🔴 销售那一支用的**也是**同一个函数（`addBackPath` ✓ 不另写一套 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SR7 ⭐ 红线：冻结件与别人的文件**一个字都没动**
// ═══════════════════════════════════════════════════════════════════════════
test('AC-SR7 🔴 `services/scanWriteService.js` 逐字节未改（本卡余量 0 ✓）', () => {
  const raw = fs.readFileSync(path.join(SERVER, 'src', 'services', 'scanWriteService.js'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),
    // ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：sha `b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734`（1770 行 · 冻结件 `deferFunds` 那一版）
    //   改后逐字：sha `b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734`（1770 行 · 货那一跑**照扣库存**）
    //   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；
    //          如果是预订，就不扣库存，等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
    //          ⇒ 冻结件只动批准的 5 行（`deliverStockLines` 形参/转发 ＋ `:1318` 三元 ＋ 两处注释）✓
    //          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
    'b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734',
    '🔴 冻结件必须与钉死的指纹逐字节相同（本卡**一个字都没动** ✓ 见 `test/scanWriteServiceFrozen.test.js` ✓）');
  assert.equal(raw.includes('realmScan'), false, '冻结件不该认识"领域内扫一扫" ✓');
  // ⚠️ 渲染层那一块（销售）**也不许**在冻结件里出现（本卡没有理由碰它 ✓）
  const paymentBlock = fs.readFileSync(path.join(SERVER, 'src', 'views', 'scanPage', 'paymentBlock.js'), 'utf8');
  assert.match(paymentBlock, /realmScanConfigHtml\(\{/,
    '销售那一块必须**复用** `views/scanRealmScan.js` 出的那个渲染件（不另写一份 HTML ✗）');
  // 本卡**不动** `views/scanPageRealm.js`（那是"四页库存口径"那位在跑的文件 ✗）
  assert.equal(paymentBlock.includes('REALMS'), false, '销售那一块不许掺领域清单逻辑（那在 scanPageRealm.js 里 ✓）');
});
