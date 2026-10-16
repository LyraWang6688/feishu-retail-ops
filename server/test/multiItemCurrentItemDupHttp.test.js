'use strict';

/**
 * multiItemCurrentItemDupHttp.test.js —— **把「＋ 再加一个货品」那颗入口放出来**的判据
 *   （task-59 收尾 · **Lead 裁决"手术刀 ①"** · 2026-10-16 下半场）。
 *
 * ## 为什么还要这一份（`#727` 已经覆盖了哪一半）
 *
 * `#727`（**已进 main**）修掉了那条**静默丢值**：`views/scanPageRenderer.js` 的
 * `payload = [首件, ...others]`（`others` = 已加件里**排掉当前这一件**），
 * 判据在 `test/multiItemCurrentItemDup.test.js`（**真渲染器 → 真路由纯函数 → 真引擎**）✓。
 * ⚠️ 那一份**一个字都不动**（本文件是**新增**、不是替换 ✗）。
 *
 * 但 `origin/main` 上那颗开关还是**关着**：
 * `config/multiItemOrder.js` 的 `addWireEnabled` 缺省 `false` ⇒ 渲染层拿到的是 `null` ⇒
 * 线上那颗入口**仍是 `<a href="?add=1">`（GET）** —— **天生带不走**她刚填的尺码/数量 ✗
 * ⇒ "填了值、点一下、值没了"**在 main 上仍然发生** ✗（`#721` 留下的那颗链接就是它）。
 *
 * 本文件钉的就是"**放出来之后**"那件事（**真 HTTP ＋ 真引擎 ＋ 缺省开关**）：
 *   · **AC-MID-1** 缺省（**没人配那个开关**）⇒ 补货 / 退货两块那颗入口**都是同表单的 submit 按钮**、
 *     且那个 POST **真的被路由 303 接住**（还是链接 / POST 没人接 ⇒ 红 ✗）
 *   · **AC-MID-2** ⭐⭐ **她这一趟走完，落进去的就是她填的**：扫 K1 → 填 40 码 × 2 → 点「加货」
 *     → 回到本页 → 填 **41 码 × 1** → 提交 ⇒ **写进去的是 41×1**（不是草稿里那份旧的 40×2 ✗）
 *   · **AC-MID-3** ⭐⭐ **探针**：**同一套 HTTP 流程**、只把提交那份载荷换成**改前逐字**那一份
 *     （`[首件, ...草稿全部]`）⇒ 写进去的是**旧值 40×2** ⇒ 证明 AC-MID-2 **真能红** ✓
 *
 * ⚠️ 全部**只读**：不联网、不写任何 Base、不碰 `services/**`（引擎只被**调用** ✓）。
 * ⚠️ 本文件**刻意不配** `SCAN_MULTI_ITEM_ADD_WIRE`（`delete` 掉）⇒ 走的是**缺省**（= 线上形状 ✓）；
 *   "**显式关 ⇒ 逐字回到那颗链接**"由 `test/multiItemOrderAddWire.test.js` 的 **AC-MI-E** 钉着 ✓。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_mid';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_mid_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_mid';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'mi_mid_session_secret';
// 🔴 **缺省 = 线上形状**：不配这个开关 ⇒ 走 `config/multiItemOrder.js` 那个**显式布尔**的缺省值
delete process.env.SCAN_MULTI_ITEM_ADD_WIRE;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const { createScanPageRouter } = require('../src/routes/scanPage');
const renderer = require('../src/views/scanPageRenderer');

const SESSION_SECRET = 'mi_mid_session_secret';
const OPEN_ID = 'ou_mimid';
const NUMBER = 'K1|黑色|A';
const FIELD = MULTI_ITEM_ORDER.field;
const WIRE = MULTI_ITEM_ORDER.wire;

const clone = (value) => JSON.parse(JSON.stringify(value));

const sessionCookie = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: OPEN_ID, name: '测试', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

/**
 * 那一款的视图模型（**按扫到的编号给**）。
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
    product_record_id: 'rec_K1',
  };
};

/** 当前这一件（她这一页扫到的）＝ 草稿里那份**旧的**（40 码 × 2 —— 她先前点过一次「加货」） */
const VIEW_A = Object.freeze({
  product_record_id: 'rec_K1', number: NUMBER, item_no: 'K1', color: '黑色', supplier_record_id: 'sup_K1',
});
const firstOf = (view) => ({
  product_record_id: view.product_record_id, number: view.number, item_no: view.item_no,
  color: view.color, supplier_record_id: view.supplier_record_id, entries: [],
});

