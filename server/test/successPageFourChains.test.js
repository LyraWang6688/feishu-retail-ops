'use strict';

/**
 * ⭐⭐ **四条链成功页「统一极简」的【真路由】判据 ＋ 整页零回归**（2026-10-16 · **加固层**）。
 *
 * 背景（如实）：成功页统一极简的**实现**已随 **#770**（`062544d1`）落地 ——
 *   `config/scanSuccessPage.js`（**没有开关**：永远极简 ＋ 那句文案）＋
 *   `views/scanPage/index.js` 的 `renderScanMessagePage` 挂钩（只在 `tone==='success'` 时清链接/按钮/自动跳转）。
 *   它自带的 `test/scanSuccessPageMinimal.test.js`（AC-MS-P1/P2/P3）钉的是**渲染层**。
 *
 * 本文件补的是**它没钉住的那三件**（不重复造 ✗）：
 *   ① **真路由**：补货 / 退货 / 销售三条链**真发 HTTP**（不是构造参数直接调渲染器）⇒
 *      证明"路由那四处成功响应**不改一行**就被这个开关覆盖" ✓（#770 的 docs 里曾把这条**记为未做** ✗ —— 实测它已经成立 ✓）；
 *   ② **验收那一半**：工作台回执正文 = 同一句（纯文本 `textContent` ⇒ 零 `<a>`/`<button>` ✓）；
 *   ③ **AC-V3**：那句统一文案**今天在两处字面量**（`config/scanSuccessPage.js` 的 `DEFAULT_MINIMAL_TEXT`
 *      与 `config/scanPage.js` 的 `SCAN_PAGE.saleSuccess.message`）⇒ 本判据钉住"**今天同值**"，
 *      漂了当场红 ✓（⚠️ 建议后续改成**引用**：`config/workbenchArrival.js:51` 就是引用 ✓）。
 *
 * 🔴 本文件**只动 `test/**`**（`src/**` 一个字不改 ✗）。
 */

// 🔴 必须在 require 任何 `config/**` / 路由**之前**摆好（配置在 require 期读 env ✗）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_success_minimal_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'success_minimal_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_SUCCESS_PAGE, minimalSuccessOverrides } = require('../src/config/scanSuccessPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const arrivalTab = require('../src/config/workbenchArrival');
const {
  NUMBER, encodePath, offendersOf, renderChainSuccessPages,
} = require('./support/scanSuccessPage');

const SERVER_DIR = path.join(__dirname, '..');
const SESSION_SECRET = 'scan-success-minimal-test-secret';
/** 共享那件：四条链**共用一处定义**的成功页文案（本文件不抄第二份 ✗）。 */
const UNIFIED = SCAN_SUCCESS_PAGE.minimalText;
/** 同一句的**另一处**字面量（`config/scanPage.js` 的 `saleSuccess.message`）—— 见 AC-V3 ✓ */
const SALE_SUCCESS_MESSAGE = SCAN_PAGE.saleSuccess.message;

// ── 路由链路的最小替身（与 `test/purchaseAsyncAcceptance.test.js` 同形 ✓）─────────────
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_success_minimal') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
const view = () => ({
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
    { size_text: '41', cells: [{ count: 2 }], total: 2, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 10:00',
  product_record_id: 'prod_1',
});
/** 写服务替身：本文件只关心"她拿到的那一页"，写库本身由既有判据钉 ✓（原样透传 ✓）。 */
const writeStub = () => ({
  calls: [],
  sessions: { get: async () => null, submitKeyFor: () => 'scan_test:key:success', setLastRealm: async () => {} },
  submitReplenish: async () => ({ ok: true, reused: false }),
  submitPurchaseReturn: async () => ({ ok: true, reused: false }),
  submitSale: async () => ({ ok: true, reused: false, order_no: 'XSD-20261016-0001', detail_count: 2 }),
});
const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: write,
  }));
  return app;
};
const postForm = async (url, cookie, body) => fetch(url, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  redirect: 'manual',
});
const pageUrl = (base, realm) => `${base}/s/${encodePath(NUMBER)}?from=${realm}`;

/**
 * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
 *   改前逐字：`AC-SP0 ⭐ 前置：开关读到 env=true`（`assert.equal(SCAN_SUCCESS_PAGE.minimalEnabled, true)`）
 *   改后逐字：本用例 —— **没有开关也成立**（他 22:5x：「把新功能都上了，不需要开关」）⇒ 前置改成钉"开关已退场"
 *   依据 = 业务负责人 2026-10-16 22:5x 逐字 ✓
 */
