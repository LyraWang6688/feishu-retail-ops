'use strict';

/** 「货品资料」只读接口：搜索 / 缺失分组 / 样例图代理。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';
const { createWorkbenchProductRoutes } = require('../src/routes/workbench/products');
const { invalidateConfigTable } = require('../src/services/configTableCache');
const { resetProductSearchSnapshot } = require('../src/services/productSearchSnapshot');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

const product = (id, number, itemNo, color, category, missing, token = '') => ({
  record_id: id,
  fields: {
    编号: [{ text: number, type: 'text' }],
    货号: itemNo,
    颜色: [{ text: color, type: 'text' }],
    类别: [{ text: category, type: 'text' }],
    缺失信息说明: missing,
    样例图: token ? [{ file_token: token, type: 'image/jpeg', name: 'x.jpg' }] : [],
  },
});

const appWith = (gateway) => {
  invalidateConfigTable('product');
  resetProductSearchSnapshot();
  const app = express();
  app.use(createWorkbenchProductRoutes({ options: { gateway } }));
  return app;
};

test('AC-PP1 搜索：只按货号模糊匹配；空搜索不返回结果', async () => {
  const gateway = { listAll: async () => [
    product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1'),
    product('rec2', '71202|黑色|男', '71202', '黑色', '男', '齐备'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/products/search?q=`)).json()).items, []);
    const body = await (await fetch(`http://127.0.0.1:${port}/products/search?q=906`)).json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].number, '906|黑色|男');
    assert.equal(body.items[0].hasSampleImage, true);
    assert.equal(body.items[0].imageUrl, '/api/workbench/products/rec1/sample-image');
  } finally { server.close(); }
});

test('AC-PP2 缺失分组：排除齐备，按缺失值动态分组、数量降序', async () => {
  const gateway = { listAll: async () => [
    product('rec1', 'A|黑|男', 'A', '黑', '男', '成本'),
    product('rec2', 'B|黑|男', 'B', '黑', '男', '成本'),
    product('rec3', 'C|黑|男', 'C', '黑', '男', '成本、品类'),
    product('rec4', 'D|黑|男', 'D', '黑', '男', '齐备'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/incomplete`)).json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.groups.map((g) => [g.value, g.count]), [['成本', 2], ['成本、品类', 1]]);
    assert.ok(body.groups[0].items[0].recordUrl.startsWith('https://'));
  } finally { server.close(); }
});

test('AC-PP3 样例图代理：按 record_id 下载附件并返回图片流', async () => {
  const gateway = {
    get: async () => product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1'),
    drive: { downloadMedia: async () => Buffer.from('fake-image') },
  };
  const app = express();
  app.use(createWorkbenchProductRoutes({ options: { gateway } }));
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'fake-image');
  } finally { server.close(); }
});

test('AC-PP4 搜索走内存快照：连续两次搜索只读一次货品表', async () => {
  let listAllCalls = 0;
  const gateway = {
    listAll: async () => {
      listAllCalls += 1;
      return [product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1')];
    },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const first = await (await fetch(`http://127.0.0.1:${port}/products/search?q=906`)).json();
    const second = await (await fetch(`http://127.0.0.1:${port}/products/search?q=90`)).json();
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.equal(listAllCalls, 1, 'TTL 内第二次搜索不许重新读整表');
  } finally { server.close(); }
});

test('AC-PP5 只匹配货号，不匹配编号', async () => {
  const gateway = {
    listAll: async () => [
      product('rec1', 'ABC|黑色|男', '906', '黑色', '男', '成本', 'file_1'),
      product('rec2', '906|黑色|男', 'XYZ', '黑色', '男', '成本'),
    ],
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/search?q=906`)).json();
    assert.deepEqual(body.items.map((item) => item.recordId), ['rec1']);
  } finally { server.close(); }
});

test('AC-PP6 冷启动快照失败 ⇒ 回退飞书 filter（只查货号）', async () => {
  let filterSeen = '';
  const gateway = {
    listAll: async () => { throw new Error('1254607'); },
    listByFilter: async (tableKey, filter) => {
      filterSeen = filter;
      return [product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1')];
    },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/search?q=906`)).json();
    assert.equal(body.items.length, 1);
    assert.ok(filterSeen.includes('CurrentValue.[货号].contains("906")'));
    assert.ok(!filterSeen.includes('CurrentValue.[编号]'));
  } finally { server.close(); }
});
