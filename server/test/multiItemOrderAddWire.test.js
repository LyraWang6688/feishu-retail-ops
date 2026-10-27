'use strict';

/**
 * multiItemOrderAddWire.test.js —— 「一单多货 · **加/删货那一半**」的 **HTTP 端到端**判据（task-59）。
 *
 * 她的需求（Lead 转述 · 2026-10-16）：
 *   · **AC-MI-A** ⭐核心：**填了首件的尺码 + 数量 ⇒ 点「＋ 再加一个货品」⇒ 首件的值不丢** ✓
 *     （改前那颗 `<a href="…?add=1">` 是 **GET** ⇒ 天生带不走表单字段 ⇒ **必丢** ✗ 这就是那个 bug）
 *   · **AC-MI-B** 两件一起提交 ⇒ 引擎被调 **1 次** · `groups.length === 2` · **首件数量正确**（不是 0、不是双倍）
 *   · **AC-MI-C** 🔴 **N=1 ⇒ 引擎 0 次 + 老路径实参逐字不变**（#710 的 `AC-MIRW-2` 原样绿 ✓ **不许动它** ✗）
 *   · **AC-MI-D** 🔴 零 JS 哨兵**未动**（本刀**不加 JS** ✓）
 *
 * 这一份跑的是**真引擎**（`services/multiItemOrderService.js`）+ 假写入件 + **真 HTTP**
 *   —— 只钉"路由把什么交给引擎 / 会话里存了什么"，**不写任何业务表**（假写入件只登记调用 ✓）。
 *
 * ⚠️ `scan` 应用的凭证在 require 阶段就要（与既有扫码页用例同一个前置 ✓）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_add_wire';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_add_wire_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_add_wire';
// ⚠️ 扫码页走的是**共享那一道**准入闸门（`requireWorkbenchAccess`）：认证没开 ⇒ **503**（不是 401）✓
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'mi_add_wire_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { multiItemPayloadJson } = require('../src/views/scanPageRenderer');

const SESSION_SECRET = 'mi_add_wire_session_secret';
const OPEN_ID = 'ou_miaw';
const NUMBER = 'K1|黑色|A';
const WIRE = Object.freeze(
  resolveMultiItemOrderConfig({}).wire,
);

const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '测试', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * 那一款的视图模型（**按扫到的编号给** —— 她第二件是**另一款** ✓ 与真机同形）。
 * ⚠️ 单元格必须带 `key: '门盒'`：`sellableCountOf` 只认「门盒 / 样品」那两格 ✓。
 */
const viewOf = (number = NUMBER) => {
  const [itemNo, color] = String(number).split('|');
  return {
    found: true, number, item_no: itemNo, color, category_name: '休闲鞋',
    category_code: 'A', price_text: '¥399', total: 2, columns: [{ key: '门盒', label: '门盒' }],
    rows: ['40', '41'].map((size, index) => ({
      size_text: size, cells: index === 0 ? [{ key: '门盒', count: 2 }] : [], total: index === 0 ? 2 : 0,
      missing: index !== 0,
    })),
    missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 07:0x',
    product_record_id: itemNo === 'K2' ? 'rec_K2' : 'rec_K1',
  };
};

