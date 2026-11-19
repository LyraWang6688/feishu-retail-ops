import { test, expect } from '@playwright/test';

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

test('验收明细：应到/实到/多到 + 自定义尺码后固定底栏同步', async ({ page }) => {
  const rows = [
    { product_record_id: 'p1', item_no: '1138-32', color: '黑色', number: '1138-32|黑色|女', size: 38, quantity: 2 },
    { product_record_id: 'p1', item_no: '1138-32', color: '黑色', number: '1138-32|黑色|女', size: 39, quantity: 1 },
    { product_record_id: 'p2', item_no: '206', color: '红色', number: '206|红色|女', size: 40, quantity: 4 },
  ];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workbench/purchase/arrivals/detail') {
      return route.fulfill(json({ success: true, rows }));
    }
    if (url.pathname === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  await page.goto('/workbench/purchase-acceptance-detail.html?batchNo=BH-1&supplierRecordId=s1&supplierName=%E4%BE%9B%E5%BA%94%E5%95%86');
  await expect(page.locator('[data-view="arrival-summary"]')).toContainText('应到 7 双 / 实到 7 双 / 多到 0 双');
  await expect(page.locator('.arrival-product').first()).toContainText('206');

  const p1 = page.locator('.arrival-product').filter({ hasText: '1138-32' });
  await p1.locator('[data-add-size="p1"]').click();
  const customSize = p1.locator('[data-field="custom-size"]');
  await customSize.fill('42');
  const uid = await customSize.getAttribute('data-row-uid');
  await p1.locator('[data-field="arrival-actual"][data-row-uid="' + uid + '"]').fill('2');
  await expect(page.locator('[data-view="arrival-summary"]')).toContainText('应到 7 双 / 实到 7 双 / 多到 2 双');
  await expect(page.locator('[data-view="arrival-total"]')).toHaveText('9 双');
});
