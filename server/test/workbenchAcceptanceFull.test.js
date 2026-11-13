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
// ⭐⭐ 2026-10-16（task-56）：工作台【确认到货】接异步 ⇒ 用例要能"等后台那一跑跑完"再断言写入口
//    （与 `test/purchaseAsyncAcceptance.test.js` 同一个入口 ✓ 不轮询、等真 Promise ✓）。
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');

const SESSION_SECRET = 'workbench_acceptance_full_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_acc_full', name: 'T', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
})();

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const fakeArrival = (overrides = {}) => {
  const calls = [];
  // ⭐⭐ 2026-10-16（task-56 · **成对迁移**）：替身会话补上 `scans`（改前这里没有它 ✗）。
  //   改前逐字：`rows: [{ product_record_id: 'p1', size: 40, quantity: 2 }], posted_keys: [],`
  //   改后逐字：`rows: [{ product_record_id: 'p1', size: 40, quantity: 2 }], posted_keys: [],`
  //             `scans: [{ product_record_id: 'p1', size: 40, quantity: 1 }],`
  //   依据：她 2026-10-16『**验收也是异步**』＋弹窗选 B —— 异步之后「空单」这道校验
  //     **必须留在同步路径**（`session.scans` 为空 ⇒ 400 + 写层那句人话 + 零写入 ✗），
  //     于是路由第一次真的去读 `session.scans` ⇒ 替身必须像**真会话**一样带上它
  //     （真会话由 `scanArrivalService.start` 建，**从来都有** `scans: []` ✓）。
  //   ⚠️ 这不是放宽判据：断言一个字没改，只是把**残缺的替身**补成真形状 ✓。
  const session = {
    session_id: 'sess-1', batch_no: 'BH-1', status: 'open', submit_round: 3,
    rows: [{ product_record_id: 'p1', size: 40, quantity: 2 }], posted_keys: [],
    scans: [{ product_record_id: 'p1', size: 40, quantity: 1 }],
  };
  return {
    calls, session,
    start: async (input) => { calls.push({ m: 'start', input }); return overrides.start ? overrides.start(input) : { ok: true, session }; },
    // ⭐ 2026-10-29（F1/F2 成对迁移）：路由【确认到货】从"逐行 addScan"改成"一次 setScans 整单替换"。
    //   改前逐字：路由每行调 `addScan`；改后逐字：路由只调一次 `setScans({ openId, lines })` ✓
    //   依据：自定义尺码/货号在旧路径**必然** 400、改数量/改 0 也不生效（见 `test/workbenchArrivalSetScans.test.js`）。
    setScans: async (input) => {
      calls.push({ m: 'setScans', input });
      return overrides.setScans ? overrides.setScans(input) : { ok: true, session };
    },
    // ⚠️ 替身仍保留 addScan（别的用例/别的链路可能用）；但**工作台 accept 这条路已不再调它** ✗
    addScan: async (input) => { calls.push({ m: 'addScan', input }); return overrides.addScan ? overrides.addScan(input) : { ok: true }; },
    get: async () => session,
    submitKeyOf: (s) => `accept:${s?.session_id}:${Number(s?.submit_round || 0)}`,
    // ⚠️ 后台失败时共用件会调 `markFailed` ⇒ 它要能读会话、也要有 store（替身给一个空实现 ✓）
    store: { update: async () => ({}) },
    finish: async (input) => {
      calls.push({ m: 'finish', input });
      if (overrides.finish) return overrides.finish(input, calls);
      return { ok: true, reused: calls.filter((c) => c.m === 'finish').length > 1, order_no: '' };
    },
  };
};
const fakeQuery = (rows) => ({ calls: [], listPurchaseRequests: async (input) => { fakeQuery.last = input; return rows; } });

