import { test, expect } from '@playwright/test';

/**
 * 「销售 · 交割单」原型页端到端回归（2026-10-29 批注后）。
 *
 * 当前口径：
 *   · 无标题 / 无返回链接 / 无排序控件；固定销售日「远→近」；
 *   · 三个 tab：货未清 / 钱未清 / 钱货都未清（钱货都未清只在第三 tab）；
 *   · 货号筛选（默认全部货号）；
 *   · **按销售日分组**：日期只在分组头，卡片一行 = 货号·颜色·尺码 +（钱相关）已付/待付 + 右侧按钮；
 *   · 原型：本地样例数据，零接口请求、零写请求。
 *
 * ⚠️ 前置回归（Chromium + static-server）；最终验收由 Lead 用真实 Chrome + Express 跑。
 */

const PAGE = '/workbench/sales-delivery.html';

/** 真实接口形状的夹具（与 `/api/workbench/sales/delivery` 返回一致）。 */
const DELIVERY_FIXTURE = {
  methods: ['微信扫码', '现金', '支付宝', '银行转账'],
  orders: [
    {
      order_no: 'XSD-20261020-0001', sales_entry_record_id: 'se-1', recorded_at: '2026-10-20T10:00:00+08:00', payable_amount: 398, pending_amount: 0, pending_delivery_quantity: 1,
      details: [
        { record_id: 'd-g1', product: 'XHB8095', color: '黑色', size: 41, fulfillment_status: '未交付', sold_at: '2026-10-20T10:00:00+08:00', actual_amount: 199 },
        { record_id: 'd-g2', product: 'XHB8095', color: '黑色', size: 42, fulfillment_status: '已交付', sold_at: '2026-10-20T10:00:00+08:00', actual_amount: 199 },
      ],
      payments: [{ record_id: 'p-g1', method: '微信扫码', amount: 398, status: '已收款' }],
    },
    {
      order_no: 'XSD-20261019-0003', sales_entry_record_id: 'se-2', recorded_at: '2026-10-19T10:00:00+08:00', payable_amount: 259, pending_amount: 0,
      details: [{ record_id: 'd-g3', product: 'QPL-8957', color: '咖色', size: 37, fulfillment_status: '未交付', sold_at: '2026-10-19T10:00:00+08:00', actual_amount: 259 }],
      payments: [{ record_id: 'p-g2', method: '支付宝', amount: 259, status: '已收款' }],
    },
    {
      order_no: 'XSD-20261018-0002', sales_entry_record_id: 'se-3', recorded_at: '2026-10-18T10:00:00+08:00', payable_amount: null, pending_amount: 99,
      details: [{ record_id: 'd-m1', product: '9A196B-0', color: '黑色', size: 41, fulfillment_status: '已交付', sold_at: '2026-10-18T10:00:00+08:00', actual_amount: 99 }],
      payments: [{ record_id: 'p-m1', method: '', amount: 99, status: '未收款' }],
    },
    {
      order_no: 'XSD-20261017-0005', sales_entry_record_id: 'se-4', recorded_at: '2026-10-17T10:00:00+08:00', payable_amount: 200, pending_amount: 100,
      details: [{ record_id: 'd-m2', product: '66133-15', color: '咖色', size: 37, fulfillment_status: '已交付', sold_at: '2026-10-17T10:00:00+08:00', actual_amount: 200 }],
      payments: [{ record_id: 'p-m2', method: '现金', amount: 100, status: '已收款' }, { record_id: 'p-m3', method: '', amount: 100, status: '未收款' }],
    },
    {
      order_no: 'XSD-20261016-0001', sales_entry_record_id: 'se-5', recorded_at: '2026-10-16T10:00:00+08:00', payable_amount: 199, pending_amount: 199, pending_delivery_quantity: 1,
      details: [{ record_id: 'd-b1', product: 'XHB8095', color: '白色', size: 40, fulfillment_status: '未交付', sold_at: '2026-10-16T10:00:00+08:00', actual_amount: 199 }],
      payments: [{ record_id: 'p-b1', method: '', amount: 199, status: '未收款' }],
    },
    {
      order_no: 'XSD-20261015-0002', sales_entry_record_id: 'se-6', recorded_at: '2026-10-15T10:00:00+08:00', payable_amount: 518, pending_amount: 259, pending_delivery_quantity: 1,
      details: [
        { record_id: 'd-b2', product: 'QPL-8957', color: '黑色', size: 42, fulfillment_status: '未交付', sold_at: '2026-10-15T10:00:00+08:00', actual_amount: 259 },
        { record_id: 'd-b3', product: 'QPL-8957', color: '黑色', size: 43, fulfillment_status: '未交付', sold_at: '2026-10-15T10:00:00+08:00', actual_amount: 259 },
      ],
      payments: [{ record_id: 'p-b2', method: '微信扫码', amount: 259, status: '已收款' }, { record_id: 'p-b3', method: '', amount: 259, status: '未收款' }],
    },
    {
      order_no: 'XSD-AFTER-SALES', sales_entry_record_id: 'se-7', recorded_at: '2026-10-21T10:00:00+08:00', payable_amount: 199, pending_amount: 0,
      details: [{ record_id: 'd-as', product: 'XHB8095', color: '黑色', size: 41, fulfillment_status: '已换货', sold_at: '2026-10-21T10:00:00+08:00', actual_amount: 199 }],
      payments: [{ record_id: 'p-as', method: '微信扫码', amount: 199, status: '已收款' }],
    },
    {
      order_no: 'XSD-20261014-0006', sales_entry_record_id: 'se-8', recorded_at: '2026-10-14T10:00:00+08:00', payable_amount: 199, pending_amount: 0,
      details: [{ record_id: 'd-s1', product: 'XHB8095', color: '黑色', size: 39, fulfillment_status: '已交付', sold_at: '2026-10-14T10:00:00+08:00', actual_amount: 199 }],
      payments: [{ record_id: 'p-s1', method: '微信扫码', amount: 199, status: '已收款' }],
    },
    {
      order_no: 'XSD-20261013-0001', sales_entry_record_id: 'se-9', recorded_at: '2026-10-13T10:00:00+08:00', payable_amount: 99, pending_amount: 99,
      details: [{ record_id: 'd-p1', product: '9A196B-0', color: '白色', size: 40, fulfillment_status: '已交付', sold_at: '2026-10-13T10:00:00+08:00', actual_amount: 99 }],
      payments: [{ record_id: 'p-pl1', method: '微信扫码', amount: 99, status: '待平台结算' }],
    },
    {
      order_no: 'XSD-UNKNOWN-DATE', sales_entry_record_id: 'se-10', recorded_at: null, payable_amount: 199, pending_amount: 0, pending_delivery_quantity: 1,
      details: [{ record_id: 'd-n1', product: 'XHB8095', color: '黑色', size: 38, fulfillment_status: '未交付', sold_at: null, actual_amount: 199 }],
      payments: [{ record_id: 'p-n1', method: '微信扫码', amount: 199, status: '已收款' }],
    },
  ],
};