/** 真会话存储（与 `scanSessionService` 同一形状：`get` / `update`，同一个 id 口径 ✓）。 */
const makeWriteService = () => {
  const records = new Map();
  const idOf = (openId) => `scan_session_${String(openId).replace(/[^a-zA-Z0-9]/g, '')}`;
  const store = {
    get: async (id) => (records.has(id) ? clone(records.get(id)) : null),
    update: async (id, patchOrMutator) => {
      const current = records.has(id) ? clone(records.get(id)) : null;
      const patch = typeof patchOrMutator === 'function' ? await patchOrMutator(current) : patchOrMutator;
      const next = { ...(current || {}), ...(patch || {}) };
      records.set(id, next);
      return clone(next);
    },
  };
  const writes = [];
  // ⚠️ 真引擎要 `sessions.ensure`（它按**同一个 store** 建 / 取会话 ✓）—— fixture 里不能少 ✗
  const ensure = async (openId) => {
    const id = idOf(openId);
    if (!records.has(id)) records.set(id, { session_id: id, created_at: new Date().toISOString() });
    return clone(records.get(id));
  };
  return {
    records,
    writes,
    // ⚠️ `submitKeyFor` 是**渲染那一页**要的（`buildWriteContext` 调它）—— fixture 里不能少 ✗
    sessions: {
      idOf, store, get: store.get, ensure, submitKeyFor: () => 'scan_replenish:test:1',
      setLastRealm: async () => {},
    },
    multiItemWriters: () => ({
      // ⚠️ 引擎的写法是 `writer(plan.taskId, plan.payload)`（**两个实参** ✓）——
      //   fixture 必须照它的形状收，不然断言的是 undefined ✗（本刀真踩到过 ✓）
      purchase: async (taskId, payload) => { writes.push({ fn: 'purchase', taskId, payload: clone(payload) }); return { ok: true }; },
      purchaseReturn: async (taskId, payload) => { writes.push({ fn: 'purchaseReturn', taskId, payload: clone(payload) }); return { ok: true }; },
      behavior: async () => ({}),
    }),
  };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const makeApp = ({ writeService, backgroundCalls = [] }) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    // 按 URL 里扫到的那一款给视图（她第二件是**另一款** ✓）
    service: { lookup: async (input) => viewOf(String((input && (input.number || input.recordId)) || '')) },
    gateway: {},
    writeService,
    // 🔴 老路径（N=1）**不许被这次加货打扰** ⇒ 用登记簿钉住"它一次都没被调" ✓
    purchaseBackground: { schedulePurchaseRest: (input) => { backgroundCalls.push(clone(input)); } },
    // ⭐ 加/删货那一半**显式打开**（缺省是关的 ⇒ 页面逐字不变 ✓；这里只验"开了之后对不对" ✓）
    multiItemWire: WIRE,
    render: {
      success: (payload) => `<html>OK</html>`,
      message: (payload) => `<html>ERR ${payload?.title || ''} | ${payload?.body || ''}</html>`,
    },
    startSnapshot: false,
  }));
  return app;
};

const postForm = (base, body, { query = 'from=replenish', number = NUMBER } = {}) => fetch(
  `${base}${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(number)}?${query}`,
  {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // 🔴 挂住 = 红（不是"跑不完的测试" ✗）—— 这一页上任何一路真去打飞书都会当场暴露 ✓
    signal: AbortSignal.timeout(15_000),
  },
);

const getPage = async (base, { query = 'from=replenish', number = NUMBER } = {}) => {
  const response = await fetch(
    `${base}${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(number)}?${query}`,
    { headers: { cookie: sessionCookie() }, signal: AbortSignal.timeout(15_000) },
  );
  assert.equal(response.status, 200, '那一页要能打开 ✓');
  return response.text();
};

/** 页面 hidden 字段里那一份载荷（**只有一份真源** = 渲染器产的 ✓ 不手拼 ✗）。 */
const hiddenItemsOf = (html) => JSON.parse(
  html.match(/name="multi_items" value="([^"]*)"/)[1].replace(/&quot;/g, '"'),
);

const K1 = Object.freeze({
  product_record_id: 'rec_K1', number: NUMBER, item_no: 'K1', color: '黑色',
  supplier_record_id: 'sup_K1', entries: [],
});
const K2 = Object.freeze({
  product_record_id: 'rec_K2', number: 'K2|白色|A', item_no: 'K2', color: '白色',
  supplier_record_id: 'sup_K2', entries: [],
});

/**
 * 「她填好首件 + 点那颗【＋ 再加一个货品】」那一次 POST。
 * ⚠️ 真实流程是**两页**：先扫 K1 填 40 码 2 双再点"加" ⇒ 303 回 K1 页；
 *    再扫 **K2** 那一页（该页 hidden = `[K2, K1]`）填 41 码 3 双再点"加" ✓。
 */
const addBody = ({
  number = NUMBER, first = K1, already = [], sizes = ['40'], quantity = '2', chain = 'replenish',
} = {}) => {
  const params = new URLSearchParams();
  // ⭐ 那颗按钮的 name/value（= 接线给的那份配置 ✓ 不写死）
  params.append(WIRE.addAction, WIRE.addValue);
  const sizesField = chain === 'replenish' ? SCAN_WRITE.fields.replenishSizes : SCAN_WRITE.fields.returnSizes;
  const qtyPrefix = chain === 'replenish'
    ? SCAN_WRITE.fields.replenishQuantityPrefix : SCAN_WRITE.fields.returnQuantityPrefix;
  for (const size of sizes) params.append(sizesField, size);
  params.append(`${qtyPrefix}${sizes[0]}`, quantity);
  // 页面渲出来的 hidden = `[首件, ...已加]`
  params.append('multi_items', multiItemPayloadJson([first, ...already]));
  return params;
};

