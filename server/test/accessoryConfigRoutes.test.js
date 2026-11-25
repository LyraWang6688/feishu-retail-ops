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

const categoryFields = V1_BITABLE_SCHEMA.tables.accessoryCategory.fields;
const makeGateway = () => {
  const rows = [{ record_id: 'a1', fields: { [fields.name]: '39元腰带', [fields.category]: '腰带', [fields.price]: 39, [fields.sampleImage]: [{ file_token: 'img_1' }] } }];
  const categories = ['腰带', '鞋油', '鞋垫'].map((name, index) => ({
    record_id: 'c' + (index + 1),
    fields: { [categoryFields.name]: name },
  }));
  let seq = 0;
  return {
    async listAll(tableKey) { return tableKey === 'accessoryCategory' ? categories : rows; },
    async get(_table, id) { return rows.find((row) => row.record_id === id) || null; },
    async create(tableKey, patch) {
      seq += 1;
      if (tableKey === 'accessoryCategory') {
        const row = { record_id: 'cn_' + seq, fields: { [categoryFields.name]: patch.name } };
        categories.push(row);
        return { recordId: row.record_id, record: row };
      }
      const row = { record_id: 'a2_' + seq, fields: physical(patch) };
      rows.push(row);
      return { recordId: row.record_id, record: row };
    },
    async update(_table, id, patch) { const row = rows.find((item) => item.record_id === id); Object.assign(row.fields, physical(patch)); return row; },
    async delete(_table, id) { const i = rows.findIndex((row) => row.record_id === id); if (i >= 0) rows.splice(i, 1); },
    rows,
    categories,
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
    const categoriesBefore = await (await fetch(`http://127.0.0.1:${port}/products/accessories/categories`)).json();
    assert.deepEqual(categoriesBefore.categories, ['腰带', '鞋油', '鞋垫']);
    const categoryAdded = await fetch(`http://127.0.0.1:${port}/products/accessories/categories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: '新种类', submitKey: 'cat1' }),
    });
    assert.equal(categoryAdded.status, 202);
    await settle();
    const categoriesAfter = await (await fetch(`http://127.0.0.1:${port}/products/accessories/categories`)).json();
    assert.ok(categoriesAfter.categories.includes('新种类'));
    const created = await fetch(`http://127.0.0.1:${port}/products/accessories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '鞋垫', category: '鞋垫', price: 18, stockQuantity: 3, isGift: true, submitKey: 'k1' }),
    });
    const body = await created.json();
    assert.equal(created.status, 202);
    assert.ok(body.job_id);
    await settle();
    const createdRow = gateway.rows.find((row) => row.fields[fields.name] === '鞋垫');
    assert.equal(createdRow.fields[fields.isGift], true, '赠品复选框必须透传到写链');
    assert.deepEqual(createdRow.fields[fields.category], ['c3'], '种类按关联 record_id 写入');
    const duplicate = await fetch(`http://127.0.0.1:${port}/products/accessories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '39元腰带', category: '腰带', price: 49, submitKey: 'k2' }),
    });
    assert.equal(duplicate.status, 400);
    const patched = await fetch(`http://127.0.0.1:${port}/products/accessories/a1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '39元腰带', category: '腰带', price: 42, submitKey: 'u1' }),
    });
    assert.equal(patched.status, 202);
    await settle();
    const patchedRow = gateway.rows.find((row) => row.record_id === 'a1');
    assert.deepEqual(
      patchedRow.fields[fields.sampleImage],
      [{ file_token: 'img_1' }],
      '编辑请求不带 sampleImageToken ⇒ 样例图必须保留（2026-11-25 事故回归）',
    );
  } finally { server.close(); }
});
