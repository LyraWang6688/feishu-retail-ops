#!/usr/bin/env node
/**
 * ⭐⭐ task-11 · **真实 Express + 本机 Google Chrome** 验证：销售 → 订单列表 → **草稿箱**
 *   列表 / 继续编辑（回到同一份草稿）/ 清空（只清本地）。
 *
 * 做法（全程真路由，不是静态假页）：
 *   ① 起真实 Express：工作台 router（含新草稿箱路由）+ 扫码页 router（产品数据用替身，不连 Base）
 *   ② 本地会话目录摆好：我自己的**两份**草稿（旧页面会话 + per-page 会话）、**别人**一份、
 *      **一份损坏文件**、**一份已提交**的（清空 lines，验证"不再出现"）
 *   ③ Chrome 里真的点：草稿单卡 → 看到 2 份 → 【继续编辑】→ 落到 `/r/<记录ID>?from=sales`
 *      且页面里"本单：N 双"与草稿一致（= **同一份**，没新建）→ 回工作台 →【清空】→ 磁盘上 lines=[]
 *
 * 🔴 只读写**临时目录**里的 `data/scan_sessions`；不连飞书 Base、不部署、不改任何真实数据。
 *
 * 用法（在 `server/` 下）：`node test/e2e/draft-box-chrome.cjs`
 * 产出：`reports/draft-box/*.png` ＋ `reports/draft-box/evidence.json`
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.resolve(SERVER, '..', 'reports', 'draft-box');
const SESSION_SECRET = 'draft-box-e2e-secret';
const OWNER = 'ou_draft_box_e2e';
const OTHER = 'ou_draft_box_e2e_other';
const NUMBER = 'YD6693-2|黑色|A';
const PORT = Number(process.env.E2E_PORT || 4291);

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_draft_box_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'draft_box_e2e_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
// 这一跑要摆"两张不同页面的草稿"⇒ 显式打开 per-page token（默认就是开的，这里写死保证可复现）
process.env.SCAN_PAGE_TOKEN_ENABLED = 'true';

const { SCAN_PAGE } = require('../../src/config/scanPage');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { createWorkbenchRouter } = require('../../src/routes/workbench');
const { createScanSessionService } = require('../../src/services/scanSessionService');

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-box-e2e-'));
const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OWNER, name: '草稿箱 E2E', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

const view = () => ({
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋',
  category_code: 'A', price_text: '¥399', total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-29 21:30',
  product_record_id: 'rec_draft_e2e',
});

const lineOf = (size, amount) => ({
  kind: 'shoe', number: NUMBER, item_no: 'YD6693-2', color: '黑色',
  product_record_id: 'rec_draft_e2e', size, trade_type_code: 'SALE_PREPAID',
  amount: String(amount), gift: '', added_at: new Date().toISOString(),
});

const seed = async (sessions, key, { lines = [], sale = {} } = {}) => {
  const session = await sessions.ensure(key);
  await sessions.store.update(session.session_id, (current) => ({
    sale: { ...(current.sale || {}), status: 'draft', lines, ...sale },
  }));
  return session.session_id;
};

const buildApp = (sessions) => {
  const followup = {
    gateway: {},
    listOrders: async () => ({ orders: [], methods: [] }),
    listAfterSalesCandidates: async () => ({ rows: [] }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.get('/api/auth/feishu/me', (req, res) => res.json({
    enabled: true, authenticated: true, user: { open_id: OWNER, name: '草稿箱 E2E' },
  }));
  app.use('/workbench', express.static(path.join(SERVER, 'public', 'workbench'), { index: 'index.html' }));
  app.use('/api/workbench', createWorkbenchRouter({
    followup,
    // ⚠️ `createWorkbenchRouter(options)` 是**单个 options 对象**：`scanSessions` 要放在这一层
    //    （`routes/workbench.js` 会把它原样传给 `createWorkbenchSalesRoutes({ options })`）
    scanSessions: sessions,
    gateway: {},
  }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: { sessions },
    purchaseBackground: { schedulePurchaseRest: () => ({ ok: true }), scheduleCustomRest: () => ({ ok: true }) },
    paymentMethodsService: { list: async () => ({ ok: true, items: [] }) },
    voucherPaymentService: { settings: { enabled: false } },
    arrivalService: false,
    startSnapshot: false,
  }));
  return app;
};

/**
 * 打开 销售 → 订单列表（三卡入口在这一屏）。
 * ⚠️ 不写死 DOM 细节：先点一级「销售」，再点领域内的「订单列表」，最后等三卡里的「草稿单」。
 */
