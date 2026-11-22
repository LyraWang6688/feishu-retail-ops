import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

test('销售查询三标签：概览 / 明细 / 趋势，查询条件和标签栏固定', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    if (path === '/api/workbench/sales/query') return route.fulfill(json({
      success: true,
      summary: {
        revenue: 258,
        accessory_sales: { amount: 0 },
        payment_methods: [{ method: '微信扫码', amount: 258, count: 1 }],
        pending_methods: [],
        delivered: { count: 1, amount: 258 },
        undelivered: { count: 0, amount: 0 },
        by_category: [{ name: '休闲鞋', delivered_count: 1, undelivered_count: 0, delivered_amount: 258, undelivered_amount: 0 }],
        by_type: [],
      },
      orders: [{
        order_no: 'XSD-20261122-0003',
        recorded_at: '2026-11-22T04:50:00.000Z',
        total_amount: 258,
        payments: [{ method: '微信扫码', amount: 258, status: '已收款' }],
        details: [{ number: '1033-8|棕色|女|超长货号用于测试横向滚动', size: 39, actual_amount: 258, fulfillment_status: '已交付' }],
      }],
    }));
    return route.fulfill(json({ success: true }));
  });
  await page.goto('/workbench/?module=sales&page=sales-query', { waitUntil: 'networkidle' });

  await expect(page.locator('[data-sq-tab]')).toHaveText(['经营概览', '销售明细', '趋势分析']);
  await expect(page.getByRole('heading', { name: '销售金额' })).toBeVisible();
  await page.locator('[data-sq-tab="details"]').click();
  await expect(page.getByRole('heading', { name: '销售明细' })).toBeVisible();
  await expect(page.getByText('XSD-20261122-0003')).toBeVisible();
  await expect(page.getByRole('heading', { name: '销售金额' })).toHaveCount(0);
  await page.locator('[data-sq-tab="trend"]').click();
  await expect(page.getByText('趋势分析正在建设中。')).toBeVisible();
  await page.locator('[data-sq-tab="overview"]').click();
  await expect(page.getByRole('heading', { name: '销售金额' })).toBeVisible();

  await page.evaluate(() => { document.body.style.minHeight = '2400px'; window.scrollTo(0, 700); });
  await page.waitForTimeout(80);
  const boxes = await page.evaluate(() => {
    const main = document.querySelector('.main-tabs')?.getBoundingClientRect();
    const sticky = document.querySelector('.sq-sticky-head')?.getBoundingClientRect();
    return { mainBottom: main ? main.bottom : 0, stickyTop: sticky ? sticky.top : 0, scrollY: window.scrollY };
  });
  expect(boxes.scrollY).toBeGreaterThan(0);
  expect(boxes.stickyTop).toBeGreaterThanOrEqual(boxes.mainBottom - 2);
  await expect(page.locator('.sq-filters')).toBeVisible();
  await expect(page.locator('.sq-tabs')).toBeVisible();
});
