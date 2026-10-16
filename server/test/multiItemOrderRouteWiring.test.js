require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * task-59「一单多货品 · **路由半**」的**反向哨兵 + 运行时判据**（本文件只加，不改既有 13 条 ✗）。
 *
 * 既有 13 条在 `test/multiItemOrderRoute.test.js`（RT1..RT8，其中 4 条是 `[待激活]` 分阶段闸门）——
 * 本文件**不重复**它们，只补它们**钉不到**的那两件（route 锚点文档 §4 明写要"逐条验红"的）：
 *   · **AC-MIRW-1..3**：`≤1` 组 ⇒ **老函数原样被调、引擎 0 次**（N=1 逐字等价 —— 运行时，不是读源码猜 ✓）；
 *   · **AC-MIRW-4**：**首件 + 本次表单的尺码/数量**真的合并进引擎那件（**只合并一次 ⇒ 不翻倍** ✓）。
 *
 * 🔴 三条都是**反向哨兵**（去掉实现那一句 ⇒ 这里红）：
 *   · 去掉 `mergeFirstItemEntries(…)` ⇒ **AC-MIRW-1** 红（引擎收到的首件 `entries: []`）；
 *   · 把分流写成 `groups.length >= 1` ⇒ **AC-MIRW-2** 红（N=1 走了引擎、老函数 0 次）；
 *   · 把合并改成 `concat`（重复合并）⇒ **AC-MIRW-3** 红（数量翻倍）。
 *
 * 形状依据：`docs/multi-item-route-anchors-2026-10-16.md`（§2/§3）+ 设计 §4.3。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService` 那条链在 require 阶段就要凭证（与既有扫码页用例同一个前置 ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_route_wiring';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_route_wiring_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_route_wiring';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const {
  createScanPageRouter, parseMultiItemGroups, mergeFirstItemEntries,
} = require('../src/routes/scanPage');
const { multiItemPayloadJson } = require('../src/views/scanPageRenderer');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-3 ⭐⭐ **只合并一次**：赋值语义 ⇒ 重复合并**不会翻倍**（纯函数，能真红 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-3 ⭐⭐ 首件合并是**赋值**语义 ⇒ 重复合并不翻倍（改成 `concat` ⇒ 红）', () => {
  const groups = [
    { product_record_id: 'rec_K1', number: 'K1|黑色|A', item_no: 'K1', entries: [] },
    { product_record_id: 'rec_K2', number: 'K2|白色|A', item_no: 'K2', entries: [] },
  ];
  const entries = [{ size: '40', quantity: '2' }, { size: '41', quantity: '1' }];

  const once = mergeFirstItemEntries(groups, entries);
  assert.deepEqual(once[0].entries, entries, '🔴 首件的 `entries` = **本次表单**那一份（渲染半留空 ⇒ 路由必须填 ✓）');
  assert.deepEqual(once[1], groups[1], '其余分组**原样透传**（本函数不碰它们 ✗）');

  // ⭐ 重复合并（例：一次提交里走了两遍）⇒ **一字不变**（赋值语义 ✓）
  const twice = mergeFirstItemEntries(once, entries);
  assert.deepEqual(twice, once, '🔴 重复合并 ⇒ **必须一模一样**（`concat` 语义 ⇒ 这里红 ✓）');
  assert.equal(twice[0].entries.length, entries.length, '🔴 数量**没有翻倍** ✓（翻倍 = 那一单凭空多补/多退 ✗）');

  // 探针：这条判据**真能分辨**"翻倍"（不是空跑 ✓）
  const appended = [...groups[0].entries, ...entries];
  assert.equal(appended.length, entries.length, '空首件 + concat ⇒ 其实也不翻倍（首件本来就是空）');
  const appendedTwice = [...appended, ...entries];
  assert.equal(appendedTwice.length, entries.length * 2, '探针：`concat` 走两遍 ⇒ **长度翻倍** ✓ 看得出来');
  assert.notDeepEqual(twice[0].entries, appendedTwice, '探针：我们这条 ≠ 翻倍那条 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 共用夹具：假引擎 / 假写服务 / 假后台 + 一个**真的** HTTP 服务器
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'mi_route_wiring_session_secret';
const OPEN_ID = 'ou_mirw';
const NUMBER = 'K1|黑色|A';

const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'K1',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 05:00',
  product_record_id: 'rec_K1',
});

/** 假写服务：**只**提供路由这一路要用的那几个口（会话 / 写入件 / 领域记忆）✓ */
const makeWriteService = ({ withWriters = true } = {}) => {
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
  const write = {
    records,
    idOf,
    sessions: { idOf, store, get: store.get, setLastRealm: async () => {} },
  };
  if (withWriters) {
    write.multiItemWriters = () => ({
      purchase: async () => {}, purchaseReturn: async () => {}, behavior: async () => ({}),
    });
  }
  return write;
};

/**
 * 假引擎（**只为钉"路由交给它什么"** ✓）—— 形状与真引擎的公开 API 同形。
 * ⚠️ 它自己**不写业务表**（真落库 / 幂等 / 轮换的判据在 `multiItemOrderStep1/Entry` 里 ✓）。
 */
const makeEngine = ({ ok = true, code = 'duplicate_line', message = '同一个货号的同一个尺码只能出现一次（K1 / 40 码重复了）。', sessions = null } = {}) => {
  const calls = [];
  const drafts = new Map();
  return {
    calls,
    drafts,
    async openDraft({ openId, chain, requestId }) {
      const orderKey = `${chain}:${openId}:1`;
      calls.push({ fn: 'openDraft', chain, orderKey, requestId });
      if (!drafts.has(orderKey)) drafts.set(orderKey, { items: [], order_amount: '', status: 'draft' });
      // ⭐ 真引擎的草稿**落在会话里**（`data/scan_sessions/` ✓）—— 这里照同一个位置种一份，
      //   好让"路由把整单金额写进草稿"这条判据**读得到**（AC-MIRW-5 ✓）。
      if (sessions && typeof sessions.store?.update === 'function') {
        const ordersField = require('../src/config/multiItemOrder').MULTI_ITEM_ORDER.session.ordersField;
        await sessions.store.update(sessions.idOf(openId), (session) => ({
          [ordersField]: { ...((session || {})[ordersField] || {}), [orderKey]: drafts.get(orderKey) },
        }));
      }
      return { ok: true, orderKey, draft: drafts.get(orderKey) };
    },
    async addItem({ chain, orderKey, item }) {
      calls.push({ fn: 'addItem', chain, orderKey, item: clone(item) });
      const draft = drafts.get(orderKey) || { items: [], order_amount: '' };
      draft.items = [
        ...draft.items.filter((one) => one.product_record_id !== item.product_record_id), clone(item),
      ];
      drafts.set(orderKey, draft);
      return { ok: true, orderKey, draft };
    },
    async submitDraft({ chain, orderKey }) {
      calls.push({ fn: 'submitDraft', chain, orderKey });
      if (!ok) return { ok: false, code, message };
      return { ok: true, summary: { chain, order_key: orderKey, batch_count: 1, detail_count: 1 } };
    },
  };
};

/** 假「后台那一跑」登记簿 —— 老路径（N=1）是不是被**原样**调，看它 ✓ */
const makeBackground = () => {
  const calls = [];
  return { calls, bg: { schedulePurchaseRest: (input) => { calls.push(clone(input)); } } };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const formApp = ({ writeService, engine, background }) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService,
    purchaseBackground: background?.bg || background,
    // 只钉"路由交给引擎什么" ⇒ 成功页 / 人话页用**最简单的渲染器**（页面的形状另有判据 ✓）
    render: {
      success: (payload) => `<html>OK ${payload?.requestId || ''}</html>`,
      message: (payload) => `<html>ERR ${payload?.title || ''} | ${payload?.body || ''}</html>`,
    },
    ...(engine ? { multiItemOrder: engine } : {}),
  }));
  return app;
};

const postForm = (base, body) => fetch(`${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
});

