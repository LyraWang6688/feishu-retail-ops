'use strict';

/**
 * 生产表 E2E（浏览器部分）
 *
 * 前置：
 *   - 生产临时实例已启动，默认通过 SSH 隧道暴露在 http://127.0.0.1:5052
 *   - 使用生产 Base，但**不写种子库存**，只用真实现有库存
 *   - 生产实例启动时 LARK_WEB_SESSION_SECRET=E2E_SECRET
 *
 * 运行：
 *   E2E_OPEN_ID=<open_id> E2E_BASE_URL=http://127.0.0.1:5052 E2E_SECRET=e2e-secret npm run test:prod
 *
 * 只做浏览器操作 + toast/单号断言；写入字段由 SSH 只读核验脚本另行断言。
 */
const { chromium } = require('playwright-core');
const { encodeSession, COOKIE_NAME } = require('../src/routes/feishuWebAuth');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:5052';
const SECRET = process.env.E2E_SECRET || 'e2e-secret';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || SECRET;
const OPEN_ID = String(process.env.E2E_OPEN_ID || '').trim();
const ITEM = process.env.E2E_ITEM || '66133-15|咖色|B';
const money = (n) => String(n);

const parseOrderNo = (text) => {
  const m = String(text || '').match(/XSD-\d{8}-\d{4}/);
  if (!m) throw new Error(`toast 没有单号：${text}`);
  return m[0];
};

const selectSize = async (page, size) => {
  await page.locator(`input[name="size"][value="${size}"]`).check({ force: true });
  await page.locator('input[name="amount"]').first().fill('200');
};

const submitGoods = async (page, add) => {
  await page.locator(add
    ? 'button[name="action"][value="add_line"]'
    : 'button[name="action"][value="submit_order"]').click();
};

const pay = async (page, rows) => {
  await page.getByText('总金额', { exact: false }).waitFor({ timeout: 60000 });
  const selects = page.locator('form[data-view="payment-pay"] select');
  const amounts = page.locator('form[data-view="payment-pay"] input[name="payment_amount"]');
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await page.locator('button[data-payment-add]').click();
    await selects.nth(i).selectOption({ label: rows[i].method });
    await amounts.nth(i).fill(money(rows[i].amount));
  }
};

const waitToastAndOrder = async (page) => {
  await page.waitForURL(/\/workbench\//, { timeout: 30000 });
  const toast = page.locator('[data-view="workbench-toast"]');
  await toast.waitFor({ timeout: 10000 });
  const text = await toast.textContent();
  return parseOrderNo(text);
};

(async () => {
  if (!OPEN_ID) throw new Error('缺少 E2E_OPEN_ID');
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  context.addCookies([
    {
      name: COOKIE_NAME,
      value: encodeSession({ open_id: OPEN_ID, name: '王颖' }),
      domain: '127.0.0.1',
      path: '/',
    },
    // ⭐ 必须固定一个页面 token：否则新浏览器上下文会落回旧会话，可能复用上一单的 submit_key
    { name: 'scan_page_id', value: `e2e_${Date.now()}`, domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  const url = `${BASE}/s/${encodeURIComponent(ITEM)}?from=sales`;
  const orders = [];
  try {
    // 1) 一单一货·现货·单支付：36
    await page.goto(url);
    await selectSize(page, '36');
    await submitGoods(page, false);
    await pay(page, [{ method: '微信扫码', amount: 200 }]);
    await page.locator('form[data-view="payment-pay"] button[type="submit"]').click();
    orders.push(await waitToastAndOrder(page));
    console.log(`✔ 生产单 1 现货36 ${orders.at(-1)}`);

    // 2) 多货按钮 + 现货38 + 预定37 + 部分收款：总额400，只付300
    await page.goto(url);
    await selectSize(page, '38');
    await submitGoods(page, true);
    await page.goto(url);
    await selectSize(page, '37');
    await submitGoods(page, false);
    await pay(page, [{ method: '微信扫码', amount: 300 }]);
    await page.locator('form[data-view="payment-pay"] button[type="submit"]').click();
    orders.push(await waitToastAndOrder(page));
    console.log(`✔ 生产单 2 38现货+37预定+未收款 ${orders.at(-1)}`);

    // 3) 重复点击：39
    await page.goto(url);
    await selectSize(page, '39');
    await submitGoods(page, false);
    await page.getByText('总金额', { exact: false }).waitFor({ timeout: 60000 });
    await page.locator('form[data-view="payment-pay"] select').first().selectOption({ label: '微信扫码' });
    await page.locator('form[data-view="payment-pay"] input[name="payment_amount"]').first().fill('200');
    await page.evaluate(() => {
      const button = document.querySelector('form[data-view="payment-pay"] button[type="submit"]');
      button.click();
      button.click();
    });
    orders.push(await waitToastAndOrder(page));
    console.log(`✔ 生产单 3 重复点击 ${orders.at(-1)}`);
    console.log(JSON.stringify({ ok: true, orders }));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((error) => {
  console.error('❌ 生产浏览器 E2E 失败：', error);
  process.exit(1);
});
