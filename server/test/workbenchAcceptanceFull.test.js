/**
 * ⭐⭐ 2026-10-14 晚：把**老验收整块搬进工作台**（业务负责人逐字，真源
 * `docs/acceptance-into-workbench-full-2026-10-14.md`，AC-AW10…AW17）。
 *
 * ⚠️ 本文件钉的是**工作台这一层**（路由编排 + 配置）：
 *   · 明细**只读**（GET ✓ 走既有 `listPurchaseRequests` ✓）
 *   · 自定义尺码/货号走**既有** `scanArrivalService.addScan` ✓（认不出 ⇒ **如实 400** ✗ 不静默丢）
 *   · 完成走**既有** `finish` ✓，**幂等键 = 服务自己的 `submitKeyOf(session)`** ✓（**不取表单里的键** ✗）
 *   · 🔴 加库存**只走** `InventoryService.applyPurchase`（本刀**不直连表** ✗ 源码哨兵 ✓）
 * ⚠️ 会话写入语义本身由 `test/scanArrival*.test.js` 覆盖（本刀**只调用、不改它** ✓）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_acc_full_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'acc_full_secret';

const { createWorkbenchRouter } = require('../src/routes/workbench');
const arrivalTab = require('../src/config/workbenchArrival');

const SESSION_SECRET = 'workbench_acceptance_full_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_acc_full', name: 'T', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
})();

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const fakeArrival = (overrides = {}) => {
  const calls = [];
  const session = {
    session_id: 'sess-1', batch_no: 'BH-1', status: 'open', submit_round: 3,
    rows: [{ product_record_id: 'p1', size: 40, quantity: 2 }], posted_keys: [],
  };
  return {
    calls, session,
    start: async (input) => { calls.push({ m: 'start', input }); return overrides.start ? overrides.start(input) : { ok: true, session }; },
    addScan: async (input) => { calls.push({ m: 'addScan', input }); return overrides.addScan ? overrides.addScan(input) : { ok: true }; },
    get: async () => session,
    submitKeyOf: (s) => `accept:${s?.session_id}:${Number(s?.submit_round || 0)}`,
    finish: async (input) => {
      calls.push({ m: 'finish', input });
      if (overrides.finish) return overrides.finish(input, calls);
      return { ok: true, reused: calls.filter((c) => c.m === 'finish').length > 1, order_no: '' };
    },
  };
};
const fakeQuery = (rows) => ({ calls: [], listPurchaseRequests: async (input) => { fakeQuery.last = input; return rows; } });

const appFor = ({ arrival, purchaseQuery }) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ gateway: {}, purchaseQuery, arrival }));
  app.use((error, req, res, next) => res.status(500).json({ success: false, error: error.message }));
  return app;
};
const getJson = async (base, p) => {
  const res = await fetch(`${base}/api/workbench${p}`, { headers: { cookie: COOKIE } });
  return { status: res.status, body: await res.json() };
};
const postJson = async (base, p, body) => {
  const res = await fetch(`${base}/api/workbench${p}`, {
    method: 'POST', headers: { cookie: COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const ROWS = [
  { record_id: 'r1', product_record_id: 'p1', item_no: 'A1', size: 40, quantity: 2 },
  { record_id: 'r2', product_record_id: 'p1', item_no: 'A1', size: 41, quantity: 1 },
];

test('AC-AW10 ⭐ 卡展开能看到**该批采购明细**（货号/尺码/数量 · **只读** GET ✓ 无输入 ✗）', async () => {
  const q = fakeQuery(ROWS);
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: q }), async (base) => {
    const res = await getJson(base, `${arrivalTab.api.detail}?batchNo=BH-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, [
      { item_no: 'A1', size: 40, quantity: 2, product_record_id: 'p1' },
      { item_no: 'A1', size: 41, quantity: 1, product_record_id: 'p1' },
    ], '明细逐字（货号/尺码/数量 ✓）');
    // 🔴 只读：这条是 GET，而且返回的是**数据**（没有表单字段/输入框语义 ✗）
    assert.equal('fields' in res.body, false, '只读明细不许回"可填字段" ✗');
  });
});

test('AC-AW10b ⭐ 缺批次号 / 明细读不到 / 明细为空 ⇒ 人话 + 不当成功 ✗', async () => {
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: fakeQuery([]) }), async (base) => {
    const missing = await getJson(base, arrivalTab.api.detail);
    assert.equal(missing.status, 400, '没批次号 ⇒ 400 ✗');
    assert.equal(missing.body.success, false);
    assert.equal(missing.body.error, arrivalTab.texts.batchMissing, '人话来自配置 ✓');
    const empty = await getJson(base, `${arrivalTab.api.detail}?batchNo=BH-none`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.rows, []);
    assert.equal(empty.body.notice, arrivalTab.texts.emptyDetail, '空明细给人话（不是静默空 ✗）');
  });
  const boom = { listPurchaseRequests: async () => { throw new Error('read failed'); } };
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: boom }), async (base) => {
    const res = await getJson(base, `${arrivalTab.api.detail}?batchNo=BH-1`);
    assert.equal(res.status, 400, '读到失败 ⇒ 400 人话（不当成功 ✗）');
    assert.equal(res.body.error, arrivalTab.texts.detailFailed);
  });
});

test('AC-AW11 ⭐⭐ 自定义尺码（手填尺码+数量）⇒ 走**既有** addScan ✓ 然后 finish ✓', async () => {
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', actualAmount: '300', acceptanceText: '都到了',
      lines: [{ productRecordId: 'p1', size: 42, quantity: 3 }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const add = arrival.calls.filter((c) => c.m === 'addScan');
    assert.equal(add.length, 1, '一行 ⇒ addScan 一次 ✓');
    assert.deepEqual(add[0].input, { openId: 'ou_acc_full', productRecordId: 'p1', size: 42, quantity: 3 });
    assert.equal(arrival.calls.filter((c) => c.m === 'finish').length, 1, '完成验收只一次 ✓');
  });
});

test('AC-AW12 ⭐⭐ 自定义货号（采购申请里没有的款）⇒ **如实 400** ✗（不静默丢、不假装成功）', async () => {
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', actualAmount: '100',
      lines: [{ itemNo: 'NOT-IN-REQUEST', size: 40, quantity: 1 }], // ⚠️ 认不出 productRecordId
    });
    assert.equal(res.status, 400, '认不出货号 ⇒ 400 人话 ✗');
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, arrivalTab.texts.itemNoUnresolved);
    assert.equal(arrival.calls.filter((c) => c.m === 'addScan').length, 0, '认不出 ⇒ **不许**静默丢进 addScan ✗');
    assert.equal(arrival.calls.filter((c) => c.m === 'finish').length, 0, '更不许假装验收成功 ✗');
  });
});

test('AC-AW13 ⭐⭐ 幂等：**同一把 `submitKey`**（服务自己的 `submitKeyOf` ✓ 不取表单 ✗）串行+并发两跑', async () => {
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const body = {
      batchNo: 'BH-1', actualAmount: '100', lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
      submitKey: 'form-controlled-key-should-be-ignored', // ⚠️ 表单里塞的键**必须被忽略** ✗
    };
    const first = await postJson(base, arrivalTab.api.accept, body);
    const second = await postJson(base, arrivalTab.api.accept, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.reused, true, '第二跑由服务层判重 ⇒ reused ✓（只写一次 ✗）');
    const keys = arrival.calls.filter((c) => c.m === 'finish').map((c) => c.input.submitKey);
    assert.equal(keys.length, 2);
    assert.deepEqual(keys, ['accept:sess-1:3', 'accept:sess-1:3'], '两跑必须带**同一把**服务端键 ✓');
    assert.equal(keys.includes('form-controlled-key-should-be-ignored'), false, '表单里的键不许被采用 ✗');
    // 并发两跑：键也必须一致 ✓
    arrival.calls.length = 0;
    const [a, b] = await Promise.all([
      postJson(base, arrivalTab.api.accept, body), postJson(base, arrivalTab.api.accept, body),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const ckeys = arrival.calls.filter((c) => c.m === 'finish').map((c) => c.input.submitKey);
    assert.deepEqual(ckeys, ['accept:sess-1:3', 'accept:sess-1:3'], '并发两跑的键也必须一致 ✓');
  });
});

test('AC-AW14 ⭐⭐ 加库存**只走** `InventoryService.applyPurchase`（源码哨兵：本刀**不直连表** ✗）', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workbench.js'), 'utf8');
  const start = route.indexOf('const purchaseQueryForArrival');
  const block = route.slice(start, route.indexOf("router.use('/purchase', createPurchaseQueryRouter"));
  for (const bad of ['gateway.create', 'gateway.update', 'listAll(', 'applyPurchase']) {
    assert.equal(block.includes(bad), false, `验收这批新代码里不该出现 ${bad}（加库存只能由既有服务做 ✗）`);
  }
  // 既有服务内部**确实**走 applyPurchase（能力没被搬走 ✓）
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scanArrivalService.js'), 'utf8');
  assert.ok(svc.includes('applyPurchase'), '加库存仍由既有 `InventoryService.applyPurchase` 走 ✓');
});

test('AC-AW17 ⭐ 失败如实：开会话失败（明细读不到 / 没明细）⇒ 400 + 服务的人话 + **零写入** ✗', async () => {
  const arrival = fakeArrival({
    start: () => ({ ok: false, reason: 'no_request_rows', message: '这一批没有采购明细' }),
  });
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, { batchNo: 'BH-1', actualAmount: '10' });
    assert.equal(res.status, 400, '读不到 ⇒ 400 ✗ 不当成功 ✗');
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, '这一批没有采购明细', '原因原样回到页面 ✓');
    assert.equal(arrival.calls.filter((c) => c.m === 'finish').length, 0, '零写入 ✓');
  });
  // 尺码/数量不合法 ⇒ 400（且不许调用 addScan ✗）
  const arrival2 = fakeArrival();
  await withServer(appFor({ arrival: arrival2, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const bad = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', lines: [{ productRecordId: 'p1', size: 'abc', quantity: 0 }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, arrivalTab.texts.sizeInvalid);
    assert.equal(arrival2.calls.filter((c) => c.m === 'addScan').length, 0, '不合法 ⇒ 不写 ✗');
  });
});
