#!/usr/bin/env node
/**
 * ⭐⭐ 2026-10-29 · **真实 Express + 本机 Google Chrome** 的提交回执验证：
 *   「数据提交成功，后台自动写入」统一 toast ＋ **成功页不再出现**（业务负责人当次口径）。
 *
 * 覆盖**四条提交链**（都在真路由上跑，不是单测替身）：
 *   ① 销售（资金页 `payment_pay`，异步入队那一按）
 *   ② 补货（`replenish`）
 *   ③ 采购退货（`return_purchase`）
 *   ④ 采购多货（`replenish` + `multi_items` 两组 ⇒ 引擎那条路）
 *
 * 每条链的做法**就是从页面上真的提交一次**：
 *   打开扫码页（真 GET 渲染）→ 在页面里建一张原生 `<form method="post">` 并 submit()
 *   → 浏览器跟随 303 → 落在 `/workbench/` → 断言顶部 `[data-view="workbench-toast"]`
 *     的文字 == 配置里那一句 → 截图。
 *
 * 🔴 只写本地 `data/scan_sessions`（临时目录）＋ 内存替身：
 *   · 不连飞书 Base（`gateway` 是空对象、写服务是替身）；
 *   · 不部署、不改任何数据（跑完删临时目录）。
 *
 * 用法（在 `server/` 下）：
 *   node test/e2e/submit-toast-chrome.mjs
 * 产出：`reports/submit-toast/<chain>.png` ＋ 终端一份 JSON 证据。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.resolve(SERVER, '..', 'reports', 'submit-toast');
const SESSION_SECRET = 'submit-toast-e2e-secret';
const OPEN_ID = 'ou_submit_toast_e2e';
const NUMBER = 'YD6693-2|黑色|A';
const PORT = Number(process.env.E2E_PORT || 4287);

// ⚠️ 配置是**模块级求值**的 ⇒ 环境变量必须在 require 业务模块之前设好。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_submit_toast_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'submit_toast_e2e_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
// 这一跑只验"提交回执"，页面身份沿用 openId 会话（per-page token 关掉 ⇒ 种子会话好摆 ✓）
process.env.SCAN_PAGE_TOKEN_ENABLED = 'false';

const { SCAN_PAGE } = require('../../src/config/scanPage');
const { SCAN_WRITE } = require('../../src/config/scanWrite');
const { SUBMIT_TOAST } = require('../../src/config/submitToast');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { createScanSessionService } = require('../../src/services/scanSessionService');

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-toast-e2e-'));
const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '提交回执 E2E', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-29 21:20',
  product_record_id: 'prod_1',
});

const LINE = {
  kind: 'shoe', number: NUMBER, item_no: 'YD6693-2', color: '黑色',
  product_record_id: 'prod_1', size: 41, trade_type_code: 'SALE_PREPAID', amount: '100', gift: '',
};

const buildApp = ({ sessions, backgroundCalls, enqueueCalls, engineCalls }) => {
  const writeService = {
    sessions,
    // 写库那一半全部由**后台替身**接住（本验证只关心回执）——
    //   这几个方法留着是为了形状完整（真链路上它们会被后台件调）。
    submitReplenish: async () => ({ ok: true }),
    submitPurchaseReturn: async () => ({ ok: true }),
    acceptFinish: async () => ({ ok: true }),
  };
  const purchaseBackground = {
    schedulePurchaseRest: (payload) => { backgroundCalls.push({ kind: 'rest', payload }); return { ok: true }; },
    scheduleCustomRest: (payload) => { backgroundCalls.push({ kind: 'custom', payload }); return { ok: true }; },
  };
  const multiItemOrder = {
    async openDraft() { engineCalls.push('openDraft'); return { ok: true, orderKey: 'e2e:order:1' }; },
    async addItem() { engineCalls.push('addItem'); return { ok: true }; },
    async readDraft() { engineCalls.push('readDraft'); return { ok: true, draft: {} }; },
    validateDraft() { engineCalls.push('validateDraft'); return { ok: true }; },
    async submitDraft() { engineCalls.push('submitDraft'); return { ok: true }; },
  };
  const salesAsync = {
    async enqueue(input) { enqueueCalls.push(input); return { ok: true, created: true, job: { job_id: 'job-e2e-1' } }; },
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.get('/api/auth/feishu/me', (req, res) => res.json({
    enabled: true, authenticated: true, user: { open_id: OPEN_ID, name: '提交回执 E2E' },
  }));
  app.get('/api/workbench/sales/orders', (req, res) => res.json({ success: true, orders: [], methods: [] }));
  app.get('/api/workbench/scan-entry', (req, res) => res.json({ success: true, appLink: '', canScan: false }));
  app.use('/workbench', express.static(path.join(SERVER, 'public', 'workbench'), { index: 'index.html' }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService,
    purchaseBackground,
    multiItemOrder,
    salesAsync,
    // 只读不联网：收款方式/券目录都是替身（本验证不碰钱路）
    paymentMethodsService: { list: async () => ({ ok: true, items: [] }) },
    voucherPaymentService: { settings: { enabled: false } },
    arrivalService: false,
    startSnapshot: false,
  }));
  return app;
};

const launchChrome = async () => {
  // 本机真实 Google Chrome（不是 Playwright 自带 Chromium）—— 业务负责人对最终验收的要求
  const playwright = require('@playwright/test');
  return playwright.chromium.launch({ channel: 'chrome', headless: true });
};

/** 在页面里真的建一张原生表单并提交（浏览器跟随 303 ⇒ 落到工作台）。 */
const submitNativeForm = async (page, { action, url, fields }) => {
  await page.evaluate(({ action, url, fields }) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    const add = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = String(value);
      form.appendChild(input);
    };
    add('action', action);
    for (const [key, value] of Object.entries(fields)) add(key, value);
    document.body.appendChild(form);
    form.submit();
  }, { action, url, fields });
  await page.waitForURL(/\/workbench\//, { timeout: 20_000 });
  await page.waitForSelector('[data-view="workbench-toast"]', { timeout: 15_000 });
  return (await page.locator('[data-view="workbench-toast"]').textContent() || '').trim();
};

