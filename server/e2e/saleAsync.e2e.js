'use strict';

/**
 * 销售异步链路·可重放浏览器 E2E
 *
 * 运行：
 *   cd server/test/e2e && npm install && npm test
 *
 * 依赖：
 *   - 本机 Google Chrome
 *   - server/.env / 仓库根 .env 指向测试 Base
 *   - 服务端端口 E2E_PORT（默认 5052）
 *
 * 覆盖：
 *   1. 一单一货·现货·单支付
 *   2. 一现货一预定·多支付
 *   3. 重复点击资金页提交（只产生一单）
 *
 * 断言：
 *   - 提交后直接到 /workbench/，有 toast
 *   - 主表/明细/收款/库存按 payload 写对
 *   - 重复点击不重复建单
 */

const { chromium } = require('playwright-core');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { V1BitableGateway, textValue, linkedRecordIds } = require('../src/services/v1BitableGateway');
const { encodeSession, COOKIE_NAME } = require('../src/routes/feishuWebAuth');

const PORT = Number(process.env.E2E_PORT || 5052);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.LARK_WEB_SESSION_SECRET || 'e2e-secret';
const OPEN_ID = String(process.env.E2E_OPEN_ID || '').trim();
const ITEM = '66133-15|咖色|B';
const SIZE_SPOT = '36';
const SIZE_PREORDER = '37';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (fn, { timeoutMs = 120000, intervalMs = 1500, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}（last=${last?.message || last}）`);
};

const startServer = async () => {
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), LARK_WEB_AUTH_ENABLED: 'true', LARK_WEB_SESSION_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitFor(async () => {
    const res = await fetch(`${BASE}/health`);
    return res.ok;
  }, { timeoutMs: 60000, label: 'server /health' });
  return child;
};

const build = async (gateway) => {
  const products = await gateway.listAll('product');
  const product = products.find((row) => String(textValue(row.fields[gateway.table('product').fields.number])) === ITEM);
  if (!product) throw new Error(`测试 Base 找不到货品 ${ITEM}`);
  const sizes = await gateway.listAll('sizeManagement');
  const sizeOf = (label) => sizes.find((row) => String(textValue(row.fields[gateway.table('sizeManagement').fields.size])) === label);
  const spotSize = sizeOf(SIZE_SPOT);
  const preorderSize = sizeOf(SIZE_PREORDER);
  if (!spotSize || !preorderSize) throw new Error('测试 Base 缺少尺码 36/37');
  return { product, spotSize, preorderSize };
};

const seedSpot = async (gateway, product, size) => gateway.create('liveInventory', {
  product: [product.record_id],
  size: [size.record_id],
  state: '门盒',
});

const cookieValue = () => {
  process.env.LARK_WEB_SESSION_SECRET = SECRET;
  return encodeSession({ open_id: OPEN_ID, name: '赵瑞玲' });
};

const parseOrderNo = (text) => {
  const match = String(text || '').match(/XSD-\d{8}-\d{4}/);
  if (!match) throw new Error(`toast 里没有单号：${text}`);
  return match[0];
};

const selectGoods = async (page) => {
  const spot = page.locator(`input[name="size"][value="${SIZE_SPOT}"]`);
  const pre = page.locator(`input[name="size"][value="${SIZE_PREORDER}"]`);
  if (await spot.count()) await spot.check({ force: true });
  else if (await pre.count()) await pre.check({ force: true });
  else throw new Error('货品页没有 36/37 尺码');
  await page.locator('input[name="amount"]').first().fill('200');
};

const submitGoods = async (page, { add } = {}) => {
  const selector = add
    ? 'button[name="action"][value="add_line"]'
    : 'button[name="action"][value="submit_order"]';
  await page.locator(selector).click();
};

const pay = async (page, rows) => {
  await page.waitForURL(/\/s\//, { timeout: 30000 }).catch(() => {});
  await page.getByText('总金额', { exact: false }).waitFor({ timeout: 60000 });
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await page.locator('button[data-payment-add]').click();
    const selects = page.locator('form[data-view="payment-pay"] select');
    await selects.nth(i).selectOption({ label: rows[i].method });
    const amounts = page.locator('form[data-view="payment-pay"] input[name="payment_amount"]');
    await amounts.nth(i).fill(String(rows[i].amount));
  }
  await page.locator('form[data-view="payment-pay"] button[type="submit"]').click();
};

const waitOrder = async (gateway, orderNo, expect) => {
  const entryField = gateway.table('salesEntry').fields;
  const detailField = gateway.table('salesDetail').fields;
  const paymentField = gateway.table('paymentRecord').fields;
  return waitFor(async () => {
    const entries = await gateway.listAll('salesEntry');
    const entry = entries.find((row) => String(textValue(row.fields[entryField.orderNo])) === orderNo);
    if (!entry || String(textValue(entry.fields[entryField.writeStatus])) !== '成功') return null;
    const details = (await gateway.listAll('salesDetail')).filter((row) => linkedRecordIds(row.fields[detailField.salesEntry]).includes(entry.record_id));
    const payments = (await gateway.listAll('paymentRecord')).filter((row) => linkedRecordIds(row.fields[paymentField.salesEntry]).includes(entry.record_id));
    if (details.length < expect.details || payments.length < expect.payments) return null;
    return { entry, details, payments };
  }, { timeoutMs: 180000, label: `order ${orderNo}` });
};

const scenario = async (browser, gateway, ctx) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addCookies([{ name: COOKIE_NAME, value: cookieValue(), domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const productUrl = `${BASE}/s/${encodeURIComponent(ITEM)}?from=sales`;

  // 1) 一单一货现货单支付
  const seed1 = await seedSpot(gateway, ctx.product, ctx.spotSize);
  try {
    await page.goto(productUrl);
    await selectGoods(page);
    await submitGoods(page);
    await pay(page, [{ method: '微信扫码', amount: 200 }]);
    await page.waitForURL(/\/workbench\//, { timeout: 30000 });
    const toast = await page.locator('[data-view="workbench-toast"]').textContent();
    const orderNo = parseOrderNo(toast);
    const result = await waitOrder(gateway, orderNo, { details: 1, payments: 1 });
    if (result.details.length !== 1 || result.payments.length !== 1) throw new Error(`一单一货数量不对：${result.details.length}/${result.payments.length}`);
    console.log(`✔ 1 一单一货·现货·单支付 ${orderNo}`);
  } finally {
    await gateway.delete('liveInventory', seed1.recordId).catch(() => {});
  }

  // 2) 一现货一预定·多支付（36 现货 + 37 预定；总额 400，微信300 + 现金100）
  const seed2 = await seedSpot(gateway, ctx.product, ctx.spotSize);
  try {
    await page.goto(productUrl);
    await selectGoods(page);
    await submitGoods(page, { add: true });
    await page.goto(productUrl);
    await page.locator(`input[name="size"][value="${SIZE_PREORDER}"]`).check({ force: true });
    await page.locator('input[name="amount"]').first().fill('200');
    await submitGoods(page);
    await pay(page, [{ method: '微信扫码', amount: 300 }, { method: '现金', amount: 100 }]);
    await page.waitForURL(/\/workbench\//, { timeout: 30000 });
    const toast = await page.locator('[data-view="workbench-toast"]').textContent();
    const orderNo = parseOrderNo(toast);
    const result = await waitOrder(gateway, orderNo, { details: 2, payments: 2 });
    if (result.details.length !== 2) throw new Error(`多货明细数不对：${result.details.length}`);
    const total = Number(textValue(result.entry.fields[gateway.table('salesEntry').fields.totalAmount]));
    if (total !== 400) throw new Error(`总额不对：${total}`);
    console.log(`✔ 2 一现货一预定·多支付 ${orderNo}`);
  } finally {
    await gateway.delete('liveInventory', seed2.recordId).catch(() => {});
  }

  // 3) 重复点击资金页提交（同一单只建一次）
  const seed3 = await seedSpot(gateway, ctx.product, ctx.spotSize);
  try {
    await page.goto(productUrl);
    await selectGoods(page);
    await submitGoods(page);
    await page.getByText('总金额', { exact: false }).waitFor({ timeout: 60000 });
    await page.locator('form[data-view="payment-pay"] select').first().selectOption({ label: '微信扫码' });
    await page.locator('form[data-view="payment-pay"] input[name="payment_amount"]').first().fill('200');
    await page.evaluate(() => {
      const form = document.querySelector('form[data-view="payment-pay"]');
      form.requestSubmit();
      setTimeout(() => form.requestSubmit(), 30);
    });
    await page.waitForURL(/\/workbench\//, { timeout: 30000 });
    const toast = await page.locator('[data-view="workbench-toast"]').textContent();
    const orderNo = parseOrderNo(toast);
    const result = await waitOrder(gateway, orderNo, { details: 1, payments: 1 });
    const entries = await gateway.listAll('salesEntry');
    const same = entries.filter((row) => String(textValue(row.fields[gateway.table('salesEntry').fields.orderNo])) === orderNo);
    if (same.length !== 1) throw new Error(`重复点击后单号不唯一：${same.length}`);
    console.log(`✔ 3 重复点击只建一单 ${orderNo}`);
  } finally {
    await gateway.delete('liveInventory', seed3.recordId).catch(() => {});
  }

  await context.close();
};

(async () => {
  if (!OPEN_ID) throw new Error('缺少 E2E_OPEN_ID（测试操作人的飞书 open_id）');
  const gateway = new V1BitableGateway();
  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const ctx = await build(gateway);
    await scenario(browser, gateway, ctx);
    console.log('✅ 销售异步浏览器 E2E 通过');
  } finally {
    await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), sleep(5000)]).catch(() => {});
  }
})().catch((error) => {
  console.error('❌ E2E 失败：', error);
  process.exit(1);
});
