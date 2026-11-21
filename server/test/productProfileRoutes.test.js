'use strict';

/** 「货品资料」只读接口：搜索 / 缺失分组 / 样例图代理。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';
process.env.FEISHU_V1_PRODUCT_VIEW_ID = process.env.FEISHU_V1_PRODUCT_VIEW_ID || 'vew_test';
const { createWorkbenchProductRoutes } = require('../src/routes/workbench/products');
const { invalidateConfigTable } = require('../src/services/configTableCache');
const { resetProductSearchSnapshot } = require('../src/services/productSearchSnapshot');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

const product = (id, number, itemNo, color, category, missing, token = '', tagMissing = '齐备', extra = '', status = '无货', downlisted = false) => ({
  record_id: id,
  fields: {
    编号: [{ text: number, type: 'text' }],
    货号: itemNo,
    颜色: [{ text: color, type: 'text' }],
    类别: [{ text: category, type: 'text' }],
    货品状态: status,
    下架: downlisted,
    商品信息缺失: missing,
    标签信息缺失: tagMissing,
    样例图: token ? [{
      file_token: token, type: 'image/jpeg', name: 'x.jpg',
      ...(extra ? { tmp_url: `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=${token}&extra=${encodeURIComponent(extra)}` } : {}),
    }] : [],
  },
});

const appWith = (gateway, extra = {}) => {
  invalidateConfigTable('product');
  resetProductSearchSnapshot();
  const app = express();
  app.use(express.json());
  app.use(createWorkbenchProductRoutes({ options: { gateway, ...extra } }));
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
    assert.deepEqual(body.items[0].issues, ['缺商品信息：成本'], '缺失 chips 由服务端唯一判定给出');
    assert.equal(body.items[0].imageUrl, '/api/workbench/products/rec1/sample-image');
    assert.match(body.items[0].recordUrl, /\/base\/app_test\?table=.*record=rec1/, '结果卡片要能打开货品记录');
    assert.match(body.items[0].recordUrl, /[?&]view=vew_test(&|$)/, '记录链接要落在指定视图');
  } finally { server.close(); }
});

test('AC-PP14 货品完善搜索 q=货号全量：能搜到已齐备货品，不返回待完善分组', async () => {
  const gateway = { listAll: async () => [
    product('rec1', '906|黑色|男', '906', '黑色', '男', '成本'),
    product('rec2', '71202|黑色|男', '71202', '黑色', '男', '齐备'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/completion?q=71202`)).json();
    assert.equal(body.success, true);
    assert.equal(body.query, '71202');
    assert.deepEqual(body.items.map((item) => item.recordId), ['rec2'], '已齐备货品也能搜到');
    assert.equal(body.dimensions, undefined, '搜索不返回待完善分组');
  } finally { server.close(); }
});

test('AC-PP1b 新增货品还没进快照 ⇒ 按货号 filter 兜底，立刻能搜到', async () => {
  let filterCalls = 0;
  const gateway = {
    listAll: async () => [product('rec_old', 'OLD|黑色|男', 'OLD', '黑色', '男', '齐备')],
    listByFilter: async (tableKey, formula, options) => {
      filterCalls += 1;
      assert.equal(tableKey, 'product');
      assert.ok(formula, '必须带 filter');
      assert.equal(options.maxRecords, 50);
      return [product('rec_new', 'NEW|黑色|男', 'NEW', '黑色', '男', '齐备')];
    },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/search?q=NEW`)).json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].recordId, 'rec_new');
    assert.equal(filterCalls, 1, '快照 0 命中才兜底一次');
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
    assert.equal(body.total, 3, '只统计至少缺一个维度的货品');
    assert.deepEqual(body.groups.map((g) => [g.value, g.count]), [['成本', 2], ['成本、品类', 1]]);
    assert.ok(body.groups[0].items[0].recordUrl.startsWith('https://'));
  } finally { server.close(); }
});


test('AC-PP-D1 货品下架：只返回无货且未下架的货品，按货号搜索', async () => {
  const gateway = { listAll: async () => [
    product('rec_down', 'A1|黑色|男', 'A1', '黑色', '男', '齐备', '', '齐备', '', '无货', false),
    product('rec_up', 'A2|黑色|男', 'A2', '黑色', '男', '齐备', '', '齐备', '', '有货', false),
    product('rec_down_2', 'B1|白色|女', 'B1', '白色', '女', '齐备', '', '齐备', '', '无货', false),
    product('rec_already', 'C1|红色|女', 'C1', '红色', '女', '齐备', '', '齐备', '', '无货', true),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const all = await (await fetch(`http://127.0.0.1:${port}/products/delisted`)).json();
    assert.equal(all.success, true);
    assert.deepEqual(all.items.map((item) => item.recordId), ['rec_down', 'rec_down_2']);
    assert.equal(all.items[0].status, '无货');
    const searched = await (await fetch(`http://127.0.0.1:${port}/products/delisted?q=B1`)).json();
    assert.deepEqual(searched.items.map((item) => item.recordId), ['rec_down_2']);
  } finally { server.close(); }
});

test('AC-PP-D2 下架接口：异步 202，透传 allowNoSample / 操作人 / submitKey', async () => {
  const calls = [];
  const productDelistAsync = {
    submit: async (input) => {
      calls.push(input);
      return { jobId: 'product_delist_job_1', toast: '数据提交成功，后台自动写入' };
    },
  };
  const { server, port } = await listen(appWith({ listAll: async () => [] }, { productDelistAsync }));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/products/rec_1`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowNoSample: true, submitKey: 'submit_1' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.accepted, true);
    assert.equal(body.job_id, 'product_delist_job_1');
    assert.equal(body.toast, '数据提交成功，后台自动写入');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].recordId, 'rec_1');
    assert.equal(calls[0].allowNoSample, true);
    assert.equal(calls[0].submitKey, 'submit_1');
    assert.ok(calls[0].correlation, '请求关联对象必须透传');
  } finally { server.close(); }
});

test('AC-PP-D3 下架提交失败：业务拒绝 400，归档失败 502', async () => {
  let reason = 'no_sample_image';
  const productDelistAsync = {
    submit: async () => {
      throw Object.assign(new Error(reason), { statusCode: reason === 'archive_failed' ? 502 : 400 });
    },
  };
  const { server, port } = await listen(appWith({ listAll: async () => [] }, { productDelistAsync }));
  try {
    const first = await fetch(`http://127.0.0.1:${port}/products/rec_1`, { method: 'DELETE' });
    assert.equal(first.status, 400);
    reason = 'archive_failed';
    const second = await fetch(`http://127.0.0.1:${port}/products/rec_1`, { method: 'DELETE' });
    assert.equal(second.status, 502);
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

test('AC-PP3d 高级权限：附件 tmp_url 的 extra 必须原样传给下载（否则飞书 400）', async () => {
  const extra = '{"bitablePerm":{"tableId":"tbl_test_product","rev":9}}';
  let seen = null;
  const gateway = {
    get: async () => product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1', '齐备', extra),
    drive: { downloadMedia: async (token, operation, options) => { seen = { token, operation, options }; return Buffer.from('fake-image'); } },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.equal(seen.token, 'file_1');
    assert.equal(seen.options.extra, extra, 'extra 必须逐字带下去');
  } finally { server.close(); }
});

test('AC-PP3b 样例图：token 缓存 + ETag/304（第二次不再读记录）', async () => {
  let getCalls = 0;
  let downloadCalls = 0;
  const gateway = {
    get: async () => { getCalls += 1; return product('rec1', '906|黑色|男', '906', '黑色', '男', '成本', 'file_1'); },
    drive: { downloadMedia: async () => { downloadCalls += 1; return Buffer.from('fake-image'); } },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    const first = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag, '必须有 ETag');
    await first.arrayBuffer();

    const second = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304, '带 If-None-Match ⇒ 304');
    assert.equal(getCalls, 1, '缓存命中不许再读货品记录');
    assert.equal(downloadCalls, 1, '304 不该下载附件');

    const third = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
    assert.equal(third.status, 200);
    await third.arrayBuffer();
    assert.equal(getCalls, 1, 'TTL 内仍是同一份 token');
    assert.equal(downloadCalls, 2);
  } finally { server.close(); }
});

test('AC-PP3c 样例图：1254607 ⇒ 503 + Retry-After；连续失败后熔断（不再打飞书）', async () => {
  let getCalls = 0;
  const gateway = {
    get: async () => {
      getCalls += 1;
      throw new Error('1254607 Data not ready, please try again later');
    },
    drive: { downloadMedia: async () => Buffer.from('x') },
  };
  const { server, port } = await listen(appWith(gateway));
  try {
    for (let index = 0; index < 5; index += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
      assert.equal(res.status, 503, '数据未准备好 ⇒ 503（页面可提示稍后刷新）');
      assert.ok(res.headers.get('retry-after'), '必须带 Retry-After');
    }
    const before = getCalls;
    const blocked = await fetch(`http://127.0.0.1:${port}/products/rec1/sample-image`);
    assert.equal(blocked.status, 503);
    assert.equal(getCalls, before, '熔断窗口内不许再打飞书');
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


test('AC-PP7 货品完善：只搜索非齐备货品，按货号匹配', async () => {
  const gateway = { listAll: async () => [
    product('rec1', 'A|黑|男', '906', '黑', '男', '成本'),
    product('rec2', 'B|黑|男', '71202', '黑', '男', '成本'),
    product('rec3', 'C|黑|男', '906', '黑', '男', '齐备'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/incomplete?q=906`)).json();
    assert.equal(body.total, 1);
    assert.equal(body.groups[0].items[0].recordId, 'rec1');
    const all = await (await fetch(`http://127.0.0.1:${port}/products/incomplete`)).json();
    assert.equal(all.total, 2, '齐备的不进入货品完善');
  } finally { server.close(); }
});

test('AC-PP8 货品完善搜索不支持按编号匹配', async () => {
  const gateway = { listAll: async () => [
    product('rec1', 'ABC|黑|男', '906', '黑', '男', '成本'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/incomplete?q=ABC`)).json();
    assert.equal(body.total, 0);
  } finally { server.close(); }
});

test('AC-PP10 无库存货品也能按 record_id 取货品资料', async () => {
  const gateway = {
    get: async (key, id) => (id === 'rec1'
      ? product('rec1', '906|黑色|男', '906', '黑色', '男', '成本')
      : null),
  };
  const app = express();
  app.use(createWorkbenchProductRoutes({ options: { gateway } }));
  const { server, port } = await listen(app);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/rec1`)).json();
    assert.equal(body.item.recordId, 'rec1');
    assert.equal(body.item.itemNo, '906');
    assert.match(body.item.recordUrl, /record=rec1/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/products/nope`)).status, 404);
  } finally { server.close(); }
});


test('AC-PP11 货品完善三维度：样例图 / 商品信息缺失 / 标签信息缺失', async () => {
  const gateway = { listAll: async () => [
    product('rec1', 'A|黑|男', 'A', '黑', '男', '齐备', '', '齐备'),
    product('rec2', 'B|黑|男', 'B', '黑', '男', '成本', 'file_2', '齐备'),
    product('rec3', 'C|黑|男', 'C', '黑', '男', '齐备', 'file_3', '主推人群'),
    product('rec4', 'D|黑|男', 'D', '黑', '男', '齐备', 'file_4', '齐备'),
  ] };
  const { server, port } = await listen(appWith(gateway));
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/products/completion`)).json();
    assert.equal(body.total, 3, '只统计至少缺一个维度的货品');
    assert.deepEqual(body.dimensions.map((d) => [d.key, d.count]), [['sample', 1], ['product', 1], ['tag', 1]]);
    assert.equal(body.dimensions[0].items.map((i) => i.recordId).join(','), 'rec1');
    assert.deepEqual(body.dimensions[0].items[0].issues, ['缺样例图'], '样例图缺失也是同一份判定');
    assert.match(body.dimensions[1].items[0].recordUrl, /record=rec2/);
  } finally { server.close(); }
});
