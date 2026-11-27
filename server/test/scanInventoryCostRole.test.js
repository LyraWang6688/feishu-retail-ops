'use strict';

/**
 * 2026-11-27：库存裸扫页的成本按角色显示。
 *   · 管理员（inventory.cost.read）显示「成本 ¥168」；
 *   · 店员 / 无角色 / 非库存领域不显示；
 *   · 成本不进共享 view，不污染其他请求。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_cost';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'cost_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'cost_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { can } = require('../src/config/permissions');

// 成本读取模块用桩：只验路由的「按角色决定读不读」，不在这里测飞书字段。
const costCalls = [];
const costPath = require.resolve('../src/services/scanPageCost');
require.cache[costPath] = {
  id: costPath, filename: costPath, loaded: true,
  exports: { costTextOf: async () => { costCalls.push(1); return '¥168'; } },
};
const { createScanPageRouter } = require('../src/routes/scanPage');

const NUMBER = 'JX505|咖色|女';
const VIEW = {
  found: true, number: NUMBER, item_no: 'JX505', color: '咖色', category_name: '休闲鞋',
  category_code: '女', price_text: '¥399', total: 1,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: [{ size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't', product_record_id: 'prod_1',
};
const cookie = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_cost', name: 'cost', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'cost_session_secret').update(payload).digest('base64url');
  return 'workbench_session=' + payload + '.' + sig;
})();

const withServer = async (service, run) => {
  const app = express();
  app.use((req, res, next) => {
    const raw = String(req.get('x-test-role') || '').toLowerCase();
    const role = raw === 'admin' ? '管理员' : (raw === 'staff' ? '店员' : '');
    if (role) req.workbenchActor = { role };
    next();
  });
  app.use('/r', createScanPageRouter({
    gateway: null,
    config: SCAN_PAGE,
    startSnapshot: false,
    service,
    writeService: false,
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const get = (base, path, role) => fetch(base + path, {
  headers: { cookie, ...(role ? { 'x-test-role': role } : {}) },
});

test('管理员在库存页看到成本；店员/无角色看不到', async () => {
  costCalls.length = 0;
  const service = { lookup: async () => VIEW };
  await withServer(service, async (base) => {
    const admin = await get(base, '/r/prod_1?from=inventory', 'admin');
    const adminHtml = await admin.text();
    assert.ok(adminHtml.includes('data-view="product-cost"'), '管理员要有成本行');
    assert.ok(adminHtml.includes('成本 ¥168'), '成本值要正确');
    assert.equal(costCalls.length, 1);

    const staff = await get(base, '/r/prod_1?from=inventory', 'staff');
    const staffHtml = await staff.text();
    assert.equal(staffHtml.includes('product-cost'), false);
    assert.equal(staffHtml.includes('¥168'), false);
    assert.equal(costCalls.length, 1, '店员不许触发成本读取');

    const anon = await get(base, '/r/prod_1?from=inventory');
    assert.equal((await anon.text()).includes('¥168'), false);
    assert.equal(VIEW.cost_text, undefined, '共享 view 不许被改');
  });
});

test('成本只在库存领域：销售页不显示，也不读成本', async () => {
  costCalls.length = 0;
  const service = { lookup: async () => VIEW };
  await withServer(service, async (base) => {
    const sales = await get(base, '/r/prod_1?from=sales', 'admin');
    assert.equal((await sales.text()).includes('¥168'), false);
    assert.equal(costCalls.length, 0);
  });
});

test('权限矩阵：inventory.cost.read 只给管理员', () => {
  assert.equal(can('管理员', 'inventory.cost.read'), true);
  assert.equal(can('店员', 'inventory.cost.read'), false);
  assert.equal(can('其它角色', 'inventory.cost.read'), false);
});