test('AC-SP0 ⭐ 前置：**开关已退场**，成功页不靠 env 也永远极简（否则下面全是空跑 ✗）', () => {
  assert.equal('minimalEnabled' in SCAN_SUCCESS_PAGE, false,
    '配置里不许再有 `minimalEnabled`（开关退了 ✗）');
  const overrides = minimalSuccessOverrides();
  assert.ok(overrides && overrides.body === SCAN_SUCCESS_PAGE.minimalText,
    '不设任何 env ⇒ 极简覆盖值照样返回（"永远开" ✓；链没接上 ⇒ 本文件全部组红 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP1a：补货 / 退货（真路由）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP1a ⭐⭐ 补货 / 退货：成功页 = 统一那一句 ＋ 零 `<a href>`/按钮/表单/自动跳转', async () => {
  login();
  const cases = [
    {
      chain: 'replenish',
      realm: 'replenish',
      action: SCAN_WRITE.actions.replenish,
      extra: {
        [`${SCAN_WRITE.fields.purchaseAmount}`]: '1200',
        [`${SCAN_WRITE.fields.replenishSizes}`]: '41',
        qty_41: '2',
      },
    },
    {
      chain: 'purchase_return',
      realm: 'purchase_return',
      action: SCAN_WRITE.actions.purchaseReturn,
      extra: {
        [`${SCAN_WRITE.fields.purchaseAmount}`]: '800',
        [`${SCAN_WRITE.fields.returnSizes}`]: '41',
        [`${SCAN_WRITE.fields.returnQuantityPrefix}41`]: '1',
      },
    },
  ];
  for (const c of cases) {
    const write = writeStub();
    await withServer(appWith(write), async (base) => {
      const res = await postForm(pageUrl(base, c.realm), sessionCookie(), {
        action: c.action, submit_key: 'scan_test:key:success', ...c.extra,
      });
      assert.equal(res.status, 200, `${c.chain}：合法提交 ⇒ 200（先回她 ✓）`);
      const html = await res.text();
      assert.ok(html.includes(UNIFIED), `${c.chain}：成功页必须有那一句「${UNIFIED}」`);
      assert.deepEqual(offendersOf(html), [],
        `${c.chain}：成功页**零 a-href / 按钮 / 表单 / 自动跳转**（她的口径「不需要任何跳转 / 链接」✗）`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP1b：销售（真路由 · 跳过付款那条成功页，`routes/scanPage/index.js:3011`）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP1b ⭐⭐ 销售：成功页 = **同一句** ＋ 零 `<a href>`/按钮/表单/自动跳转', async () => {
  login();
  const write = writeStub();
  await withServer(appWith(write), async (base) => {
    const res = await postForm(pageUrl(base, 'sales'), sessionCookie(), {
      action: SCAN_PAGE.paymentStep.skipAction,
      submit_key: 'scan_test:key:success',
      order_no: 'XSD-20261016-0001',
      count: '2',
    });
    assert.equal(res.status, 200, '销售（跳过付款）⇒ 200（先回她 ✓）');
    const html = await res.text();
    assert.ok(html.includes(UNIFIED), `销售成功页必须有那一句「${UNIFIED}」（四条链**同一句** ✓）`);
    assert.deepEqual(offendersOf(html), [],
      '销售成功页**零 `<a href>` / 按钮 / 表单 / 自动跳转**（她：「不需要做任何跳转，也不需要做任何链接」✗）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP1c：四条链**同一句话**（含验收那一半）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP1c ⭐⭐ 四条链成功页**同一句话**：三条扫码链路 HTML ＋ 验收（工作台）那条回执正文', () => {
  const pages = renderChainSuccessPages();
  for (const [chain, html] of Object.entries(pages)) {
    assert.ok(html.includes(UNIFIED), `${chain}：成功页要有那一句「${UNIFIED}」`);
    assert.deepEqual(offendersOf(html), [], `${chain}：成功页零 a-href/按钮/表单/自动跳转 ✗`);
  }
  // ④ 验收（工作台入口）：它的"成功页"是**回执正文那一句**（写进工作台那一屏的纯文本 ✓）
  assert.equal(arrivalTab.texts.submitted, UNIFIED,
    '验收那条成功回执 = **同一句**（唯一真源 `SCAN_PAGE.saleSuccess.message` ✓ 抄第二份必漂 ✗）');
  // ⭐ 工作台那一屏是**纯文本**写进去的 ⇒ 页面上**不可能**多出 `<a>` / `<button>` ✓（源码判据）
  const frontEnd = fs.readFileSync(
    path.join(SERVER_DIR, 'public', 'workbench', 'features', 'orders', 'index.js'), 'utf8',
  );
  assert.match(frontEnd, /node\.textContent = text \|\| '';/,
    '工作台那一屏用 `textContent` 写结果 ⇒ 成功回执是纯文本（零 `<a>`/`<button>` ✓）');
  const routeSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'), 'utf8');
  assert.ok(routeSrc.includes('message: arrivalTab.texts.submitted'),
    '验收回执正文走**配置**（不新造字面量 ✓）');
  assert.deepEqual(offendersOf(UNIFIED), [], '回执正文本身不含任何 HTML（纯文本 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP1d：探针（检测器真能红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP1d ⭐ 探针：检测器**真能红**（证明 AC-SP1a/1b/1c 不是空跑 ✓）', () => {
  assert.deepEqual(offendersOf(`<p>${UNIFIED}</p>`), [], '极简那一页 ⇒ 干净 ✓');
  assert.deepEqual(offendersOf(`<p>${UNIFIED}</p><a class="btn" href="/s">返回扫码</a>`), ['a-href'],
    '塞回一颗链接 ⇒ **必须**报红 ✓');
  assert.deepEqual(offendersOf(`<p>${UNIFIED}</p><form method="post"><button>跳过</button></form>`),
    ['button', 'form'], '塞回按钮 / 表单 ⇒ **必须**报红 ✓');
  assert.deepEqual(offendersOf(`<head><meta http-equiv="refresh" content="2;url=/s"></head>`),
    ['auto-jump'], '塞回**自动跳转** ⇒ **必须**报红 ✓（她："不需要做任何跳转"）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP2：配置驱动（改文案不用改代码）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP2 ⭐ 配置驱动：换成另一份文案 ⇒ 页面跟着变（渲染器里没有写死那句中文 ✓）', () => {
  // eslint-disable-next-line global-require
  const { renderSaleSuccessPage, renderScanMessagePage } = require('../src/views/scanPageRenderer');
  // eslint-disable-next-line global-require
  const { saleSuccessPayload } = require('./support/scanSuccessPage');
  const html = renderScanMessagePage({
    title: '标题-注入', body: '正文-不要', tone: 'success',
    backPath: '/s/x', backLabel: '返回扫码', returnPath: '/s/y', returnLabel: '返回扫码',
    autoReturnUrl: '/s/z', returnDelaySeconds: 2, retryHint: '提示-不要', details: ['行-不要'], number: 'NUM-不要',
    successPage: { minimalEnabled: true, minimalText: '正文-注入' },
  }, SCAN_PAGE);
  assert.ok(html.includes('正文-注入'),
    '成功页那一句**只从 config 取**（注入什么显示什么 ✓）');
  assert.equal(html.includes(UNIFIED), false, '缺省那一句**不再出现**（写死必红 ✓）');
  // 渲染器源码里**不许**出现那句中文（写死 ⇒ 红 ✓；中文闸门 `noHardcodedChinese` 也会红）
  //   ⚠️ **先剥注释**再判：渲染器里那几段**引用她原话**的注释含这句中文（那是给人读的 ✓ 不算写死 ✗）
  const rendererSrc = fs.readFileSync(
    path.join(SERVER_DIR, 'src', 'views', 'scanPage', 'index.js'), 'utf8',
  );
  const code = rendererSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(code.includes(UNIFIED), false,
    '🔴 渲染器**代码**里不许写死成功页那句中文（注释里引用她原话不算 ✗；文案的家在 `config/scanPage.js` ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SP3：显式布尔 · 空串 = 关 · 禁 `||` 兜底
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SP3 ⭐⭐ 反向哨兵：**开关已退场**（成功页永远极简）＋ 源码里**不许** `||` 兜底', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`AC-SP3 🔴 开关 = 显式布尔（readFlag）：空串 = 关 …`（逐条钉 readFlag 语义）
  //   改后逐字：本用例 —— 开关已退场 ⇒ 改钉"**它不许回来**"＋"那条禁令（`||` 兜底）继续成立" ✓
  //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**……把新功能都上了，不需要开关。**」✓
  // ⚠️ 名字**拼出来**（源码里不留字面量 ⇒ 将来 no-switch 哨兵扫字面量时不会误判 ✓）
  const KEY = ['SCAN', 'SUCCESS', 'PAGE', 'MINIMAL', 'ENABLED'].join('_');
  const cfgSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanSuccessPage.js'), 'utf8');
  const cfgCode = cfgSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(cfgCode.includes(KEY), false, '🔴 开关名不许回来 ✗');
  assert.equal(/process\.env\.[A-Z_]+\s*\|\|/.test(cfgCode), false, '🔴 禁 `||` 兜底（清空变量会关不掉 ✗）');
  // 正向：四条链的成功页**永远极简**（不依赖任何 env ✓）
  const { minimalSuccessOverrides } = require('../src/config/scanSuccessPage');
  const overrides = minimalSuccessOverrides();
  assert.ok(overrides.body && overrides.backPath === '' && overrides.autoReturnUrl === '',
    '极简覆盖值**永远**返回（没有开关可关 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-V3（复核新增）：那句统一文案**今天在两处**（值相同）⇒ 漂了当场红
// ═══════════════════════════════════════════════════════════════════════════

test('AC-V3 🔴 统一那句的**两处字面量**今天必须同值（⚠️ 抄了一份 = 漂移风险，如实标注）', () => {
  assert.equal(UNIFIED, SALE_SUCCESS_MESSAGE,
    '`SCAN_SUCCESS_PAGE.minimalText` 与 `SCAN_PAGE.saleSuccess.message` 今天必须同值 —— '
    + '否则四条链就不再是"同一句话"（验收回执走前者所在的 SCAN_PAGE、成功页走后者 ✗）');
  // 如实：这本可以是**引用**（`config/workbenchArrival.js:51` 就是引用 ✓）而不是抄一份 ✗
  const cfgSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanSuccessPage.js'), 'utf8');
  assert.match(cfgSrc, /const DEFAULT_MINIMAL_TEXT = '/,
    '如实标注：那一句在 `config/scanSuccessPage.js` 里是**独立字面量**（不是引用 `SCAN_PAGE.saleSuccess.message` ⇒ 建议改引用 ✓）');
});
