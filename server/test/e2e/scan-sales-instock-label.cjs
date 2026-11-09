#!/usr/bin/env node
/**
 * ⭐ 2026-11-07（业务负责人截图口径）：销售扫码页「有货」段标题里的
 *    **「（样品 + 门盒）」** 去掉 —— 只留「有货」。
 *
 * 本脚本 = **真实 Express + 本机 Google Chrome** 的渲染验证（不连 Base）：
 *   ① 按她截图那一款的形状（0225 / 棕色 · 女 / 38 码现货 / 36,37,39,40 预订 / 特殊码 5）
 *      起一个真扫码路由；
 *   ② Chrome 打开 `/r/0225?from=sales`，断言：
 *      · 「有货」段标题**存在**且**不含**「样品 + 门盒」；
 *      · 整页文本**不含**「样品 + 门盒」；
 *      · 现货/预订两组仍在（38 码在现货组、36/37/39/40 在预订组 —— 只删文字，不动分组 ✓）；
 *   ③ 截图留档 `reports/scan-instock-label/sales-page.png`。
 *
 * 用法（在 `server/` 下）：`node test/e2e/scan-sales-instock-label.cjs`
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.resolve(SERVER, '..', 'reports', 'scan-instock-label');
const SESSION_SECRET = 'scan-instock-label-e2e-secret';
const OPEN_ID = 'ou_scan_instock_label_e2e';
const NUMBER = '0225|棕色|B';
const PORT = Number(process.env.E2E_PORT || 4293);

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_instock_label_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_instock_label_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../../src/config/scanPage');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { createScanSessionService } = require('../../src/services/scanSessionService');

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-instock-label-'));
const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '有货标题 E2E', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

/** 她截图那一款：女 B 段（普通码 36–40 / 特殊码 34,35,41,42,43）。 */
const view = () => {
  const columns = [
    { key: '门盒', label: '门盒' },
    { key: '样品', label: '样品' },
    { key: '仓库', label: '仓库' },
    { key: '', label: SCAN_PAGE.states.emptyLabel },
  ];
  const normalMissing = new Set([36, 37, 39, 40]);
  const special = new Set([34, 35, 41, 42, 43]);
  const sizes = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43];
  const rows = sizes.map((size) => {
    const box = size === 38 ? 1 : 0; // 截图：只有 38 码有货（门盒）
    return {
      size_text: String(size),
      cells: [{ key: '门盒', count: box }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }],
      total: box,
      // 缺码 = 普通码里没货的那些（特殊码没货收进折叠块，不参与缺码 ✓）
      missing: normalMissing.has(size),
    };
  });
  return {
    found: true,
    number: NUMBER,
    item_no: '0225',
    color: '棕色',
    category_name: '女鞋',
    category_code: '女',
    price_text: '¥399',
    total: 1,
    columns,
    rows,
    missing_count: normalMissing.size,
    sizes_degraded: false,
    notes: [],
    updated_at_text: '2026-09-27 20:29',
    product_record_id: 'prod_0225',
    // 让"特殊码 5"按截图出现：这些码在采购明细里出现过
    special_sizes_present: [...special].map(String),
  };
};

const buildApp = () => {
  const sessions = createScanSessionService({ dir: SESSION_DIR });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: { sessions },
    paymentMethodsService: { list: async () => ({ ok: true, items: [] }) },
    voucherPaymentService: { settings: { enabled: false } },
    arrivalService: false,
    startSnapshot: false,
  }));
  return app;
};

const run = async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const app = buildApp();
  const server = await new Promise((resolve) => { const i = app.listen(PORT, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${PORT}`;

  const playwright = require('@playwright/test');
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await context.addCookies([{ name: 'workbench_session', value: sessionCookie(), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    const response = await page.goto(`${base}/r/${encodeURIComponent('0225')}?from=sales`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, '销售扫码页必须能打开（否则本判据是空跑）');
    await page.waitForSelector('.size-group', { timeout: 15_000 });

    // ① 2026-11-07 业务负责人 HTML 批注：销售两组**只保留标签**（现货 / 预订），标题整个去掉
    const inStockTitles = await page.locator('[data-stock-group="in_stock"] .size-group__title').count();
    const prepaidTitles = await page.locator('[data-stock-group="prepaid"] .size-group__title').count();
    assert.equal(inStockTitles, 0, '现货组不许再有组标题（只留「现货」标签）');
    assert.equal(prepaidTitles, 0, '预订组不许再有组标题（只留「预订」标签）');
    const inStockTag = (await page.locator('[data-stock-group="in_stock"] .tag').first().textContent() || '').trim();
    const prepaidTag = (await page.locator('[data-stock-group="prepaid"] .tag').first().textContent() || '').trim();
    assert.equal(inStockTag, '现货', `现货组的标签必须是「现货」（实得「${inStockTag}」）`);
    assert.equal(prepaidTag, '预订', `预订组的标签必须是「预订」（实得「${prepaidTag}」）`);
    // ② 整页不许再出现旧解释
    const bodyText = await page.locator('body').innerText();
    assert.equal(bodyText.includes('样品 + 门盒'), false, '整页不许再出现「样品 + 门盒」');
    assert.equal(bodyText.includes('样品+门盒'), false);
    // ⭐ 特殊码折叠那块**保留自己的标题**（批注只点名现货/预订两组）
    const specialTitle = (await page.locator('details.size-fold .size-group__title').first().textContent() || '').trim();
    assert.equal(specialTitle, '特殊码');
    // ③ 只删文字、不动分组：38 码仍在现货组；36/37/39/40 仍在预订组
    const inStockSizes = await page.locator('[data-stock-group="in_stock"] input[name="size"]').evaluateAll((nodes) => nodes.map((n) => n.value));
    const prepaidSizes = await page.locator('[data-stock-group="prepaid"] input[name="size"]').evaluateAll((nodes) => nodes.map((n) => n.value));
    assert.deepEqual(inStockSizes, ['38'], `现货组必须仍是 38 码（实得 ${JSON.stringify(inStockSizes)}）`);
    for (const size of ['36', '37', '39', '40']) {
      assert.ok(prepaidSizes.includes(size), `预订组必须仍含 ${size} 码（实得 ${JSON.stringify(prepaidSizes)}）`);
    }
    // ④ 特殊码标签数量不变（她截图那把 = 5）
    const specialTag = (await page.locator('details.size-fold .tag').first().textContent() || '').trim();
    assert.equal(specialTag, '5', `特殊码数量标签保持 5（实得「${specialTag}」）`);

    const shot = path.join(REPORT_DIR, 'sales-page.png');
    await page.screenshot({ path: shot, fullPage: false });
    const evidence = {
      at: new Date().toISOString(),
      url: page.url(),
      in_stock_titles: inStockTitles,
      in_stock_tag: inStockTag,
      prepaid_tag: prepaidTag,
      contains_removed_text: bodyText.includes('样品 + 门盒'),
      in_stock_sizes: inStockSizes,
      prepaid_sizes_contains_36_37_39_40: ['36', '37', '39', '40'].every((size) => prepaidSizes.includes(size)),
      special_title: specialTitle,
      special_tag: specialTag,
      screenshot: shot.replace(`${SERVER}/..`, ''),
    };
    fs.writeFileSync(path.join(REPORT_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
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
