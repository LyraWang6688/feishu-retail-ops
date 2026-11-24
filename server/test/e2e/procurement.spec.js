/**
 * 采购页（供应 → 录单 → 采购）Playwright 判据（mock API，不连真实 Base）。
 *
 * 覆盖：懒加载请求数 / 扫一扫占位禁用 / 默认选中与统计 / 草稿跨 tab & 刷新保留 /
 *      提交前 0 写请求 / 提交只 1 次 POST 且 payload 正确 / 成功清空 / 失败保留 /
 *      390 与 604 无横向滚动 + 点击区 ≥44px；截图存 docs/procurement-page-real-shots/。
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_KEY, mockApi } from './fixtures/procurementMock.js';

const SHOTS = path.resolve(process.cwd(), '../docs/procurement-page-real-shots');

const openPage = async (page) => {
  // 顶部已按工作台改成 .header > .auth（登录状态 + 退出登录），页面内不再有「采购」大标题
  await expect(page.locator('.pr-tabs[role="tablist"]')).toBeVisible();
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
};
const tab = (page, name) => page.getByRole('tab', { name });

const qtyOf = (page, recordId, size) => page.locator(`[data-pr-qty][data-record="${recordId}"][data-size="${size}"]`);
const draftInStorage = async (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), STORAGE_KEY);

test.beforeEach(async ({ page }) => {
  await page.goto('/workbench/procurement.html');
  await page.evaluate(() => localStorage.clear());
});

test('AC-P20 首屏同时加载补货 + 上新；待提交列表不请求', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  expect(calls.replenish).toBe(1);
  expect(calls.newProducts).toBe(1);

  await tab(page, /预览区/).click();
  await expect(page.getByText('还没有选要采购的货品。')).toBeVisible();
  await expect(page.locator('.pr-search')).toBeHidden();
  expect(calls.replenish).toBe(1);
  expect(calls.newProducts).toBe(1);
  expect(calls.writes).toHaveLength(0);
});

test('AC-P26 供应商筛选：无「全部」，默认第一个供应商；统计随供应商变化', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  const filter = page.locator('[data-pr-supplier]:visible');
  await expect(filter).toHaveCount(2);
  await expect(filter.nth(0)).toHaveText('供应商 A');
  await expect(filter.nth(1)).toHaveText('供应商 B');
  const summary = await page.locator('.pr-query-row').boundingBox();
  const chips = await page.locator('.pr-supplier-filter').boundingBox();
  expect(summary.y).toBeLessThan(chips.y);
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
  await expect(page.getByText('92608 · 咖色')).toHaveCount(0);
  await filter.nth(1).click();
  await expect(page.getByText('92608 · 咖色')).toBeVisible();
  await expect(page.getByText('86822 · 黑色')).toHaveCount(0);
  await expect(page.locator('[data-pr-supplier]:visible').nth(1)).toHaveText('供应商 B');
});

test('AC-P28 顶部搜索固定；全局搜索跨 tab/供应商并自动定位', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  const head = page.locator('.pr-sticky-head');
  await expect(head.locator('[data-pr-search]')).toBeVisible();
  await page.evaluate(() => { document.body.style.minHeight = '2400px'; window.scrollTo(0, 900); });
  await page.waitForTimeout(50);
  const box = await head.boundingBox();
  expect(box.y).toBeLessThanOrEqual(2);
  const search = head.locator('[data-pr-search]');
  await search.fill('LY002');
  const results = page.locator('[data-pr-search-results]');
  await expect(results).toContainText('LY002');
  await expect(results).toContainText('供应商 B');
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
  await results.getByRole('button', { name: /LY002/ }).click();
  await expect(page.locator('[data-pr-tab="suggested"]')).toHaveClass(/active/);
  await expect(page.getByText('LY002 · 米白')).toBeVisible();
  await expect(search).toHaveValue('');
});

test('AC-P28b 短屏搜索定位：目标卡头在 sticky 头下方，不被滚出可视区', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await page.locator('[data-pr-search]').fill('LY002');
  const results = page.locator('[data-pr-search-results]');
  await expect(results).toContainText('LY002');
  await results.getByRole('button', { name: /LY002/ }).click();
  await expect.poll(async () => page.evaluate(() => {
    const card = document.querySelector('[data-pr-group="recNewB"]');
    const sticky = document.querySelector('.pr-sticky-head');
    if (!card || !sticky) return false;
    return card.getBoundingClientRect().top >= sticky.getBoundingClientRect().bottom - 2;
  })).toBe(true);
});

test('AC-P3b 库存非 0 的货品：只显示货品卡 + 添加尺码，不显示标准行', async ({ page }) => {
  const customOnlyBody = {
    success: true,
    range: { from: '2026-10-25', to: '2026-10-27', days: 3 },
    stats: { spotSold: 0, prepaidPending: 0, notArrived: 0, productCount: 1 },
    groups: [{
      productRecordId: 'recStock', number: 'STOCK01', itemNo: 'STOCK01', color: '黑色',
      supplierRecordId: 'recSupA', supplierName: '供应商 A', sizes: [], standardSizes: [39, 40],
      stockMode: 'custom-only', prepaidTotal: 0, spotTotal: 0, notArrivedTotal: 0,
    }],
  };
  await mockApi(page, { replenishBody: customOnlyBody });
  await page.reload();
  await expect(page.locator('.pr-tabs')).toBeVisible();
  await expect(page.getByText('STOCK01 · 黑色')).toBeVisible();
  await expect(page.getByText('当前尺码有库存，不显示标准尺码；需要补货请添加自定义尺码。')).toBeVisible();
  await expect(page.locator('[data-pr-qty][data-record="recStock"]')).toHaveCount(0);
  await expect(page.locator('[data-pr-add-size][data-record="recStock"]')).toBeVisible();
});

test('AC-P27 补货自定义尺码：多行弹窗保存后按原样式展示并进入 payload', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  const group = page.locator('[data-pr-group="recProdA"]');
  await group.locator('[data-pr-add-size]').click();
  const modal = page.locator('[data-pr-custom-modal]');
  await expect(modal).toBeVisible();
  await expect(modal.locator('[data-pr-modal-qty]').first()).toHaveValue('1');
  await modal.locator('[data-pr-modal-size]').first().fill('45');
  await modal.locator('[data-pr-modal-qty]').first().fill('2');
  await modal.locator('[data-pr-custom-add-row]').click();
  await modal.locator('[data-pr-modal-size]').nth(1).fill('46');
  await modal.locator('[data-pr-modal-qty]').nth(1).fill('1');
  await modal.locator('[data-pr-custom-save]').click();
  await expect(modal).toBeHidden();
  await expect(qtyOf(page, 'recProdA', 45)).toHaveValue('2');
  await expect(qtyOf(page, 'recProdA', 46)).toHaveValue('1');
  await expect(group.locator('[data-pr-custom-row]')).toHaveCount(2);
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="45"]').click();
  await expect(qtyOf(page, 'recProdA', 45)).toHaveValue('3');
  await page.locator('[data-pr-step="-1"][data-record="recProdA"][data-size="45"]').click();
  await expect(qtyOf(page, 'recProdA', 45)).toHaveValue('2');
  const draft = await draftInStorage(page);
  expect(draft.products.recProdA.entries['45']).toBe(2);
  expect(draft.products.recProdA.entries['46']).toBe(1);
  await page.getByRole('button', { name: '提交' }).click();
  await page.waitForURL(/\/workbench\/\?toast=/);
  const payload = calls.submit[0];
  const line = payload.items.find((item) => item.productRecordId === 'recProdA');
  expect(line.entries).toContainEqual({ size: 45, quantity: 2 });
  expect(line.entries).toContainEqual({ size: 46, quantity: 1 });
});

test('AC-P30 待提交列表：按供应商分组、只读、隐藏搜索', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await qtyOf(page, 'recProdA', 39).fill('2');
  await page.locator('[data-pr-supplier]').nth(1).click();
  await qtyOf(page, 'recProdB', 43).fill('1');
  await tab(page, /预览区/).click();
  const pending = page.locator('[data-pr-pending]');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('供应商：供应商 A');
  await expect(pending).toContainText('供应商：供应商 B');
  await expect(pending).toContainText('86822 · 黑色');
  await expect(pending).toContainText('39 码 × 2');
  await expect(pending).toContainText('92608 · 咖色');
  await expect(pending.locator('input, button')).toHaveCount(0);
  await expect(page.locator('.pr-search')).toBeHidden();
  await expect(page.locator('.pr-query-row')).toBeHidden();
  await expect(page.locator('.pr-range-host')).toBeHidden();
});

test('AC-P29 只保留统计范围和刷新，不显示数字统计卡', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(page.locator('.pr-stat')).toHaveCount(0);
  await expect(page.locator('.pr-range-host')).toContainText('统计范围');
  await expect(page.locator('.pr-range-host')).toContainText('近 7 天（含今天）');
  await expect(page.locator('[data-pr-refresh]')).toBeVisible();
});

test('AC-P18/P22 默认全 0：预订/现货都不自动填数量（不显示勾选框）；手填/点 + 才选中', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  // 2026-11-17 业务负责人：预订不再自动加数量，与现货 / 上新一致，全部默认 0
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('0', { timeout: 5000 });
  await expect(qtyOf(page, 'recProdA', 41)).toHaveValue('0');
  // 2026-10-29 业务负责人两次批注：**所有尺码行都不要勾选框**（预订/现货都不要方框）；
  // 是否选中由数量框决定（0 = 不选），现货行第一次点「+」按「现货已售数」选中。
  await expect(page.locator('[data-pr-check]')).toHaveCount(0, { timeout: 5000 });
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('0');
  // 预订行手点「+」⇒ 从 0 开始加 1（不再按预订数起步）
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="41"]').click();
  await expect(qtyOf(page, 'recProdA', 41)).toHaveValue('1');
  // 不再显示数字统计，只保留统一统计范围
  await expect(page.locator('.pr-stat')).toHaveCount(0);
  await expect(page.locator('.pr-range-host')).toContainText('近 7 天（含今天）');
  // 记录 ID 只在 data-* 内部主键里，页面上不出现
  const bodyText = await page.locator('#procurement-app').innerText();
  expect(bodyText.includes('recProdA')).toBe(false);
  // 没有勾选框：现货行第一次点「+」⇒ 数量 = 现货已售数（fixture 42 码现货 3）；再「−」= 2
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="42"]').click();
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('3');
  await page.locator('[data-pr-step="-1"][data-record="recProdA"][data-size="42"]').click();
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('2');
});

test('AC-P18c 普通采购可清空草稿：数量归零、submitKey 重置；修改单不显示', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="41"]').click();
  await expect(page.locator('[data-pr-total]')).toContainText('1 双');
  const before = await draftInStorage(page);
  await expect(page.locator('[data-pr-clear]')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-pr-clear]').click();
  await expect(page.locator('[data-pr-total]')).toContainText('0 双');
  await expect(page.locator('[data-pr-clear]')).toBeHidden();
  await expect(qtyOf(page, 'recProdA', 41)).toHaveValue('0');
  const after = await draftInStorage(page);
  expect(after.products).toEqual({});
  expect(after.submitKey).not.toBe(before.submitKey);
});

test('AC-P19b 手动「刷新」= 实时重新拉一次；已选数量保留；成功后提示已更新', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('0');
  await qtyOf(page, 'recProdA', 39).fill('4');
  await page.waitForTimeout(100);
  expect(calls.replenish).toBe(1);
  await page.locator('[data-pr-refresh]').click();
  await expect(page.getByText('已更新到最新数据')).toBeVisible();
  await expect.poll(() => calls.replenish).toBe(2);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('4', { timeout: 5000 });
});

test('AC-P19 切 tab / 刷新后草稿保留（同一用户同一浏览器）', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await qtyOf(page, 'recProdA', 39).fill('5');
  await page.waitForTimeout(100);
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('5');
  // 刷新（重新加载数据）后仍是 5（只补默认、不覆盖她改过的数量）
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('5', { timeout: 5000 });
  const draft = await draftInStorage(page);
  expect(draft.products.recProdA.entries['39']).toBe(5);
});

test('AC-P22 提交前 0 写请求；点提交只 1 次 POST 且 payload 正确；成功清空草稿', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('0');
  expect(calls.writes).toHaveLength(0);
  // 默认全 0 ⇒ 要手动选：A 两个码 + B 一个码（与下面 payload 断言对应）
  await qtyOf(page, 'recProdA', 39).fill('1');
  await qtyOf(page, 'recProdA', 41).fill('2');
  await page.locator('[data-pr-supplier]').nth(1).click();
  await qtyOf(page, 'recProdB', 43).fill('2');
  await page.waitForTimeout(100);
  const draftBefore = await draftInStorage(page);
  expect(draftBefore.submitKey).toBeTruthy();

  await page.getByRole('button', { name: '提交' }).click();
  // ⭐ A 方案：成功后跳工作台（`?toast=`），由 `shared/toast.js` 弹统一 toast（不是采购页自己的容器）
  await page.waitForURL(/\/workbench\/\?toast=/);
  await expect(page.getByText('数据提交成功，后台自动写入')).toBeVisible();
  expect(calls.submit).toHaveLength(1);
  const payload = calls.submit[0];
  expect(payload.submitKey).toBe(draftBefore.submitKey);
  expect(payload.items.map((item) => item.productRecordId).sort()).toEqual(['recProdA', 'recProdB']);
  // 2026-11-09：页面来源随载荷提交（默认全部来自「补货」tab）
  expect(payload.items.every((item) => item.source === 'replenish')).toBe(true);
  const lineA = payload.items.find((item) => item.productRecordId === 'recProdA');
  expect(lineA.entries).toEqual([{ size: 39, quantity: 1 }, { size: 41, quantity: 2 }]);
  // 成功之后草稿清空、submitKey 换新（下一单不会被这一单吸收）——
  // ⚠️ 要在**跳转后的工作台页**读 localStorage（再回采购页会按默认值重新种子，不能当作"没清"）
  const draftAfter = await draftInStorage(page);
  expect(draftAfter.products).toEqual({});
  expect(draftAfter.submitKey).not.toBe(draftBefore.submitKey);
  expect(calls.submit).toHaveLength(1);
});

test('AC-P22 提交失败：给人话 + 草稿保留（刷新还在）', async ({ page }) => {
  await mockApi(page, { submitFails: true });
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('0');
  await qtyOf(page, 'recProdA', 39).fill('1');
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('提交没成功，请稍后重试。')).toBeVisible();
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1', { timeout: 5000 });
});

test('AC-P23b 两个子 tab 等分（业务负责人 2026-10-29 批注）', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  const widths = await page.locator('.pr-tabs .pr-tab').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(widths).toHaveLength(2);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
});

test('AC-P23 无横向滚动 + 点击区 ≥44px（390 / 604 两个 project 都跑）', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const heights = await page.evaluate(() => ({
    tab: document.querySelector('.pr-tab').getBoundingClientRect().height,
    submit: document.querySelector('[data-pr-submit]').getBoundingClientRect().height,
    stepper: document.querySelector('[data-pr-step]').getBoundingClientRect().height,
  }));
  expect(heights.submit).toBeGreaterThanOrEqual(44);
  expect(heights.tab).toBeGreaterThanOrEqual(44);
  expect(heights.stepper).toBeGreaterThanOrEqual(44);

  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, `procurement-${testInfo.project.name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach(`采购页 ${testInfo.project.name}`, { path: shot, contentType: 'image/png' });
  // 合并清单里同时保留上新卡片（卡片小字 / 特殊码折叠）
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  // 男、女两组现在都是 4 个特殊码 ⇒ 文本会命中两组；这里只要求至少有一组可见。
  await expect(page.getByText('特殊码 · 4 个（默认 0 双，点开选择）').last()).toBeVisible();
  const newShot = path.join(SHOTS, `procurement-${testInfo.project.name}-new.png`);
  await page.screenshot({ path: newShot, fullPage: true });
  await testInfo.attach(`采购页·上新 ${testInfo.project.name}`, { path: newShot, contentType: 'image/png' });
});

test('AC-P22b 补货 + 上新共用一张草稿：一次提交只发一单，两个来源都在 payload', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);

  // 补货选一个码（另一个货品也手选一个码，补货默认已全 0）
  await qtyOf(page, 'recProdA', 39).fill('2');
  await page.locator('[data-pr-supplier]').nth(1).click();
  await qtyOf(page, 'recProdB', 43).fill('2');
  await page.waitForTimeout(100);

  // 合并清单里直接选上新货品的普通码（切回供应商 A）
  await page.locator('[data-pr-supplier]:visible').nth(0).click();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  await qtyOf(page, 'recNewA', 38).fill('2');
  await page.waitForTimeout(100);

  const draft = await draftInStorage(page);
  expect(draft.products.recProdA).toBeTruthy();
  expect(draft.products.recNewA).toBeTruthy();

  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('数据提交成功，后台自动写入')).toBeVisible();
  expect(calls.submit).toHaveLength(1);
  const payload = calls.submit[0];
  // 上新 / 补货默认全部 0：只有手动填过的行进 payload（recNewB 不选 ⇒ 不进 payload）。
  expect(payload.items.map((item) => item.productRecordId).sort()).toEqual(['recNewA', 'recProdA', 'recProdB']);
  expect(payload.items.find((item) => item.productRecordId === 'recNewA').entries)
    .toContainEqual({ size: 38, quantity: 2 });
  // 提交成功清空整张草稿（两个来源都清）
  expect((await draftInStorage(page)).products).toEqual({});
});

test('AC-P31b 修改单强制显示原采购尺码：即使当前是 custom-only', async ({ page }) => {
  const customOnlyBody = {
    success: true,
    range: { from: '2026-10-25', to: '2026-10-27', days: 3 },
    stats: { spotSold: 0, prepaidPending: 0, notArrived: 0, productCount: 1 },
    groups: [{
      productRecordId: 'recProdA', number: '86822', itemNo: '86822', color: '黑色',
      supplierRecordId: 'recSupA', supplierName: '供应商 A', sizes: [], standardSizes: [39, 40],
      stockMode: 'custom-only', prepaidTotal: 0, spotTotal: 0, notArrivedTotal: 0,
    }],
  };
  await mockApi(page, {
    replenishBody: customOnlyBody,
    submittedBatches: [{
      batch_no: 'CGD-E2E-0002', supplier_record_id: 'recSupA', supplier_name: '供应商 A',
      submitted_at: '2026-10-28T08:25:00Z', product_count: 1, total_quantity: 1,
      products: [{ product_record_id: 'recProdA', item_no: '86822', number: '86822', color: '黑色', entries: [{ size: 39, quantity: 1 }] }],
    }],
  });
  await page.reload();
  await expect(page.locator('.pr-tabs')).toBeVisible();
  await tab(page, /预览区/).click();
  await page.locator('[data-pr-modify-batch="CGD-E2E-0002"]').click();
  await expect(page.locator('[data-pr-modify-banner]')).toContainText('正在修改 CGD-E2E-0002');
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1');
  await expect(page.getByText('当前尺码有库存，不显示标准尺码；需要补货请添加自定义尺码。')).toBeHidden();
});

test('AC-P32 已报货：今天默认展开，历史默认折叠，点击后才加载明细', async ({ page }) => {
  const day = (iso) => Date.parse(iso);
  const todayDetail = {
    batch_no: 'CGD-TODAY', supplier_name: '供应商 A', submitted_at: day('2026-10-28T08:25:00Z'),
    product_count: 1, total_quantity: 1,
    products: [{ product_record_id: 'recProdA', item_no: '86822', number: '86822', color: '黑色', entries: [{ size: 39, quantity: 1 }] }],
  };
  const historyDetail = {
    batch_no: 'CGD-HISTORY', supplier_name: '供应商 B', submitted_at: day('2026-10-20T08:25:00Z'),
    product_count: 1, total_quantity: 2,
    products: [{ product_record_id: 'recProdB', item_no: '92608', number: '92608', color: '咖色', entries: [{ size: 43, quantity: 2 }] }],
  };
  const calls = await mockApi(page, {
    submittedBatches: [
      { batch_no: 'CGD-TODAY', supplier_name: '供应商 A', submitted_at: day('2026-10-28T08:25:00Z'), is_today: true },
      { batch_no: 'CGD-HISTORY', supplier_name: '供应商 B', submitted_at: day('2026-10-20T08:25:00Z'), is_today: false },
    ],
    submittedDetails: { 'CGD-TODAY': todayDetail, 'CGD-HISTORY': historyDetail },
  });
  await page.reload();
  await openPage(page);
  await tab(page, /预览区/).click();
  await expect(page.getByText('CGD-TODAY')).toBeVisible();
  const todayBatch = page.locator('[data-pr-submitted-batch="CGD-TODAY"]');
  const historyBatch = page.locator('[data-pr-submitted-batch="CGD-HISTORY"]');
  await expect(todayBatch.getByText('86822 · 黑色')).toBeVisible();
  await expect(historyBatch).toBeVisible();
  await expect(historyBatch.getByText('92608 · 咖色')).toBeHidden();
  expect(calls.submittedDetail).toEqual(['CGD-TODAY']);
  await page.locator('[data-pr-expand-batch="CGD-HISTORY"]').click();
  await expect(historyBatch.getByText('92608 · 咖色')).toBeVisible();
  expect(calls.submittedDetail).toEqual(['CGD-TODAY', 'CGD-HISTORY']);
});

test('AC-P31 已报货：修改按钮打开原批次，预填数量并提交 modify', async ({ page }) => {
  const detail = {
    batch_no: 'CGD-E2E-0001', supplier_record_id: 'recSupA', supplier_name: '供应商 A',
    submitted_at: '2026-10-28T08:25:00Z', product_count: 1, total_quantity: 1,
    products: [{ product_record_id: 'recProdA', item_no: '86822', number: '86822', color: '黑色', entries: [{ size: 39, quantity: 1 }] }],
  };
  const calls = await mockApi(page, {
    submittedBatches: [{
      batch_no: 'CGD-E2E-0001', supplier_name: '供应商 A', submitted_at: '2026-10-28T08:25:00Z', is_today: false,
    }],
    submittedDetails: { 'CGD-E2E-0001': detail },
  });
  await page.reload();
  await openPage(page);
  await tab(page, /预览区/).click();
  await expect(page.getByText('CGD-E2E-0001')).toBeVisible();
  await page.locator('[data-pr-modify-batch="CGD-E2E-0001"]').click();
  await expect(page.locator('[data-pr-modify-banner]')).toContainText('正在修改 CGD-E2E-0001');
  await expect(page.locator('[data-pr-clear]')).toBeHidden();
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1');
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="39"]').click();
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('2');
  await page.getByRole('button', { name: '提交修改' }).click();
  await expect.poll(() => calls.modify.length).toBe(1);
  const payload = calls.modify[0];
  expect(payload.batchNo).toBe('CGD-E2E-0001');
  expect(payload.items).toContainEqual({ productRecordId: 'recProdA', source: 'replenish', entries: [{ size: 39, quantity: 2 }] });
});

test('AC-P28c 扫码定位：搜索/扫码同一行，统计范围下一行，扫到后切换并高亮', async ({ page }) => {
  await page.addInitScript(() => {
    window.h5sdk = {
      config: async () => {},
      ready: (done) => done(),
    };
    window.tt = {
      scanCode: ({ success }) => success({ result: '/r/recNewB?from=procurement' }),
    };
  });
  await mockApi(page);
  await page.reload();
  await openPage(page);

  const search = page.locator('[data-pr-search]');
  const scan = page.locator('[data-pr-scan]');
  const range = page.locator('[data-pr-range-row]');
  await expect(scan).toBeVisible();
  const searchBox = await search.boundingBox();
  const scanBox = await scan.boundingBox();
  const rangeBox = await range.boundingBox();
  expect(Math.abs(searchBox.y - scanBox.y)).toBeLessThan(4);
  expect(rangeBox.y).toBeGreaterThan(searchBox.y + searchBox.height - 4);

  await scan.click();
  await expect(page.getByText('LY002 · 米白')).toBeVisible();
  await expect(page.locator('[data-pr-group="recNewB"]')).toHaveClass(/is-scan-target/);
  await expect(search).toHaveValue('');
});
