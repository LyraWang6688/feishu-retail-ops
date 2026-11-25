import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

const OVERVIEW = {
  success: true,
  range: { from: '2026-11-25', to: '2026-11-25', days: 1 },
  change: {
    from: '2026-11-25',
    to: '2026-11-25',
    inbound: { records: 2, pairs: 3 },
    outbound: { records: 1, pairs: 1 },
    net_pairs: 2,
    groups: [
      { key: 'inbound', label: '入库', direction: '增加', records: 2, pairs: 3, behaviors: [{ key: 'b1', name: '手工调增', records: 2, pairs: 3 }] },
      { key: 'outbound', label: '出库', direction: '减少', records: 1, pairs: 1, behaviors: [{ key: 'b2', name: '销售减少', records: 1, pairs: 1 }] },
      { key: 'state', label: '状态调整', direction: '不影响', records: 1, pairs: 0, behaviors: [{ key: 'b3', name: '转样品', records: 1, pairs: 0 }] },
      { key: 'unknown', label: '未分类', direction: '', records: 0, pairs: 0, behaviors: [] },
    ],
    truncated: false,
    limit: 20000,
    state_anomalies: 0,
  },
  snapshot: {
    total: { pairs: 5, styles: 3 },
    seasons: {
      current: { key: 'current', label: '当季', pairs: 4, styles: 2 },
      off: { key: 'off', label: '非当季', pairs: 1, styles: 1 },
    },
    current: {
      pairs: 4,
      styles: 2,
      states: [{ key: 'doorbox', label: '门盒', pairs: 3 }, { key: 'sample', label: '样品', pairs: 1 }],
      by_category: [{ name: '单鞋', pairs: 3, styles: 1, share: 0.75 }, { name: '棉鞋', pairs: 1, styles: 1, share: 0.25 }],
      by_class: [{ name: '男', pairs: 3, styles: 2, share: 0.75 }, { name: '女', pairs: 1, styles: 1, share: 0.25 }],
      by_supplier: [{ name: '信踏', pairs: 4, styles: 2, share: 1 }],
    },
    missing: { season: 'current', category_pairs: 0, class_pairs: 0, supplier_pairs: 0 },
  },
};

test('库存分析：总览（变动→现状）/ 流水标签，查询栏固定，日期栏不新增', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    if (path === '/api/workbench/inventory/overview') return route.fulfill(json(OVERVIEW));
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
  // 日期栏沿用页面上已有那一个：总览不新增第二个控件。
  await expect(page.locator('.ledger-filters')).toHaveCount(1);
  await expect(page.locator('.ledger-filters')).toBeVisible();

  const change = page.locator('[data-overview-change]');
  const snapshot = page.locator('[data-overview-snapshot]');
  await expect(change).toBeVisible();
  await expect(snapshot).toBeVisible();

  // B 段在前、A 段在后（业务负责人 2026-11-25 定）。
  const order = await page.evaluate(() => ({
    change: document.querySelector('[data-overview-change]').getBoundingClientRect().top,
    snapshot: document.querySelector('[data-overview-snapshot]').getBoundingClientRect().top,
  }));
  expect(order.change).toBeLessThan(order.snapshot);

  await expect(change).toContainText('库存变动');
  await expect(change).toContainText('统计区间 2026-11-25 · 按库存流水创建时间');
  await expect(page.locator('[data-change-group="inbound"]')).toContainText('手工调增');
  await expect(page.locator('[data-change-group="inbound"]')).toContainText('3 双');
  await expect(page.locator('[data-change-group="state"]')).toContainText('转样品');
  await expect(page.locator('[data-change-group="state"]')).toContainText('不影响库存总量');
  await expect(page.locator('.ledger-metric--net')).toContainText('+2');

  await expect(snapshot).toContainText('库存现状');
  await expect(snapshot).toContainText('实时快照，不受上方日期影响');
  await expect(snapshot).toContainText('门盒');
  await expect(snapshot).toContainText('单鞋');
  await expect(snapshot).toContainText('信踏');

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
