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
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const summaryBox = await page.locator('[data-view="arrival-summary"]').boundingBox();
  // 顶部多了「验收区 / 预览区」tab；汇总条在 tab 下方吸顶
  expect(summaryBox.y).toBeLessThanOrEqual(80);

  const p1 = page.locator('.arrival-product').filter({ hasText: '1138-32' });
  const sizeBoxes = await p1.locator('.arrival-size-row').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(sizeBoxes.length).toBeGreaterThanOrEqual(2);
  expect(Math.abs(sizeBoxes[0].y - sizeBoxes[1].y)).toBeLessThan(4);
  expect(sizeBoxes[1].x).toBeGreaterThan(sizeBoxes[0].x);
  expect(sizeBoxes[0].width).toBeLessThan(320);
  await p1.locator('[data-add-size="p1"]').click();
  const customSize = p1.locator('[data-field="custom-size"]');
  await customSize.fill('42');
  const uid = await customSize.getAttribute('data-row-uid');
  await p1.locator('[data-field="arrival-actual"][data-row-uid="' + uid + '"]').fill('2');
  await expect(page.locator('[data-view="arrival-summary"]')).toContainText('应到 7 双 / 实到 7 双 / 多到 2 双');
  await expect(page.locator('[data-view="arrival-total"]')).toHaveText('9 双');
});

test('验收明细：验收区 / 预览区切换，三色状态实时跟随，自定义尺码算多到', async ({ page }) => {
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

  await page.goto('/workbench/purchase-acceptance-detail.html?batchNo=BH-2&supplierRecordId=s1&supplierName=%E4%BE%9B%E5%BA%94%E5%95%86');
  await expect(page.locator('[data-arrival-tab="accept"]')).toHaveText('验收区');
  await expect(page.locator('[data-arrival-tab="preview"]')).toHaveText('预览区');

  await page.locator('[data-arrival-tab="preview"]').click();
  await expect(page.locator('[data-view="arrival-panel-preview"]')).toBeVisible();
  await expect(page.locator('[data-view="arrival-panel-accept"]')).toBeHidden();
  await expect(page.locator('[data-view="arrival-preview-summary"]')).toContainText('应到 7 双 / 实到 7 双 / 多到 0 双');
  await expect(page.locator('.arrival-preview-row.is-match')).toHaveCount(3);

  await page.locator('[data-arrival-tab="accept"]').click();
  const p1 = page.locator('.arrival-product').filter({ hasText: '1138-32' });
  const row39 = p1.locator('.arrival-size-row').filter({ hasText: '39' });
  await row39.locator('[data-field="arrival-actual"]').fill('0');
  const p2 = page.locator('.arrival-product').filter({ hasText: '206' });
  await p2.locator('[data-field="arrival-actual"]').fill('5');
  await p1.locator('[data-add-size="p1"]').click();
  const customSize = p1.locator('[data-field="custom-size"]');
  await customSize.fill('42');
  const uid = await customSize.getAttribute('data-row-uid');
  await p1.locator('[data-field="arrival-actual"][data-row-uid="' + uid + '"]').fill('2');

  await page.locator('[data-arrival-tab="preview"]').click();
  await expect(page.locator('[data-view="arrival-preview-summary"]')).toContainText('应到 7 双 / 实到 6 双 / 多到 3 双');
  await expect(page.locator('.arrival-preview-row.is-short')).toHaveCount(1);
  await expect(page.locator('.arrival-preview-row.is-short')).toContainText('39');
  await expect(page.locator('.arrival-preview-row.is-short')).toContainText('未到货');
  await expect(page.locator('.arrival-preview-row.is-extra')).toHaveCount(2);
  await expect(page.locator('.arrival-preview-row.is-extra').filter({ hasText: '40' })).toContainText('多到货');
  await expect(page.locator('.arrival-preview-row.is-extra').filter({ hasText: '42' })).toContainText('自定义');
});
