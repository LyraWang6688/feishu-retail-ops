import { test, expect } from '@playwright/test';

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

const mockApi = async (page, { orders = [] } = {}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (path === '/api/workbench/sales/orders') {
      return route.fulfill(json({ success: true, methods: [], orders }));
    }
    if (path === '/api/workbench/sales/after-sales/candidates') {
      return route.fulfill(json({
        success: true,
        productRecordId: 'p1',
        days: 7,
        candidates: [{
          record_id: 'o1',
          order_no: 'XSD-E2E-001',
          recorded_at: Date.now(),
          fulfillment_status: '已交付',
          payment_status: '已收款',
          matched_details: [{ record_id: 'd1', product: 'YD1', color: '黑', size: 40, actual_amount: 100 }],
        }],
      }));
    }
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });
};

test.beforeEach(async ({ page }) => { await mockApi(page); });

test('五个领域 tab + 订单列表懒加载', async ({ page }) => {
  const orderRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/workbench/sales/orders') orderRequests.push(request.url());
  });
  await page.goto('/workbench/');
  await expect(page.getByText('已登录：E2E')).toBeVisible();
  await expect(page.locator('.main-tab')).toHaveText(['销售', '库存', '供应', '货品', '资金']);

  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  await expect(page.getByRole('button', { name: /交割单/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /售后单/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /草稿单/ })).toBeVisible();
  expect(orderRequests).toHaveLength(0);

  await page.getByRole('button', { name: /交割单/ }).click();
  await expect.poll(() => orderRequests.length).toBe(1);
  await expect(page.getByText('这一类现在没有单')).toBeVisible();
});

test('订单三卡同宽、横向居中，且无横向滚动', async ({ page }) => {
  await page.goto('/workbench/');
  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  const cards = page.locator('.orders-section-card');
  await expect(cards).toHaveCount(3);
  const boxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThanOrEqual(1);
  const align = await cards.first().evaluate((node) => {
    const style = getComputedStyle(node);
    return { direction: style.flexDirection, justify: style.justifyContent };
  });
  expect(align).toEqual({ direction: 'row', justify: 'center' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('售后候选页：选单后出现退货 / 换货 / 赔货', async ({ page }) => {
  await page.goto('/workbench/after-sales.html?productRecordId=p1');
  await expect(page.getByText('XSD-E2E-001')).toBeVisible();
  await page.getByRole('button', { name: /XSD-E2E-001/ }).click();
  await expect(page.getByRole('button', { name: '退货' })).toBeVisible();
  await expect(page.getByRole('button', { name: '换货' })).toBeVisible();
  await expect(page.getByRole('button', { name: '赔货' })).toBeVisible();
  await page.getByRole('button', { name: '退货' }).click();
  await expect(page).toHaveURL(/after_sales_order=o1/);
  await expect(page).toHaveURL(/after_sales_action=return/);
});
