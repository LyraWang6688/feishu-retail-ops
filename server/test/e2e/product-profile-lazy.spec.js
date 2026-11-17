import { test, expect } from '@playwright/test';

/**
 * 货品资料缩略图：**严格进入视口才请求**（2026-11-17，业务负责人）。
 * 用 20 条搜索结果把列表撑出首屏；在滚动前只允许请求首屏那几张。
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

test('缩略图：滚动进入视口才请求（不是一次性拉全部）', async ({ page }) => {
  const imageRequests = [];
  const items = Array.from({ length: 20 }, (_, index) => ({
    recordId: `p${index}`,
    number: `LAZY${String(index).padStart(2, '0')}|黑色|男`,
    itemNo: `LAZY${String(index).padStart(2, '0')}`,
    color: '黑色',
    category: '男',
    hasSampleImage: true,
    imageUrl: `/api/workbench/products/p${index}/sample-image`,
    recordUrl: 'https://example.feishu.cn/base/app?table=tbl&record=p' + index,
    issues: [],
  }));

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (url.pathname === '/api/workbench/products/search') {
      return route.fulfill(json({ success: true, items }));
    }
    if (/^\/api\/workbench\/products\/p\d+\/sample-image$/.test(url.pathname)) {
      imageRequests.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    if (url.pathname === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  await page.goto('/workbench/');
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByRole('button', { name: '货品资料', exact: true }).click();
  await page.getByRole('button', { name: /货品上新/ }).click();
  await page.locator('[data-pp-search]').fill('LAZY');
  await expect(page.locator('[data-pp-results] .pp-row')).toHaveCount(20);

  // 首屏只应请求视口内的少数几张（20 条不可能一次全发）。
  await expect.poll(() => imageRequests.length).toBeGreaterThan(0);
  const initial = imageRequests.length;
  expect(initial).toBeLessThan(20);

  // 滚到最后一行的缩略图 ⇒ 它进入视口后才请求。
  const last = page.locator('[data-pp-results] .pp-row').last().locator('img[data-pp-thumb]');
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => imageRequests.length).toBeGreaterThan(initial);
});
