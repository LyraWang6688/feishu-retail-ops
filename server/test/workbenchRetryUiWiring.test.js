'use strict';

/**
 * ⭐⭐ ⑨b-1 UI（**交互那一半**）：工作台「未完成，可点重试」的**真渲染 + 真点击**验收用例。
 *
 * 依据（业务负责人逐字）：
 *   「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」；
 *    重试**只走 `submitSale` 同一把 `submitKey`**（**绝不直调 `_confirm`**、**绝不重复写/重复扣**）」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么**还要**这个文件（核过 2026-10-16 的 main）：
 *   · 判据那一半（三个维度 → `write_incomplete`）已由 `test/salesRetryUiFlag.test.js` 的
 *     AC-ASU1…ASU5 钉住 ✓；服务端那次续写（同键/只写一次/失败如实）已由
 *     `test/salesRetryEntry.test.js` 的 AC-AS4 / AC-AS5 / AC-AS9 钉住 ✓。
 *   · **缺**的三条（本文件补上，且是**真渲染 + 真点击**，不是源码正则）：
 *       AC-RW1 **点了真调端点**：点那颗按钮 ⇒ 真的 `POST /api/workbench/sales/retry`，
 *                body = `{ order_no: <她点的那一单> }`；成功后**强制拉新**（她看到真实状态）。
 *       AC-RW2 **点了立刻有反馈 + 防连点**：那一刻置灰 + 换文案；在飞时连点**只发一次**。
 *       AC-RW3 **失败如实显示**：服务端那句人话原样摆出（标红 + 请求编号），
 *                **绝不许假成功**；按钮恢复 ⇒ 她还能再点（再点真的再发一次）。
 *       AC-RW4 **命中区 ≥44px**：那颗按钮走既有 `.btn` ⇒ `--control-height` = 44px。
 *       AC-RW5（**再钉一次**，与 `salesRetryUiFlag.test.js` 的 AC-ASU4 同一判据）：
 *                **只有没写完的单**才有那句话 + 按钮；已写完 / 判据缺失都没有。
 *       AC-RW6 服务端说"这一单已经写完了"（`reused:true`）⇒ **如实转述**，不是又写一遍。
 *   ⚠️ 本文件**没有改任何既有判据**：一条都没放宽、没删、没 skip ✗；只**新增**。
 *
 * ⚠️ 跑的是**真前端模块**（`features/orders/index.js` + `core/ui.js` + `core/api-client.js`
 *    + `config/orders.js`，拷到临时目录、**只改 import 的文件名**）+ **真点击委托**；
 *    只有浏览器那几样（`window` / `document` / `fetch`）是**够用的替身**。
 *    ⇒ 因此它同时钉住「点击 → 分派 → 请求 → 反馈 → 刷新」这条**整链**。
 * ─────────────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 与既有用例同一套做法：拷成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）。 */
const loadFrontend = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-wiring-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { orders: load('orders-index'), config: load('orders-config') };
};

// ── 够用的假 DOM（只实现这几个模块真的调到的那几个方法）─────────────────────────

const createClassList = () => {
  const set = new Set();
  return {
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      if (force === undefined) {
        if (set.has(name)) set.delete(name); else set.add(name);
      } else if (force) set.add(name); else set.delete(name);
      return set.has(name);
    },
  };
};

const createNode = () => {
  const handlers = new Map();
  return {
    innerHTML: '', textContent: '', value: '', checked: false, open: false, disabled: false,
    dataset: {}, classList: createClassList(),
    addEventListener(type, handler) {
      const key = String(type);
      if (!handlers.has(key)) handlers.set(key, []);
      handlers.get(key).push(handler);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    replaceChildren: () => {},
    appendChild: (child) => child,
    matches: () => false,
    closest: () => null,
    setAttribute: () => {},
    getAttribute: () => null,
    handlers,
  };
};

const jsonResponse = (status, body, requestId = '') => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (name) => (String(name).toLowerCase() === 'x-request-id' ? requestId : '') },
});

const ORIGIN = 'http://workbench.test';
const ORDER_NO = 'XSD-20261016-0001';

