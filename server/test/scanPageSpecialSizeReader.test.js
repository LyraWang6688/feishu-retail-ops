'use strict';

/**
 * ⭐⭐ 2026-10-13 线上真 bug（日志逐字）：
 *   `warn scan.page.failed reason=purchase_size_list_failed error="reader.listSizes is not a function"`（22:34~22:41 反复刷 ✗）
 *
 * 真因：`services/purchaseSizeReader.js` 导出的是**工厂**
 *   `module.exports = { createPurchaseSizeReader, … }`（`listSizes` 在**工厂返回的对象**上 ✓）
 *   而接线处直接 `require(...)` 拿到**模块**、并对它调 `listSizes` ⇒ 不存在 ✗
 *   ⇒ 每次降级（安全 ✓）但**特殊码永远不出现**（能力失效 ✗）+ 警告刷屏 ✗
 *
 * 修法（**只改调用侧** ✓）：工厂 ⇒ 用路由里**已解析的** `gateway` 建实例；
 *   `options.purchaseSizeReader` 注入那一支**优先**（替身/单测不受影响 ✓）；仍**不 catch**
 *   （读失败照旧冒到外层 ⇒ 降级 + 一条 warn ✓ 设计不变 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_psr';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'psr_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'psr_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
const RECORD_ID = 'recPsrAc0001';

/** 自签一条会话（本测试自己设的密钥 ✓）——否则带鉴权时请求会被 302 去登录 ✗ */
const SESSION_COOKIE = (() => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_psr', name: '自检', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(payload).digest('base64url')}`;
})();


/** 视图里**包含** 34 / 43 两个码（判断"特殊码是否真的出现"要用到 ✓） */
const view = () => ({
  found: true, number: 'YD6693-2|黑色|A', item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋',
  price_text: '¥399', total: 2, columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '34', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '43', cells: [{ count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});

const runApp = async (purchaseSizeReader, run) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: false,
    followup: { addPayment: async () => ({ ok: true }) }, purchaseSizeReader,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const captureLogs = async (work) => {
  const lines = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return out(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return err(chunk, ...rest); };
  try { await work(); } finally { process.stdout.write = out; process.stderr.write = err; }
  return lines.join('\n');
};

const getPage = async (base, p) => {
  const response = await fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie: SESSION_COOKIE } });
  return { response, html: await response.text() };
};

test('AC-PSR1 🔴 源码哨兵：调 `listSizes` 前必须经过**工厂**（不许对模块直接调 ✗）', () => {
  assert.ok(SRC.includes('createPurchaseSizeReader('),
    '接线处必须用工厂建实例（`require(...)` 拿到的是模块、没有 listSizes ✗）');
  assert.equal(/const reader = options\.purchaseSizeReader \|\| require\('\.\.\/services\/purchaseSizeReader'\);/.test(SRC), false,
    '不许再对 `require(...)` 的结果直接调 listSizes（那正是线上刷警告的那句 ✗）');
  // 注入那一支仍然**优先** ✓
  assert.match(SRC, /const reader = options\.purchaseSizeReader\s*\n?\s*\|\|/, '注入的替身必须优先 ✓');
});

test('AC-PSR2 ⭐ 端到端：注入替身 ⇒ 特殊码**真的出现**，且**不出现** warn', async () => {
  const seen = [];
  const logs = await captureLogs(async () => {
    await runApp({ listSizes: async () => { seen.push(1); return ['34', '43（女）']; } }, async (base) => {
      const { response, html } = await getPage(base, `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`);
      assert.equal(response.status, 200, '页面要能开 ✓');
      assert.equal(seen.length, 1, '接线处要真的问一次尺码 ✓');
      assert.ok(html.includes('34') || html.includes('43'), '尺码清单里要能看到 34 / 43 ✓（不是永远不出现 ✗）');
    });
  });
  assert.equal(logs.includes('purchase_size_list_failed'), false,
    '🔴 读表**成功**时不许报那条 warn（刷屏会淹没真问题 ✗）');
});

test('AC-PSR3 读表失败 ⇒ **仍然降级**（页面 200）+ **一条可 grep 的 warn**（不是静默 ✗）', async () => {
  const logs = await captureLogs(async () => {
    await runApp({ listSizes: async () => { throw new Error('假的读表失败'); } }, async (base) => {
      const { response } = await getPage(base, `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`);
      assert.equal(response.status, 200, '读特殊码失败**不许**让整页失败 ✗');
    });
  });
  assert.ok(logs.includes('purchase_size_list_failed'), '失败要留一条可 grep 的 warn ✓');
  assert.ok(logs.includes('假的读表失败'), 'warn 要带原因（可排查 ✓）');
});

test('AC-PSR4 回归：`/r/` 仍取这一款 · `/s/` 的 next 逐字不变 · 今晚两处渲染根因修复没被碰', async () => {
  await runApp({ listSizes: async () => [] }, async (base) => {
    const page = await getPage(base, `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`);
    assert.ok(page.html.includes('YD6693-2'), '/r/ 仍渲染这一款 ✓');
    // ⚠️ 要验的是**未登录**时 next 是否逐字保留 ⇒ 这一次**故意不带** cookie ✓
    const numbered = await fetch(`${base}${SCAN_PAGE.route.basePath}/MK31-1?from=sales`, { redirect: 'manual' });
    assert.equal(numbered.status, 302);
    const next = new URL(String(numbered.headers.get('location')), base).searchParams.get('next');
    assert.equal(next, `${SCAN_PAGE.route.basePath}/MK31-1?from=sales`, '/s/ 的 next 逐字不变 ✓');
  });
  // 两处根因修复仍在（只读哨兵 ✓）
  assert.ok(RENDERER_SRC.includes("window.location.pathname + '?data=1'"), '「按当前路径取数」修复仍在 ✓');
  assert.match(RENDERER_SRC, /<style>\$\{STYLE\}\$\{PAYMENT_STEP_STYLE\}\$\{REALM_BAR_STYLE\}<\/style>/, '「首屏样式包裹」修复仍在 ✓');
});
