'use strict';

/**
 * multiItemOrderAddRemove.test.js —— 「一单多货品」**加货 / 删货**这一刀的判据（task-59 · 两半一刀）。
 *
 * ## 为什么是"两半必须同一刀"（Lead 裁决 (a)）
 *
 * 改前：`multiItemBlockHtml` 渲的是一颗**链接** `<a href="…?add=1">`。
 *   · 链接点了**没反应**（路由没人读 `?add=1`）—— 这是**改前**的现状 ✓
 *   · 而**只合渲染半**（把那颗链接换成 `submit`）会**更糟** ✗：
 *     她一点 ⇒ 整个表单（含 hidden `action=replenish`）POST 出去 ⇒ 落到**既有补货提交** ⇒
 *     **直接报单走人、页面跳走**，而她刚填的那一件到底进没进单她根本看不出来 ✗✗
 *   ⇒ ⭐ **加货那颗按钮必须由路由接住（303 回本页）**，两半**一起**才自洽 ✓
 *   ⇒ 这就是 **AC-MI-D** 要钉住的东西（少了 routes 半 ⇒ 红 ✓）。
 *
 * ## 硬判据（每条都**能真红** ✓）
 *   · **AC-MI-A** ⭐核心：填了首件的尺码+数量 ⇒ 点「＋ 再加一个货品」⇒ **首件的值不丢** ✓
 *     （丢了就是改前那个 bug ✓；这里连"过滤当前这件"的**必要性**都用**真引擎**证一遍 ✓）
 *   · **AC-MI-B** HTTP 端到端：两件一起提交 ⇒ 引擎 **1 次** · 分组 **2** · 首件数量正确（不是 0、不是双倍）✓
 *   · **AC-MI-C** N=1 ⇒ 引擎 **0 次** ＋ 老路径实参 / `submitKey` **逐字不变**（#710 的 AC-MIRW-2 原样绿 ✓）
 *   · **AC-MI-D** ⭐ 防"只合一半"：加货**必须由 routes 接住并 303 回本页** ✓
 *   · **AC-MI-E** 别的领域（销售 / 库存 / 货品）与**单货品那两条老路**行为不变 ✓
 *
 * ## 依据（业务负责人逐字）
 *   · 2026-10-16 本 bug（她真机）：填了值点「＋ 再加一个货品」，值**没了** / 点了**没反应** ✓
 *   · 2026-10-12：「我可没有说过，**我们是能够进行动态交互的**」⇒ 扫码页允许动态交互 ✓
 *     （⚠️ 但本刀**仍然一行 JS 都不加**：一颗 `submit` 按钮 + 服务端会话就够 ✓ 见 AC-MI-A①）
 *
 * ⚠️ 全部**只读**：纯函数 + 真引擎（假会话 store）+ 一次真路由（express 监听 0 端口）
 *   —— 不联网、不写任何 Base、不碰 `services/scanWriteService.js` ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_addremove';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_addremove_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_addremove';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'mi_addremove_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER, resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
const renderer = require('../src/views/scanPageRenderer');
const { multiItemPayloadJson, multiItemBlockHtml } = renderer;

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

const ADD_FIELD = MULTI_ITEM_ORDER.addField;
const ADD_VALUE = MULTI_ITEM_ORDER.addValue;
const REMOVE_FIELD = MULTI_ITEM_ORDER.removeField;
const FIELD = MULTI_ITEM_ORDER.field;

// ═══════════════════════════════════════════════════════════════════════════
// 共用夹具（与 `multiItemOrderRouteWiring.test.js` / `multiItemOrderReturnTrim.test.js`
// 同一套口径 ✓ —— 但这里**两个半都要**：真渲染器 + 真路由 + 假引擎）
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'mi_addremove_session';
const OPEN_ID = 'ou_miar';
const A = Object.freeze({
  product_record_id: 'rec_A', number: 'K1|黑色|A', item_no: 'K1', color: '黑色', supplier_record_id: 'sup_A',
});
const B = Object.freeze({
  product_record_id: 'rec_B', number: 'K2|白色|A', item_no: 'K2', color: '白色', supplier_record_id: 'sup_B',
});

const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

/** 她的真实形状：**有库存** ⇒ 尺码行画得出来 ⇒ 多货品块与提交按钮都在 ✓
 *  ⚠️ 退货那一块**只列 `sellable > 0` 的尺码**（她 2026-10-15 逐字「严格按照实时库存里的数据来，
 *     只展示有数量的尺码」）⇒ 这里的每一行都要**真有数量**，否则整块（含金额行）都不渲染 ✗。 */
const viewOf = (product, rows) => ({
  found: true, number: product.number, item_no: product.item_no, color: product.color,
  category_name: '休闲鞋', category_code: 'A', price_text: '¥399',
  total: 1, columns: [{ key: '门盒', label: '门盒' }], missing_count: 0, sizes_degraded: false,
  notes: [], updated_at_text: '2026-10-16 06:0x',
  rows: rows.map((size) => ({
    size_text: size, cells: [{ count: 2 }], total: 2, missing: false,
  })),
  product_record_id: product.product_record_id, supplier_record_id: product.supplier_record_id,
});

/** 假写服务：路由这一路要用的那几个口**一个不少**（会话 / 写入件 / 领域记忆 / 幂等键）✓ */
const PREFIX = { sale: 'scan_sale', replenish: 'scan_replenish', purchase_return: 'scan_return' };
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
    records, idOf,
    sessions: {
      idOf,
      store,
      // ⚠️ 真 `scanSessionService.get(openId)` 内部会 `idOf(openId)` 再查 store（**不是**拿 openId 当 id ✗）
      //    —— 假件必须照这个形状（否则路由那一侧读到的是"没有会话"，草稿永远看不见 ✗）。
      get: async (openId) => store.get(idOf(openId)),
      setLastRealm: async () => {},
      // ⚠️ 老路线的幂等键：`buildWriteContext` 与 POST 两处都要它 ⇒ **照真形状给**（前缀:会话:轮次 ✓）
      submitKeyFor: (openId, _session, flow = 'sale') => `${PREFIX[flow] || 'scan_sale'}:${idOf(openId)}:1`,
    },
    listAccessories: async () => [],
  };
  if (withWriters) {
    write.multiItemWriters = () => ({
      purchase: async () => {}, purchaseReturn: async () => {}, behavior: async () => ({}),
    });
  }
  return write;
};

