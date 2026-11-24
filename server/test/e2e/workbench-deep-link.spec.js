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
  let inventoryQuery = '';
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (url.pathname === '/api/workbench/inventory') {
      inventoryQuery = url.searchParams.get('productRecordId') || '';
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
  expect(inventoryQuery).toBe('p1');
});

test('空状态：下拉显示「请选择状态」，保存前必须先选，不能偷偷按门盒提交', async ({ page }) => {
  const pairPosts = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (url.pathname === '/api/workbench/inventory') {
      return route.fulfill(json({
        success: true,
        rows: [{
          product_record_id: 'p1', product_number: 'HL55173-1', color: '黑色', category: '休闲鞋',
          size: '40', state: '', quantity: 2,
        }],
      }));
    }
    if (url.pathname === '/api/workbench/inventory/adjustments/pairs' && request.method() === 'POST') {
      pairPosts.push(JSON.parse(request.postData() || '{}'));
      return route.fulfill(json({ success: true, job_id: 'job_pair_1' }));
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
  const stateSelect = page.locator('select[data-k="state"]');
  await expect(stateSelect).toHaveValue('');
  await expect(stateSelect.locator('option:checked')).toHaveText('请选择状态');

  // 空状态不偷偷当门盒：点保存 ⇒ 前端拦住、不发请求，并聚焦到这个下拉
  await page.locator('[data-save]').click();
  await expect(page.locator('#page-error')).toContainText('请先为每一行选择「所属状态」');
  expect(pairPosts).toHaveLength(0);

  await stateSelect.selectOption('门盒');
  await page.locator('[data-save]').click();
  await expect(page.locator('[data-view="sample-modal"]')).toBeVisible();
  await expect(page.locator('[data-view="sample-modal"]')).toContainText('这一款没有样品');
  expect(pairPosts).toHaveLength(0);

  // 只是提醒：点「仍然保存」不改成样品也必须能提交
  await page.locator('[data-sample-continue]').click();
  await expect.poll(() => pairPosts.length).toBe(1);
  expect(pairPosts[0].rows).toEqual([{ size: 40, state: '门盒', quantity: 2 }]);
});

test('样品两双：保存前弹「样品多」提醒，仍然可以提交', async ({ page }) => {
  const pairPosts = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (url.pathname === '/api/workbench/inventory') {
      return route.fulfill(json({
        success: true,
        rows: [
          { product_record_id: 'p1', product_number: 'HL55173-1', color: '黑色', category: '休闲鞋', size: '40', state: '样品', quantity: 2 },
          { product_record_id: 'p1', product_number: 'HL55173-1', color: '黑色', category: '休闲鞋', size: '41', state: '门盒', quantity: 1 },
        ],
      }));
    }
    if (url.pathname === '/api/workbench/inventory/adjustments/pairs' && request.method() === 'POST') {
      pairPosts.push(JSON.parse(request.postData() || '{}'));
      return route.fulfill(json({ success: true, job_id: 'job_pair_extra' }));
    }
    if (url.pathname === '/api/workbench/products/p1') {
      return route.fulfill(json({ success: true, item: { number: 'HL55173-1|黑色|男', color: '黑色', category: '休闲鞋' } }));
    }
    if (url.pathname === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  await page.goto('/workbench/?module=inventory&page=inventory-adjust&product=p1');
  await page.locator('[data-save]').click();
  await expect(page.locator('[data-view="sample-modal"]')).toBeVisible();
  await expect(page.locator('[data-view="sample-modal"]')).toContainText('这一款有 2 双样品');
  await expect(page.locator('[data-view="sample-modal"]')).toContainText('正常应只有 1 双样品');
  expect(pairPosts).toHaveLength(0);
  await page.locator('[data-sample-continue]').click();
  await expect.poll(() => pairPosts.length).toBe(1);
  expect(pairPosts[0].rows).toEqual([{ size: 40, state: '样品', quantity: 2 }, { size: 41, state: '门盒', quantity: 1 }]);
});