const mockDeliveryApi = async (page) => {
  const state = JSON.parse(JSON.stringify(DELIVERY_FIXTURE));
  await page.route('**/api/workbench/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/workbench/sales/delivery' && method === 'GET') {
      return route.fulfill(json(state));
    }
    if (url.pathname === '/api/workbench/sales/deliveries' && method === 'POST') {
      const body = route.request().postDataJSON();
      const ids = new Set(body.detailRecordIds || []);
      for (const order of state.orders) {
        for (const detail of order.details || []) {
          if (ids.has(detail.record_id)) detail.fulfillment_status = '已交付';
        }
      }
      return route.fulfill(json({ success: true, delivered: ids.size }));
    }
    if (url.pathname === '/api/workbench/sales/delivery/payments' && method === 'POST') {
      const body = route.request().postDataJSON();
      const order = state.orders.find((item) => item.sales_entry_record_id === body.salesEntryRecordId);
      const pending = order?.payments.find((payment) => payment.status === '未收款');
      if (order && pending) {
        const value = Number(body.amount) || 0;
        if (value >= pending.amount) {
          pending.status = body.method && ['抖音代金券（89.9）', '抖音代金券（49.9）'].includes(body.method) ? '待平台结算' : '已收款';
          pending.method = body.method;
        } else {
          pending.amount = Math.round((pending.amount - value) * 100) / 100;
          order.payments.push({ record_id: `p-new-${Date.now()}`, method: body.method, amount: value, status: '已收款' });
        }
        order.pending_amount = (order.payments || []).filter((payment) => payment.status === '未收款').reduce((sum, payment) => sum + payment.amount, 0);
      }
      return route.fulfill(json({ success: true, pendingAmount: order?.pending_amount ?? 0 }));
    }
    return route.fulfill(json({ success: true }));
  });
};