/**
 * 假引擎：形状与真引擎的公开 API 同形 ✓ ——
 * ⚠️ 但它**把草稿真的落进那个假会话**（`store`）⇒ 后面那次 GET 读得到 `view.multi_items` ✓
 *   （"加货 ⇒ PRG ⇒ 页面看得见她刚加的那件"这条端到端判据靠它成立 ✓）。
 */
const makeEngine = (writeService) => {
  const calls = [];
  const drafts = new Map();
  const { store, idOf } = writeService.sessions;
  const ordersField = resolveMultiItemOrderConfig({}).session.ordersField;
  // ⚠️ 假引擎**必须照真引擎的"读-改-写"来**（`multiItemOrderService.js` 的 `writeDraft` 就是先在
  //    store 里读回草稿再改 ✓）—— 否则它会拿自己那份内存副本把**别的字段**（例：`order_amount`）
  //    一把盖掉 ✗ ⇒ AC-MI-F 会被**假件**弄成假红（那是测试的错，不是实现的错 ✗）。
  const readStored = async (orderKey) => {
    const session = await store.get(idOf(OPEN_ID));
    const orders = (session && session[ordersField]) || {};
    return orders[orderKey] ? clone(orders[orderKey]) : null;
  };
  const persist = async (orderKey, draft) => {
    drafts.set(orderKey, clone(draft));
    return store.update(idOf(OPEN_ID), (session) => ({
      [ordersField]: { ...((session || {})[ordersField] || {}), [orderKey]: clone(draft) },
    }));
  };
  const emptyDraft = (orderKey, chain) => ({
    chain, open_id: OPEN_ID, submit_key: orderKey, order_key: orderKey,
    items: [], order_amount: '', status: 'draft', updated_at: '2026-10-16T06:00:00.000Z',
  });
  const draftOf = async (orderKey, chain) => (await readStored(orderKey)) || emptyDraft(orderKey, chain);
  return {
    calls,
    drafts,
    async openDraft({ openId, chain, requestId }) {
      const orderKey = `${chain}:${openId}:1`;
      calls.push({ fn: 'openDraft', chain, orderKey, requestId });
      const draft = await draftOf(orderKey, chain);
      await persist(orderKey, draft);
      return { ok: true, orderKey, draft: clone(draft) };
    },
    async addItem({ chain, orderKey, item }) {
      calls.push({ fn: 'addItem', chain, orderKey, item: clone(item) });
      const draft = await draftOf(orderKey, chain);
      const key = (one) => String(one.product_record_id || one.number || one.item_no || '');
      const next = { ...draft, items: [...draft.items.filter((one) => key(one) !== key(item)), clone(item)] };
      await persist(orderKey, next);
      return { ok: true, orderKey, draft: clone(next) };
    },
    async removeItem({ chain, orderKey, productRecordId }) {
      calls.push({ fn: 'removeItem', chain, orderKey, productRecordId });
      const draft = await draftOf(orderKey, chain);
      const next = {
        ...draft,
        items: draft.items.filter((one) => String(one.product_record_id || '') !== String(productRecordId)),
      };
      await persist(orderKey, next);
      return { ok: true, orderKey, draft: clone(next) };
    },
    async submitDraft({ chain, orderKey, submitKey }) {
      calls.push({ fn: 'submitDraft', chain, orderKey, submitKey });
      const draft = await draftOf(orderKey, chain);
      const next = { ...draft, status: 'submitted' };
      await persist(orderKey, next);
      return { ok: true, summary: { chain, order_key: orderKey, batch_count: 1, detail_count: next.items.length } };
    },
  };
};

/** 假「后台那一跑」登记簿 —— N=1 是不是被**原样**交给老路径，看它 ✓ */
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

/** 真渲染器 + 真路由（`lookup` 按编号给那一款 ✓）—— 两个半都在这一套夹具里跑 ✓ */
const makeApp = ({ writeService, engine, background, views }) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async ({ number }) => views[number] || null },
    gateway: {},
    writeService,
    purchaseBackground: background?.bg || background,
    startSnapshot: false,
    ...(engine ? { multiItemOrder: engine } : {}),
  }));
  return app;
};

const pageUrl = (base, number) => `${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(number)}`;
const postForm = (base, number, body, from = 'replenish') => fetch(
  `${pageUrl(base, number)}?from=${from}`,
  {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  },
);
const getPage = (base, number, from = 'replenish') => fetch(`${pageUrl(base, number)}?from=${from}`,
  { redirect: 'manual', headers: { cookie: sessionCookie() } });

