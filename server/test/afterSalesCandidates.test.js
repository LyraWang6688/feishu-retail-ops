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
