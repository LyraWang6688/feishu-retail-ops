import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

test('销售查询快捷范围包含今天、昨天、前天和近3/7/30天', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/sales/query') return route.fulfill(json({ success: true, summary: {}, orders: [] }));
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });
  await page.setViewportSize({ width: 430, height: 800 });
  await page.goto('/workbench/?module=sales&page=sales-query', { waitUntil: 'networkidle' });
  const range = page.locator('[data-sq-range]');
  await expect(range.locator('option')).toHaveText(['今天', '昨天', '前天', '近3天', '近7天', '近30天']);
  const yesterday = await page.evaluate(() => {
    const d = new Date(Date.now() - 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  });
  await range.selectOption('yesterday');
  await expect(page.locator('[data-sq-from]')).toHaveValue(yesterday);
  await expect(page.locator('.sq-filters .date-control__value').first()).toHaveText(yesterday);
});