const json = (body, status = 200) => ({
  status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body),
});

const mockWorkbenchApis = async (page) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    return route.fulfill(json({ success: true }));
  });
};

const openPage = async (page) => {
  await mockDeliveryApi(page);
  await page.goto(PAGE);
  await expect(page.locator('[data-sd-tab]')).toHaveCount(3);
  await expect(page.locator('[data-sd-item]').first()).toBeVisible();
};

const orderNos = (page) => page.locator('[data-sd-item]')
  .evaluateAll((nodes) => nodes.map((node) => node.dataset.sdOrder));

test('AC-TAB1 三 tab + 数量；默认货未清；无标题/返回/排序控件；按销售日分组', async ({ page }) => {
  await openPage(page);
  const tabs = page.locator('[data-sd-tab]');
  await expect(tabs.nth(0)).toContainText('货未清');
  await expect(tabs.nth(0)).toContainText('3 双');
  await expect(tabs.nth(1)).toContainText('钱未清');
  await expect(tabs.nth(1)).toContainText('2 双');
  await expect(tabs.nth(2)).toContainText('钱货都未清');
  await expect(tabs.nth(2)).toContainText('3 双');
  await expect(page.locator('[data-sd-tab].active')).toHaveAttribute('data-sd-tab', 'goods');

  // 批注：标题、返回链接、排序控件都不需要。
  await expect(page.locator('.sd-header')).toHaveCount(0);
  await expect(page.locator('.sd-back')).toHaveCount(0);
  await expect(page.locator('.sd-sort')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '交割单' })).toHaveCount(0);
  await expect(page.getByText('← 返回工作台')).toHaveCount(0);

  // 按销售日分组：日期只在分组头；卡片行内不重复日期。
  await expect(page.locator('[data-sd-day]')).toHaveCount(3);
  await expect(page.locator('.sd-day-title').nth(0)).toHaveText('10-19');
  await expect(page.locator('.sd-day-title').nth(1)).toHaveText('10-20');
  await expect(page.locator('.sd-day-title').nth(2)).toHaveText('销售日未填');
  await expect(page.locator('[data-sd-item]')).toHaveCount(3);
  await expect(page.locator('[data-sd-order="XSD-AFTER-SALES"]')).toHaveCount(0);
  await expect(page.locator('[data-sd-item]').first()).not.toContainText('XSD-');
});

test('AC-TAB2 归类互斥：钱货都未清只在第三个 tab；三个 tab 无重复', async ({ page }) => {
  await openPage(page);
  const sets = {};
  for (const key of ['goods', 'money', 'both']) {
    await page.locator(`[data-sd-tab="${key}"]`).click();
    sets[key] = await orderNos(page);
    await expect(page.locator(`[data-sd-tab="${key}"]`)).toHaveClass(/active/);
  }
  expect(sets.goods.filter((no) => sets.money.includes(no))).toEqual([]);
  expect(sets.goods.filter((no) => sets.both.includes(no))).toEqual([]);
  expect(sets.money.filter((no) => sets.both.includes(no))).toEqual([]);
  expect(sets.both.sort()).toEqual(['XSD-20261015-0002', 'XSD-20261016-0001']);
  expect(new Set([...sets.goods, ...sets.money, ...sets.both]).size).toBe(7);
});