/**
 * 读一句页面文案 —— **不规定它住在哪个对象里**（`ORDERS_PAGE` / `ORDERS_TEXTS` 都认），
 * 只要求"**配了**，而且**页面真的把它显示出来了**"。
 * ⚠️ 这一条正是 2026-10-16 那个真 bug 的形状：文案配在 `ORDERS_PAGE`、代码却按
 *    `ORDERS_TEXTS` 读 ⇒ 读成 `undefined` ⇒ 回执空白（点了没反应）。判据必须落在**行为**上，
 *    不能只断言"配置里有这个键" ✗。
 */
const copyOf = (config, key) => config.ORDERS_TEXTS[key] ?? config.ORDERS_PAGE[key];
const expectCopy = (config, key) => {
  const text = copyOf(config, key);
  assert.ok(String(text || '').trim(), `文案「${key}」必须真的配了（配置先行 ✓）`);
  return text;
};

/** 一单：判据（`write_incomplete`）由服务端给 ⇒ 用例照它走 ✓ 不猜 ✗ */
const ROW = (extra = {}) => ({
  record_id: 'rec_retry_1',
  order_no: ORDER_NO,
  fulfillment_status: '部分交付',
  payment_status: '部分收款',
  receivable_amount: 100,
  paid_amount: 0,
  pending_amount: 100,
  pending_delivery_quantity: 1,
  details: [{
    record_id: 'd1', product: 'A', color: '黑', size: 40,
    actual_amount: 100, fulfillment_status: '未交付', requires_size: true,
  }],
  payments: [],
  ...extra,
});

/**
 * 台子：真前端模块 + 真点击委托 + 够用的假浏览器。
 * `POST` 的应答由用例自己给（`setRetry`）——成功 / 400 / 500 / `reused` 各跑一条。
 */