/** 补货表单（`multi_items` 由**渲染半那个序列化器**产出 ✓ 不手拼形状 ✗） */
const replenishBody = ({ items, sizes = ['40'], quantity = '2', key = 'scan_replenish:scan_session_mirw:1' }) => {
  const params = new URLSearchParams();
  params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.replenish);
  params.append(SCAN_WRITE.fields.submitKey, key);
  for (const size of sizes) params.append(SCAN_WRITE.fields.replenishSizes, size);
  params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${sizes[0]}`, quantity);
  if (items) params.append('multi_items', multiItemPayloadJson(items));
  return params;
};

const FIRST = {
  product_record_id: 'rec_K1', number: NUMBER, item_no: 'K1', color: '黑色',
  supplier_record_id: 'sup_K1', entries: [],
};
const SECOND = {
  product_record_id: 'rec_K2', number: 'K2|白色|A', item_no: 'K2', color: '白色',
  supplier_record_id: 'sup_K2', entries: [],
};

const callsOf = (engine, fn) => engine.calls.filter((call) => call.fn === fn);

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-1 ⭐⭐ 分组 > 1 ⇒ 引擎；**首件带上了本次表单的尺码/数量**（去掉合并 ⇒ 红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-1 ⭐⭐ 分组 = 2 ⇒ 引擎被调，且**首件**拿到了本次表单的 `entries`（老路径 0 次）', async () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  const writeService = makeWriteService();
  const engine = makeEngine({ sessions: writeService.sessions });
  const background = makeBackground();

  await withServer(formApp({ writeService, engine, background }), async (base) => {
    const response = await postForm(base, replenishBody({ items: [FIRST, SECOND] }));
    assert.equal(response.status, 200, '成功页 200（引擎那一路 ✓）');
    assert.match(await response.text(), /^<html>OK /, '成功页复用既有那一个出口 ✓');

    assert.deepEqual(callsOf(engine, 'openDraft').length, 1, '引擎：开草稿 **1** 次 ✓');
    const added = callsOf(engine, 'addItem');
    assert.equal(added.length, 2, '引擎：**每个货品一件**（2 次 ✓）');
    assert.equal(callsOf(engine, 'submitDraft').length, 1, '引擎：提交 **1** 次 ✓');

    // 🔴 这条就是"必须合并首件"的判据：**去掉 `mergeFirstItemEntries(…)` ⇒ 这里红**（会是 `[]` ✗）
    assert.deepEqual(added[0].item.entries, [{ size: '40', quantity: '2' }],
      '🔴 首件必须带上**本次表单**的尺码/数量（渲染半留空、由路由在提交时合并 ✓）');
    assert.deepEqual(added[1].item.entries, [], '第二个货品**原样透传**（本函数不碰它 ✗）');
    assert.deepEqual(added[0].item.product_record_id, 'rec_K1', '首件 = 她当前扫的这一款 ✓');

    assert.deepEqual(background.calls, [], '🔴 走了引擎 ⇒ **老路径一次都不排**（两条路不许同时走 ✗）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-2 ⭐⭐ `≤1` 组 ⇒ 老路径**原样**被调 + 引擎 **0 次**（改成 `>= 1` ⇒ 红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-2 ⭐⭐ 单货品（没有 `multi_items` / 只有 1 组）⇒ 老路径逐字原样、引擎 0 次', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine({ sessions: writeService.sessions });
  const background = makeBackground();

  await withServer(formApp({ writeService, engine, background }), async (base) => {
    // ① 页面上**根本没有**那个字段（开关关 / 她只扫一款就是今天这个样子 ✓）
    const withoutField = await postForm(base, replenishBody({ items: null }));
    assert.equal(withoutField.status, 200);
    // ② 旧页面残留的那个字段**只有首件**（渲染半逐字就是这么渲的 ✓）
    const withOneGroup = await postForm(base, replenishBody({ items: [FIRST] }));
    assert.equal(withOneGroup.status, 200);

    assert.deepEqual(engine.calls, [], '🔴 `≤1` 组 ⇒ 引擎 **0 次**（分流写成 `>= 1` ⇒ 这里红 ✓）');
    assert.equal(background.calls.length, 2, '🔴 两次都走**老路径**（先排后台 ⇒ 她自己看到成功页 ✓）');

    const [first, second] = background.calls;
    for (const call of [first, second]) {
      assert.equal(call.chain, 'replenish', '链名逐字 ✓');
      assert.deepEqual(Object.keys(call.restInput).sort(), ['entries', 'number', 'openId', 'productRecordId'],
        '🔴 老路径的**实参清单逐字不变**（`RT2-static` 那 6 个键由 `runRest` 原样转给写层 ✓）');
      assert.deepEqual(call.restInput.entries, [{ size: '40', quantity: '2' }],
        '表单解析结果**原样**（路由**不**合并 / 不改写 ✓）');
      assert.equal(call.restInput.productRecordId, 'rec_K1');
      assert.equal(call.restInput.number, NUMBER);
      assert.equal(call.restInput.openId, OPEN_ID);
      assert.equal(call.submitKey, 'scan_replenish:scan_session_mirw:1', '同一把 `submitKey` **原样透传** ✓');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-4 ⭐ 拒单 / 引擎不可用 ⇒ **400 + 人话 + 零写入**（绝不静默只写第一件）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-4 🔴 引擎拒单（重复行）⇒ 400 + 那句人话；引擎不可用 ⇒ 400 + 零写入（不静默）', async () => {
  // ① 引擎拒单（重复行 / 超上限 / 缺金额 —— 引擎给的那句人话原样回给她 ✓）
  const rejecting = makeEngine({ ok: false });
  const write1 = makeWriteService();
  const bg1 = makeBackground();
  await withServer(formApp({ writeService: write1, engine: rejecting, background: bg1 }), async (base) => {
    const response = await postForm(base, replenishBody({ items: [FIRST, SECOND] }));
    assert.equal(response.status, 400, '她填错了 ⇒ **400**（不是 5xx ✓）');
    const html = await response.text();
    assert.match(html, /ERR /, '有人话页 ✓');
    assert.match(html, /40 码重复了/, '🔴 拒单那句人话**真的到了页面上**（`respondWriteFailure` ✓）');
    assert.deepEqual(bg1.calls, [], '拒单 ⇒ **零写入**：老路径一次都没排 ✓');
  });

  // ② 引擎不可用（写服务没挂 `multiItemWriters` 且没注入引擎）⇒ **不许**回落到"只写第一件" ✗
  const write2 = makeWriteService({ withWriters: false });
  const bg2 = makeBackground();
  await withServer(formApp({ writeService: write2, engine: null, background: bg2 }), async (base) => {
    const response = await postForm(base, replenishBody({ items: [FIRST, SECOND] }));
    assert.equal(response.status, 400, '引擎不可用 ⇒ 人话 + 400 ✓');
    assert.deepEqual(bg2.calls, [],
      '🔴 **绝不静默只写第一件**：其余货品一个字都没写 ⇒ 宁可当场告诉她（这条是"假成功"的反向哨兵 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-5 ⭐ 退货那条链：整单金额进草稿；空金额 ⇒ 同步 400 + 引擎 0 次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-5 ⭐ 退货 · 分组 2：金额写进草稿 `order_amount`；空金额 ⇒ 400 + 引擎 0 次', async () => {
  const returnBody = ({ amount }) => {
    const params = new URLSearchParams();
    params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.purchaseReturn);
    params.append(SCAN_WRITE.fields.submitKey, 'scan_return:scan_session_mirw:1');
    params.append(SCAN_WRITE.fields.returnSizes, '41');
    params.append(`${SCAN_WRITE.fields.returnQuantityPrefix}41`, '1');
    if (amount !== null) params.append(SCAN_WRITE.fields.purchaseAmount, amount);
    params.append('multi_items', multiItemPayloadJson([FIRST, SECOND]));
    return params;
  };

  // ① 金额有 ⇒ 引擎走完，草稿里 `order_amount` 真是那个数（引擎的 `amountRequired` 靠它 ✓）
  const writeService = makeWriteService();
  const engine = makeEngine({ sessions: writeService.sessions });
  await withServer(formApp({ writeService, engine, background: makeBackground() }), async (base) => {
    const response = await postForm(base, returnBody({ amount: '399' }));
    assert.equal(response.status, 200);
    assert.equal(callsOf(engine, 'submitDraft').length, 1, '引擎提交 1 次 ✓');
    const sessionId = writeService.idOf(OPEN_ID);
    const session = await writeService.sessions.store.get(sessionId);
    assert.equal(session.orders['return:' + OPEN_ID + ':1'].order_amount, '399',
      '🔴 整单金额**进了草稿**（空 ⇒ 引擎会按配置拦下这一单 ✗）');
  });

  // ② 金额空 ⇒ **既有那道同步闸门**当场拦（400 + 人话 + 零写入 + 引擎 0 次 ✓）
  const engine2 = makeEngine();
  const write2 = makeWriteService();
  const bg2 = makeBackground();
  await withServer(formApp({ writeService: write2, engine: engine2, background: bg2 }), async (base) => {
    const response = await postForm(base, returnBody({ amount: null }));
    assert.equal(response.status, 400, '退货缺整单金额 ⇒ 400（既有口径，未放宽 ✓）');
    assert.deepEqual(engine2.calls, [], '🔴 金额没过 ⇒ 引擎 **一次都不调**（零写入 ✓）');
    assert.deepEqual(bg2.calls, [], '也不排后台 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MIRW-6 ⭐ 源码哨兵：坏输入一律 `[]`（回落老路径）+ 分流必须是 `> 1`
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MIRW-6 🔴 `parseMultiItemGroups` 坏输入一律 `[]`；路由的分流是 `groups.length > 1`', () => {
  const field = 'multi_items';
  const multiConfig = { field };
  for (const bad of [undefined, {}, { [field]: '' }, { [field]: '   ' }, { [field]: 'not-json' },
    { [field]: '{"groups":"nope"}' }, { [field]: '"a string"' }, { [field]: '42' }, { [field]: 'null' }]) {
    assert.deepEqual(parseMultiItemGroups(bad, multiConfig), [],
      `坏输入 ${JSON.stringify(bad)} ⇒ **空数组**（回落老路径、引擎 0 次 ✓ 不抛 / 不编 ✗）`);
  }
  assert.deepEqual(parseMultiItemGroups({ [field]: '[{"product_record_id":"rec_K1"}]' }, multiConfig),
    [{ product_record_id: 'rec_K1' }], '合法 JSON 数组 ⇒ 原样解析 ✓');
  assert.deepEqual(parseMultiItemGroups({ [field]: ['[]', '[{"a":1}]'] }, multiConfig), [{ a: 1 }],
    '同名字段出现多次 ⇒ 取**最后**那一份（浏览器最后提交的那份 ✓）');
  assert.deepEqual(parseMultiItemGroups({ [field]: '[]' }, { field: '' }), [],
    '字段名空（配置空串）⇒ 不认任何字段 ✓（显式：不偷偷回落成别的名字 ✗）');

  // 🔴 分流必须是 `> 1`：写成 `>= 1` ⇒ N=1 也走引擎 ⇒ AC-MIRW-2 红 ✓
  assert.match(ROUTE_SRC, /groups\.length\s*>\s*1/, '路由要有"`> 1` 组才走引擎"的分流 ✓');
  assert.equal(/groups\.length\s*>=\s*1/.test(ROUTE_SRC), false, '🔴 不许写成 `>= 1`（那会把 N=1 也吞进来 ✗）');
  // 🔴 合并**必须**真的接在解析后面（去掉这一句 ⇒ AC-MIRW-1 红 ✓）
  assert.match(ROUTE_SRC, /mergeFirstItemEntries\(\s*parseMultiItemGroups\(/,
    '🔴 解析出来的分组**必须**先过"首件合并"再分流（去掉它 ⇒ 首件丢数量 ✗）');
  assert.match(ROUTE_SRC, /multiItemWriters\(\)/, '写入件只经 `writeService.multiItemWriters()` ✓（RT5 ✓）');
  // 零 JS 哨兵（既有 `AC-W2` / `AC-6R5` 同口径）：本刀也不许往扫码页塞脚本 ✗
  assert.equal(/<script/i.test(ROUTE_SRC), false, '路由源码里不许有 `<script>` ✗');
});