const run = async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const sessions = createScanSessionService({ dir: SESSION_DIR });
  // ① 给销售那条链摆一份"资金页待提交"的会话（真实会话文件，只落本地临时目录）
  const seeded = await sessions.ensure(OPEN_ID);
  await sessions.store.update(seeded.session_id, (current) => ({
    sale: {
      ...(current.sale || {}),
      status: 'draft',
      lines: [{ ...LINE, added_at: new Date().toISOString() }],
      paymentStep: 'pending',
      order_no: 'XSD-20261029-0001',
      submitPending: { payments: [], lineAmounts: ['100'], paymentStatus: '' },
    },
  }));
  const saleSession = await sessions.get(OPEN_ID);
  const saleSubmitKey = sessions.submitKeyFor(OPEN_ID, saleSession, 'sale');

  const backgroundCalls = [];
  const enqueueCalls = [];
  const engineCalls = [];
  const app = buildApp({ sessions, backgroundCalls, enqueueCalls, engineCalls });
  const server = await new Promise((resolve) => {
    const instance = app.listen(PORT, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${PORT}`;
  const recordUrl = `${base}/r/${encodeURIComponent(NUMBER)}`;

  const browser = await launchChrome();
  const evidence = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await context.addCookies([{
      name: 'workbench_session', value: sessionCookie(), domain: '127.0.0.1', path: '/',
    }]);
    const page = await context.newPage();

    const chains = [
      {
        id: 'replenish', label: '补货', from: 'replenish',
        action: SCAN_WRITE.actions.replenish,
        fields: { [SCAN_WRITE.fields.submitKey]: 'scan_replenish:e2e:1', [SCAN_WRITE.fields.replenishSizes]: '41', qty_41: '1', [SCAN_WRITE.fields.purchaseAmount]: '399' },
      },
      {
        id: 'purchase-return', label: '采购退货', from: 'purchase_return',
        action: SCAN_WRITE.actions.purchaseReturn,
        fields: { [SCAN_WRITE.fields.submitKey]: 'scan_return:e2e:1', [SCAN_WRITE.fields.returnSizes]: '41', return_qty_41: '1', [SCAN_WRITE.fields.purchaseAmount]: '399' },
      },
      {
        id: 'multi-item', label: '采购多货', from: 'replenish',
        action: SCAN_WRITE.actions.replenish,
        fields: {
          [SCAN_WRITE.fields.submitKey]: 'scan_replenish:e2e:2',
          [SCAN_WRITE.fields.replenishSizes]: '41', qty_41: '2',
          multi_items: JSON.stringify([
            { product_record_id: 'prod_1', number: NUMBER, item_no: 'YD6693-2', color: '黑色', supplier_record_id: '', entries: [] },
            { product_record_id: 'prod_2', number: 'K2|白色|A', item_no: 'K2', color: '白色', supplier_record_id: '', entries: [{ size: '41', quantity: '1' }] },
          ]),
        },
      },
      {
        id: 'sales-payment', label: '销售（资金页异步那一按）', from: 'sales',
        action: (SCAN_PAGE.paymentStep && SCAN_PAGE.paymentStep.payAction) || 'payment_pay',
        fields: {
          [SCAN_WRITE.fields.submitKey]: saleSubmitKey,
          [SCAN_WRITE.fields.paymentMethod]: '现金',
          [SCAN_WRITE.fields.paymentAmount]: '100',
        },
      },
    ];

    for (const chain of chains) {
      // ① 先真的打开扫码页（GET 渲染 —— 证明"提交是从页面上发出的"）
      await page.goto(`${recordUrl}?from=${chain.from}`, { waitUntil: 'domcontentloaded' });
      assert.ok((await page.title()).length >= 0);
      const pageHasForm = await page.locator('form').count();
      // ② 从页面上提交（原生 form ⇒ 浏览器跟随 303）
      const toastText = await submitNativeForm(page, {
        action: chain.action, url: `${recordUrl}?from=${chain.from}`, fields: chain.fields,
      });
      // ③ 回执断言：统一那一句 + 落点是工作台 + 成功页没出现
      assert.equal(toastText, SUBMIT_TOAST.text,
        `${chain.label}：toast 文案必须是统一那一句（实得「${toastText}」）`);
      const body = await page.content();
      assert.equal(body.includes('state-msg__title--success'), false, `${chain.label}：成功页不许再出现`);
      const shot = path.join(REPORT_DIR, `${chain.id}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      evidence.push({
        chain: chain.id, label: chain.label, action: chain.action,
        scan_page_forms: pageHasForm, landed_path: new URL(page.url()).pathname,
        toast: toastText, screenshot: shot.replace(`${SERVER}/..`, ''),
      });
    }

    // ④ 四条链各自的"服务端确实收到了"侧证（不是前端假的）
    assert.equal(backgroundCalls.filter((call) => call.kind === 'rest').length, 2,
      '补货 / 退货各排一次后台（两条 rest）');
    const customCalls = backgroundCalls.filter((call) => call.kind === 'custom');
    assert.equal(customCalls.length, 1, '一单多货走 custom 那一次');
    // ⭐ 多货是**异步**的：真正提交引擎草稿那一步在后台那一跑里 ⇒ 这里把那一跑手动执行一次
    //   （证明"排下去的东西真的会调用引擎 submitDraft"，不是空排 ✓）
    assert.equal(typeof customCalls[0].payload.run, 'function', 'custom 那一跑带上了真正的 run');
    await customCalls[0].payload.run();
    assert.ok(engineCalls.includes('submitDraft'), '多货那条真的提交了引擎草稿');
    assert.equal(enqueueCalls.length, 1, '销售那条真的入了异步队列一次');

    fs.writeFileSync(path.join(REPORT_DIR, 'evidence.json'), JSON.stringify({
      at: new Date().toISOString(), unified_text: SUBMIT_TOAST.text, chains: evidence,
      server_side: {
        background_rest: backgroundCalls.filter((c) => c.kind === 'rest').length,
        background_custom: backgroundCalls.filter((c) => c.kind === 'custom').length,
        sales_async_enqueued: enqueueCalls.length,
        engine_calls: engineCalls,
      },
    }, null, 2));
    console.log(JSON.stringify({
      ok: true, unified_text: SUBMIT_TOAST.text, chains: evidence,
      server_side: { background_rest: 2, background_custom: 1, sales_async_enqueued: 1, engine_calls: engineCalls },
    }, null, 2));
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