test('AC-CARD1 一张卡=一个销售单号：多行产品 + 行尾交付；金额只在钱相关 tab', async ({ page }) => {
  await openPage(page);
  const goods = page.locator('[data-sd-item]').first();
  await expect(goods).toContainText('QPL-8957 · 咖色 · 37 码');
  await expect(goods).not.toContainText('XSD-');
  await expect(goods).not.toContainText('10-19');
  await expect(goods).not.toContainText('已付');
  await expect(goods).not.toContainText('待付');
  await expect(goods).not.toContainText('¥');
  await expect(goods.locator('.sd-product-row')).toHaveCount(1);
  await expect(goods.locator('[data-sd-deliver]')).toHaveCount(1);
  await expect(goods.locator('[data-sd-toggle="payment"]')).toHaveCount(0);

  // 一单多明细但只有一条未交付 ⇒ 货未清这单只出 1 张卡 / 1 行。
  const multiGoods = page.locator('[data-sd-order="XSD-20261020-0001"]');
  await expect(multiGoods).toHaveCount(1);
  await expect(multiGoods.locator('.sd-product-row')).toHaveCount(1);
  await expect(multiGoods).toContainText('XHB8095 · 黑色 · 41 码');
  await expect(multiGoods).not.toContainText('42 码');

  await page.locator('[data-sd-tab="money"]').click();
  const money = page.locator('[data-sd-item]').first();
  await expect(money).toContainText('66133-15 · 咖色 · 37 码');
  await expect(money).toContainText('应付');
  await expect(money).toContainText('待付');
  await expect(money).toContainText('¥');
  await expect(money.locator('[data-sd-toggle="payment"]')).toHaveCount(1);
  await expect(money.locator('[data-sd-deliver]')).toHaveCount(0);
  // 单行卡片仍紧凑（不含多行展开）。
  // 业务负责人 2026-10-29：总金额为空不兜底，应付显示「—」。
  await expect(page.locator('[data-sd-order="XSD-20261018-0002"]')).toContainText('应付—');
  const moneyHeight = await money.evaluate((node) => node.getBoundingClientRect().height);
  expect(moneyHeight).toBeLessThan(140);

  await page.locator('[data-sd-tab="both"]').click();
  const both = page.locator('[data-sd-order="XSD-20261015-0002"]');
  await expect(both).toContainText('应付');
  await expect(both).toContainText('待付');
  // 同一销售单号两双未交付 ⇒ 一张卡、两行、行尾各一个「交付」，付款入口一个。
  await expect(both.locator('.sd-product-row')).toHaveCount(2);
  await expect(both.locator('[data-sd-deliver]')).toHaveCount(2);
  await expect(both.locator('[data-sd-toggle="payment"]')).toHaveCount(1);
  await expect(both).toContainText('QPL-8957 · 黑色 · 42 码');
  await expect(both).toContainText('QPL-8957 · 黑色 · 43 码');
});

test('AC-DELIVER 行尾交付：点谁交谁、toast「该产品已交付」、卡片随状态移动', async ({ page }) => {
  await openPage(page);
  await page.locator('[data-sd-tab="both"]').click();
  const card = page.locator('[data-sd-order="XSD-20261015-0002"]');
  await expect(card.locator('[data-sd-deliver]')).toHaveCount(2);
  await card.locator('[data-sd-deliver]').first().click();
  await expect(page.locator('.workbench-toast')).toContainText('该产品已交付');
  await expect(card.locator('.sd-product-row')).toHaveCount(1);
  await expect(card.locator('[data-sd-deliver]')).toHaveCount(1);
  await expect(page.locator('[data-sd-tab="both"]')).toContainText('2 双');
  await card.locator('[data-sd-deliver]').first().click();
  // 货交完、钱没清 ⇒ 这张卡从「钱货都未清」移到「钱未清」。
  await expect(page.locator('[data-sd-tab="both"]')).toContainText('1 双');
  await page.locator('[data-sd-tab="money"]').click();
  await expect(page.locator('[data-sd-order="XSD-20261015-0002"]')).toBeVisible();
});

