'use strict';

/**
 * 生产表 E2E（浏览器部分，可配置计划）
 *
 * 前置：
 *   - 生产临时实例通过 SSH 隧道暴露在 E2E_BASE_URL（默认 http://127.0.0.1:5052）
 *   - 使用生产 Base，但**不写种子库存**，只用真实现有库存
 *
 * 运行例：
 *   E2E_OPEN_ID=<open_id> E2E_BASE_URL=http://127.0.0.1:5052 E2E_SECRET=e2e-secret \
 *   E2E_PLAN='[{"name":"单货","items":[{"item":"86822|黑色|A","size":"40","amount":99}],"payments":[{"method":"微信扫码","amount":99}]}]' \
 *   npm run test:prod
 */
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const { encodeSession, COOKIE_NAME } = require('../src/routes/feishuWebAuth');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:5052';
const SECRET = process.env.E2E_SECRET || 'e2e-secret';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || SECRET;
const OPEN_ID = String(process.env.E2E_OPEN_ID || '').trim();
const HEADLESS = process.env.E2E_HEADLESS !== 'false';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_PLAN = [
  { name: '生产单 1', items: [{ item: '86822|黑色|A', size: '40', amount: 99 }], payments: [{ method: '微信扫码', amount: 99 }] },
];
const PLAN = (() => {
  const raw = String(process.env.E2E_PLAN || '').trim();
  if (!raw) return DEFAULT_PLAN;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('E2E_PLAN 必须是非空数组');
  return parsed;
})();

const parseOrderNo = (text) => {
  const m = String(text || '').match(/XSD-\d{8}-\d{4}/);
  if (!m) throw new Error(`toast 没有单号：${text}`);
  return m[0];
};

const itemUrl = (item) => `${BASE}/s/${encodeURIComponent(item)}?from=sales`;

const fillGoods = async (page, item, add) => {
  await page.goto(itemUrl(item.item));
  await page.locator(`input[name="size"][value="${item.size}"]`).check({ force: true });
  await page.locator('input[name="amount"]').first().fill(String(item.amount));
  await page.locator(add
    ? 'button[name="action"][value="add_line"]'
    : 'button[name="action"][value="submit_order"]').click();
};

const fillPayment = async (page, rows) => {
  await page.getByText('总金额', { exact: false }).waitFor({ timeout: 60000 });
  const selects = page.locator('form[data-view="payment-pay"] select');
  const amounts = page.locator('form[data-view="payment-pay"] input[name="payment_amount"]');
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await page.locator('button[data-payment-add]').click();
    await selects.nth(i).selectOption({ label: rows[i].method });
    await amounts.nth(i).fill(String(rows[i].amount));
  }
};

const runScenario = async (browser, spec) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  // 合法 token：必须匹配服务端 [A-Za-z0-9_-]{16,64}；不能用 Math.random() 里的小数点
  const token = crypto.randomBytes(16).toString('hex');
  await context.addCookies([
    { name: COOKIE_NAME, value: encodeSession({ open_id: OPEN_ID, name: '王颖' }), url: BASE },
    { name: 'scan_page_id', value: token, url: BASE },
  ]);
  const page = await context.newPage();
  try {
    for (let i = 0; i < spec.items.length; i += 1) {
      await fillGoods(page, spec.items[i], i < spec.items.length - 1);
    }
    await fillPayment(page, spec.payments);
    if (spec.duplicate) {
      await page.evaluate(() => {
        const button = document.querySelector('form[data-view="payment-pay"] button[type="submit"]');
        button.click();
        button.click();
      });
    } else {
      await page.locator('form[data-view="payment-pay"] button[type="submit"]').click();
    }
    await page.waitForURL(/\/workbench\//, { timeout: 60000 });
    const orderNo = parseOrderNo(await page.locator('[data-view="workbench-toast"]').textContent());
    console.log(`✔ ${spec.name} ${orderNo}`);
    return orderNo;
  } finally {
    await context.close();
  }
};

(async () => {
  if (!OPEN_ID) throw new Error('缺少 E2E_OPEN_ID');
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 120,
  });
  const orders = [];
  try {
    for (const spec of PLAN) orders.push(await runScenario(browser, spec));
    console.log(JSON.stringify({ ok: true, orders }));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((error) => {
  console.error('❌ 生产浏览器 E2E 失败：', error);
  process.exit(1);
});
