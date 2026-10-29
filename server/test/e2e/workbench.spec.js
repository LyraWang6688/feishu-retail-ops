import { test, expect } from '@playwright/test';

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

const mockApi = async (page, { orders = [] } = {}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/feishu/me') {
      return route.fulfill(json({ enabled: true, authenticated: true, user: { name: 'E2E' } }));
    }
    if (path === '/api/workbench/sales/orders') {
      return route.fulfill(json({ success: true, methods: [], orders }));
    }
    if (path === '/api/workbench/sales/after-sales/scan-candidates') {
      // 2026-10-29：售后扫一扫落地页的只读候选（销售日 / 尺码 / 该单总金额）
      return route.fulfill(json({
        success: true,
        product: { record_id: 'p1', item_no: 'YD1', color: '黑' },
        days: 7,
        cutoff: Date.now() - 7 * 86400000,
        candidates: [{
          sales_entry_record_id: 'o1',
          order_no: 'XSD-E2E-001',
          sales_detail_record_id: 'd1',
          sales_date: Date.now(),
          sales_date_source: 'sold_at',
          size: 40,
          size_record_id: 's40',
          total_amount: 300,
          actual_amount: 100,
          fulfillment_status: '已交付',
        }, {
          sales_entry_record_id: 'o2',
          order_no: 'XSD-E2E-002',
          sales_detail_record_id: 'd2',
          sales_date: Date.now() - 86400000,
          sales_date_source: 'sold_at',
          size: 41,
          size_record_id: 's41',
          total_amount: 200,
          actual_amount: 200,
          fulfillment_status: '已交付',
        }],
        excluded: { notDelivered: 0, notPosted: 0, outOfWindow: 0, missingSalesDate: 0 },
      }));
    }
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });
};

test.beforeEach(async ({ page }) => { await mockApi(page); });

test('五个领域 tab + 订单列表懒加载', async ({ page }) => {
  const orderRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/workbench/sales/orders') orderRequests.push(request.url());
  });
  await page.goto('/workbench/');
  await expect(page.getByText('已登录：E2E')).toBeVisible();
  await expect(page.locator('.main-tab')).toHaveText(['销售', '库存', '供应', '货品', '资金']);

  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  await expect(page.getByRole('button', { name: /交割单/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /售后单/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /草稿单/ })).toBeVisible();
  expect(orderRequests).toHaveLength(0);

  // ⭐ 2026-10-28：「交割单」卡片跳**独立原型页**（三 tab + 样例数据，不请求订单接口）。
  await page.getByRole('button', { name: /交割单/ }).click();
  await expect(page).toHaveURL(/\/workbench\/sales-delivery\.html/);
  await expect(page.locator('[data-sd-tab]')).toHaveCount(3);
  expect(orderRequests, '原型页不请求订单接口').toHaveLength(0);
});

test('订单三卡同宽、横向居中，且无横向滚动', async ({ page }) => {
  await page.goto('/workbench/');
  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  const cards = page.locator('.orders-section-card');
  await expect(cards).toHaveCount(3);
  const boxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThanOrEqual(1);
  const align = await cards.first().evaluate((node) => {
    const style = getComputedStyle(node);
    return { direction: style.flexDirection, justify: style.justifyContent };
  });
  expect(align).toEqual({ direction: 'row', justify: 'center' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ⭐ 2026-10-29（业务负责人当天定的页面口径）：扫一扫落地页 = 货品（颜色）→ 近 7 天销售
//   （销售日 / 尺码 / 该单总金额）→ 选一条 → 三个动作按钮，水平顺序 **换货 · 退货 · 赔货**。
//   ⚠️ 按钮之后的处理逻辑**还没接**（她：等页面确认再谈）⇒ 点击只显示"待接入"提示、**不跳走**；
//   这条断言故意钉住"现在不许偷偷接上"（接上时要按新口径改这条用例）。
test('售后扫一扫落地页：选哪条卡片，那条卡片就变成三个动作按钮', async ({ page }) => {
  await page.goto('/workbench/after-sales.html?productRecordId=p1');
  await expect(page.getByText('YD1 · 黑')).toBeVisible();
  // ⭐ 2026-10-29 HTML 批注：提示语逐字是「请选择售后单」（「要」字已去掉），且居中加粗大字号。
  const hint = page.getByText('请选择售后单', { exact: true });
  await expect(hint).toBeVisible();
  const hintStyle = await hint.evaluate((node) => {
    const style = getComputedStyle(node);
    return { align: style.textAlign, weight: style.fontWeight };
  });
  expect(hintStyle.align).toBe('center');
  expect(Number(hintStyle.weight)).toBeGreaterThanOrEqual(600);

  const cards = page.locator('.candidate-card');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.candidate-action')).toHaveCount(0);

  const first = cards.first();
  // ⭐ 2026-10-29 HTML 批注：卡片**只有一行**「销售日 / 尺码 / 总金额」，**不显示销售单号**。
  await expect(first).toContainText('40 码');
  await expect(first).toContainText('¥300');
  await expect(first).not.toContainText('XSD-E2E-001');
  // 日期不突出 + 三样同字号。
  const styles = await first.locator('.candidate-value').evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return { size: style.fontSize, weight: style.fontWeight };
  }));
  expect(new Set(styles.map((item) => item.size)).size).toBe(1);
  expect(styles[0].weight).not.toBe('600');
  expect(styles[0].weight).not.toBe('700');

  // ⭐⭐ 2026-10-29（她定的交互）：选中哪条记录，**那条卡片上**就变成三个按钮（换货 · 退货 · 赔货），
  //   且按钮上**只有这三个词、没有解释小字**。
  await first.click();
  const buttons = page.locator('.candidate-action');
  await expect(buttons).toHaveCount(3);
  await expect(buttons.nth(0)).toHaveText('换货');
  await expect(buttons.nth(1)).toHaveText('退货');
  await expect(buttons.nth(2)).toHaveText('赔货');
  await expect(page.getByText('换一双给她')).toHaveCount(0);
  // 三个按钮出现在**被选中的那条卡片的位置**，其余记录仍是卡片。
  await expect(page.locator('.candidate-card-actions')).toHaveCount(1);
  await expect(page.locator('.candidate-card:not(.candidate-card-actions)')).toHaveCount(1);

  // 换选另一条 ⇒ 按钮跟着挪到新选中的那条卡片上（仍然是三个）。
  await page.locator('.candidate-card:not(.candidate-card-actions)').click();
  await expect(page.locator('.candidate-card-actions')).toHaveCount(1);
  await expect(page.locator('.candidate-action')).toHaveCount(3);

  await page.locator('.candidate-action').nth(1).click();
  await expect(page.getByText(/退货：处理流程还没有接上/)).toBeVisible();
  await expect(page).toHaveURL(/after-sales\.html/);
});