/** 补货表单（**照渲染半那个形状**：`multi_items` 由**真序列化器**产出 ✓ 不手拼 ✗） */
const replenishBody = ({
  items, sizes = ['40'], quantity = '2', key = 'scan_replenish:scan_session_oumiar:1', extra = {},
} = {}) => {
  const params = new URLSearchParams();
  params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.replenish);
  params.append(SCAN_WRITE.fields.submitKey, key);
  for (const size of sizes) params.append(SCAN_WRITE.fields.replenishSizes, size);
  for (const size of sizes) params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${size}`, quantity);
  if (items) params.append(FIELD, multiItemPayloadJson(items));
  for (const [name, value] of Object.entries(extra)) params.append(name, value);
  return params;
};

/** 从**真页面**里取出那个 hidden 字段（= 渲染半的实际产物 ✓ 不是测试自己拼的 ✗） */
const hiddenPayloadOf = (html) => {
  const match = html.match(new RegExp(`name="${FIELD}" value="([^"]*)"`));
  assert.ok(match, `页面上必须有 hidden \`${FIELD}\`（渲染半的产物 ✓）`);
  return match[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
};
const hiddenItemsOf = (html) => JSON.parse(hiddenPayloadOf(html));
const callsOf = (engine, fn) => engine.calls.filter((call) => call.fn === fn);
const entriesOf = (item) => (item?.entries || []).map((one) => ({ size: one.size, quantity: one.quantity }));

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI-A ⭐核心：填了首件的尺码+数量 ⇒ 点「＋ 再加一个货品」⇒ 首件的值不丢
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-A① 🔴 「＋ 再加一个货品」是**同一张表单里的第二颗 submit**（旧的 `?add=1` 链接形态去掉 ✗）', () => {
  const html = multiItemBlockHtml({ postAction: `${SCAN_PAGE.route.basePath}/K1%7C%E9%BB%91%E8%89%B2%7CA` }, {
    ...A, multi_items: [],
  });
  assert.ok(html.length > 0, '多货品块要渲得出来 ✓');
  // 改前逐字：`<a class="btn btn--primary" data-multi-add href="/s/K1…?add=1">＋ 再加一个货品</a>`
  // 改后逐字：`<button type="submit" class="btn btn--primary" data-multi-add name="multi_item_add" value="1">＋ 再加一个货品</button>`
  // 依据：她 2026-10-16 本 bug（填了值点那颗链接 ⇒ **值丢了 / 点了没反应**）——
  //   GET 链接**天生带不走表单字段** ✗，只有 **POST** 会把她填的尺码/数量一起发出去 ✓。
  assert.match(html, new RegExp(`<button type="submit"[^>]*data-multi-add[^>]*name="${ADD_FIELD}"[^>]*value="${ADD_VALUE}"`),
    '🔴 加货必须是**同一张表单里的第二颗 `submit`**（带配置里的**新字段名** ✓ 不是 `action` ✗）');
  assert.equal(/data-multi-add[^>]*href=/.test(html), false,
    '🔴 旧的 `href="…?add=1"` 链接形态**必须去掉**（两种入口并存 ⇒ 判据混乱 ✗）');
  assert.equal(html.includes('add=1'), false, '连那个参数串也不许剩 ✗');
  // 🔴 字段名**不许是 `action`**：表单里已经有 hidden `action=replenish`，`extended:true` 下同名再来一个
  //    会变成**数组** ⇒ `String(body[fields.action])` 当场坏掉（整个动作分派认不出来 ✗）。
  assert.notEqual(ADD_FIELD, SCAN_WRITE.fields.action, '🔴 加货字段名**不许**用 `action`（会被挤成数组 ✗）');
  assert.notEqual(REMOVE_FIELD, SCAN_WRITE.fields.action, '🔴 删货字段名同上 ✗');
  assert.notEqual(ADD_FIELD, REMOVE_FIELD, '加 / 删是两个不同的字段名 ✓');
  // 零 JS 哨兵一个字不动 ✓（`AC-W2` / `AC-6R5` / RT5b 同口径）
  assert.doesNotMatch(html, /<script/i, '这一块里**不许有任何 `<script>`** ✗（本刀不加 JS ✓）');
  assert.equal(/on(click|change|submit)=/i.test(html), false, '也不许内联事件处理器 ✗');
  // 列表每一行一颗**删除**按钮（同表单内：`name=<删货字段> value=<product_record_id>` ✓）
  const withRows = multiItemBlockHtml({}, { ...A, multi_items: [{ ...B, entries: [{ size: '41', quantity: 1 }] }] });
  assert.match(withRows, new RegExp(`data-multi-remove[^>]*name="${REMOVE_FIELD}"[^>]*value="rec_B"`),
    '每一行要有**删除**按钮（`value` = 那一件的 `product_record_id` ✓）');
  assert.ok(withRows.includes('移除'), '删除按钮的文字来自配置（`MULTI_ITEM_RENDER_TEXTS.remove` ✓）');
});

test('AC-MI-A② ⭐⭐ 端到端：她勾了 40 码 × 2 再点「加货」⇒ 引擎收到的**就是这两个数**（不是 `[]` ✗）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    const response = await postForm(base, A.number,
      replenishBody({ items: [{ ...A, entries: [] }], sizes: ['40'], quantity: '2', extra: { [ADD_FIELD]: ADD_VALUE } }));
    assert.equal(response.status, 303, '加货是 **PRG**：303 回本页 ✓（不是成功页、不是 200 ✓）');
    const added = callsOf(engine, 'addItem');
    assert.equal(added.length, 1, '加货 ⇒ 引擎 `addItem` **1 次** ✓');
    assert.equal(added[0].chain, 'replenish', '链名来自**领域**（补货那一块 ✓）');
    assert.equal(added[0].item.product_record_id, 'rec_A', '加的是**她当前这一件**（从 hidden `multi_items[0]` 直接取 ✓ 不再 lookup ✗）');
    assert.deepEqual(entriesOf(added[0].item), [{ size: '40', quantity: '2' }],
      '🔴 她填的**尺码 + 数量**必须进草稿（丢了 = 改前那个 bug 又回来了 ✗）。'
      + '⚠️ `quantity` 到这一步还是**表单里那个字符串**（`parseReplenishEntries` 只做形状转换 ✓）'
      + ' —— 与**老路径逐字同口径**（`RT-static` 那两处也是原样透传 ✓）；'
      + '真正"变成数字 / 补默认值 / 压超库存"发生在**提交时**的 `validateDraft`（引擎里 ✓ 一处真源 ✓）');
    assert.deepEqual(callsOf(engine, 'submitDraft'), [], '🔴 加货**绝不提交**（点了加货就走人 = 她最恨的那种 ✗）');
    assert.deepEqual(background.calls, [], '🔴 也不排后台（老路径一次都不许被碰到 ✓）');
  });
});

