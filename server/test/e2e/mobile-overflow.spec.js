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
          accessory_sales: { amount: 5 },
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
          details: [{ number: 'YA8902|黑色|女|37|超级长的商品描述|加长货号用于滚动', size: 37, actual_amount: 940, fulfillment_status: '已交付' }],
        }],
      }));
    }
    if (path === '/api/workbench/inventory/ledger') {
      return route.fulfill(json({
        success: true, total: 2, from: '2026-11-19', to: '2026-11-19',
        rows: [
          { created_at: '2026-11-19T15:10:00.000Z', behavior: '销售减少', number: 'YA8902|黑色|女|超长货号用于滚动测试', size: '37', quantity_change: -1 },
          { created_at: '2026-11-19T15:09:00.000Z', behavior: '手工调减', number: '832-538|黑色|男|超长货号用于滚动测试', size: '39', quantity_change: 1 },
        ],
      }));
    }
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });

  for (const url of ['/workbench/?module=sales&page=sales-query', '/workbench/?module=inventory&page=inventory-ledger']) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (url.includes('sales-query')) {
      await expect(page.locator('.sq-filters .date-control')).toHaveCount(2);
      await expect(page.locator('.sq-filters .date-control__value').first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
      await expect(page.locator('.sq-revenue')).toContainText('其中包括配品销售：¥5');
      await expect(page.locator('.sq-bar-row').first()).toContainText('3 笔');
      await expect(page.locator('.sq-pending-row')).toContainText('1 笔');
      await page.locator('[data-sq-tab="details"]').click();
      await expect(page.locator('.sq-order-head').first()).toBeVisible();
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
    if (url.includes('sales-query')) {
      const aligned = await page.evaluate(() => {
        const head = document.querySelector('.sq-order-head');
        const table = head?.closest('.sq-order')?.querySelector('.sq-detail-table');
        if (!head || !table) return false;
        return Math.abs(head.getBoundingClientRect().width - table.getBoundingClientRect().width) < 2;
      });
      expect(aligned).toBe(true, '订单头与明细表同宽');
    }
    if (url.includes('inventory-ledger')) {
      const columnsAligned = await page.evaluate(() => {
        const th = document.querySelector('.ledger-table thead th:nth-child(3)');
        const td = document.querySelector('.ledger-table tbody td:nth-child(3)');
        if (!th || !td) return false;
        return Math.abs(th.getBoundingClientRect().left - td.getBoundingClientRect().left) < 2;
      });
      expect(columnsAligned).toBe(true, '库存流水表头与数据行同列');
    }

    const after = await page.evaluate(() => new Promise((resolve) => {
      const wrap = document.querySelector('[data-scroll-wrap]');
      const area = document.querySelector('[data-scroll-area]');
      area.scrollLeft = area.scrollWidth;
      setTimeout(() => resolve({ wrapClass: wrap?.className || '', scrollLeft: area.scrollLeft }), 100);
    }));
    expect(after.scrollLeft).toBeGreaterThan(0);
    expect(after.wrapClass).toContain('at-end');
    if (url.includes('inventory-ledger')) {
      await expect(page.locator('.ledger-filters .date-control')).toHaveCount(2);
      await expect(page.locator('.ledger-filters .date-control__value').first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    }
  }

});
