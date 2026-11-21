const { test, expect } = require('@playwright/test');
const { saleFormHtml } = require('../../src/views/scanPage/paymentBlock');
const { getFlow } = require('../../src/services/scanFlowService');
const { SCAN_WRITE } = require('../../src/config/scanWrite');

const json = (body) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

test('售后换款式：有差价时选差价方式，提交售后接口而不是普通销售', async ({ page }) => {
  const flow = getFlow('afterSalesExchange');
  const view = {
    number: 'XHB1|黑|男', item_no: 'XHB1', color: '黑',
    rows: [{ size_text: '38', count: 1, missing: false }], columns: [], total: 1,
    price_text: '¥100',
  };
  const write = { ...SCAN_WRITE, draft: { lines: [] }, postAction: '/r/newprod', saleKey: 'k' };
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + saleFormHtml(view, write, {
      flow,
      flowContext: {
        requestId: 'r1', salesEntryRecordId: 'e1', detailRecordId: 'd1',
        originalAmount: '100', productRecordId: 'p1',
      },
    })
    + '</body></html>';

  let submitted = null;
  let normalPost = false;
  await page.route('**/r/newprod*', async (route) => {
    if (route.request().method() !== 'GET') {
      normalPost = true;
      return route.fulfill({ status: 500, body: 'normal sale should not be submitted' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  await page.route('**/api/workbench/sales/after-sales/payment-methods**', (route) =>
    route.fulfill(json({ items: ['微信扫码', '现金'] })));
  await page.route('**/api/workbench/sales/after-sales/exchange/submit', async (route) => {
    submitted = route.request().postData() || '';
    await route.fulfill(json({ success: true }));
  });

  await page.goto('/r/newprod?from=sales&flow=afterSalesExchange&requestId=r1&salesEntryRecordId=e1&detailRecordId=d1&originalAmount=100&productRecordId=p1');
  await page.locator('[name="amount"]').fill('120');
  await page.locator('input[name="size"][value="38"]').check();
  await page.locator('button[type="submit"]').click();

  await expect(page.locator('[data-exchange-modal]')).toBeVisible();
  await page.locator('[data-exchange-method]').selectOption('微信扫码');
  await page.locator('[data-exchange-confirm]').click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(normalPost).toBe(false);
  expect(submitted).toContain('newAmount=120');
  expect(submitted).toContain('diffPaymentMethod=%E5%BE%AE%E4%BF%A1%E6%89%AB%E7%A0%81');
  expect(submitted).toContain('newProductRecordId=newprod');
  expect(submitted).toContain('newSize=38');
  expect(submitted).toContain('scenario=new');
});