test('AC-MI-A③ ⭐⭐ 加货后 PRG 回来：页面上「本单已加的货品」里**看得见她刚填的那两个数**', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background: makeBackground(), views }), async (base) => {
    const posted = await postForm(base, A.number,
      replenishBody({ items: [{ ...A, entries: [] }], sizes: ['40'], quantity: '2', extra: { [ADD_FIELD]: ADD_VALUE } }));
    assert.equal(posted.status, 303);
    const location = String(posted.headers.get('location') || '');
    assert.ok(location.includes(encodeURIComponent(A.number)) || location.includes(A.number),
      `303 必须回**本页**（实得 ${location}）`);
    assert.ok(location.includes('from=replenish'), '回跳**停在本领域**（补货那一块 ✓ 不回销售 ✗）');

    // ⭐ 真 GET：草稿（她刚加的那件）经 `view.multi_items` 进页面 ✓
    const page = await getPage(base, A.number);
    assert.equal(page.status, 200, 'GET 本页要 200 ✓');
    const html = await page.text();
    assert.match(html, /data-view="multi-item-list"/, '「本单已加的货品」列表要出现（她加过东西了 ✓）');
    assert.match(html, /<li class="multi-item-row">K1\|黑色\|A/,
      '🔴 列表里那一行就是**她刚加的那一件**（编号逐字 ✓）');
    assert.match(html, /1 行/,
      '🔴 行数 = **1 行**（她勾的那一个尺码 40 **记下来了** ✓ —— 改前点了那颗链接是**一条都不记** ✗）；'
      + '⚠️ "数量是 2 不是 0/不是翻倍"那一半在 **AC-MI-B** 里核（那一页的 hidden 才带数量 ✓）');
    assert.match(html, new RegExp(`data-multi-remove[^>]*value="rec_A"`),
      '删除按钮带着**这一件的 `product_record_id`** ✓（她要删的就是它 ✓）');
    const items = hiddenItemsOf(html);
    assert.equal(items[0].product_record_id, 'rec_A', 'hidden 的**首件永远是她当前扫的这一件** ✓');
    assert.deepEqual(items[0].entries, [],
      '⚠️ 首件的 `entries` **仍然是空的** —— "把本次表单并进首件"这件事**留到提交时做** ✓'
      + '（既有判据 `RT-shape` 逐字钉着它 ✓ 本刀不放宽 ✗）');
  });
});