const appFor = ({ arrival, purchaseQuery, gateway = {}, acceptBackground = null }) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway, purchaseQuery, arrival,
    ...(acceptBackground ? { acceptBackground } : {}),
  }));
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
  // 真实 `listPurchaseRequests` 行：`product_item_no`=货号、`product_color`=颜色、`product_number`=编号（复合值）
  { record_id: 'r1', product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', product_number: 'A1|黑色|女', size: 40, quantity: 2 },
  { record_id: 'r2', product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', product_number: 'A1|黑色|女', size: 41, quantity: 1 },
];

test('AC-AW10 ⭐ 卡展开能看到**该批采购明细**（货号/尺码/数量 · **只读** GET ✓ 无输入 ✗）', async () => {
  const q = fakeQuery(ROWS);
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: q }), async (base) => {
    const res = await getJson(base, `${arrivalTab.api.detail}?batchNo=BH-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, [
      { item_no: 'A1', color: '黑色', number: 'A1|黑色|女', size: 40, quantity: 2, product_record_id: 'p1' },
      { item_no: 'A1', color: '黑色', number: 'A1|黑色|女', size: 41, quantity: 1, product_record_id: 'p1' },
    ], '明细逐字（货号/颜色/编号/尺码/数量 ✓）');
    // 🔴 只读：这条是 GET，而且返回的是**数据**（没有表单字段/输入框语义 ✗）
    assert.equal('fields' in res.body, false, '只读明细不许回"可填字段" ✗');
  });
});

test('AC-AW10c ⭐ 按供应商拆卡后：明细只回**这个供应商**的行（同批次多供应商）', async () => {
  const q = fakeQuery([
    { record_id: 'r1', product_record_id: 'p1', product_item_no: 'A1', product_color: '黑色', product_number: 'A1', size: 40, quantity: 2, supplier_record_id: 's1', supplier_name: '一代千金' },
    { record_id: 'r2', product_record_id: 'p2', product_item_no: 'A2', product_color: '黑色', product_number: 'A2', size: 40, quantity: 3, supplier_record_id: 's2', supplier_name: '信踏' },
  ]);
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: q }), async (base) => {
    const res = await getJson(base, `${arrivalTab.api.detail}?batchNo=BH-1&supplierRecordId=s1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, [{
      item_no: 'A1', color: '黑色', number: 'A1', size: 40, quantity: 2, product_record_id: 'p1', supplier_record_id: 's1',
    }], '只回一代千金那 1 行（信踏的不混进来 ✓）');
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

test('AC-AW18 ⭐ 按供应商拆卡：accept 把 supplierRecordId 原样交给会话（每家独立验收）', async () => {
  const q = fakeQuery([{
    record_id: 'r1', batch_no: 'BH-1', product_record_id: 'p1', product_item_no: 'A1', size: 40,
    quantity: 2, report_behavior: 'purchase_request', arrival_status: '未到货', supplier_record_id: 's1',
  }]);
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: q }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', supplierRecordId: 's1', actualAmount: '100',
      lines: [{ productRecordId: 'p1', size: 40, quantity: 2 }],
    });
    assert.equal(res.status, 200);
    const started = arrival.calls.find((c) => c.m === 'start');
    assert.equal(started?.input?.supplierRecordId, 's1', '开会话时带上本次验收的供应商 ✓');
  });
});

test('AC-AW18b ⭐ 供应商不在这批采购明细里 ⇒ 400 + 人话 + 零会话（防旧页面/手工请求）', async () => {
  const q = fakeQuery([{
    record_id: 'r1', batch_no: 'BH-1', product_record_id: 'p1', product_item_no: 'A1', size: 40,
    quantity: 2, report_behavior: 'purchase_request', arrival_status: '未到货', supplier_record_id: 's1',
  }]);
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: q }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', supplierRecordId: 's-not-here', actualAmount: '100',
      lines: [{ productRecordId: 'p1', size: 40, quantity: 2 }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, arrivalTab.texts.supplierNotInBatch, '人话走配置 ✓');
  });
  assert.equal(arrival.calls.length, 0, '不在本批 ⇒ 零会话 ✓');
});