/**
 * ⭐⭐ **改前逐字**那一份载荷（= `#721` 的 `const payload = wired ? [first, ...already] : [first];`，
 *   而 `view.multi_items` 当时还是**草稿全部 items** ⇒ 当前这件在载荷里**两次**）——
 *   **AC-MID-3** 那个探针用的就是它 ✓。
 *   ⚠️ 走的是**渲染半同一个序列化器**（`multiItemPayloadJson`）⇒ 形状逐字同源 ✓ 不手拼 ✗。
 */
const preFixPayload = () => JSON.parse(
  renderer.multiItemPayloadJson([firstOf(VIEW_A), { ...VIEW_A, entries: [{ size: '40', quantity: 2 }] }]),
);

/** 页面上那个 hidden 载荷（**真渲染器的产物** ✓）。 */
const payloadOf = (html) => {
  const match = html.match(new RegExp(`name="${FIELD}" value="([^"]*)"`));
  assert.ok(match, `页面上必须有 hidden \`${FIELD}\` ✓`);
  return JSON.parse(match[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
};

// ── 真路由（express 监听 0 端口；假写入件只登记调用 ✓ 一个字节都不落业务表）────────────────

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
  const ensure = async (openId) => {
    const id = idOf(openId);
    if (!records.has(id)) records.set(id, { session_id: id, created_at: new Date().toISOString() });
    return clone(records.get(id));
  };
  return {
    records,
    writes,
    sessions: {
      idOf, store, get: store.get, ensure, submitKeyFor: () => 'scan_replenish:test:1',
      setLastRealm: async () => {},
    },
    multiItemWriters: () => ({
      // ⚠️ 引擎的写法是 `writer(plan.taskId, plan.payload)`（**两个实参** ✓）
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
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async (input) => viewOf(String((input && (input.number || input.recordId)) || '')) },
    gateway: {},
    writeService,
    // 🔴 N=1 那条老路径**不许被这一刀打扰** ⇒ 用登记簿钉住"它收到的是她填的那一份" ✓
    purchaseBackground: { schedulePurchaseRest: (input) => { backgroundCalls.push(clone(input)); } },
    // ⭐ **刻意不注入** `multiItemWire` ⇒ 走配置那一位（**缺省 = 已放出**，= 线上那条路 ✓）
    render: {
      success: () => '<html>OK</html>',
      message: (payload) => `<html>ERR ${payload?.title || ''} | ${payload?.body || ''}</html>`,
    },
    startSnapshot: false,
  }));
  return app;
};

const getPage = async (base, { from = 'replenish', number = NUMBER } = {}) => {
  const response = await fetch(
    `${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(number)}?from=${from}`,
    { headers: { cookie: sessionCookie() }, signal: AbortSignal.timeout(15_000) },
  );
  assert.equal(response.status, 200, `?from=${from} 那一页要能打开 ✓`);
  return response.text();
};

const postForm = (base, body, { from = 'replenish', number = NUMBER } = {}) => fetch(
  `${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(number)}?from=${from}`,
  {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // 🔴 挂住 = 红（这一页上任何一路真去打飞书都会当场暴露 ✓）
    signal: AbortSignal.timeout(15_000),
  },
);

/** 「她填好这一件的尺码/数量 + 点那颗【＋ 再加一个货品】」那一次 POST。 */
const addBody = ({ sizes = ['40'], quantity = '2' } = {}) => {
  const params = new URLSearchParams();
  params.append(WIRE.addAction, WIRE.addValue);
  for (const size of sizes) params.append(SCAN_WRITE.fields.replenishSizes, size);
  params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${sizes[0]}`, quantity);
  params.append(FIELD, renderer.multiItemPayloadJson([firstOf(VIEW_A)]));
  return params;
};

/** 提交那一次 POST：`items` = 页面上那份 hidden 载荷（浏览器就是这么送的 ✓）。 */
const submitBody = ({ items, sizes = ['41'], quantity = '1' } = {}) => {
  const params = new URLSearchParams();
  params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.replenish);
  params.append(SCAN_WRITE.fields.submitKey, 'scan_replenish:mid:1');
  for (const size of sizes) params.append(SCAN_WRITE.fields.replenishSizes, size);
  params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${sizes[0]}`, quantity);
  params.append(FIELD, renderer.multiItemPayloadJson(items));
  return params;
};

