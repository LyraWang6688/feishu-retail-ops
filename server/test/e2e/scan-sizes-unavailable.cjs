#!/usr/bin/env node
/**
 * ⭐ 2026-11-08（业务负责人真机截图 · M2165|卡其|）：
 *   销售扫码页「一行尺码都没有」⇒ 兜底人话改成
 *     **「这个编号缺类别（A/B），暂时算不出尺码，请核对编号」**（不再说"没有可选的尺码"）。
 *
 * 本脚本 = 真实 Express + 本机 Google Chrome 渲染验证（不连 Base）：
 *   ① 降级形状（= 她截图那种：编号第 3 段为空 + 实时库存无记录 ⇒ rows = []）
 *      ⇒ 页面上只有**新文案**、**没有**现货/预订两个组、不出现旧句；
 *   ② 正常"没货"（普通码都在、只是没库存）⇒ 仍是「现货空 + 预订组 + 旧句」，
 *      新文案**不出现**（防误伤）。
 *   两张截图留档 `reports/scan-sizes-unavailable/{missing-category,normal-no-stock}.png`。
 *
 * 用法（在 `server/` 下）：`node test/e2e/scan-sizes-unavailable.cjs`
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.resolve(SERVER, '..', 'reports', 'scan-sizes-unavailable');
const SESSION_SECRET = 'scan-sizes-unavailable-e2e-secret';
const OPEN_ID = 'ou_scan_sizes_unavailable_e2e';
const PORT = Number(process.env.E2E_PORT || 4296);

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_sizes_unavailable_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_sizes_unavailable_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
process.env.SCAN_PAGE_TOKEN_ENABLED = 'false';

const { SCAN_PAGE } = require('../../src/config/scanPage');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { createScanSessionService } = require('../../src/services/scanSessionService');

const NEW_TEXT = SCAN_PAGE.texts.saleSizesUnavailable;
const OLD_TEXT = '这一款现在没有可选的尺码';

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-sizes-unavailable-'));
const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '尺码兜底 E2E', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

const COLUMNS = () => [
  { key: '门盒', label: '门盒' },
  { key: '样品', label: '样品' },
  { key: '仓库', label: '仓库' },
  { key: '', label: SCAN_PAGE.states.emptyLabel },
];

const rowOf = (size, { total = 0, missing = false } = {}) => ({
  size_text: String(size),
  cells: [{ key: '门盒', count: total }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }],
  total,
  missing,
});

const baseView = (over) => ({
  found: true,
  number: 'M2165|卡其|',
  item_no: 'M2165',
  color: '卡其',
  category_name: '',
  category_code: '',
  price_text: '—',
  total: 0,
  columns: COLUMNS(),
  rows: [],
  missing_count: 0,
  sizes_degraded: true,
  notes: [],
  updated_at_text: '—',
  product_record_id: 'rec_m2165',
  ...over,
});

// ① 她截图那种：编号缺类别段 + 无库存 ⇒ rows = []
const MISSING_CATEGORY = baseView({});
// ② 正常"没货"：B 段普通码 36–40 都在、只是没库存
const NORMAL_NO_STOCK = baseView({
  number: 'QPL8093|卡其|B',
  item_no: 'QPL8093',
  category_name: '女鞋',
  category_code: '女',
  price_text: '¥399',
  rows: [36, 37, 38, 39, 40].map((size) => rowOf(size, { missing: true })),
  missing_count: 5,
  sizes_degraded: false,
  updated_at_text: '2026-11-08 01:28',
  product_record_id: 'rec_qpl8093',
});

const buildApp = () => {
  const sessions = createScanSessionService({ dir: SESSION_DIR });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: {
      lookup: async ({ recordId }) => (String(recordId).includes('QPL8093') ? NORMAL_NO_STOCK : MISSING_CATEGORY),
    },
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
  const evidence = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await context.addCookies([{ name: 'workbench_session', value: sessionCookie(), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();

    /** ① 降级：只一句话、不画两组 */
    const response = await page.goto(`${base}/r/${encodeURIComponent('M2165')}?from=sales`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, '降级页必须能打开（否则本判据是空跑）');
    await page.waitForSelector('[data-view="sale-sizes-unavailable"]', { timeout: 15_000 });
    const bodyText = await page.locator('body').innerText();
    assert.ok(bodyText.includes(NEW_TEXT), `降级页必须显示新文案（实得：${bodyText.slice(0, 120)}…）`);
    assert.equal(bodyText.includes(OLD_TEXT), false, '降级页不许再出现旧句「这一款现在没有可选的尺码」');
    assert.equal(await page.locator('.size-group').count(), 0, '降级页**不画**现货/预订两个组');
    const shot1 = path.join(REPORT_DIR, 'missing-category.png');
    await page.screenshot({ path: shot1, fullPage: false });
    evidence.missing_category = {
      url: page.url(),
      text: NEW_TEXT,
      size_group_count: 0,
      old_text_present: false,
      screenshot: shot1.replace(`${SERVER}/..`, ''),
    };

    /** ② 正常没货：仍是两组 + 旧句；新文案不出现 */
    const response2 = await page.goto(`${base}/r/${encodeURIComponent('QPL8093')}?from=sales`, { waitUntil: 'domcontentloaded' });
    assert.equal(response2.status(), 200, '正常没货页必须能打开');
    await page.waitForSelector('[data-stock-group="prepaid"]', { timeout: 15_000 });
    const bodyText2 = await page.locator('body').innerText();
    assert.equal(bodyText2.includes(NEW_TEXT), false, '正常没货**不许**出现「核对编号」那句 ✗');
    assert.ok(bodyText2.includes(OLD_TEXT), '正常没货仍用旧句（业务负责人确认过这句没问题）');
    assert.equal(await page.locator('.size-group').count(), 2, '正常没货照常画两个组');
    const shot2 = path.join(REPORT_DIR, 'normal-no-stock.png');
    await page.screenshot({ path: shot2, fullPage: false });
    evidence.normal_no_stock = {
      url: page.url(),
      size_group_count: 2,
      old_text_present: true,
      screenshot: shot2.replace(`${SERVER}/..`, ''),
    };

    fs.writeFileSync(path.join(REPORT_DIR, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
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