const createHarness = async () => {
  const loaded = loadFrontend();
  const [ordersModule, ordersConfig] = await Promise.all([loaded.orders, loaded.config]);

  const nodes = { result: createNode(), ordersHost: createNode() };
  const container = createNode();
  container.querySelector = (selector) => {
    if (selector === '[data-view="action-result"]') return nodes.result;
    if (selector === '[data-view="orders-host"]') return nodes.ordersHost;
    return null;
  };

  const calls = [];
  let retryHandler = () => jsonResponse(200, {
    success: true, order_no: ORDER_NO, reused: false, message: '已续写完成。',
  });

  globalThis.window = { location: { origin: ORIGIN } };
  globalThis.document = { getElementById: () => createNode() };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { url, method, body };
    calls.push(call);
    // 读订单列表（既有 `GET /api/workbench/sales/orders`）⇒ 一行"没写完"的单
    if (method !== 'POST') return jsonResponse(200, { success: true, orders: [ROW({ write_incomplete: true })], methods: [] });
    return retryHandler(call);
  };

  const flush = async (ticks = 4) => {
    for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  ordersModule.createOrdersModule({ mode: 'sales' }).mount(container);
  await flush();

  /** 那颗按钮的替身：**同一个对象**要复用（真机连点命中的是同一个元素）。 */
  const makeRetryTrigger = (orderNo = ORDER_NO) => ({
    dataset: { action: 'retry-write', orderNo }, disabled: false, textContent: '重试',
  });

  return {
    ordersModule,
    ordersConfig,
    container,
    nodes,
    calls,
    flush,
    makeRetryTrigger,
    setRetry: (handler) => { retryHandler = handler; },
    posts: () => calls.filter((call) => call.method === 'POST'),
    gets: () => calls.filter((call) => call.method === 'GET'),
    /** 真点击：走模块**自己注册**的点击委托（不是直接调内部函数）。 */
    clickRetry(trigger) {
      const handler = container.handlers.get('click')[0];
      assert.ok(handler, '订单模块必须注册了点击委托');
      const event = {
        target: { closest: (selector) => (selector === '[data-action]' ? trigger : null) },
      };
      return handler(event);
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW1 点了真调端点（＋成功后强制拉新）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW1 ⭐ 点那颗按钮 ⇒ 真的 POST 既有 `/api/workbench/sales/retry`（带这一单的单号）＋ 成功后拉新', async () => {
  const h = await createHarness();
  h.setRetry(() => jsonResponse(200, {
    success: true, order_no: ORDER_NO, reused: false, message: '已续写完成。',
  }));

  await h.clickRetry(h.makeRetryTrigger(ORDER_NO));

  const posts = h.posts();
  assert.equal(posts.length, 1, '点一下正好发一次写请求');
  assert.equal(posts[0].url, `${ORIGIN}/api/workbench/sales/retry`, '打的是**既有**那条续写端点（不新开接口 ✗）');
  assert.deepEqual(posts[0].body, { order_no: ORDER_NO },
    'body = `{ order_no }`（点的是哪一单就续哪一单 ⇒ 服务端那道"单号对不上"的闸门才有用 ✓）');
  assert.ok(h.gets().length >= 1, '成功之后强制拉新（她刷新/回看看到的是真实状态 ✓）');
  assert.equal(h.calls[h.calls.length - 1].method, 'GET', '拉新在写之后（不是拿旧列表糊弄 ✗）');
  assert.ok(h.nodes.result.textContent.includes('已续写完成。'), '服务端那句回执**原样**显示出来');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW2 点了立刻有反馈 + 防连点
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW2 ⭐ 点了立刻置灰 + 换文案；在飞的时候连点 ⇒ 只发一次（防重复写 / 重复扣）', async () => {
  const h = await createHarness();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  h.setRetry(async () => {
    await gate;
    return jsonResponse(200, { success: true, order_no: ORDER_NO, reused: false, message: '已续写完成。' });
  });

  const trigger = h.makeRetryTrigger(ORDER_NO);
  const first = h.clickRetry(trigger);

  // ⭐ 还在飞的时候（await 之前）就已经置灰 + 换文案了 —— "点了没反应 ⇒ 她连点"就是这么没的
  assert.equal(trigger.disabled, true, '点击那一刻就置灰');
  assert.equal(trigger.textContent, expectCopy(h.ordersConfig, 'retrying'), '文案立刻换成「正在续写…」');

  // 连点：**同一颗按钮**（真机就是同一个元素）
  assert.equal(await h.clickRetry(trigger), undefined, '在飞的时候第二次点击什么都不做');
  assert.equal(await h.clickRetry(trigger), undefined, '第三次也一样');
  assert.equal(h.posts().length, 1, '连点 3 次 ⇒ 只发 1 次写请求（绝不重复写/重复扣 ✓）');

  open();
  await first;
  assert.equal(trigger.disabled, false, '结束后恢复可点');
  assert.equal(trigger.textContent, '重试', '文案恢复原样');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW3 失败如实显示（不许假成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW3 🔴 续写没成功 ⇒ 如实摆出服务端那句人话（标红 · 带请求编号）· 按钮还能再点', async () => {
  const h = await createHarness();
  h.setRetry(() => jsonResponse(400, {
    success: false, code: 'no_pending_order', error: '这一单没有要接着写的东西。',
  }, 'req-retry-1'));

  const trigger = h.makeRetryTrigger(ORDER_NO);
  await h.clickRetry(trigger);

  assert.ok(h.nodes.result.textContent.includes('这一单没有要接着写的东西。'),
    '服务端那句人话**原样**显示（不许换一句更中听的 ✗）');
  assert.ok(h.nodes.result.textContent.includes('req-retry-1'), '带上请求编号（她好让我们排查 ✓）');
  assert.equal(h.nodes.result.classList.contains('error-text'), true, '失败要**标红**（不能看着像成功）');
  assert.equal(h.nodes.result.textContent.includes(expectCopy(h.ordersConfig, 'retryDone')), false,
    '🔴 **绝不许假成功**（不许显示"已续写完成"）');
  assert.equal(trigger.disabled, false, '失败后按钮恢复 ⇒ 她还能再点');

  // 再点 ⇒ **真的又去写**（不是"一次性的"）
  await h.clickRetry(trigger);
  assert.equal(h.posts().length, 2, '重试真的又发了一次（服务端还走同一把 submitKey ✓）');
});

test('AC-RW3b 🔴 续写抛在客户端（网络/异常）⇒ 也如实显示人话，按钮仍可再点', async () => {
  const h = await createHarness();
  h.setRetry(async () => { throw new Error('网络断了（用例注入）'); });

  const trigger = h.makeRetryTrigger(ORDER_NO);
  await h.clickRetry(trigger);

  assert.ok(h.nodes.result.textContent.includes('网络断了（用例注入）'), '异常也如实说，不吞掉');
  assert.equal(h.nodes.result.classList.contains('error-text'), true, '同样标红');
  assert.equal(h.nodes.result.textContent.includes(expectCopy(h.ordersConfig, 'retryDone')), false, '不许假成功');
  assert.equal(trigger.disabled, false, '还能再点');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW4 命中区 ≥44px
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW4 ⭐ 那颗按钮的命中区 ≥44px（走既有 `.btn` ⇒ `--control-height`）· `type="button"` · 带这一单的单号', async () => {
  const loaded = loadFrontend();
  const orders = await loaded.orders;
  const html = orders.ordersListHtml([ROW({ write_incomplete: true })]);

  const tag = /<button[^>]*data-action="retry-write"[^>]*>/.exec(html);
  assert.ok(tag, '没写完的单必须渲染出那颗按钮');
  assert.match(tag[0], /class="btn btn-primary order-retry"/, '用既有 `.btn`（命中区不是页面自己拍的数字）');
  assert.ok(tag[0].includes('type="button"'), '必须 `type="button"`（回车不会触发默认提交 ⇒ 不重复提交）');
  assert.ok(tag[0].includes(`data-order-no="${ORDER_NO}"`), '按钮上带的就是**这一单**的单号（点了不会指向别的单 ✗）');

  // `.btn` ⇒ `min-height: var(--control-height)`；`--control-height` = 44px（两处都逐字核）
  assert.match(read('styles/base.css'),
    /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '既有 `.btn` 规则的命中区 = `--control-height`（**既有**移动端口径 ✓）');
  assert.match(read('styles/tokens.css'), /--control-height:\s*44px;/, '令牌就是 44px');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW5（**再钉一次**，同一判据也在 `salesRetryUiFlag.test.js` 的 AC-ASU4）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW5 ⭐ 渲染层：**只有没写完的单**才有那句话 + 按钮（已写完 / 判据缺失都没有）', async () => {
  const loaded = loadFrontend();
  const orders = await loaded.orders;

  const bad = orders.ordersListHtml([ROW({ write_incomplete: true })]);
  assert.ok(bad.includes('未完成，可点重试'), '她逐字那一句要在（判据 = 服务端给的 `write_incomplete` ✓）');
  assert.ok(bad.includes('data-view="order-incomplete"'), '那句话要有可断言的锚点');
  assert.ok(bad.includes('data-action="retry-write"'), '＋一颗能点的按钮');
  assert.ok(bad.includes('data-action="open-order"'), '「查看 / 操作」那颗**不受影响**（一个字没动 ✓）');

  for (const [label, row] of [
    ['已写完（write_incomplete:false）', ROW({ write_incomplete: false })],
    ['判据缺失（老单 / 那一列还没写）', ROW()],
  ]) {
    const html = orders.ordersListHtml([row]);
    assert.equal(html.includes('未完成，可点重试'), false, `${label} ⇒ **不显示**那句话（不猜 ✗）`);
    assert.equal(html.includes('retry-write'), false, `${label} ⇒ **不发**按钮（不猜 ✗）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RW6 服务端说"已经写完了" ⇒ 如实转述（不是又写一遍）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RW6 ⭐ 服务端回 `reused:true`（这一单刚才已经交过了）⇒ 如实转述，不冒充"又写了一遍"', async () => {
  const h = await createHarness();
  h.setRetry(() => jsonResponse(200, { success: true, order_no: ORDER_NO, reused: true }));

  await h.clickRetry(h.makeRetryTrigger(ORDER_NO));

  assert.ok(h.nodes.result.textContent.includes(expectCopy(h.ordersConfig, 'retryAlreadyDone')),
    '如实说"这一单已经写完了，没有要接着写的东西"（**必须显示出来** —— 空白 = "点了没反应" ✗）');
  assert.equal(h.nodes.result.textContent.includes(expectCopy(h.ordersConfig, 'retryDone')), false,
    '不冒充"已续写完成"（那是又写了一遍的意思 ✗）');
});
