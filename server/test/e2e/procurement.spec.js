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
  await expect(page.getByRole('heading', { name: '采购' })).toBeVisible();
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
};
const tab = (page, name) => page.getByRole('tab', { name });

const qtyOf = (page, recordId, size) => page.locator(`[data-pr-qty][data-record="${recordId}"][data-size="${size}"]`);
const draftInStorage = async (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), STORAGE_KEY);

test.beforeEach(async ({ page }) => {
  await page.goto('/workbench/procurement.html');
  await page.evaluate(() => localStorage.clear());
});

test('AC-P20 懒加载：首屏只请求补货一次；点上新才请求；切回不重复；扫一扫禁用', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(page.getByText('现货已售')).toBeVisible();
  expect(calls.replenish).toBe(1);
  expect(calls.newProducts).toBe(0);

  await tab(page, /上新/).click();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  expect(calls.newProducts).toBe(1);
  await tab(page, /补货/).click();
  await expect(page.getByText('86822 · 黑色')).toBeVisible();
  expect(calls.replenish).toBe(1);
  expect(calls.newProducts).toBe(1);

  const scanTab = page.locator('[data-pr-scan-disabled]');
  await expect(scanTab).toBeDisabled();
  await expect(scanTab).toHaveAttribute('aria-disabled', 'true');
  await expect(scanTab).toHaveAttribute('data-tap-target', 'scan:replenish');
  expect(calls.writes).toHaveLength(0);
});

test('AC-P18/P22 默认选中：预订默认已选且数量=预订数（不显示勾选框）；只有现货默认 0 且可勾选', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1', { timeout: 5000 });
  // 2026-10-29 业务负责人两次批注：**所有尺码行都不要勾选框**（预订/现货都不要方框）；
  // 是否选中由数量框决定（0 = 不选），现货行第一次点「+」按「现货已售数」选中。
  await expect(page.locator('[data-pr-check]')).toHaveCount(0, { timeout: 5000 });
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('0');
  // 顶部统计（补货 3 项）+ 统计范围
  await expect(page.getByText('预订待补')).toBeVisible();
  await expect(page.getByText('涉及货品')).toBeVisible();
  // 业务负责人 2026-10-29 口径：结束时间 = 现在（不是"截止昨天"）
  await expect(page.getByText('10月25日 00:00 – 现在')).toBeVisible();
  // 记录 ID 只在 data-* 内部主键里，页面上不出现
  const bodyText = await page.locator('#procurement-app').innerText();
  expect(bodyText.includes('recProdA')).toBe(false);
  // 没有勾选框：现货行第一次点「+」⇒ 数量 = 现货已售数（fixture 42 码现货 3）；再「−」= 2
  await page.locator('[data-pr-step="1"][data-record="recProdA"][data-size="42"]').click();
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('3');
  await page.locator('[data-pr-step="-1"][data-record="recProdA"][data-size="42"]').click();
  await expect(qtyOf(page, 'recProdA', 42)).toHaveValue('2');
});

test('AC-P19b 手动「刷新」= 实时重新拉一次；已选数量保留；成功后提示已更新', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1');
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
  await tab(page, /上新/).click();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  await tab(page, /补货/).click();
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
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1');
  expect(calls.writes).toHaveLength(0);
  const draftBefore = await draftInStorage(page);
  expect(draftBefore.submitKey).toBeTruthy();

  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('已提交成功，数据会更新')).toBeVisible();
  expect(calls.submit).toHaveLength(1);
  const payload = calls.submit[0];
  expect(payload.submitKey).toBe(draftBefore.submitKey);
  expect(payload.items.map((item) => item.productRecordId).sort()).toEqual(['recProdA', 'recProdB']);
  const lineA = payload.items.find((item) => item.productRecordId === 'recProdA');
  expect(lineA.entries).toEqual([{ size: 39, quantity: 1 }, { size: 41, quantity: 2 }]);
  // 成功之后草稿清空、submitKey 换新（下一单不会被这一单吸收）
  const draftAfter = await draftInStorage(page);
  expect(draftAfter.products).toEqual({});
  expect(draftAfter.submitKey).not.toBe(draftBefore.submitKey);
  // 再点提交：空草稿 ⇒ 不发第二次 POST
  await page.getByRole('button', { name: '提交' }).click();
  expect(calls.submit).toHaveLength(1);
});

test('AC-P22 提交失败：给人话 + 草稿保留（刷新还在）', async ({ page }) => {
  await mockApi(page, { submitFails: true });
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1');
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('提交没成功，请稍后重试。')).toBeVisible();
  await page.reload();
  await openPage(page);
  await expect(qtyOf(page, 'recProdA', 39)).toHaveValue('1', { timeout: 5000 });
});

test('AC-P23b 三个子 tab 三等分（业务负责人 2026-10-29 批注）', async ({ page }) => {
  await mockApi(page);
  await page.reload();
  await openPage(page);
  const widths = await page.locator('.pr-tabs .pr-tab').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(widths).toHaveLength(3);
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
  // 上新 tab 也留一张（卡片小字 / 特殊码折叠 / 只有「新增货品」一个统计）
  await tab(page, /上新/).click();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  await expect(page.getByText('特殊码 · 4 个（默认 0 双，点开选择）')).toBeVisible();
  const newShot = path.join(SHOTS, `procurement-${testInfo.project.name}-new.png`);
  await page.screenshot({ path: newShot, fullPage: true });
  await testInfo.attach(`采购页·上新 ${testInfo.project.name}`, { path: newShot, contentType: 'image/png' });
});

test('AC-P22b 补货 + 上新共用一张草稿：一次提交只发一单，两个来源都在 payload', async ({ page }) => {
  const calls = await mockApi(page);
  await page.reload();
  await openPage(page);

  // 补货选一个码
  await qtyOf(page, 'recProdA', 39).fill('2');
  await page.waitForTimeout(100);

  // 切到上新，选一个普通码
  await tab(page, /上新/).click();
  await expect(page.getByText('LY001 · 黑色')).toBeVisible();
  await qtyOf(page, 'recNewA', 38).fill('2');
  await page.waitForTimeout(100);

  const draft = await draftInStorage(page);
  expect(draft.products.recProdA).toBeTruthy();
  expect(draft.products.recNewA).toBeTruthy();

  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('已提交成功，数据会更新')).toBeVisible();
  expect(calls.submit).toHaveLength(1);
  const payload = calls.submit[0];
  expect(payload.items.map((item) => item.productRecordId).sort()).toEqual(['recNewA', 'recNewB', 'recProdA', 'recProdB']);
  expect(payload.items.find((item) => item.productRecordId === 'recNewA').entries)
    .toContainEqual({ size: 38, quantity: 2 });
  // 提交成功清空整张草稿（两个来源都清）
  expect((await draftInStorage(page)).products).toEqual({});
});
