/**
 * 验收页供应商卡片：只来自**当前有未到货批次**的供应商。
 * 不再暴露/读取「供应商管理」全量列表。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('AC-SUP1 不再暴露全量供应商接口', () => {
  const route = read('src', 'routes', 'purchaseQuery.js');
  assert.equal(route.includes("router.get('/suppliers'"), false, '全量供应商接口已移除');
  const service = read('src', 'services', 'purchaseQueryService.js');
  assert.equal(service.includes('listSuppliers'), false, '全量供应商读模型已移除');
});

test('AC-SUP2 验收页不再请求供应商管理全量列表', () => {
  const orders = read('public', 'workbench', 'features', 'orders', 'index.js');
  assert.equal(orders.includes('ORDERS_API.suppliers'), false, '前端不再请求全量供应商');
  assert.equal(orders.includes('state.suppliers'), false, '前端不再保存全量供应商');
  const config = read('public', 'workbench', 'config', 'orders.js');
  assert.equal(config.includes("/api/workbench/purchase/suppliers"), false, '接口配置已移除');
});