test('AC-MI-A④ ⭐⭐ 探针（**真引擎**）：不排除"当前这件" ⇒ 草稿旧值把她刚填的**覆盖成空**（所以必须排除 ✓）', async () => {
  const records = new Map();
  const idOf = (openId) => `scan_session_${openId}`;
  const engineSessions = {
    idOf,
    store: {
      get: async (id) => (records.has(id) ? clone(records.get(id)) : null),
      update: async (id, patchOrMutator) => {
        const current = records.has(id) ? clone(records.get(id)) : null;
        const patch = typeof patchOrMutator === 'function' ? await patchOrMutator(current) : patchOrMutator;
        const next = { ...(current || {}), ...(patch || {}) };
        records.set(id, next);
        return clone(next);
      },
    },
    ensure: async (openId) => {
      if (!records.has(idOf(openId))) records.set(idOf(openId), { session_id: idOf(openId) });
      return clone(records.get(idOf(openId)));
    },
  };
  const engine = createMultiItemOrderService({
    sessions: engineSessions, config: resolveMultiItemOrderConfig({}), writers: {},
  });
  const chain = 'replenish';
  const opened = await engine.openDraft({ openId: OPEN_ID, chain });

  // ① **错的那一版**（不过滤）：她刚填的那件在前，草稿里那份**同一件**（旧 `entries`）在后
  await engine.addItem({ openId: OPEN_ID, chain, orderKey: opened.orderKey, item: { ...A, entries: [{ size: '40', quantity: 2 }] } });
  await engine.addItem({ openId: OPEN_ID, chain, orderKey: opened.orderKey, item: { ...A, entries: [] } });
  const wrong = (await engine.readDraft({ openId: OPEN_ID, chain, orderKey: opened.orderKey })).draft;
  assert.deepEqual(wrong.items[0].entries, [],
    '🔴 不过滤 ⇒ 草稿里那份旧的**把她刚填的 40 码 × 2 覆盖成空** = 静默丢值 ✗'
    + '（`addItem` 按 productKey **覆盖**、而且**后写的赢** ✓ —— 这就是"必须排除当前这件"的依据 ✓）');

  // ② **对的那一版**：载荷来自**渲染半的实际产物**（当前这件排在最后一件之外 ✓）
  const html = multiItemBlockHtml({}, { ...A, multi_items: [{ ...A, entries: [] }] });
  const payload = hiddenItemsOf(html);
  assert.equal(payload.length, 1, '当前这一件**只在首件位置出现一次** ✓（草稿里那份被排掉 ✓）');
  const fresh = makeWriteService();
  const engine2 = createMultiItemOrderService({
    sessions: {
      idOf,
      store: {
        get: async (id) => (id === idOf(OPEN_ID) ? fresh.records.get(id) || null : null),
        update: async (id, mutator) => {
          const current = fresh.records.get(id) || null;
          const patch = typeof mutator === 'function' ? await mutator(current) : mutator;
          fresh.records.set(id, { ...(current || {}), ...(patch || {}) });
          return fresh.records.get(id);
        },
      },
      ensure: async (openId) => {
        if (!fresh.records.has(idOf(openId))) fresh.records.set(idOf(openId), { session_id: idOf(openId) });
        return clone(fresh.records.get(idOf(openId)));
      },
    },
    config: resolveMultiItemOrderConfig({}), writers: {},
  });
  const opened2 = await engine2.openDraft({ openId: OPEN_ID, chain });
  for (const item of [payload[0]].map((one) => ({ ...one, entries: [{ size: '40', quantity: 2 }] }))) {
    await engine2.addItem({ openId: OPEN_ID, chain, orderKey: opened2.orderKey, item });
  }
  const right = (await engine2.readDraft({ openId: OPEN_ID, chain, orderKey: opened2.orderKey })).draft;
  assert.deepEqual(right.items[0].entries, [{ size: '40', quantity: 2 }],
    '✅ 排除当前这件 ⇒ 她填的**原样留住** ✓');
  assert.notDeepEqual(right.items[0].entries, wrong.items[0].entries,
    '探针：两种情况**看得出差别** ✓（证明这条判据不是空跑 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI-B ⭐⭐ HTTP 端到端：两件一起提交 ⇒ 引擎 1 次 · 分组 2 · 首件数量正确
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-B ⭐⭐ 她加了 A、再扫 B 提交 ⇒ 引擎 **1 次** · 分组 **2** · 首件数量**不是 0、不是双倍**', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    // ① 她在 A 那一页填了 40 码 × 2 ⇒ 点「＋ 再加一个货品」⇒ 303
    const added = await postForm(base, A.number,
      replenishBody({ items: [{ ...A, entries: [] }], sizes: ['40'], quantity: '2', extra: { [ADD_FIELD]: ADD_VALUE } }));
    assert.equal(added.status, 303);
    // ⚠️ 加货那一下**自己也会** `addItem` 一次（那是"记进草稿"✓）；提交那一步的两次从它后面数起 ✓
    const afterAdd = callsOf(engine, 'addItem').length;
    assert.equal(afterAdd, 1, '加货 ⇒ `addItem` 1 次（当前这一件 ✓）');

    // ② 她扫 B ⇒ 那一页的 hidden `multi_items` **从页面上取**（= 渲染半 + GET 的实际产物 ✓）
    const pageB = await getPage(base, B.number);
    assert.equal(pageB.status, 200);
    const htmlB = await pageB.text();
    const items = hiddenItemsOf(htmlB);
    assert.equal(items.length, 2, '🔴 B 那一页的 hidden 里要有**两件**（B 自己 + 草稿里的 A ✓）');
    assert.equal(items[0].product_record_id, 'rec_B', '首件 = 她当前扫的这一件 ✓');
    assert.deepEqual(entriesOf(items[1]), [{ size: '40', quantity: 2 }],
      '🔴 A 那一件带着**她刚才填的 40 码 × 2** 一起走（"首件的值不丢"的信息链 ✓）');

    // ③ 她在 B 那一页勾 41 码 × 3 ⇒ 提交（hidden 用**页面上的那一份** ✓）
    const params = new URLSearchParams();
    params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.replenish);
    params.append(SCAN_WRITE.fields.submitKey, 'scan_replenish:scan_session_oumiar:1');
    params.append(SCAN_WRITE.fields.replenishSizes, '41');
    params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}41`, '3');
    params.append(FIELD, hiddenPayloadOf(htmlB));
    const submitted = await postForm(base, B.number, params);
    assert.equal(submitted.status, 200, '提交 ⇒ 成功页 200 ✓');
    assert.match(await submitted.text(), /提交成功|已提交成功|success/i, '成功页 ✓');

    assert.equal(callsOf(engine, 'openDraft').length, 2,
      '引擎：开草稿 **2 次**（加货那一下一次 ＋ 提交这一次一次 ✓）—— 提交那一次**只开一次** ✓'
      + '（提交内部重复开草稿 ⇒ 这里会 3 次 ✗）');
    const adds = callsOf(engine, 'addItem').slice(afterAdd);
    assert.equal(adds.length, 2, '🔴 **提交这一步**：两件各一次 = **分组 2** ✓（少一件 = 静默丢货 ✗）');
    assert.equal(callsOf(engine, 'submitDraft').length, 1, '🔴 引擎：提交 **1 次**（不是两次 ✗）');
    assert.deepEqual(background.calls, [], '🔴 走多货品 ⇒ 老路径**一次都不排** ✓');

    assert.equal(adds[0].item.product_record_id, 'rec_B');
    assert.deepEqual(entriesOf(adds[0].item), [{ size: '41', quantity: '3' }],
      '🔴 首件的数量 = **她这次填的 3**（不是 0 ✗、不是 6 ✗）；'
      + '⚠️ 它是**表单里那个字符串**（与老路径逐字同口径 ✓ 见 AC-MI-A②）');
    assert.equal(adds[1].item.product_record_id, 'rec_A');
    assert.deepEqual(entriesOf(adds[1].item), [{ size: '40', quantity: 2 }],
      '🔴 第二件带着**她先前填的 2**（不是 0 ✗、不是 4 ✗ —— "不是双倍"正是这条 ✓）');
    // ⚠️ 幂等键 = 本单的 `orderKey`（**不传页面那把旧的** —— 提交后它仍是旧值 ⇒ 会把第 2 单算成第 1 单 ✗）
    assert.equal(callsOf(engine, 'submitDraft')[0].submitKey, callsOf(engine, 'submitDraft')[0].orderKey,
      '提交时的幂等键 = 本单的 `orderKey` ✓（设计 §4.2 的动机 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI-C ⭐⭐ N=1 ⇒ 引擎 0 次 + 老路径实参 / `submitKey` **逐字不变**
//   （#710 的 AC-MIRW-2 原样绿 ✓ **不放宽它** ✗ —— 这里补的是"加/删货的拦截**不许吞掉正常提交**"）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-C ⭐⭐ 没有加/删货字段 ⇒ **一个字节都不变**：老路径逐字 + 引擎 0 次（探针：加了那个字段就变 ✓）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    // ① 她只扫一款就提交（页面上那个 hidden 只有首件 —— 渲染半逐字就是这么渲的 ✓）
    const single = await postForm(base, A.number, replenishBody({ items: [{ ...A, entries: [] }] }));
    assert.equal(single.status, 200, '🔴 N=1 ⇒ 走**既有成功页**（不是 303 ✗ —— 那就不是"逐字不变"了）');
    assert.deepEqual(callsOf(engine, 'addItem'), [], '🔴 N=1 ⇒ 引擎 **0 次**（分流写成 `>= 1` ⇒ 这里红 ✓）');
    assert.deepEqual(callsOf(engine, 'openDraft'), [], 'N=1 ⇒ 草稿一次都不开 ✓（加/删货的拦截**也没吞掉它** ✓）');
    assert.equal(background.calls.length, 1, '🔴 N=1 ⇒ 老路径**原样**被排（少一次 = 她的单没了 ✗）');
    const call = background.calls[0];
    assert.equal(call.chain, 'replenish', '链名逐字 ✓');
    assert.equal(call.submitKey, 'scan_replenish:scan_session_oumiar:1', '🔴 `submitKey` **原样透传** ✓');
    assert.deepEqual(Object.keys(call.restInput).sort(), ['entries', 'number', 'openId', 'productRecordId'],
      '🔴 老路径的**实参清单逐字不变**（`RT2-static` 那 6 个键由 `runRest` 原样转给写层 ✓）');
    assert.deepEqual(call.restInput.entries, [{ size: '40', quantity: '2' }],
      '表单解析结果**原样**（路由**不**合并 / 不改写 ✓）');
    assert.equal(call.restInput.productRecordId, 'rec_A');
    assert.equal(call.restInput.number, A.number);
    assert.equal(call.restInput.openId, OPEN_ID);

    // ② **探针**：同一份 body **只多那颗按钮的字段** ⇒ 立刻变成"加货"（303 + 引擎 1 次 + 老路径 0 次）
    //    ⇒ 证明 ① 的"0 次"不是空跑、也证明"拦不拦"是**看得见**的 ✓
    const withAdd = await postForm(base, A.number,
      replenishBody({ items: [{ ...A, entries: [] }], extra: { [ADD_FIELD]: ADD_VALUE } }));
    assert.equal(withAdd.status, 303, '探针：多了那颗按钮的字段 ⇒ 走加货（303 ✓）');
    assert.equal(callsOf(engine, 'addItem').length, 1, '探针：引擎这次被调了 ✓');
    assert.equal(background.calls.length, 1, '探针：老路径**没有被多排一次** ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI-D ⭐⭐ 防"只合一半"：加货**必须由 routes 接住并 303 回本页**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-D ⭐⭐ 加货由**路由**接住 ⇒ 303 回本页（探针：拿掉那颗按钮的字段 = "少了 routes 半"那条路 ⇒ 直接报单走人 ✗）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    // ① 她的那一下（表单里**只有**那颗按钮多出来的字段）
    const base1 = replenishBody({ items: [{ ...A, entries: [] }], sizes: ['40'], quantity: '2' });
    const pressed = new URLSearchParams(base1);
    pressed.append(ADD_FIELD, ADD_VALUE);
    const response = await postForm(base, A.number, pressed);
    assert.equal(response.status, 303,
      '🔴 加货必须被**路由**接住 ⇒ 303（PRG 回本页 ✓）—— 少了 routes 半这里会是 **200 成功页** ✗');
    const location = String(response.headers.get('location') || '');
    assert.ok(location.includes('from=replenish'), `303 回**本页 + 本领域**（实得 ${location}）`);
    assert.equal(callsOf(engine, 'submitDraft').length, 0, '🔴 加货**绝不提交** ✓');
    assert.deepEqual(background.calls, [], '🔴 也绝不落到"既有补货提交"（那会**直接报单走人、页面跳走** ✗✗）');
    assert.equal(String((await response.text()) || '').includes('提交成功'), false,
      '303 不该带**成功页**正文（它只是个跳转 ✓ —— `See Other. Redirecting to …` 是 Express 的固定文案 ✓）');

    // ② ⭐ **探针**：**同一个 body 拿掉那颗按钮的字段** = "她点了按钮、而路由没接住"时会走的那条路
    //    ⇒ 200 成功页 + 老路径被排一次 ⇒ 正是"**直接报单走人、页面跳走**" ✗✗
    //    （这就是 Lead 说的"只合 views 半会比现状更糟"那条 ✓ —— 现状是"点了没反应" ✓）
    const withoutCatch = await postForm(base, A.number, base1);
    assert.equal(withoutCatch.status, 200,
      '🔴 探针：**没有路由接住**时，这次 POST 会落到**既有补货提交** ⇒ 200 成功页（她那一单直接报走了 ✗）');
    assert.equal(background.calls.length, 1, '🔴 探针：老路径真的被排了一次（= 报单走人 ✓）');
    assert.equal(callsOf(engine, 'addItem').length, 1, '🔴 探针：那次 POST 里没有加货（引擎的 addItem 还是只有 ① 那一次 ✓）');
    assert.match(await withoutCatch.text(), /提交成功|已提交成功|success/i, '探针：那是一张成功页 ✓');
  });
});

test('AC-MI-D② 🔴 源码哨兵：加 / 删货的拦截**排在动作分派之前**（挪到后面 ⇒ 红 ✓）', () => {
  const at = ROUTE_SRC.indexOf('multiItemActionOf');
  assert.notEqual(at, -1, '路由里要有"这一发是不是加/删货"的判据（一处定义 ✓）');
  const dispatch = ROUTE_SRC.indexOf('if (action === actions.replenish)');
  const addLine = ROUTE_SRC.indexOf('if (action === actions.addLine)');
  assert.notEqual(dispatch, -1, '补货动作分派那一行要在 ✓（锚点 ✓）');
  // ⚠️ 锚必须落在**调用点**上，不能落在**定义**上 —— 定义在工厂作用域（≈ 前面 1800 行），
  //   拿它当锚的话"把调用挪到分派之后"也照样绿 = **假判据** ✗（我第一版就是错的，靠变异测试抓出来的 ✓）。
  //   定义写成 `const handleMultiItemAction = async ({ … })`、调用写成 `return handleMultiItemAction({ … })`
  //   ⇒ 用 `return handleMultiItemAction(` 当锚**只**命中调用点 ✓。
  const intercept = ROUTE_SRC.indexOf('return handleMultiItemAction(');
  assert.ok(intercept > 0, '🔴 要有**真的调用**那一行（`return handleMultiItemAction({ … })` ✓）');
  assert.ok(ROUTE_SRC.includes('const handleMultiItemAction = async ('), '那个接住点本身也要在 ✓');
  assert.ok(intercept < dispatch,
    '🔴 加/删货的拦截**必须在动作分派之前** —— 放到后面 ⇒ 她的那一下会先被"补货提交"吃掉 ✗');
  assert.ok(intercept < addLine, '同样要排在「加入本单」之前 ✓');
  // 老路径那条分流**一个字没动**（`#710` 的 AC-MIRW-6 / AC-MI-C 都靠它 ✓）
  assert.match(ROUTE_SRC, /groups\.length\s*>\s*1/, '`> 1` 组才走引擎（本刀不动它 ✓）');
  assert.equal(/groups\.length\s*>=\s*1/.test(ROUTE_SRC), false, '🔴 不许写成 `>= 1` ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI-E 别的领域 / 单货品老路 ⇒ 行为不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-E① 🔴 别的领域（销售 / 库存 / 货品）页面里**没有**加 / 删货那一套（探针：检测器真能红 ✓）', async () => {
  const writeService = makeWriteService();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']) };
  await withServer(makeApp({ writeService, engine: null, background: makeBackground(), views }), async (base) => {
    for (const from of ['sales', 'inventory', 'product']) {
      const response = await getPage(base, A.number, from);
      assert.equal(response.status, 200, `?from=${from} 那一页照旧 200 ✓`);
      const html = await response.text();
      assert.equal(html.includes('data-multi-add'), false, `?from=${from} 里不该有多货品块 ✗`);
      assert.equal(html.includes(`name="${ADD_FIELD}"`), false, `?from=${from} 里不该有加货字段 ✗`);
      assert.equal(html.includes(`name="${REMOVE_FIELD}"`), false, `?from=${from} 里不该有删货字段 ✗`);
    }
    // 探针：这个检测器**真能红**（把那一块塞进别的领域它就认得出 ✓）
    const probe = multiItemBlockHtml({}, { ...A, multi_items: [] });
    assert.equal(probe.includes('data-multi-add'), true, '探针：多货品块本身是认得出的 ✓');
    assert.equal(probe.includes(`name="${ADD_FIELD}"`), true, '探针：那个字段名也认得出 ✓');
  });
});

test('AC-MI-E② 🔴 领域 → 链 的映射**只有补货 / 退货**两条（别的领域一律不认 ⇒ 不给动作、零写入 ✓）', () => {
  // ⚠️ 这是"别的领域行为不变"的**结构保证**：映射里多一条 ⇒ 别的领域也会去开草稿 ✗
  const block = ROUTE_SRC.slice(ROUTE_SRC.indexOf('CHAIN_BY_REALM'), ROUTE_SRC.indexOf('CHAIN_BY_REALM') + 1400);
  assert.ok(/\[REPLENISH_REALM\]\s*:/.test(block), '补货领域 → 补货链 ✓');
  assert.ok(/\[PURCHASE_RETURN_REALM\]\s*:/.test(block), '退货领域 → 退货链 ✓');
  for (const realm of ['sales', 'inventory', 'product']) {
    assert.equal(new RegExp(`['"]${realm}['"]\\s*:`).test(block), false,
      `🔴 映射里不许有 \`${realm}\`（多一条 ⇒ 那个领域也会去碰草稿 ✗）`);
  }
  // 配置默认值的键名也要在（配置先行 ✓）
  assert.equal(typeof MULTI_ITEM_ORDER.addField, 'string', '加货字段名来自配置 ✓');
  assert.equal(typeof MULTI_ITEM_ORDER.removeField, 'string', '删货字段名来自配置 ✓');
  assert.ok(MULTI_ITEM_ORDER.addField && MULTI_ITEM_ORDER.removeField && MULTI_ITEM_ORDER.addValue,
    '三个值都非空 ⇒ 渲染层才发得出那颗按钮 ✓');
  assert.equal(MULTI_ITEM_ORDER.addField.includes('action') && MULTI_ITEM_ORDER.addField === 'action', false,
    '🔴 配置默认值也不许叫 `action` ✗');
});

test('AC-MI-E③ ⭐⭐ 退货那条链的单货品老路**逐字不变**（`orderAmount` 那个键还在 ✓）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    const params = new URLSearchParams();
    params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.purchaseReturn);
    params.append(SCAN_WRITE.fields.submitKey, 'scan_return:scan_session_oumiar:1');
    params.append(SCAN_WRITE.fields.returnSizes, '41');
    params.append(`${SCAN_WRITE.fields.returnQuantityPrefix}41`, '1');
    params.append(SCAN_WRITE.fields.purchaseAmount, '399');
    const response = await postForm(base, A.number, params, 'purchase_return');
    assert.equal(response.status, 200, '单货品退货 ⇒ 既有成功页 ✓');
    assert.deepEqual(callsOf(engine, 'addItem'), [], '引擎 0 次 ✓');
    assert.equal(background.calls.length, 1, '老路径原样被排一次 ✓');
    const call = background.calls[0];
    assert.equal(call.chain, 'purchase_return', '链名逐字 ✓');
    assert.equal(call.submitKey, 'scan_return:scan_session_oumiar:1', '🔴 `submitKey` 原样 ✓');
    assert.deepEqual(Object.keys(call.restInput).sort(),
      ['entries', 'number', 'openId', 'orderAmount', 'productRecordId'],
      '🔴 退货老路径的实参清单逐字不变（含 `orderAmount` ✓）');
    assert.equal(call.restInput.orderAmount, '399', '整单金额原样透传 ✓');
  });
});

