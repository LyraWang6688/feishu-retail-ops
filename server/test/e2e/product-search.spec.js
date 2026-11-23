import { test, expect } from '@playwright/test';

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const productNumber = '1033-8|棕色|女';

const salesSummary = {
  revenue: 258,
  accessory_sales: { amount: 0 },
  payment_methods: [{ method: '微信扫码', amount: 258, count: 1 }],
  pending_methods: [],
  delivered: { count: 1, amount: 258 },
  undelivered: { count: 0, amount: 0 },
  by_category: [],
  by_type: [],
};
const order = {
  order_no: 'XSD-20261122-0003',
  recorded_at: '2026-11-22T04:50:00.000Z',
  total_amount: 258,
  payments: [{ method: '微信扫码', amount: 258, status: '已收款' }],
  details: [{ number: productNumber, size: 39, actual_amount: 258, fulfillment_status: '已交付' }],
};

test('销售明细按 recordId 过滤；库存流水暂按完整编号过滤（搜索候选带记录 ID）', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  const requests = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/auth/feishu/me') return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    if (path === '/api/workbench/scan-entry') return route.fulfill(json({ success: true, canScan: false }));
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    if (path === '/api/workbench/products/search') {
      requests.push({ type: 'search', q: url.searchParams.get('q'), includeDelisted: url.searchParams.get('includeDelisted') });
      return route.fulfill(json({ success: true, query: url.searchParams.get('q'), items: [{
        recordId: 'rec_1033', number: productNumber, itemNo: '1033-8', color: '棕色', category: '女',
      }] }));
    }
    if (path === '/api/workbench/sales/query') {
      requests.push({ type: 'sales', productRecordId: url.searchParams.get('productRecordId') });
      return route.fulfill(json({ success: true, summary: salesSummary, orders: [order] }));
    }
    if (path === '/api/workbench/inventory/ledger') {
      requests.push({ type: 'ledger', product: url.searchParams.get('product') });
      return route.fulfill(json({
        success: true, from: '2026-11-22', to: '2026-11-22', total: 1, truncated: false,
        rows: [{ created_at: '2026-11-22T04:50:00.000Z', behavior: '销售减少', number: productNumber, size: '39', quantity_change: 1 }],
      }));
    }
    return route.fulfill(json({ success: true }));
  });

  await page.goto('/workbench/?module=sales&page=sales-query', { waitUntil: 'networkidle' });
  await page.locator('[data-sq-tab="details"]').click();
  await page.locator('[data-ps-input]').fill('1033');
  await expect(page.locator('[data-ps-result]')).toContainText(productNumber);
  await expect(page.locator('[data-ps-result]')).toContainText('记录ID');
  await page.locator('[data-ps-result]').click();
  await expect.poll(() => requests.filter((item) => item.type === 'sales' && item.productRecordId === 'rec_1033').length).toBeGreaterThan(0);
  await expect(page.locator('[data-ps-selected]')).toContainText(productNumber);

  await page.goto('/workbench/?module=inventory&page=inventory-ledger', { waitUntil: 'networkidle' });
  await page.locator('[data-ledger-tab="ledger"]').click();
  await page.locator('[data-ps-input]').fill('1033');
  await expect(page.locator('[data-ps-result]')).toContainText(productNumber);
  await page.locator('[data-ps-result]').click();
  await expect.poll(() => requests.filter((item) => item.type === 'ledger' && item.product === productNumber).length).toBeGreaterThan(0);
  await expect(page.locator('[data-ps-selected]')).toContainText(productNumber);

  assertSearchRequest(requests);
});

function assertSearchRequest(requests) {
  const searches = requests.filter((item) => item.type === 'search');
  if (!searches.length) throw new Error('没有发出货品搜索请求');
  if (!searches.every((item) => item.q === '1033')) throw new Error('搜索词不是 1033');
  if (!searches.every((item) => item.includeDelisted === '1')) throw new Error('历史场景没有带 includeDelisted=1');
}
