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
        excluded: { byFulfillment: {}, notPosted: 0, outOfWindow: 0, missingSalesDate: 0 },
      }));
    }
    if (path === '/api/workbench/sales/after-sales/payment-methods') {
      return route.fulfill(json({ success: true, items: ['现金', '微信扫码'] }));
    }
    if (path === '/api/workbench/sales/after-sales/submit' && route.request().method() === 'POST') {
      // 表单 POST ⇒ 服务端入队后 303 回售后页并带统一 toast（e2e 里直接模拟那一跳）
      const toast = encodeURIComponent('数据提交成功，后台自动写入');
      return route.fulfill({
        status: 303,
        headers: { location: `/workbench/after-sales.html?productRecordId=p1&toast=${toast}&submitted=1` },
        body: '',
      });
    }
    if (path === '/api/workbench/sales/after-sales/stock-sizes') {
      // 换尺码：与销售扫码页同一套视图模型（现货 / 预订 / 特殊码）
      return route.fulfill(json({
        success: true,
        groups: {
          inStock: [{ size: 40, count: 2 }],
          reserve: [{ size: 41, count: 0 }, { size: 42, count: 0 }],
          special: [{ size: 45, count: 0 }],
        },
      }));
    }
    if (path === '/api/workbench/ui-tap') return route.fulfill({ status: 204, body: '' });
    return route.fulfill(json({ success: true }));
  });
};

test.beforeEach(async ({ page }) => { await mockApi(page); });

test('六个领域 tab + 订单列表懒加载', async ({ page }) => {
  const orderRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/workbench/sales/orders') orderRequests.push(request.url());
  });
  await page.goto('/workbench/');
  await expect(page.getByText('已登录：E2E')).toBeVisible();
  await expect(page.locator('.main-tab')).toHaveText(['销售', '库存', '供应', '资金', '配置', '创作']);

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

test('创作 tab 能打开占位页，不报未知模块', async ({ page }) => {
  await page.goto('/workbench/');
  await page.getByRole('button', { name: '创作', exact: true }).click();
  await expect(page.getByText('待建设')).toBeVisible();
  await expect(page.getByText(/未知工作台模块/)).toHaveCount(0);
});

test('货品 → 信息配置：标签打印右侧的占位子 tab', async ({ page }) => {
  await page.goto('/workbench/');
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '标签打印', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '信息配置', exact: true }).click();
  await expect(page.getByText('待建设')).toBeVisible();
  await expect(page.locator('[data-placeholder="product-info-config"]')).toBeVisible();
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

// ⭐ 2026-11-08（业务负责人：「草稿页需要和其他占位前端一致」＋ HTML 批注「返回按钮不需要，删除」）：
//   草稿单那片占位页 = **和 货品→信息配置 同一套占位卡**（虚线卡 + 「待建设」小标签），
//   且**不再有**「← 返回订单列表」那颗按钮。
test('草稿单占位页 = 统一占位卡（虚线卡 + 待建设标签），且没有「返回订单列表」按钮', async ({ page }) => {
  await page.goto('/workbench/');
  await page.getByRole('button', { name: '订单列表', exact: true }).click();
  await page.getByRole('button', { name: /草稿单/ }).click();

  const card = page.locator('[data-placeholder="draft"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/placeholder-card/);
  await expect(card.locator('.tag-info')).toHaveText('待建设');
  const border = await card.evaluate((node) => getComputedStyle(node).borderTopStyle);
  expect(border, '统一占位卡 = 虚线边框（与信息配置那张同款）').toBe('dashed');
  await expect(page.getByRole('button', { name: /返回订单列表/ })).toHaveCount(0);
});

// ⭐ 2026-10-29（业务负责人当天定的页面口径）：扫一扫落地页 = 货品（颜色）→ 近 7 天销售
//   （销售日 / 尺码 / 该单总金额）→ 选一条 → 三个动作按钮，水平顺序 **换货 · 退货 · 赔货**。
//   ⭐ 2026-10-29 第二步：按钮之后是**弹窗原型**（退货=退款/留存；换货=换尺码/换款式；赔货灰置），
//   确认只 toast、不写库（本用例钉住弹窗交互；接写库时再改断言）。
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

  // 点击「退货」⇒ 弹窗（只剩 退款 / 留存；选退款才出现退款方式）
  await page.locator('.candidate-action').nth(1).click();
  await expect(page.locator('[data-as-modal]:not([hidden])')).toBeVisible();
  await expect(page.locator('[data-as-money-mode="refund"]')).toBeVisible();
  await expect(page.locator('[data-as-method]')).toHaveCount(0);
  await page.locator('[data-as-money-mode="refund"]').click();
  await expect(page.locator('[data-as-method]')).toHaveCount(1);
  // 退款方式来自「支付方式管理」接口（不写死）
  await expect(page.locator('[data-as-method] option')).toHaveText(['请选择', '现金', '微信扫码']);
  await page.locator('[data-as-method]').selectOption('现金');
  // 提交退货表单 ⇒ 303 回售后页 + 统一 toast「数据提交成功，后台自动写入」
  await page.locator('[data-as-return-form] button[type="submit"]').click();
  // toast 显示后前端会清掉 URL 上的 toast 参数（刷新不重复弹）⇒ 这里等 toast 本体 + submitted 标记
  await expect(page.locator('.workbench-toast')).toContainText('数据提交成功，后台自动写入');
  await expect(page).toHaveURL(/submitted=1/);
  // 提交后页面已刷新（候选重新加载、无选中）⇒ 再选一条继续测换货
  await page.locator('.candidate-card').first().click();

  // 点击「换货」→ 换尺码 ⇒ 尺码按销售扫码页口径分三组（现货 / 预订 / 特殊码折叠）
  await page.locator('.candidate-action').nth(0).click();
  await expect(page.locator('[data-as-modal]:not([hidden])')).toBeVisible();
  await page.locator('[data-as-exchange-kind="same"]').click();
  await expect(page.locator('.as-size-group')).toHaveCount(3); // 现货 + 预订 + 特殊码(折叠)
  await expect(page.locator('.as-size-fold')).toHaveCount(1);
  await expect(page.locator('[data-as-size-value="40"]')).toBeVisible();
  await page.locator('[data-as-size-value="40"]').click();
  await expect(page.locator('[data-as-size-value="40"]')).toHaveClass(/active/);
  await expect(page).toHaveURL(/after-sales\.html/);
});
