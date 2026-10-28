/**
 * 采购页 e2e 的 **API mock 与假数据**（从 `procurement.spec.js` 按职责拆出；判据不变）。
 * 全部由 Playwright `page.route` 提供：不连真实 Base、不需要飞书登录。
 */
export const STORAGE_KEY = 'procurement:draft:v1:ou_e2e';

const json = (body, status = 200) => ({
  status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
});

const replenishBody = () => ({
  success: true,
  range: { from: '2026-10-25', to: '2026-10-27', days: 3 },
  stats: { spotSold: 4, prepaidPending: 6, productCount: 2 },
  groups: [
    {
      productRecordId: 'recProdA', number: '86822', itemNo: '86822', color: '黑色', supplierRecordId: 'recSupA',
      sizes: [{ size: 39, spotSold: 2, prepaidSold: 1 }, { size: 41, spotSold: 0, prepaidSold: 2 }, { size: 42, spotSold: 3, prepaidSold: 0 }],
      prepaidTotal: 3, spotTotal: 5,
    },
    {
      productRecordId: 'recProdB', number: '92608', itemNo: '92608', color: '咖色', supplierRecordId: 'recSupB',
      sizes: [{ size: 43, spotSold: 0, prepaidSold: 2 }], prepaidTotal: 2, spotTotal: 0,
    },
  ],
});

const newProductsBody = () => ({
  success: true,
  range: { from: '2026-10-28', to: '2026-10-28' },
  stats: { productCount: 2 },
  groups: [
    {
      productRecordId: 'recNewA', number: 'LY001', itemNo: 'LY001', color: '黑色', category: 'A', categoryMissing: false,
      supplierName: '供应商 A', supplierRecordId: 'recSupA', createdAt: Date.parse('2026-10-28T09:15:00+08:00'),
      sizes: { normal: [38, 39, 40, 41, 42, 43, 44], special: [45, 46, 47, 48] },
      defaults: { normal: 1, special: 0 },
    },
    {
      productRecordId: 'recNewB', number: 'LY002', itemNo: 'LY002', color: '米白', category: 'B', categoryMissing: false,
      supplierName: '供应商 B', supplierRecordId: 'recSupB', createdAt: Date.parse('2026-10-28T10:02:00+08:00'),
      sizes: { normal: [36, 37, 38, 39, 40], special: [34, 35, 41, 42, 43] },
      defaults: { normal: 1, special: 0 },
    },
  ],
});

export const mockApi = async (page, options = {}) => {
  const calls = { replenish: 0, newProducts: 0, submit: [], writes: [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (request.method() !== 'GET' && pathname !== '/api/workbench/ui-tap') calls.writes.push(pathname);
    if (pathname === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { open_id: 'ou_e2e', name: 'E2E' } }));
    }
    if (pathname === '/api/workbench/procurement/replenish') {
      calls.replenish += 1;
      return route.fulfill(json(replenishBody()));
    }
    if (pathname === '/api/workbench/procurement/new-products') {
      calls.newProducts += 1;
      return route.fulfill(json(newProductsBody()));
    }
    if (pathname === '/api/workbench/procurement/submit' && request.method() === 'POST') {
      calls.submit.push(JSON.parse(request.postData() || '{}'));
      if (options.submitFails) return route.fulfill(json({ success: false, error: '提交没成功，请稍后重试。' }, 500));
      return route.fulfill(json({ success: true, accepted: true, message: '已提交成功，数据会更新' }));
    }
    if (pathname === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });
  return calls;
};
