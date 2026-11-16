import { test, expect } from '@playwright/test';

/**
 * 扫码页「库存调整」按钮的落点（2026-11-17）：
 *   /workbench/?module=inventory&page=inventory-adjust&product=<recordId>
 * 必须直接打开「库存 → 手工调整 → 单双调整」，并把这一款的编辑行展开。
 */
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

test('深链：module=inventory&page=inventory-adjust&product=… 直接展开这一款', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (url.pathname === '/api/workbench/inventory') {
      return route.fulfill(json({
        success: true,
        rows: [{
          product_record_id: 'p1', product_number: 'HL55173-1', color: '黑色', category: '休闲鞋',
          size: '40', state: '门盒', quantity: 1,
        }],
      }));
    }
    if (url.pathname === '/api/workbench/products/p1') {
      return route.fulfill(json({
        success: true,
        item: { number: 'HL55173-1|黑色|男', color: '黑色', category: '休闲鞋' },
      }));
    }
    if (url.pathname === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  await page.goto('/workbench/?module=inventory&page=inventory-adjust&product=p1');
  await expect(page.locator('[data-view="single-label"]')).toContainText('HL55173-1');
  await expect(page.locator('[data-view="single-rows"] .edit-row')).toHaveCount(1);
  await expect(page.locator('[data-manual="cards"]')).toBeHidden();
});
