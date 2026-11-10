'use strict';

/**
 * ⭐ 2026-11-11（业务负责人）：验收页"已验收完的供应商卡"只认**主表「已到货供应商」**。
 * 本地 `accepted-suppliers` 依赖已删除 —— 判据：源码里不许再出现那条链路。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8');

test('AC-AS-BASE1 列表/到货接口都从主表投影 arrived_supplier_ids', () => {
  const query = read('src/services/purchaseQueryService.js');
  assert.ok(query.includes("asLinks('purchaseOrderBatch', batch, 'arrivedSuppliers')"),
    'listPurchaseRequests 从主表投影「已到货供应商」✓');
  assert.ok(query.includes("asLinks('purchaseOrderBatch', record, 'arrivedSuppliers')"),
    'listPurchaseArrivals 从主表投影「已到货供应商」✓');
});

test('AC-AS-BASE2 本地 accepted-suppliers 链路已彻底删除', () => {
  assert.equal(read('src/routes/workbench/purchase.js').includes('accepted-suppliers'), false,
    '后端路由不再有 accepted-suppliers 端点 ✓');
  assert.equal(read('src/services/workbenchPurchaseArrivalService.js').includes('acceptedSuppliers'), false,
    'facade 不再暴露 acceptedSuppliers ✓');
  assert.equal(read('src/services/acceptanceSupplierProgress.js').includes('listAcceptedSuppliers'), false,
    '本地任务读取助手已删除 ✓');
  assert.equal(read('src/services/purchaseArrivalConversationService.js').includes('listAcceptedSuppliersByBatch'), false,
    '会话服务不再提供本地已验收供应商列表 ✓');
});

test('AC-AS-BASE3 前端按主表 arrived_supplier_ids 过滤，不再调本地端点', () => {
  const frontend = read('public/workbench/features/orders/index.js');
  assert.ok(frontend.includes('arrived_supplier_ids'), '前端读列表行上的主表字段 ✓');
  assert.equal(frontend.includes('/purchase/arrivals/accepted-suppliers'), false,
    '前端不再调本地 accepted-suppliers ✓');
  const config = read('public/workbench/config/orders.js');
  assert.equal(config.includes('acceptedSuppliers'), false, '配置不再有本地端点 ✓');
});
