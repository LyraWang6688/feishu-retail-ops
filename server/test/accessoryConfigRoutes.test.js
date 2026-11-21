'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchProductRoutes } = require('../src/routes/workbench/products');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const fields = V1_BITABLE_SCHEMA.tables.accessory.fields;
const physical = (patch) => Object.fromEntries(Object.entries(patch).map(([key, value]) => [fields[key] || key, value]));
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const fakeAsyncJobs = () => ({
  jobIdFor: (type, key) => `${type}_${key}`,
  enqueue: async ({ jobId }) => ({ created: true, job: { job_id: jobId, status: 'queued' } }),
  run: async ({ run }) => run(),
});

const makeGateway = () => {
  const rows = [{ record_id: 'a1', fields: { [fields.name]: '39元腰带', [fields.category]: '腰带', [fields.price]: 39 } }];
  return {
    async listAll() { return rows; },
    async get(_table, id) { return rows.find((row) => row.record_id === id) || null; },
    async create(_table, patch) { const row = { record_id: 'a2', fields: physical(patch) }; rows.push(row); return row; },
    async update(_table, id, patch) { const row = rows.find((item) => item.record_id === id); Object.assign(row.fields, physical(patch)); return row; },
    async delete(_table, id) { const i = rows.findIndex((row) => row.record_id === id); if (i >= 0) rows.splice(i, 1); },
    rows,
  };
};

const appWith = (gateway) => {
  const app = express();
  app.use(express.json());
  app.use(createWorkbenchProductRoutes({ options: { gateway, asyncJobs: fakeAsyncJobs() } }));
  return app;
};

test('配品 API：列表同步读，新增/修改/删除返回 202 + job_id', async () => {
  const gateway = makeGateway();
  const { server, port } = await listen(appWith(gateway));
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/products/accessories`)).json();
    assert.equal(list.rows.length, 1);
    const created = await fetch(`http://127.0.0.1:${port}/products/accessories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '鞋垫', category: '鞋垫', price: 18, stockQuantity: 3, submitKey: 'k1' }),
    });
    const body = await created.json();
    assert.equal(created.status, 202);
    assert.ok(body.job_id);
    await settle();
    assert.equal(gateway.rows.some((row) => row.fields[fields.name] === '鞋垫'), true);
    const duplicate = await fetch(`http://127.0.0.1:${port}/products/accessories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '39元腰带', category: '腰带', price: 49, submitKey: 'k2' }),
    });
    assert.equal(duplicate.status, 400);
  } finally { server.close(); }
});