const submitBody = ({
  items, number = NUMBER, sizes = ['41'], quantity = '3', key = 'scan_replenish:x:1',
} = {}) => {
  const params = new URLSearchParams();
  params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.replenish);
  params.append(SCAN_WRITE.fields.submitKey, key);
  for (const size of sizes) params.append(SCAN_WRITE.fields.replenishSizes, size);
  params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${sizes[0]}`, quantity);
  params.append('multi_items', multiItemPayloadJson(items));
  return params;
};

const pendingOf = async (writeService, chain = 'replenish') => {
  const session = await writeService.sessions.store.get(writeService.sessions.idOf(OPEN_ID));
  const ordersField = resolveMultiItemOrderConfig({}).session.ordersField;
  return ((session || {})[ordersField] || {})[`${chain}:pending`] || null;
};

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐⭐ AC-MI-A —— 填了首件的尺码+数量 ⇒ 点「再加一个货品」⇒ **首件的值不丢**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-A ⭐⭐⭐ 点「＋ 再加一个货品」⇒ **她填的尺码/数量进了草稿**（改前 GET 链接 ⇒ 丢 ✗）', async () => {
  const writeService = makeWriteService();
  const backgroundCalls = [];
  await withServer(makeApp({ writeService, backgroundCalls }), async (base) => {
    const posted = await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    assert.equal(posted.status, 303, '加货 ⇒ **303 PRG**（刷新不重复加 ✓）');
    const pending = await pendingOf(writeService);
    assert.ok(pending, '🔴 草稿里必须存下这一件（不然她填的值就丢了 ✗）');
    assert.equal(pending.items.length, 1, '一次加 = 一件 ✓');
    assert.deepEqual(pending.items[0].entries, [{ size: '40', quantity: '2' }],
      '🔴 **首件的尺码 + 数量原样进了草稿**（这就是 AC-MI-A 的"值不丢" ✓ 丢了 ⇒ 红）');
    assert.equal(pending.items[0].product_record_id, 'rec_K1', '货品也带上 ✓');
    // 🔴 这一半**一个字都不落业务表**、也**不排后台**（它只是"把这一件先记下来" ✓）
    assert.equal(backgroundCalls.length, 0, '加货**不许**触发老路径的后台写入 ✗');
  });
});

test('AC-MI-A2 ⭐⭐ 303 回本页之后：**已加那件**回到页面上（列表 + hidden 字段都带着它）', async () => {
  const writeService = makeWriteService();
  await withServer(makeApp({ writeService }), async (base) => {
    await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    // ⭐ 她**再扫 K2** 那一页（已加的 K1 会跟着 hidden 字段过来 ✓ —— 与真机同一条路）
    const html = await getPage(base, { number: 'K2|白色|A' });
    // ① 列表里看得见（`data-view="multi-item-list"` + 那一件的编号 ✓）
    assert.match(html, /data-view="multi-item-list"/, '已加货品列表要出现（她看得见自己加了什么 ✓）');
    assert.match(html, /K1\|黑色\|A/, '那一行是已加的那件（K1 ✓）');
    // ② 每行那颗删除按钮（接线字段 + 该件 id ✓）
    assert.match(html, new RegExp(`data-multi-remove name="${WIRE.removeField}" value="rec_K1"`),
      '🔴 每行一颗删除按钮（`value` = 该件 record_id ✓）');
    // ③ hidden 字段 = `[首件(当前这页 = K2), ...已加(K1)]`
    const payload = hiddenItemsOf(html);
    assert.equal(payload.length, 2, '🔴 `[首件, ...已加]` = 2 件（只渲首件 ⇒ 她点一下"加"就丢已加的 ✗）');
    assert.equal(payload[0].product_record_id, 'rec_K2', '首件 = 当前这一页扫到的 K2 ✓');
    assert.deepEqual(payload[0].entries, [], '首件的 entries 仍空（本次表单的由路由在提交时合并 ✓）');
    // ⚠️ 这里经过 `multiItemPayloadJson`（`quantity: Number(...)` ✓）⇒ 读回来是**数字** ✓
    assert.deepEqual(payload[1].entries, [{ size: '40', quantity: 2 }],
      '🔴 已加那件**带着自己的 entries** ✓');
  });
});

test('AC-MI-A3 ⭐⭐ 再加第二件 ⇒ 两件都在草稿里；**删除**一颗 ⇒ 只摘掉那一件 ✓', async () => {
  const writeService = makeWriteService();
  await withServer(makeApp({ writeService }), async (base) => {
    await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    // 她**再扫 K2** 那一页（hidden = [K2(首件), K1(已加, 40 码 2 双)]）⇒ 点"加"（K2 填 41 码 1 双）
    await postForm(base, addBody({
      number: 'K2|白色|A', first: K2,
      already: [{ ...K1, entries: [{ size: '40', quantity: '2' }] }],
      sizes: ['41'], quantity: '1',
    }));
    const pending = await pendingOf(writeService);
    assert.equal(pending.items.length, 2, '两件都在 ✓');
    assert.deepEqual(pending.items.map((item) => item.product_record_id).sort(), ['rec_K1', 'rec_K2']);
    // ⚠️ 顺序 = 先加的在前面（K1 先加、K2 后加 ✓）
    assert.deepEqual(pending.items[1].entries, [{ size: '41', quantity: '1' }],
      '第二件（K2）带着**她自己**的 41 码 1 双 ✓');
    assert.deepEqual(pending.items[0].entries, [{ size: '40', quantity: '2' }],
      '第一件（K1）**先前那份 entries 原样还在** ✓（被后一次加货冲掉 ⇒ 红 ✗）');
    // 删掉第一件（列表行那颗 submit）
    const remove = new URLSearchParams();
    remove.append(WIRE.removeField, 'rec_K1');
    const removed = await postForm(base, remove);
    assert.equal(removed.status, 303, '删除也是 303 PRG ✓');
    const after = await pendingOf(writeService);
    assert.deepEqual(after.items.map((item) => item.product_record_id), ['rec_K2'],
      '🔴 只摘掉点名那一件（删错 / 全删 ⇒ 红）');
  });
});

test('AC-MI-A4 🔴 加货时她填错了 ⇒ **400 + 人话 + 零写入**（不静默存进去 ✗）', async () => {
  const writeService = makeWriteService();
  await withServer(makeApp({ writeService }), async (base) => {
    const posted = await postForm(base, addBody({ sizes: ['40'], quantity: '0' }));
    assert.equal(posted.status, 400, '数量 0 ⇒ 当场拦（与提交那条路同一份校验 ✓）');
    const pending = await pendingOf(writeService);
    assert.equal(pending, null, '🔴 被拦的那次**一个字都没存** ✓（不能"看起来加了、其实是个坏行" ✗）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-MI-B —— 两件一起提交 ⇒ 引擎 1 次 · groups = 2 · 首件数量正确
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-B ⭐⭐ 两件一起提交 ⇒ 引擎 **1 次** · `groups.length === 2` · **首件数量正确**', async () => {
  const writeService = makeWriteService();
  await withServer(makeApp({ writeService }), async (base) => {
    // ① 先扫 K2 填 41 码 1 双、点"加"（⇒ 草稿里记下 K2）
    await postForm(base, addBody({ number: 'K2|白色|A', first: K2, sizes: ['41'], quantity: '1' }));
    // ② 她**再扫 K1**（hidden = `[K1(首件, entries 空), K2(已加)]`）
    const html = await getPage(base);
    const payload = hiddenItemsOf(html);
    assert.equal(payload.length, 2, '页面 hidden 里就是两件 ✓');
    assert.deepEqual(payload[0].entries, [], '首件的 entries 还是空 ✓');
    assert.deepEqual(payload[1].entries, [{ size: '41', quantity: 1 }], 'K2 带着自己那份 ✓');
    // ③ 提交：她当前这页（K1）填 41 码 3 双 ⇒ 首件 entries 由路由合并进来 ✓
    const posted = await postForm(base, submitBody({ items: payload, sizes: ['41'], quantity: '3' }));
    assert.equal(posted.status, 200, `提交要成功（实得 ${posted.status}：${(await posted.text()).slice(0, 200)}）`);
    // ③ **假写入件被调 1 次**（一批明细 = 一次落库 ✓ 不是两次 ✗）
    const purchases = writeService.writes.filter((write) => write.fn === 'purchase');
    assert.equal(purchases.length, 1, `🔴 引擎那条路**只落一次**（实得 ${purchases.length} 次）`);
    const payloadWritten = purchases[0].payload;
    // ④ **`groups.length === 2` 的落库侧证据**：载荷明细里**两件都在**（`items` = 扁平行 ✓ 引擎形状）
    const lineItems = Array.isArray(payloadWritten.items) ? payloadWritten.items : [];
    const linesOf = (id) => lineItems
      .filter((line) => String(line.product_record_id || '') === id)
      // ⚠️ 落库那一份是**刮过表的那一行**（`size` 可能是数字 / `quantity` 是数字 ✓）⇒ 归一化再比 ✓
      .map((line) => ({ size: String(line.size), quantity: Number(line.quantity) }));
    // ⚠️ 引擎落库那一份把 `quantity` 归一成**数字**（`size` 仍是字符串 ✓）—— 与 `planSubmission` 同形 ✓
    assert.deepEqual(linesOf('rec_K1'), [{ size: '41', quantity: 3 }],
      '🔴 **首件数量正确** = 她刚填的 41 码 3 双（0 / 双倍 / 旧值 ⇒ 红 ✗）');
    assert.deepEqual(linesOf('rec_K2'), [{ size: '41', quantity: 1 }],
      '第二件 = 她先前填的 41 码 1 双 ✓（两件都在 ⇒ `groups.length === 2` ✓）');
    assert.equal(new Set(lineItems.map((line) => line.product_record_id)).size, 2,
      '🔴 落库的行覆盖**两个货品**（只剩一件 ⇒ 引擎没拿到 2 组 ⇒ 红 ✓）');
    // ⑤ 一单一把批次：`taskId` 只有一把（两件**不是两个批次** ✓）
    assert.equal(String(purchases[0].taskId || '').length > 0, true, '批次 id 有值 ✓');
  });
});

test('AC-MI-B2 ⭐ 提交成功之后 ⇒ **暂存清掉**（下一单看不见上一单加的那些 ✓）', async () => {
  const writeService = makeWriteService();
  await withServer(makeApp({ writeService }), async (base) => {
    await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    const html = await getPage(base, { number: 'K2|白色|A' });
    await postForm(base, submitBody({ items: hiddenItemsOf(html) }));
    assert.equal(await pendingOf(writeService), null, '🔴 交出去之后暂存必须清空（不清 ⇒ 下一单凭空多货 ✗）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 AC-MI-C —— N=1：引擎 0 次 · 老路径**原样**（#710 的 AC-MIRW-2 原样绿 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-C ⭐⭐ N=1（没加过任何货品）⇒ 老路径原样被调 · 加货那条路 0 次', async () => {
  const writeService = makeWriteService();
  const backgroundCalls = [];
  await withServer(makeApp({ writeService, backgroundCalls }), async (base) => {
    const posted = await postForm(base, submitBody({ items: [K1], sizes: ['41'], quantity: '3' }));
    assert.equal(posted.status, 200, 'N=1 照旧成功 ✓');
    assert.equal(backgroundCalls.length, 1, '🔴 老路径**原样被调一次** ✓');
    assert.equal(backgroundCalls[0].restInput.productRecordId, 'rec_K1', '实参里的货品原样 ✓');
    assert.deepEqual(backgroundCalls[0].restInput.entries, [{ size: '41', quantity: '3' }],
      '实参里的明细原样（她填的那一行 ✓）');
    assert.equal(writeService.writes.length, 0, '🔴 引擎那条路**一次都没落库**（N=1 不进引擎 ✓）');
    assert.equal(await pendingOf(writeService), null, 'N=1 那条路**不碰**加货暂存 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 开关**显式关** ⇒ 页面逐字不变（零回归 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-E 🔴 开关**显式关**（`SCAN_MULTI_ITEM_ADD_WIRE=false`）⇒ 那颗入口仍是**链接**、没有删除按钮', async () => {
  const writeService = makeWriteService();
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // ⭐⭐ 2026-10-16 下半场 **成对迁移**（**改指向、不放宽** ✓）：
  //   改前逐字：本用例**不配**这个开关，靠"缺省 = `false`"成立（那时 `config/multiItemOrder.js`
  //     的 `addWireEnabled` 缺省就是 `false` ✓）。
  //   改后逐字：**显式配成 `false`**（下面那一行 ＋ `finally` 里删掉）—— 缺省已在**同一刀**里翻成
  //     `true`（Lead 裁决"手术刀 ①"：**关着 = 她那个 bug 还活着** ✗ ⇒ 放出来 ✓）。
  //   ⇒ 本条钉的"**关掉之后页面仍与今天逐字一致**"这条保证**一个字都没丢** ✓，
  //     只是不再靠"缺省"、而是靠**显式关**来钉（`readFlag` ⇒ 空串 / `false` **关得掉** ✓）。
  //   ⚠️ **三条断言一个字未改** ✓（入口仍是链接 / 没有删除按钮 ✓）。
  process.env.SCAN_MULTI_ITEM_ADD_WIRE = 'false';
  try {
    app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
      // 按 URL 里扫到的那一款给视图（她第二件是**另一款** ✓）
      service: { lookup: async (input) => viewOf(String((input && (input.number || input.recordId)) || '')) }, gateway: {}, writeService,
      // ⚠️ **不注入** wire ⇒ 走配置那一位（本用例把它**显式配成关** ✓）
      purchaseBackground: { schedulePurchaseRest: () => {} },
      render: { success: () => '<html>OK</html>', message: () => '<html>ERR</html>' },
      startSnapshot: false,
    }));
    await withServer(app, async (base) => {
      const html = await getPage(base);
      assert.match(html, /data-multi-add[^>]*href="/,
        '⭐ 显式关 ⇒ 仍是那颗 `<a href="?add=1">`（"关态"的页面逐字不变 ✓）');
      assert.equal(html.includes('data-multi-remove'), false, '关 ⇒ 没有删除按钮 ✓');
    });
  } finally {
    delete process.env.SCAN_MULTI_ITEM_ADD_WIRE;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 AC-MI-F ⭐ **生产那个开关真的能把它打开**（`SCAN_MULTI_ITEM_ADD_WIRE=true` ⇒ 路由半接线 ✓）
//   ——上面几条都是**注入**接线位（`options.multiItemWire`）；这一条走的是**线上那条路**：
//     环境变量 ⇒ `resolveMultiItemOrderConfig()` ⇒ `addWireEnabled` ⇒ 工厂自己把那一位交给路由与渲染 ✓。
//   ⭐ 2026-10-16 下半场：`addWireEnabled` **缺省已翻成 `true`**（Lead 裁决"手术刀 ①"）⇒
//     本条的"显式 `true`"与**缺省**是同一个结果（"缺省 = 开"由
//     `multiItemCurrentItemDupHttp.test.js` 的 **AC-MID-1/2** 用真 HTTP 单独钉着 ✓）；
//     **"显式关 ⇒ 回到那颗链接"**由上面 **AC-MI-E** 钉着 ✓（两条合起来 = 这个开关**两个方向都关得住 / 打得开** ✓）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F 🔴 `SCAN_MULTI_ITEM_ADD_WIRE=true` ⇒ 页面出按钮、POST 真的被接住（线上那条路 ✓）', async () => {
  const { createScanPageRouter: createRouterWithEnvWire } = require('../src/routes/scanPage');
  const writeService = makeWriteService();
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  process.env.SCAN_MULTI_ITEM_ADD_WIRE = 'true';
  try {
    app.use(SCAN_PAGE.route.recordBasePath, createRouterWithEnvWire({
      service: {
        lookup: async (input) => viewOf(String((input && (input.number || input.recordId)) || '')),
      },
      gateway: {}, writeService,
      purchaseBackground: { schedulePurchaseRest: () => {} },
      // ⚠️ **不注入** `multiItemWire` ⇒ 走环境变量那一条（= 线上）✓
      render: { success: () => '<html>OK</html>', message: (p) => `<html>ERR ${p?.body || ''}</html>` },
      startSnapshot: false,
    }));
    await withServer(app, async (base) => {
      const html = await getPage(base);
      assert.match(html, /<button type="submit"[^>]*data-multi-add/,
        '🔴 环境变量打开 ⇒ 页面上那颗入口必须是**按钮**（还是链接 ⇒ 这条路没接上 ✗）');
      assert.equal(/data-multi-add[^>]*href="/.test(html), false, '开了就不该再是链接 ✓');
      const posted = await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
      assert.equal(posted.status, 303, '🔴 POST 真的被接住（没接住 ⇒ 400 / 直接提交走 ✗）');
      const pending = await pendingOf(writeService);
      assert.deepEqual(pending?.items?.[0]?.entries, [{ size: '40', quantity: '2' }],
        '她填的值进了草稿 ✓（与注入那几条同一条实现 ✓）');
    });
  } finally {
    delete process.env.SCAN_MULTI_ITEM_ADD_WIRE;
  }
});
