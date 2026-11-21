import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

test('360px 销售查询 / 库存流水不撑出页面', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/sales/query') {
      return route.fulfill(json({
        success: true,
        summary: {
          revenue: 1880,
          delivered: { count: 2, amount: 1880 },
          undelivered: { count: 0, amount: 0 },
          payment_methods: [{ method: '微信扫码', amount: 1710, count: 3 }, { method: '现金', amount: 170, count: 1 }],
          pending_methods: [{ method: '抖音代金券', amount: 256.2, count: 1 }],
          by_category: [{ name: '休闲鞋', delivered_count: 2, delivered_amount: 1880, undelivered_count: 0, undelivered_amount: 0 }],
          by_type: [],
        },
        orders: [{
          order_no: 'XSD-20261119-0013', recorded_at: '2026-11-19T15:10:00.000Z', total_amount: 1880,
          payments: [{ method: '微信扫码', amount: 1710, status: '已收' }],
          details: [{ number: 'YA8902|黑色|女|37|超级长的商品描述', size: 37, actual_amount: 940, fulfillment_status: '已交付' }],
        }],
      }));
    }
    if (path === '/api/workbench/inventory/ledger') {
      return route.fulfill(json({
        success: true, total: 2, from: '2026-11-19', to: '2026-11-19',
        rows: [
          { created_at: '2026-11-19T15:10:00.000Z', behavior: '销售减少', number: 'YA8902|黑色|女', size: '37', quantity_change: -1 },
          { created_at: '2026-11-19T15:09:00.000Z', behavior: '手工调减', number: '832-538|黑色|男', size: '39', quantity_change: 1 },
        ],
      }));
    }
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  for (const url of ['/workbench/?module=sales&page=sales-query', '/workbench/?module=inventory&page=inventory-ledger']) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (url.includes('sales-query')) {
      await expect(page.locator('.sq-bar-row').first()).toContainText('3 笔');
      await expect(page.locator('.sq-pending-row')).toContainText('1 笔');
    }
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.doc).toBeLessThanOrEqual(widths.viewport);
    expect(widths.body).toBeLessThanOrEqual(widths.viewport);

    const initial = await page.evaluate(() => {
      const wrap = document.querySelector('[data-scroll-wrap]');
      const area = document.querySelector('[data-scroll-area]');
      return { wrapClass: wrap?.className || '', max: area ? area.scrollWidth - area.clientWidth : 0 };
    });
    expect(initial.max).toBeGreaterThan(0);
    expect(initial.wrapClass).toContain('has-overflow');

    const after = await page.evaluate(() => new Promise((resolve) => {
      const wrap = document.querySelector('[data-scroll-wrap]');
      const area = document.querySelector('[data-scroll-area]');
      area.scrollLeft = area.scrollWidth;
      setTimeout(() => resolve({ wrapClass: wrap?.className || '', scrollLeft: area.scrollLeft }), 100);
    }));
    expect(after.scrollLeft).toBeGreaterThan(0);
    expect(after.wrapClass).toContain('at-end');
  }

});
