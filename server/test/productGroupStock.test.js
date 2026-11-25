'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductGroupStockService } = require('../src/services/productGroupStockService');
const { renderGroupStockPage, renderGroupPickerPage } = require('../src/views/groupScanPage');

const gateway = {
  async get(table, id) {
    assert.equal(table, 'productGroup');
    return { record_id: id, fields: { 货品组: 'JXN9573', 关联货品: [{ record_ids: ['rec_a', 'rec_b'] }], 颜色: [{ text: '黑色' }], 单价: 320 } };
  },
  async getBatch(table, ids) {
    assert.equal(table, 'product');
    return ids.map((id) => ({ record_id: id, fields: { 编号: id === 'rec_a' ? '9573-28|黑色|女' : '9573-45|黑色|女', 货号: id === 'rec_a' ? '9573-28' : '9573-45', 颜色: '黑色', 类别: '女' } }));
  },
  async listByFilter(table, filter) {
    assert.equal(table, 'liveInventory');
    if (!filter.includes('rec_a')) return [];
    return [
      { fields: { 库存键: '9573-28|黑色|女|35', 尺码: '35', 所属状态: '门盒' } },
      { fields: { 库存键: '9573-28|黑色|女|36', 尺码: '36', 所属状态: '样品' } },
    ];
  },
};

test('组库存：成员独立、0 库存成员保留、组只汇总总数', async () => {
  const service = createProductGroupStockService({ gateway });
  const group = await service.get('rec_g1');
  assert.equal(group.name, 'JXN9573');
  assert.equal(group.total, 2);
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].total, 2);
  assert.equal(group.members[1].total, 0);
  assert.equal(group.members[0].sizes.length, 2);
  const html = renderGroupStockPage(group, { currentUrl: '/g/rec_g1?from=inventory' });
  assert.match(html, /JXN9573/);
  assert.match(html, /9573-28/);
  assert.match(html, /9573-45/);
  assert.match(html, /product=rec_a/);
  assert.match(html, /return_to=%2Fg%2Frec_g1/);
});

test('组成员选择：销售全部显示，0 库存不隐藏、不置灰', async () => {
  const service = createProductGroupStockService({ gateway });
  const group = await service.get('rec_g1');
  const html = renderGroupPickerPage(group, { from: 'sales', currentUrl: '/g/rec_g1?from=sales' });
  assert.match(html, /请选择货品/);
  assert.match(html, /\/r\/rec_a\?from=sales/);
  assert.match(html, /\/r\/rec_b\?from=sales/);
  assert.match(html, /9573-45/);
});

test('组库存页复用货品库存卡：价格 / 尺码 / 缺码 / 调整入口都在', async () => {
  const service = createProductGroupStockService({ gateway });
  const group = await service.get('rec_g1');
  group.members[0].view = {
    found: true, item_no: '9573-28', color: '黑色', category_code: '女', category_name: '女',
    price_text: '¥320', total: 2, updated_at_text: '2026-11-25 14:00',
    columns: [{ key: 'doorbox', label: '门盒' }, { key: 'sample', label: '样品' }],
    rows: [{ size_text: '35', cells: [{ count: 1 }, { count: 0 }], missing: false }],
    notes: [], product_record_id: 'rec_a',
  };
  const html = renderGroupStockPage(group, { currentUrl: '/g/rec_g1' });
  assert.match(html, /¥320/);
  assert.match(html, /2026-11-25 14:00/);
  assert.match(html, /data-view="product-adjust"/);
  assert.match(html, /stock/);
});
