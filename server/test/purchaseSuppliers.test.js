/**
 * 验收页第一层：**供应商管理里的全部供应商**（固定出现，不管有没有未到货）。
 * 判据：
 *   · 供应商列表走**统一配置表缓存**（`configTables` 已登记 supplier；`getConfigRows`）；
 *   · `GET /purchase/suppliers` 只读、失败 502；
 *   · 前端固定渲染全部供应商卡片（没有未到货的也显示空态）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createPurchaseQueryRouter } = require('../src/routes/purchaseQuery');
const { CONFIG_TABLES } = require('../src/config/configTables');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appWith = (service) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/purchase', createPurchaseQueryRouter({ service }));
  return app;
};

test('AC-SUP1 ⭐ 供应商列表走统一配置表缓存（supplier 已登记，不在调用方自建缓存）', () => {
  assert.ok(CONFIG_TABLES.supplier, 'configTables 里登记了 supplier ✓');
  assert.ok(CONFIG_TABLES.supplier.ttlMs > 0, 'supplier TTL 由注册表统一给 ✓');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'purchaseQueryService.js'), 'utf8');
  assert.match(src, /listSuppliers[\s\S]*getConfigRows\(\{ gateway, tableKey: 'supplier' \}\)/, 'listSuppliers 走 getConfigRows ✓');
  assert.equal(/gateway\.listAll\('supplier'\)/.test(src), false, '⛔ 不许绕过缓存直接 listAll supplier');
});

test('AC-SUP2 ⭐ GET /purchase/suppliers 只读返回全部供应商（含没有未到货的）', async () => {
  const rows = [
    { record_id: 's1', name: '供应商甲' },
    { record_id: 's2', name: '供应商乙' },
    { record_id: 's3', name: '供应商丙' },
  ];
  const app = appWith({ listSuppliers: async () => rows });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/workbench/purchase/suppliers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.rows, rows, '全部供应商原样返回（顺序 = 配置表顺序）✓');
  });
});

test('AC-SUP3 ⭐ 供应商列表读失败 ⇒ 502 + success:false（页面走兜底，不静默成功）', async () => {
  const app = appWith({ listSuppliers: async () => { throw new Error('boom'); } });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/workbench/purchase/suppliers`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.success, false);
  });
});