test('AC-MI-F ⭐⭐ 退货：她敲的「整单金额」也在"加货"这一下**原地留住**（草稿存着 ⇒ 回来预填回那一格 ✓）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']) };
  const returnBody = (extra = {}) => {
    const params = new URLSearchParams();
    params.append(SCAN_WRITE.fields.action, SCAN_WRITE.actions.purchaseReturn);
    params.append(SCAN_WRITE.fields.submitKey, 'scan_return:scan_session_oumiar:1');
    params.append(SCAN_WRITE.fields.returnSizes, '41');
    params.append(`${SCAN_WRITE.fields.returnQuantityPrefix}41`, '1');
    params.append(SCAN_WRITE.fields.purchaseAmount, '399');
    params.append(FIELD, multiItemPayloadJson([{ ...A, entries: [] }]));
    for (const [name, value] of Object.entries(extra)) params.append(name, value);
    return params;
  };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    // ① 她在**退货**那一页填了整单金额 + 一个尺码 ⇒ 点「＋ 再加一个货品」
    const posted = await postForm(base, A.number, returnBody({ [ADD_FIELD]: ADD_VALUE }), 'purchase_return');
    assert.equal(posted.status, 303, '退货那一块的加货同样是 **PRG**（303 ✓）');
    assert.equal(callsOf(engine, 'addItem').length, 1, '引擎 `addItem` 1 次（链 = `return` ✓）');
    assert.equal(callsOf(engine, 'addItem')[0].chain, 'return', '链名来自领域映射（`purchase_return` → `return` ✓）');
    assert.deepEqual(background.calls, [], '🔴 不许落到"既有退货提交"（那会直接报走这一单 ✗）');
    const session = await writeService.sessions.get(OPEN_ID);
    const draft = Object.values(session[resolveMultiItemOrderConfig({}).session.ordersField])[0];
    assert.equal(draft.order_amount, '399',
      '🔴 她敲的整单金额**进了草稿**（丢了 = 同一个 bug 类：填了值、点一下、值没了 ✗）');

    // ② 回来的那一页：金额那一格**预填 = 399**（她不用重敲 ✓）
    const page = await getPage(base, A.number, 'purchase_return');
    const html = await page.text();
    assert.match(html, new RegExp(`${SCAN_WRITE.fields.purchaseAmount}"[^>]*value="399"`),
      '🔴 「整单金额」那一格必须**预填回 399**（值不丢 ✓）');

    // ③ **探针**（防"顺手改了既有页面" ✗）：**没有草稿**时那一格**一个 `value` 属性都不加** ⇒
    //   既有页面 HTML 逐字节不变 ✓（本刀不动既有判据靠的就是这一条 ✓）
    const fresh = makeWriteService();
    await withServer(makeApp({
      writeService: fresh, engine: makeEngine(fresh), background: makeBackground(), views,
    }), async (bare) => {
      const plain = await (await getPage(bare, A.number, 'purchase_return')).text();
      assert.match(plain, new RegExp(`name="${SCAN_WRITE.fields.purchaseAmount}"`), '那一格本身照旧在 ✓');
      assert.equal(new RegExp(`name="${SCAN_WRITE.fields.purchaseAmount}"[^>]*value=`).test(plain), false,
        '🔴 探针：没有草稿 ⇒ **不加 `value` 属性**（也**不加** `value=""` ✗）⇒ 既有 HTML 逐字节不变 ✓');
    });
  });
});