/** 草稿里"已加的货品"那一段（加货那一半写的就是它 ✓）。 */
const pendingOf = async (writeService) => {
  const session = await writeService.sessions.store.get(writeService.sessions.idOf(OPEN_ID));
  const ordersField = MULTI_ITEM_ORDER.session.ordersField;
  return ((session || {})[ordersField] || {})['replenish:pending'] || null;
};

/** 落库明细里 `rec_K1` 那几行（引擎那条路）—— 归一化成 `{size, quantity}` ✓。 */
const landedLinesOf = (writeService) => writeService.writes
  .filter((write) => write.fn === 'purchase')
  .flatMap((write) => (Array.isArray(write.payload?.items) ? write.payload.items : []))
  .filter((line) => String(line.product_record_id) === 'rec_K1')
  .map((line) => ({ size: String(line.size), quantity: Number(line.quantity) }));

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ AC-MID-1 —— 缺省（= 线上形状）⇒ 那颗入口**放出来了**，而且 POST 真的被接住
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MID-1 ⭐ `SCAN_MULTI_ITEM_ADD_WIRE` **缺省**（没人配）⇒ 补货 / 退货那两块那颗入口都是**按钮**、POST 被 303 接住', async () => {
  const writeService = makeWriteService();
  const backgroundCalls = [];
  await withServer(makeApp({ writeService, backgroundCalls }), async (base) => {
    for (const from of ['replenish', 'purchase_return']) {
      const html = await getPage(base, { from });
      assert.match(html, /<button type="submit"[^>]*data-multi-add/,
        `🔴 ?from=${from}：缺省（没人配那个开关）⇒ 那颗入口必须是**同表单的 submit 按钮**`
        + '（`addWireEnabled` 的缺省值被翻回去 ⇒ 又变回 `?add=1` 链接 ⇒ 红 ✓）');
      assert.equal(/data-multi-add[^>]*href="/.test(html), false,
        `🔴 ?from=${from}：缺省已是按钮 ⇒ 不该再是链接（GET **天生带不走**她填的尺码/数量 ✗）`);
    }
    // ⭐ 那个 POST **真的被路由接住**（没人接 ⇒ 她点一下会把这一单直接提交走 ✗✗ ⇒ 也必须红 ✓）
    const added = await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    assert.equal(added.status, 303, '加货 ⇒ **303 PRG**（刷新不重复加 ✓ ⇒ 接住者真的在 ✓）');
    assert.deepEqual((await pendingOf(writeService))?.items?.[0]?.entries, [{ size: '40', quantity: '2' }],
      '⭐ 她填的 40×2 原样进了草稿 ✓（POST 被认成"加货"、没被当成销售提交 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-MID-2 —— **真 HTTP ＋ 真引擎 ＋ 缺省开关**：她这一趟走完，落进去的就是她填的
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MID-2 ⭐⭐ 【真 HTTP · 缺省开关】她填 41×1 ⇒ 提交后**落进去的就是她填的 41×1**', async () => {
  const writeService = makeWriteService();
  const backgroundCalls = [];
  await withServer(makeApp({ writeService, backgroundCalls }), async (base) => {
    // ① 她扫 K1、填 40 码 × 2、点「＋ 再加一个货品」⇒ 草稿里先有这一件（**bug 的前提** ✓）
    const added = await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    assert.equal(added.status, 303, '加货 ⇒ 303 PRG ✓');
    assert.deepEqual((await pendingOf(writeService))?.items?.[0]?.entries, [{ size: '40', quantity: '2' }],
      '⭐ 点"加货"这一刻，她填的 40×2 原样进了草稿 ✓');
    // ② 她回到 K1 那一页（再扫 / 刷新）—— 页面上那份 hidden 载荷 = 浏览器提交时会送的那一份 ✓
    const html = await getPage(base);
    const payload = payloadOf(html);
    // ③ 她这次填 **41 码 × 1** 并提交
    const posted = await postForm(base, submitBody({ items: payload, sizes: ['41'], quantity: '1' }));
    assert.equal(posted.status, 200, `提交要成功（实得 ${posted.status}：${(await posted.text()).slice(0, 200)}）`);
    // ④ 🔴 **落进去的那一份必须是她填的 41×1** —— 这一条**先断**（走哪条路都在这里读得到 ✓）：
    //    老路径（她本来那一单）= `restInput.entries`；引擎那条路 = 落库明细里 `rec_K1` 那几行。
    //    ⚠️ 两边的形状各是各的（老路径是字符串数量 ✓ 引擎归一成数字 ✓）⇒ 各自归一化后比 ✓。
    const landed = backgroundCalls.length === 1
      ? backgroundCalls[0].restInput.entries
      : landedLinesOf(writeService);
    assert.deepEqual(landed, [{ size: '41', quantity: '1' }],
      '🔴 **写进去的就是她填的 41 码 × 1**（旧的 40×2 赢了 ⇒ 红 ✗ —— 那就是"填了值、点一下、值没了"）');
    // ⑤ 走的是**她本来那一单**（N=1 老路径）—— 不许被当前这件在载荷里出现两次而平白撑成"多货品" ✗
    assert.equal(writeService.writes.length, 0,
      '修好之后这一页只有一件 ⇒ 走 N=1 老路径（引擎**一次都不该**被平白拉进来 ✓）');
    assert.equal(backgroundCalls.length, 1, '老路径被调一次 ✓');
    assert.equal(backgroundCalls[0].restInput.productRecordId, 'rec_K1', '还是她扫的那一件 ✓');
    // ⑥ 页面上这份载荷里当前这件**只有一份**（两份 ⇒ ④ 那条就被草稿旧值覆盖 ✗✗）
    assert.equal(payload.filter((item) => item.product_record_id === 'rec_K1').length, 1,
      '🔴 载荷里当前这件**只有一份**（`#727` 那一刀的保证 ✓ 去掉它 ⇒ 这里会数到 2 ⇒ 红 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-MID-3 —— 探针：同一套 HTTP 流程、只换**改前逐字**那份载荷 ⇒ 旧值赢（AC-MID-2 真能红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MID-3 ⭐⭐ 探针：同一套 HTTP 流程、只把载荷换成**改前逐字**那一份 ⇒ 落进去的是旧值 40×2', async () => {
  const writeService = makeWriteService();
  const backgroundCalls = [];
  await withServer(makeApp({ writeService, backgroundCalls }), async (base) => {
    const added = await postForm(base, addBody({ sizes: ['40'], quantity: '2' }));
    assert.equal(added.status, 303, '加货照旧 303 ✓（探针只换**提交**那一份载荷 ✓）');
    const broken = preFixPayload();
    assert.equal(broken.filter((item) => item.product_record_id === 'rec_K1').length, 2,
      '探针：这就是**改前逐字**渲染器真实渲出来的那一份（同一件两次 ✓）');
    const posted = await postForm(base, submitBody({ items: broken, sizes: ['41'], quantity: '1' }));
    assert.equal(posted.status, 200, '探针那一单也要能交出去（不然测的不是同一个形状 ✗）');
    assert.equal(backgroundCalls.length, 0, '探针：两件 ⇒ 走引擎那条路（老路径 0 次 ✓）');
    assert.deepEqual(landedLinesOf(writeService), [{ size: '40', quantity: 2 }],
      '🔴 探针：落进去的是**草稿旧值 40 码 × 2** ⇒ 她这次填的 41×1 **静默没了** ✗✗'
      + '（所以 AC-MID-2 的 ④ 钉的正是 `#727` 那一行 ✓）');
    assert.equal(JSON.stringify(landedLinesOf(writeService)).includes('41'), false,
      '探针：她填的 41 一个字节都没进去 ✓（读得出来）');
  });
});
