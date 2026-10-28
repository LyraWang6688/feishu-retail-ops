'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SalesFollowupService } = require('../src/services/salesFollowupService');

const serviceWith = (orders) => {
  const service = Object.create(SalesFollowupService.prototype);
  service.listOrders = async () => ({ orders });
  return service;
};

test('售后候选：只取近 7 天、包含该货品的销售单', async () => {
  const now = Date.now();
  const orders = [
    { record_id: 'o1', order_no: 'XSD-1', recorded_at: now - 2 * 86400000, details: [
      { record_id: 'd1', product_record_id: 'p1', product: 'YD1', color: '黑', size: 40, actual_amount: 100 },
      { record_id: 'd2', product_record_id: 'p2', product: 'YD2', color: '白', size: 41, actual_amount: 100 },
    ] },
    { record_id: 'o2', order_no: 'XSD-2', recorded_at: now - 8 * 86400000, details: [
      { record_id: 'd3', product_record_id: 'p1', product: 'YD1', color: '黑', size: 40, actual_amount: 100 },
    ] },
    { record_id: 'o3', order_no: 'XSD-3', recorded_at: now - 1 * 86400000, details: [
      { record_id: 'd4', product_record_id: 'p3', product: 'YD3', color: '棕', size: 42, actual_amount: 100 },
    ] },
  ];
  const out = await serviceWith(orders).listAfterSalesCandidates({ productRecordId: 'p1' });
  assert.equal(out.days, 7);
  assert.deepEqual(out.candidates.map((item) => item.record_id), ['o1']);
  assert.deepEqual(out.candidates[0].matched_details.map((item) => item.record_id), ['d1']);
});

test('售后候选：缺货品 id 400，未知货品空数组', async () => {
  await assert.rejects(() => serviceWith([]).listAfterSalesCandidates({}), (error) => error.statusCode === 400);
  const out = await serviceWith([]).listAfterSalesCandidates({ productRecordId: 'missing' });
  assert.deepEqual(out.candidates, []);
});

test('售后页面与接口存在，且三步流程文案在配置里', () => {
  const root = path.join(__dirname, '../public/workbench');
  assert.ok(fs.existsSync(path.join(root, 'after-sales.html')));
  assert.ok(fs.existsSync(path.join(root, 'features/after-sales/index.js')));
  const config = fs.readFileSync(path.join(root, 'config/afterSalesPage.js'), 'utf8');
  for (const label of ['退货', '换货', '赔货']) assert.match(config, new RegExp(label));
  const service = fs.readFileSync(path.join(__dirname, '../src/services/salesFollowupService.js'), 'utf8');
  assert.match(service, /listAfterSalesCandidates/);
});

/**
 * ⭐ 2026-10-29：售后**扫一扫落地页**的判据（业务负责人当天定的页面口径）。
 *
 *   ① 三个动作的**水平顺序**逐字是「换货 → 退货 → 赔货」（顺序换了要红）；
 *   ② 页面读的是**扫一扫落地页自己的只读接口**（`scan-candidates`），
 *      不是订单列表那条候选接口 —— 因为落地页要摆「销售日 + 销售主表总金额」；
 *   ③ 页面**不写库**：这一版没有 POST（按钮处理逻辑还没接，谁偷偷接上要红）；
 *   ④ 数据来源在页面里写清楚（她问过"数据来自哪里"）。
 */
test('AC-LP1 ⭐ 落地页：动作顺序「换货 · 退货 · 赔货」，读 scan-candidates，且这一版不写库', () => {
  const root = path.join(__dirname, '../public/workbench');
  const config = fs.readFileSync(path.join(root, 'config/afterSalesPage.js'), 'utf8');
  const actions = config.slice(config.indexOf('export const AFTER_SALES_ACTIONS'));
  const order = ['exchange', 'return', 'compensation'].map((value) => actions.indexOf(`value: '${value}'`));
  for (const index of order) assert.ok(index >= 0, '三个动作都要在配置里');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '水平顺序必须是 换货 → 退货 → 赔货');

  const page = fs.readFileSync(path.join(root, 'features/after-sales/index.js'), 'utf8');
  assert.match(page, /scanCandidatesApi/, '落地页读 scan-candidates（销售日 + 总金额那条只读接口）');
  assert.match(page, /AFTER_SALES_PAGE\.totalLabel|AFTER_SALES_PAGE\.sizeLabel/, '销售日 / 尺码 / 总金额 的字段名从配置取');
  assert.doesNotMatch(page, /api\.post\(/, '这一版只做页面：不许有写请求（按钮处理逻辑还没接）');
});