test('AC-MI-E④ 🔴 删货：由路由接住（`removeItem`）⇒ 303 回本页、**不提交**；删完那一行就没了 ✓', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine(writeService);
  const background = makeBackground();
  const views = { [A.number]: viewOf(A, ['39', '40', '41']), [B.number]: viewOf(B, ['40', '41']) };
  await withServer(makeApp({ writeService, engine, background, views }), async (base) => {
    // 先加一件（A）
    await postForm(base, A.number,
      replenishBody({ items: [{ ...A, entries: [] }], sizes: ['40'], quantity: '2', extra: { [ADD_FIELD]: ADD_VALUE } }));
    assert.equal(callsOf(engine, 'addItem').length, 1);

    // 她在 B 那一页点「移除」（那一行的 `value` = rec_A ✓）
    const removed = await postForm(base, B.number,
      replenishBody({ items: [{ ...B, entries: [] }], extra: { [REMOVE_FIELD]: 'rec_A' } }));
    assert.equal(removed.status, 303, '删货也是 PRG：303 回本页 ✓');
    const calls = callsOf(engine, 'removeItem');
    assert.equal(calls.length, 1, '引擎 `removeItem` **1 次** ✓');
    assert.equal(calls[0].productRecordId, 'rec_A', '删的是**那一行**那一件（`value` = `product_record_id` ✓）');
    assert.deepEqual(callsOf(engine, 'submitDraft'), [], '🔴 删货**绝不提交** ✓');
    assert.deepEqual(background.calls, [], '🔴 也不排后台 ✓');

    // 删完那一行就没了（GET 重新渲染 ✓）
    const page = await getPage(base, B.number);
    const html = await page.text();
    assert.equal(/<li class="multi-item-row">/.test(html), false, '删掉之后列表里那一行**不该再有** ✓');
  });
});
