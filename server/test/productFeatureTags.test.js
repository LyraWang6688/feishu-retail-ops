'use strict';

/** 「产品特点配置」只读列表 + 新增去重（三个标签字典表）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';
const { createWorkbenchProductRoutes } = require('../src/routes/workbench/products');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

const appWith = (gateway) => {
  const app = express();
  app.use(express.json());
  app.use(createWorkbenchProductRoutes({ options: { gateway } }));
  return app;
};

const seeded = () => ({
  tbloFxwZa5q504t2: [{ record_id: 'r1', fields: { 标签: '学生党' } }],
  tblEqYe3j5a5Nc9R: [{ record_id: 'r2', fields: { 标签: '防滑耐磨' } }],
  tblsqR83PySHsIZU: [{ record_id: 'r3', fields: { 标签: '上班通勤' } }],
});

const gatewayOf = (tables) => ({
  schema: { appToken: 'app_test' },
  assertSuccess: () => {},
  scheduledWrite: async (tableKey, operation, work) => work(),
  client: {
    bitable: {
      appTableRecord: {
        list: async ({ path }) => ({ data: { items: tables[path.table_id] || [], has_more: false } }),
        create: async ({ path, data }) => {
          const record = { record_id: `new-${path.table_id}`, fields: data.fields };
          tables[path.table_id] = [...(tables[path.table_id] || []), record];
          return { data: { record } };
        },
      },
    },
  },
});

test('AC-PF1 三个维度返回已有标签', async () => {
  const { server, port } = await listen(appWith(gatewayOf(seeded())));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/features`)).json();
    assert.equal(body.dimensions.length, 3);
    assert.deepEqual(body.dimensions.map((item) => item.label), ['主推人群', '核心卖点', '主推场景']);
    assert.equal(body.dimensions[0].items[0].tag, '学生党');
  } finally { server.close(); }
});

test('AC-PF2 新增写对应表；重复标签被拦截', async () => {
  const tables = seeded();
  const { server, port } = await listen(appWith(gatewayOf(tables)));
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/products/features/audience/tags`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: ' 小个子女生 ' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(tables.tbloFxwZa5q504t2.at(-1).fields.标签, '小个子女生');
    const dup = await fetch(`http://127.0.0.1:${port}/products/features/audience/tags`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: '学生党' }),
    });
    assert.equal(dup.status, 400);
    assert.equal(tables.tbloFxwZa5q504t2.filter((item) => item.fields.标签 === '学生党').length, 1);
  } finally { server.close(); }
});