test('AC-AW-ALREADY ⭐⭐ 已到货批次再提交验收 ⇒ 400 + 人话 + 零写入（前端已不渲染它，后端也挡）', async () => {
  const arrival = fakeArrival();
  const q = fakeQuery([{
    record_id: 'r1', batch_no: 'BH-1', product_record_id: 'p1', item_no: 'A1', size: 40,
    quantity: 1, arrival_status: '已到货', report_behavior: 'purchase_request',
  }]);
  await withServer(appFor({ arrival, purchaseQuery: q }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', actualAmount: '100', lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
    });
    assert.equal(res.status, 400, '已到货 ⇒ 400（不许再验收 ✗）');
    assert.ok(String(res.body.error || '').includes(arrivalTab.texts.alreadyAccepted), '人话走配置 ✓');
  });
  assert.equal(arrival.calls.length, 0, '零会话 / 零写入 / 零后台（start 一次都没调 ✓）');
});

test('AC-AW11 ⭐⭐ 自定义尺码（手填尺码+数量）⇒ 走**一次** setScans（整单替换）✓ 然后 finish ✓', async () => {
  // ⚠️ **2026-10-29（F1/F2）成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(add.length, 1)` / `deepEqual(add[0].input, { openId, productRecordId, size, quantity })`
  //   改后逐字：`assert.equal(replaced.length, 1)` / `deepEqual(replaced[0].input, { openId, lines: [{ product_record_id, size, quantity }] })`
  //   依据：旧路由逐行 `addScan` **根本不认**自定义行（不在本批申请行 ⇒ 必 400 ✗）；
  //     改成 `setScans` 后"自定义尺码（款在本批）"才会真的被收下（F1 的修复点 ✓）。
  //   判据没放宽：仍然钉"她填的尺码/数量原样到达写层一次"，只是入口从 addScan 换成 setScans ✓。
  const arrival = fakeArrival();
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', actualAmount: '300', acceptanceText: '都到了',
      lines: [{ productRecordId: 'p1', size: 42, quantity: 3 }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const replaced = arrival.calls.filter((c) => c.m === 'setScans');
    assert.equal(replaced.length, 1, '一次提交 ⇒ setScans 一次（整单替换 ✓）');
    assert.deepEqual(replaced[0].input, {
      openId: 'ou_acc_full',
      lines: [{ product_record_id: 'p1', size: 42, quantity: 3 }],
    });
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
  // ⭐⭐ 2026-10-16（task-56 · **成对迁移**）：异步之后"判重那一跑"在**后台**，
  //   HTTP 回执不再可能带写库结果 ⇒ 判据改成"**等后台那一跑跑完，再由它的结果证明判重**" ✓
  //   改前逐字：`assert.equal(second.body.reused, true, '第二跑由服务层判重 ⇒ reused ✓（只写一次 ✗）');`
  //   改后逐字：`await waitForPendingPurchaseBackgrounds();`
  //             `assert.equal(finishResults[1].reused, true, '第二跑由服务层判重 ⇒ reused ✓（只写一次 ✗）');`
  //   依据：业务负责人 2026-10-16「**工作台那半也接异步**」（弹窗选 B）＋「用户提交之后
  //     **都是一个成功页**」——她那一屏只等"系统已收到"，**写库结果不再随 HTTP 回执回来** ✗；
  //     ⇒ 判据**一个字没放宽**：仍然要求"同键两跑 ⇒ 只有一次真写"，只是**取证位置**从
  //     响应体挪到"后台那一跑的返回值"（那就写入口自己的结果 ✓）。
  const finishResults = [];
  const realFinish = arrival.finish;
  arrival.finish = async (input) => { const result = await realFinish(input); finishResults.push(result); return result; };
  await withServer(appFor({ arrival, purchaseQuery: fakeQuery(ROWS) }), async (base) => {
    const body = {
      batchNo: 'BH-1', actualAmount: '100', lines: [{ productRecordId: 'p1', size: 40, quantity: 1 }],
      submitKey: 'form-controlled-key-should-be-ignored', // ⚠️ 表单里塞的键**必须被忽略** ✗
    };
    const first = await postJson(base, arrivalTab.api.accept, body);
    const second = await postJson(base, arrivalTab.api.accept, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // ⭐ 异步：两跑都只承诺"已提交成功，数据会更新"（写库结果由后台那一跑给 ✓）
    assert.equal(first.body.message, arrivalTab.texts.submitted, '成功页 = 统一那一句 ✓');
    assert.equal(second.body.message, arrivalTab.texts.submitted, '第二跑同样是那一句 ✓');
    // ⭐ 等后台那一跑 ⇒ 判重的那次**由写入口自己**给出 `reused: true`（零写入 ✓）
    await waitForPendingPurchaseBackgrounds();
    assert.equal(finishResults.length, 2, '两跑都排了后台那一跑 ✓（本件不做去重 ✗ —— 幂等在写层 ✓）');
    assert.equal(finishResults[1].reused, true, '第二跑由服务层判重 ⇒ reused ✓（只写一次 ✗）');
    const keys = arrival.calls.filter((c) => c.m === 'finish').map((c) => c.input.submitKey);
    assert.equal(keys.length, 2);
    assert.deepEqual(keys, ['accept:sess-1:3', 'accept:sess-1:3'], '两跑必须带**同一把**服务端键 ✓');
    assert.equal(keys.includes('form-controlled-key-should-be-ignored'), false, '表单里的键不许被采用 ✗');
    // 并发两跑：键也必须一致 ✓
    arrival.calls.length = 0;
    finishResults.length = 0;
    const [a, b] = await Promise.all([
      postJson(base, arrivalTab.api.accept, body), postJson(base, arrivalTab.api.accept, body),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    await waitForPendingPurchaseBackgrounds();
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

// ═══════════════════════════════════════════════════════════════════════════
// AC-AW16（前端那一刀）：卡展开里的明细/自定义行 ⇒ 走**新接口** · 文案走配置 · ≥44px · 即时反馈
// ═══════════════════════════════════════════════════════════════════════════
const FEATURE = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'features', 'orders', 'index.js'), 'utf8');
const FE_CONFIG = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'config', 'orders.js'), 'utf8');

test('AC-AW16a ⭐ 明细与提交打的是**新接口**（配置常量 ✓ 不写死 URL ✗）', () => {
  assert.ok(FEATURE.includes('ARRIVAL_FULL_API.detail'), '明细读 /purchase/arrivals/detail ✓');
  assert.ok(FEATURE.includes('ARRIVAL_FULL_API.accept'), '提交打 /purchase/arrivals/accept ✓');
  assert.ok(FEATURE.includes('arrival-detail'), '有只读明细容器 ✓');
  // ⭐ 2026-11-09（业务负责人批注：「自定义尺码 / 自定义货号」不需要，删除）⇒ 两个入口不许回来
  assert.equal(FEATURE.includes('data-field="custom-size"'), false, '⛔ 自定义尺码入口已删除 ✓');
  assert.equal(FEATURE.includes('data-field="custom-item-no"'), false, '⛔ 自定义货号入口已删除 ✓');
  // 服务端两条接口的路径逐字在配置里 ✓（前后端同一份口径）
  assert.match(FE_CONFIG, /detail: '\/api\/workbench\/purchase\/arrivals\/detail'/, '明细接口路径 ✓');
  assert.match(FE_CONFIG, /accept: '\/api\/workbench\/purchase\/arrivals\/accept'/, '验收接口路径 ✓');
});

test('AC-AW16b ⭐ 自定义入口已退场（业务负责人 2026-11-09 批注）', () => {
  assert.equal(/custom-size|custom-quantity|custom-item/.test(FEATURE), false, '⛔ 前端不许再有自定义尺码/货号字段 ✓');
  assert.equal(FEATURE.includes('resolveItemNo'), false, '⛔ 解析自定义货号的辅助函数已删除 ✓');
});

test('AC-AW16c ⭐ 交互硬规矩：文案走配置 ✓ · 无内联高度 ✗（沿用 ≥44px 的既有控件样式）· 提交有**即时反馈** ✓', () => {
  // 新块用配置文案（不硬编码中文 ✓）
  // 自定义入口已退场 ⇒ 配置里也不许再留这些文案（能真红：塞回即红）
  assert.equal(FE_CONFIG.includes('customSizeLabel'), false, '⛔ 配置里的自定义尺码文案已删除 ✓');
  // ≥44px：沿用既有控件样式（base.css 给 --control-height）✓ 且**不写内联高度** ✗
  const base = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'styles', 'base.css'), 'utf8');
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/, '既有控件 ≥44px ✓');
  const block = FEATURE.slice(FEATURE.indexOf('data-view="arrival-detail"'), FEATURE.indexOf('data-field="arrival-amount"'));
  assert.equal(/style="height/.test(block), false, '新块不许写内联高度（走既有令牌 ✓）');
  // 即时反馈：提交仍走既有的 runWriteAction（点击立刻置灰 + 换文案 ✓）
  const submitSlice = FEATURE.slice(FEATURE.indexOf('async function submitArrival'), FEATURE.indexOf('async function runAction'));
  assert.ok(submitSlice.includes('runWriteAction('), '提交必须走既有即时反馈封装 ✓');
  assert.ok(submitSlice.includes('ARRIVAL_FULL_API.accept'), '而且打的是新接口 ✓');
});

test('AC-AW16d ⭐ 幂等键不来自表单：前端**不传** submitKey（由服务端会话决定 ✓）', () => {
  // ⚠️ 先剥注释再判（注释里解释幂等会提到 submitKey ✗）
  const submitSlice = FEATURE.slice(FEATURE.indexOf('async function submitArrival'), FEATURE.indexOf('async function runAction'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/submitKey/.test(submitSlice), false, 'frontend must not invent or send the idempotency key');
});


test('AC-AW-DOC1 ⭐ 验收单上传：图片原始二进制 → 飞书素材 → 返回 file_token（写「对方单据」用）', async () => {
  let uploadedPath = '';
  const gateway = {
    uploadAttachment: async (filePath, options) => {
      uploadedPath = filePath;
      assert.equal(options.parentType, 'bitable_image');
      return 'file_token_doc_1';
    },
  };
  await withServer(appFor({ arrival: fakeArrival(), purchaseQuery: fakeQuery([]), gateway }), async (base) => {
    const res = await fetch(`${base}/api/workbench${arrivalTab.api.acceptanceDoc}`, {
      method: 'POST',
      headers: {
        cookie: COOKIE,
        'Content-Type': 'image/jpeg',
        'x-file-name': encodeURIComponent('验收单 1.jpg'),
      },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.file.file_token, 'file_token_doc_1');
    assert.equal(body.file.file_name, '验收单_1.jpg', '文件名解码并安全化 ✓');
    assert.ok(uploadedPath.includes('acceptance-doc-'), '上传后临时文件已传路径 ✓');
    assert.equal(fs.existsSync(uploadedPath), false, '临时文件已清理 ✓');
  });
});

test('AC-AW-DOC2 ⭐ accept 把验收单 tokens 原样交给后台（后台写「对方单据」）', async () => {
  const scheduled = [];
  const acceptBackground = { schedulePurchaseRest: (input) => { scheduled.push(input); } };
  const docs = [{ fileToken: 'file_token_doc_1', fileName: '验收单 1.jpg' }];
  await withServer(appFor({
    arrival: fakeArrival(), purchaseQuery: fakeQuery(ROWS), acceptBackground,
  }), async (base) => {
    const res = await postJson(base, arrivalTab.api.accept, {
      batchNo: 'BH-1', actualAmount: '300',
      lines: [{ productRecordId: 'p1', size: 40, quantity: 2 }],
      counterpartyDocuments: docs,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(scheduled[0].restInput.counterpartyDocuments, docs,
      '验收单 tokens 进后台 restInput ✓');
    assert.equal(scheduled[0].restInput.batchNo, 'BH-1');
  });
});