const openOrdersTab = async (page, base) => {
  await page.goto(`${base}/workbench/`, { waitUntil: 'domcontentloaded' });
  // 一级 tab「销售」（首屏默认就是它，但仍显式点一次 —— 真实用户路径）
  const salesTab = page.locator('.main-tab', { hasText: '销售' }).first();
  if (await salesTab.count()) await salesTab.click().catch(() => undefined);
  // 领域内子页「订单列表」
  const ordersEntry = page.getByRole('button', { name: /订单列表/ }).first();
  if (await ordersEntry.count()) await ordersEntry.click();
  else await page.getByText('订单列表', { exact: true }).first().click();
  await page.getByRole('button', { name: /草稿单/ }).click({ timeout: 20_000 });
};

const run = async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const sessions = createScanSessionService({ dir: SESSION_DIR });

  // ① 摆数据（全部在临时目录）
  const legacyDraft = await seed(sessions, OWNER, { lines: [lineOf(41, 200)] });
  const token = 'd'.repeat(32);
  const pageKey = `${OWNER}|page|${token}`;
  const pagedDraft = await seed(sessions, pageKey, { lines: [lineOf(42, 150.5), lineOf(43, 99)] });
  const otherDraft = await seed(sessions, OTHER, { lines: [lineOf(40, 999)] });
  const submittedDraft = await seed(sessions, `${OWNER}|page|${'e'.repeat(32)}`, { lines: [lineOf(41, 300)] });
  await sessions.store.update(submittedDraft, (current) => ({
    sale: { ...current.sale, lines: [], status: 'submitted' },
  }));
  fs.writeFileSync(path.join(SESSION_DIR, 'scan_session_brokene2e00000.json'), '{broken', 'utf8');
  const countFiles = () => fs.readdirSync(SESSION_DIR).filter((name) => name.endsWith('.json')).length;

  const app = buildApp(sessions);
  const server = await new Promise((resolve) => { const i = app.listen(PORT, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${PORT}`;

  const playwright = require('@playwright/test');
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const evidence = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await context.addCookies([{ name: 'workbench_session', value: sessionCookie(), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    const draftApiCalls = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/workbench/sales/drafts')) {
        draftApiCalls.push({ status: response.status(), url: response.url() });
      }
    });
    page.on('dialog', (dialog) => dialog.accept());

    // ② 草稿箱列表
    await openOrdersTab(page, base);
    await page.waitForSelector('[data-view="drafts"], [data-view="drafts-empty"]', { timeout: 15_000 });
    const cards = page.locator('[data-view="draft-card"]');
    assert.equal(await cards.count(), 2, '只有我自己的 2 份在草稿箱（别人的 / 已提交的 / 坏文件都不出现）');
    const summary = await page.locator('[data-view="drafts-summary"]').textContent();
    const corrupt = await page.locator('[data-view="drafts-corrupt"]').textContent();
    assert.match(String(corrupt || ''), /1 份/, '坏文件只给提示（不删、不打崩）');
    const cardTexts = await cards.allInnerTexts();
    assert.ok(cardTexts.join('\n').includes('共 3 双') === false, '（每份卡各自计数）');
    assert.ok(cardTexts.some((text) => text.includes('共 1 双')), '旧页面那份 = 1 双');
    assert.ok(cardTexts.some((text) => text.includes('共 2 双')), 'per-page 那份 = 2 双');
    await page.screenshot({ path: path.join(REPORT_DIR, 'draft-list.png'), fullPage: false });
    evidence.list = { draft_cards: await cards.count(), summary: String(summary || '').trim(), corrupt: String(corrupt || '').trim(), api: draftApiCalls };

    // ③ 继续编辑（per-page 那份 ⇒ 2 双）→ 回到**同一份**草稿
    const pagedCard = cards.filter({ hasText: '共 2 双' });
    await pagedCard.getByRole('button', { name: /继续编辑/ }).click();
    await page.waitForURL(/\/r\//, { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded');
    const scanUrl = page.url();
    assert.match(new URL(scanUrl).pathname, /^\/r\/rec_draft_e2e$/);
    assert.equal(new URL(scanUrl).searchParams.get('from'), 'sales');
    const scanHtml = await page.content();
    assert.match(scanHtml, /本单：2 双/, '落到扫码页时**还是那份草稿**（同一份，不是新建的空本单）');
    const cookies = await context.cookies();
    const pageCookie = cookies.find((cookie) => cookie.name === 'scan_page_id');
    assert.ok(pageCookie && pageCookie.value === token, 'per-page 草稿的身份 token 已下发（同一份会话 ✓）');
    await page.screenshot({ path: path.join(REPORT_DIR, 'draft-resume.png'), fullPage: false });
    evidence.resume = { url: scanUrl, draft_bar: '本单：2 双', scan_page_token_matched: pageCookie.value === token };

    // ④ 回工作台 → 清空**旧页面**那份 → 列表只剩 1 份 + 磁盘上 lines 清空
    await openOrdersTab(page, base);
    await page.waitForSelector('[data-view="drafts"]', { timeout: 15_000 });
    const filesBefore = countFiles();
    const legacyCard = page.locator('[data-view="draft-card"]').filter({ hasText: '共 1 双' });
    await legacyCard.getByRole('button', { name: /^清空$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-view="draft-card"]').length === 1, null, { timeout: 15_000 });
    const afterCards = await page.locator('[data-view="draft-card"]').count();
    const legacyRaw = await sessions.store.get(legacyDraft);
    assert.equal(afterCards, 1, '清空之后只剩那一份（列表立刻刷新）');
    assert.deepEqual(legacyRaw.sale.lines, [], '磁盘上那份草稿的 lines 真的清空了');
    assert.equal(countFiles(), filesBefore, '清空**不新建/不删除**任何会话文件（只清 lines）');
    // per-page 那份一个字节都不动
    const pagedRaw = await sessions.store.get(pagedDraft);
    assert.equal(pagedRaw.sale.lines.length, 2, '另一份草稿不许被顺手清掉');
    await page.screenshot({ path: path.join(REPORT_DIR, 'draft-cleared.png'), fullPage: false });
    evidence.clear = {
      cards_after_clear: afterCards,
      cleared_lines: legacyRaw.sale.lines.length,
      other_draft_lines: pagedRaw.sale.lines.length,
      session_files_unchanged: countFiles() === filesBefore,
    };

    // ⑤ 已提交的那份 / 别人的那份始终不在列表里
    assert.equal(evidence.list.draft_cards, 2, '别人的 + 已提交的 + 坏文件 = 都不出现 ✓');
    evidence.other_user_draft_still_exists = (await sessions.get(OTHER)).sale.lines.length === 1;
    evidence.submitted_draft_not_listed = true;

    fs.writeFileSync(path.join(REPORT_DIR, 'evidence.json'), JSON.stringify({
      at: new Date().toISOString(), owner_isolated: true, evidence,
    }, null, 2));
    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error('E2E 失败：', error?.message || error);
  process.exitCode = 1;
});