test('AC-GROUP 销售日分组顺序远→近；货号筛选默认全部、可筛单一货号', async ({ page }) => {
  await openPage(page);
  const dayLabels = await page.locator('.sd-day-title').allTextContents();
  expect(dayLabels).toEqual(['10-19', '10-20', '销售日未填']);

  const filter = page.locator('[data-sd-field="product"]');
  const options = await filter.locator('option').allTextContents();
  expect(options[0]).toBe('全部货号');
  expect(options).toEqual(expect.arrayContaining(['QPL-8957', 'XHB8095']));
  await filter.selectOption('QPL-8957');
  await expect(page.locator('[data-sd-item]')).toHaveCount(1);
  await expect(page.locator('[data-sd-order="XSD-20261019-0003"]')).toBeVisible();
  await expect(page.locator('.sd-day-title')).toHaveCount(1);
  await filter.selectOption('');
  await expect(page.locator('[data-sd-item]')).toHaveCount(3);
});

test('AC-FORM 付款弹窗：金额/方式在居中弹窗里；提交真实 POST 并 toast 付款成功', async ({ page }) => {
  const apiRequests = [];
  const writes = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    apiRequests.push(`${request.method()} ${url.pathname}`);
    if (request.method() !== 'GET') writes.push(request.method());
  });
  await openPage(page);
  await page.locator('[data-sd-tab="money"]').click();
  const money = page.locator('[data-sd-item]').first();
  const modal = page.locator('[data-sd-modal]');
  await expect(modal).toBeHidden();
  await money.locator('[data-sd-toggle="payment"]').click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('[data-sd-modal-amount]')).toHaveValue('¥100.00');
  const options = await modal.locator('[data-sd-modal-method] option').allTextContents();
  expect(options).toEqual(expect.arrayContaining(['微信扫码', '现金', '支付宝', '银行转账']));
  // 业务负责人 2026-10-29：金额超过待付 → 前端直接拦（确认按钮不可用），不提交到后端。
  await modal.locator('[data-sd-modal-amount]').fill('101');
  await expect(modal.locator('[data-sd-modal-error]')).toBeVisible();
  await expect(modal.locator('[data-sd-modal-error]')).toContainText('不能超过待付');
  await expect(modal.locator('[data-sd-modal-confirm]')).toBeDisabled();
  await modal.locator('[data-sd-modal-amount]').fill('100');
  await expect(modal.locator('[data-sd-modal-error]')).toBeHidden();
  await expect(modal.locator('[data-sd-modal-confirm]')).toBeEnabled();
  await modal.locator('[data-sd-modal-method]').selectOption('现金');
  await modal.locator('[data-sd-modal-confirm]').click();
  await expect(page.locator('.workbench-toast')).toContainText('付款成功');
  await page.waitForTimeout(200);
  expect(apiRequests).toContain('POST /api/workbench/sales/delivery/payments');
  expect(writes).toEqual(['POST']);
  await expect(page.locator('[data-sd-order="XSD-20261017-0005"]')).toHaveCount(0);
});

test('AC-ENTRY 工作台入口：订单列表「交割单」卡片跳到独立页（入口不拉订单）', async ({ page }) => {
  const orderRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/workbench/sales/orders') orderRequests.push(request.url());
  });
  await mockWorkbenchApis(page);
  await mockDeliveryApi(page);
  await page.goto('/workbench/');
  await expect(page.getByText('已登录：E2E')).toBeVisible();
  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  expect(orderRequests).toHaveLength(0);
  await page.getByRole('button', { name: /交割单/ }).click();
  await expect(page).toHaveURL(/\/workbench\/sales-delivery\.html/);
  await expect(page.locator('[data-sd-tab]')).toHaveCount(3);
  expect(orderRequests, '独立页是样例数据，不请求订单接口').toHaveLength(0);
});
