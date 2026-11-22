import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

test('库存分析：库存总览占位 / 库存流水标签，查询栏固定', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    if (path === '/api/workbench/inventory/ledger') return route.fulfill(json({
      success: true,
      from: '2026-11-22',
      to: '2026-11-22',
      total: 1,
      truncated: false,
      rows: [{
        created_at: '2026-11-22T04:50:00.000Z',
        behavior: '销售减少',
        number: '1033-8|棕色|女|超长货号用于测试横向滚动',
        size: '39',
        quantity_change: 1,
      }],
    }));
    return route.fulfill(json({ success: true }));
  });
  await page.goto('/workbench/?module=inventory&page=inventory-ledger', { waitUntil: 'networkidle' });

  await expect(page.getByRole('button', { name: '库存分析' })).toBeVisible();
  await expect(page.locator('[data-ledger-tab]')).toHaveText(['库存总览', '库存流水']);
  await expect(page.getByText('库存总览正在建设中。')).toBeVisible();
  await expect(page.locator('.ledger-filters')).toBeVisible();
  await page.locator('[data-ledger-tab="ledger"]').click();
  await expect(page.locator('.ledger-table')).toBeVisible();
  await expect(page.getByText('1033-8|棕色|女|超长货号用于测试横向滚动')).toBeVisible();
  await expect(page.locator('.ledger-summary')).toContainText('共 1 条');

  await page.evaluate(() => { document.querySelector('.ledger-page').style.minHeight = '1600px'; document.body.style.minHeight = '2400px'; window.scrollTo(0, 700); });
  await page.waitForTimeout(80);
  const boxes = await page.evaluate(() => {
    const main = document.querySelector('.main-tabs')?.getBoundingClientRect();
    const sticky = document.querySelector('.ledger-sticky-head')?.getBoundingClientRect();
    return { mainBottom: main ? main.bottom : 0, stickyTop: sticky ? sticky.top : 0, scrollY: window.scrollY };
  });
  expect(boxes.scrollY).toBeGreaterThan(0);
  expect(boxes.stickyTop).toBeGreaterThanOrEqual(boxes.mainBottom - 2);
  await expect(page.locator('.ledger-filters')).toBeVisible();
  await expect(page.locator('.ledger-tabs')).toBeVisible();
});
