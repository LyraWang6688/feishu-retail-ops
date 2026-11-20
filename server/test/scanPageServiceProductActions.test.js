'use strict';

/**
 * 扫码页视图模型里的两个入口（2026-11-17）：
 *   · product_missing_text：只取「商品信息缺失 / 标签信息缺失」里不是「齐备」的值；
 *   · product_record_url / product_adjust_url：分别指向货品记录与工作台单双调整。
 *
 * 用最小假网关（只读）跑真实 lookup，不碰飞书。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// 单测进程不加载 .env；这条用例要验证 recordUrl，所以显式给一个测试用 app token。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';

const { createScanPageService } = require('../src/services/scanPageService');
const { invalidateConfigTable } = require('../src/services/configTableCache');
const { SCAN_PAGE } = require('../src/config/scanPage');

const sizeRow = { record_id: 'size_40', fields: { 尺码: 40, 类别: ['男'] } };

const productRow = (number, extra = {}) => ({
  record_id: 'prod_1',
  fields: {
    编号: number,
    货号: 'HL55173-1',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: '男',
    品类: { text: '休闲鞋', record_ids: ['cat_casual'] },
    单价: 299,
    // 默认有样例图；AC-SPA4 单独覆盖成 []（样例图也算「资料不齐」）。
    样例图: [{ file_token: 'file_1', type: 'image/jpeg' }],
    ...extra,
  },
});

const inventoryRow = (number) => ({
  record_id: 'inv_40',
  fields: {
    编号: [{ record_ids: ['prod_1'] }],
    尺码: ['size_40'],
    所属状态: '门盒',
    库存键: number + '|40',
    品类: '休闲鞋',
    更新时间: Date.UTC(2026, 10, 17, 1, 0),
  },
});

const fakeGateway = (product, number) => ({
  table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => ({
    product: [product],
    liveInventory: [inventoryRow(number)],
    sizeManagement: [sizeRow],
  }[key] || []),
});

test('AC-SPA1 资料缺失：view 带缺失文案 + 记录链接 + 库存调整链接', async () => {
  invalidateConfigTable('product');
  const number = 'HL55173-1|黑色|男';
  const service = createScanPageService(
    fakeGateway(productRow(number, { 商品信息缺失: '成本、单价', 标签信息缺失: '齐备' }), number),
    { config: SCAN_PAGE },
  );
  const view = await service.lookup({ number, requestId: 't1' });
  assert.equal(view.product_missing_text, '缺商品信息：成本、单价');
  assert.match(view.product_record_url, /record=prod_1/);
  assert.match(view.product_adjust_url, /product=prod_1/);
  assert.match(view.product_adjust_url, /module=inventory/);
  assert.deepEqual(view.product_action_labels, { adjust: '库存调整', info: '信息完善' }, '两个入口文案来自同一份配置');
});

test('AC-SPA2 资料齐备：缺失文案为空（渲染层据此不画），库存调整链接仍在', async () => {
  invalidateConfigTable('product');
  const number = 'HL55173-2|黑色|男';
  const service = createScanPageService(
    fakeGateway(productRow(number, { 商品信息缺失: '齐备', 标签信息缺失: '齐备' }), number),
    { config: SCAN_PAGE },
  );
  const view = await service.lookup({ number, requestId: 't2' });
  assert.equal(view.product_missing_text, '');
  assert.match(view.product_adjust_url, /product=prod_1/);
});

test('AC-SPA4 样例图未上传也算「资料不齐」（与货品资料页 / 销售卡片同一份判定）', async () => {
  invalidateConfigTable('product');
  const number = 'HL55173-4|黑色|男';
  const service = createScanPageService(
    fakeGateway(productRow(number, { 商品信息缺失: '齐备', 标签信息缺失: '齐备', 样例图: [] }), number),
    { config: SCAN_PAGE },
  );
  const view = await service.lookup({ number, requestId: 't4' });
  assert.equal(view.product_missing_text, '缺样例图');
  assert.match(view.product_record_url, /record=prod_1/);
});

test('AC-SPA3 标签信息缺失也进「资料不齐」；商品与标签都缺时两条都出现', async () => {
  invalidateConfigTable('product');
  const number = 'HL55173-3|黑色|男';
  const service = createScanPageService(
    fakeGateway(productRow(number, { 商品信息缺失: '成本', 标签信息缺失: '成本' }), number),
    { config: SCAN_PAGE },
  );
  const view = await service.lookup({ number, requestId: 't3' });
  assert.equal(view.product_missing_text, '缺商品信息：成本；缺标签：成本');
});
