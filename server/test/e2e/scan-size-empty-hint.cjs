#!/usr/bin/env node
/**
 * ⭐ 2026-11-08（业务负责人真机截图）：「现货 / 预订」组**没有尺码**时那句人话
 *   「这一款现在没有可选的尺码」原来被 4 列尺码网格挤成 **1/4 宽** ⇒ 一句 11 个字折成两行。
 *
 * 修法：`.size-chips > .hint { grid-column: 1 / -1; }`（那句话横跨整行）——
 *   本脚本用**真实 Express + 本机 Google Chrome** 验两件事：
 *     ① 预订组为空（所有普通码都有现货）⇒ 预订组里的空态那句**不换行**（宽度 = 整行）；
 *     ② 现货组为空（普通码全部没货）⇒ 现货组里的空态那句**同样不换行**。
 *   同时截图留档 `reports/scan-size-empty-hint/{prepaid-empty,in-stock-empty}.png`。
 *
 * 用法（在 `server/` 下）：`node test/e2e/scan-size-empty-hint.cjs`
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.resolve(SERVER, '..', 'reports', 'scan-size-empty-hint');
const SESSION_SECRET = 'scan-size-empty-hint-e2e-secret';
const OPEN_ID = 'ou_scan_size_empty_hint_e2e';
const PORT = Number(process.env.E2E_PORT || 4295);

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_size_empty_hint_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_size_empty_hint_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
process.env.SCAN_PAGE_TOKEN_ENABLED = 'false';

const { SCAN_PAGE } = require('../../src/config/scanPage');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { createScanSessionService } = require('../../src/services/scanSessionService');

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-size-empty-hint-'));
const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '空态换行 E2E', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

const columns = () => [
  { key: '门盒', label: '门盒' },
  { key: '样品', label: '样品' },
  { key: '仓库', label: '仓库' },
  { key: '', label: SCAN_PAGE.states.emptyLabel },
];

/** 女 B 段：普通码 36–40 / 特殊码 34,35,41,42,43。 */
const B_SIZES = [34, 35, 36, 37, 38, 39, 40, 41, 42, 43];
const NORMAL = new Set([36, 37, 38, 39, 40]);

const viewWith = ({ inStockSizes = [], number }) => ({
  found: true,
  number,
  item_no: number.split('|')[0],
  color: '棕色',
  category_name: '女鞋',
  category_code: '女',
  price_text: '¥399',
  total: inStockSizes.length,
  columns: columns(),
  rows: B_SIZES.map((size) => {
    const inStock = inStockSizes.includes(size) ? 1 : 0;
    return {
      size_text: String(size),
      cells: [{ key: '门盒', count: inStock }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }],
      total: inStock,
      // 缺码只看普通码；特殊码没货收进折叠块（不参与缺码 ✓）
      missing: NORMAL.has(size) && !inStock,
    };
  }),
  missing_count: [...NORMAL].filter((size) => !inStockSizes.includes(size)).length,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-11-08 01:28',
  product_record_id: `prod_${number.split('|')[0]}`,
});

const CASE_PREPAID_EMPTY = viewWith({
  number: 'QPL8092|黑色|A'.replace('A', 'B'), // 保持 B 段
  inStockSizes: [36, 37, 38, 39, 40], // 普通码全有 ⇒ 预订组空
});
const CASE_IN_STOCK_EMPTY = viewWith({
  number: 'QPL8093|黑色|B',
  inStockSizes: [], // 全部没货 ⇒ 现货组空
});

const buildApp = () => {
  const sessions = createScanSessionService({ dir: SESSION_DIR });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: {
      lookup: async ({ recordId }) => (String(recordId).includes('QPL8093') ? CASE_IN_STOCK_EMPTY : CASE_PREPAID_EMPTY),
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

/** 量一句空态人话：宽度是不是整行、有没有折行（**它不在 4 列尺码网格里** ✓）。 */
const hintMetrics = (page, group) => page.evaluate((groupKey) => {
  const fieldset = document.querySelector(`[data-stock-group="${groupKey}"]`);
  const hint = fieldset && fieldset.querySelector('.hint');
  if (!fieldset || !hint) return null;
  const style = window.getComputedStyle(hint);
  const rect = hint.getBoundingClientRect();
  const box = fieldset.getBoundingClientRect();
  const padLeft = parseFloat(window.getComputedStyle(fieldset).paddingLeft) || 0;
  const padRight = parseFloat(window.getComputedStyle(fieldset).paddingRight) || 0;
  const innerWidth = box.width - padLeft - padRight;
  return {
    text: (hint.textContent || '').trim(),
    hintWidth: Math.round(rect.width),
    innerWidth: Math.round(innerWidth),
    hintHeight: Math.round(rect.height),
    lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6,
    ratio: innerWidth > 0 ? rect.width / innerWidth : 0,
    insideGrid: Boolean(fieldset.querySelector('.size-chips .hint')),
    gridCount: fieldset.querySelectorAll('.size-chips').length,
  };
}, group);

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

    const check = async ({ id, url, group, why }) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200, `${id}：页面必须能打开`);
      await page.waitForSelector(`[data-stock-group="${group}"]`, { timeout: 15_000 });
      const metrics = await hintMetrics(page, group);
      assert.ok(metrics, `${id}：${group} 组里必须出现空态那句人话`);
      assert.equal(metrics.text, '这一款现在没有可选的尺码', `${id}：空态文案保持配置里那一句`);
      // ① 结构：那句**不在** 4 列尺码网格里（空组不画网格），宽度 ≈ 整行
      assert.equal(metrics.insideGrid, false, `${id}：空态那句不许塞进 .size-chips 网格里（会被挤成 1/4 宽）`);
      assert.equal(metrics.gridCount, 0, `${id}：空组不画 .size-chips 网格`);
      assert.ok(metrics.ratio > 0.95,
        `${id}：空态那句必须横跨整行（实得 ${metrics.hintWidth}/${metrics.innerWidth} = ${metrics.ratio.toFixed(2)}）`);
      // ② 单行：高度不超过 1.5 倍行高
      assert.ok(metrics.hintHeight <= metrics.lineHeight * 1.5,
        `${id}：空态那句不许折行（高 ${metrics.hintHeight}px / 行高 ${metrics.lineHeight}px）`);
      const shot = path.join(REPORT_DIR, `${id}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      evidence[id] = { ...metrics, why, screenshot: shot.replace(`${SERVER}/..`, '') };
    };

    // ① 预订组空（普通码全都有现货）
    await check({
      id: 'prepaid-empty', group: 'prepaid', why: '普通码全有现货 ⇒ 预订组空',
      url: `${base}/r/${encodeURIComponent('QPL8092')}?from=sales`,
    });
    // ② 现货组空（普通码全部没货）
    await check({
      id: 'in-stock-empty', group: 'in_stock', why: '普通码全没货 ⇒ 现货组空',
      url: `${base}/r/${encodeURIComponent('QPL8093')}?from=sales`,
    });

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
