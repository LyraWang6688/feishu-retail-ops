'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchAccessorySaleRoutes } = require('../src/routes/workbench/accessorySales');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SUBMIT_TOAST } = require('../src/config/submitToast');

const makeGateway = () => {
  const payments = [];
  const details = [];
  return {
    async listAll(tableKey) {
      if (tableKey === 'paymentRecord') {
        return payments.map((row) => ({
          record_id: row.id,
          fields: { [V1_BITABLE_SCHEMA.tables.paymentRecord.fields.receiptId]: row.receiptId },
        }));
      }
      return [];
    },
    async create(tableKey, fields) {
      const id = 'pay_' + (payments.length + 1);
      payments.push({ id, fields });
      return { recordId: id };
    },
    async update() { return {}; },
    async createBatch(tableKey, rows) {
      return rows.map((fields) => {
        const id = 'line_' + (details.length + 1);
        details.push({ id, fields });
        return { recordId: id };
      });
    },
  };
};

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

test('配品销售：成功后返回统一回执 redirect（文案/落点来自 submitToast）', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'req_test';
    req.workbenchUser = { open_id: 'ou_test', name: '测试' };
    next();
  });
  app.use(createWorkbenchAccessorySaleRoutes({ options: { gateway: makeGateway() } }));
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/accessory-sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ accessoryRecordId: 'acc_1', quantity: 1 }],
        amount: 9.9,
        methodRecordId: 'pm_1',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(String(body.orderNo).startsWith('PX-'));
    const url = new URL(body.redirect, 'http://localhost');
    assert.equal(url.pathname, '/workbench/', '统一回执落点 = 工作台');
    assert.equal(url.searchParams.get('toast'), SUBMIT_TOAST.text, '统一文案唯一真源');
    assert.equal(url.searchParams.get('done'), body.orderNo, '单号只进 done，不进 toast');
  } finally {
    server.close();
  }
});
