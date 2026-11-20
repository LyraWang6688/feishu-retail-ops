'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_supplier_balance_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'supplier_balance_test_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_supplier_balance_test';
const { createWorkbenchPurchaseRoutes } = require('../src/routes/workbench/purchase');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

test('AC-SB-API 往来款只读接口：原样返回 service 聚合结果', async () => {
  const payload = { asOf: '2026-11-20T14:00:00.000Z', windowDays: 30, suppliers: [{ name: '七匹狼/吉祥鸟', balance: 10430 }] };
  const app = express();
  app.use(createWorkbenchPurchaseRoutes({ options: { supplierBalance: { list: async () => payload } } }));
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/purchase/supplier-balances`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.windowDays, 30);
    assert.deepEqual(body.suppliers, payload.suppliers);
  } finally { server.close(); }
});
