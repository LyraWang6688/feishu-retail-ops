'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ task-23（2026-10-15 真机 · 业务负责人逐字）：
 *   「**退货这里的逻辑不好，应该是用户点了退货 tab 页之后呢，直接就是出来实时库存里的尺码和数量，
 *     用户可以勾选退货的尺码及其对应的数量～用户填好之后，可以点击退货按钮，前端交互按照这个**」
 *
 * ## ⚠️ 开工前先把"现状"核清楚（不要照 brief 的字面结论做 —— 会白改 ✗）
 * brief 说「前端从来没渲染过那些输入 ⇒ 提交必然 `sizes=[]`」。**实测不是这样**（见 AC-RT0）：
 * 用真路由 GET `?from=purchase_return` 渲染出来，**尺码勾选框与数量输入本来就在**
 * （`return_sizes` / `return_qty_<尺码>`，来自 2026-10-11 那一版）✓。
 * 真正的缺口是**三处**（都在这一条要求里）：
 *   ① 🔴 **看不到"数量"** —— 每行只有「尺码 + 数量输入」，**没有当前库存数量** ⇒
 *      她原话要的是「实时库存里的**尺码和数量**」✗（`sizeRowsHtml` 把 `sellable` 丢掉了 ✗）
 *   ② 🔴 **退货数量写死 `value="1"`** —— 没走配置（后端兜底用的是 `purchaseReturn.defaultQuantity`）✗
 *   ③ 🔴 **前端没有任何拦截** —— 一个都不勾也能点（要等后端 `return_empty` 才回人话）✗
 *   （brief 里"照她的交互做"那几条 ⇒ ① 补数量列 ② 默认值走配置 ③ 补前端拦截 ✓ 后端字段名一个字不动 ✓）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-RT0（**先把现状钉住**，免得后来人再照 brief 的字面结论白改一遍）
 *         退货块的**尺码勾选框 + 数量输入本来就有**（`return_sizes` / `return_qty_<尺码>`）✓
 *  AC-RT1 点退货 ⇒ 每个尺码一行：**尺码** · **当前库存数量**（来自扫码时已取到的 `sellable`）；
 *         库存为 0 ⇒ 显示「—」（与全页既有口径一致）；**取不到库存** ⇒ 如实说"未确认"，**不显示假数字** ✗
 *  AC-RT2 勾 2 个尺码 + 填数量 ⇒ **真提交**（POST）后写服务收到的 `entries` **恰好那两行**；
 *         字段名仍是既有配置（`return_sizes` / `return_qty_<尺码>`）⇒ **后端一个字没改** ✓
 *  AC-RT3 ⭐ 一个都不勾 ⇒ **前端就拦住**（`preventDefault` + 人话 + **不发请求**）✓（后端那道仍在 ✓）
 *  AC-RT4 ⭐ 退货数量非法（空 / 0 / 负 / 小数 / 超 `maxQuantity`）⇒ **前端拦住 + 人话**；
 *         勾超过 `maxSizes` 个尺码也拦住；**合法**（1..max）⇒ **不拦**（不许修过头 ✗）
 *  AC-RT5 尺码/库存取不到或为空 ⇒ **如实提示**（那句人话来自配置 ✓）、**不显示假尺码/假数量** ✗
 *  AC-RT6 既有判据一条没放宽：**补货那一块逐字不变**（`value="1"` 照旧、没有数量列）
 *         ＋ `scanPageSixRealms` / `scanPageRealmServerSide` / `scanPurchaseAmountRequired` 等既有文件**不改** ✓
 *
 * ❓ **不实现**（等业务负责人的口径，Lead 已去问）：退货数量**要不要限制"不能超过当前库存"** ⇒
 *    本文件**故意没有**那条（`AC-RT7` 留空）—— 现在只拦"非法数量"（正整数 + 配置上限 ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_return_sizes';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'return_sizes_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'return_sizes_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⭐⭐ 成对迁移（2026-10-16 · `SCAN_DRAFT_ENABLED` 缺省翻 true 之后）—— 本文件测的不是草稿：
//   它测的是 退货尺码清单（每码一行 / 勾选框 / 数量上限）。
//   🔴 **改前逐字**：本文件**不配** `SCAN_DRAFT_ENABLED` ⇒ 靠 `config/scanDraft.js` 的缺省拿到
//     "草稿关"（`resolveShared` 里那一行当时代码是：`const enabled = readFlag(env, 'SCAN_DRAFT_ENABLED', false);`）。
//   ✅ **改后逐字**：`process.env.SCAN_DRAFT_ENABLED = 'false';` ⇒ **显式**要"草稿关"。
//   ⭐ **依据** = 业务负责人 2026-10-16「**开关打开**」（同一行缺省已翻成 `true`）⇒ 缺省不再是关态，
//     所以"靠缺省"这条路**没有了**，必须自己写死。
//   ⚠️ **强度不变（不是放宽）**：页面上那一份输出与迁移前**逐字节相同** —— 迁移前缺省就是 `false`
//     （本文件在 main 上是绿的）；这里只把"碰巧的缺省"换成"自己声明的前置条件"，
//     断言**一条没删、一条没 skip、一条没放宽**；缺省再翻也不会静默改掉本文件的语义 ✓。
process.env.SCAN_DRAFT_ENABLED = 'false';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET;
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_return_sizes', name: '自检', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
})();

const NUMBER = 'N05|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

/** 扫码时**已经取到**的那个尺码/库存结构（`view.rows`）——40 有 3 双、41 缺码 0 双、42 有 1 双。 */
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'N05',
  color: '黑色',
  category_name: '休闲鞋',
  price_text: '¥399',
  total: 4,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: [
    { size_text: '40', cells: [{ count: 2 }, { count: 1 }], total: 3, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 0 }], total: 1, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-15 21:00',
  ...overrides,
});

/** 假写服务：只记她提交了什么（**不写任何表** ✓）。 */
const fakeWriteService = () => {
  const calls = [];
  return {
    calls,
    sessions: {
      get: async () => null,
      submitKeyFor: () => 'scan_return:probe:1',
      saveSaleProgress: async () => ({ ok: true }),
    },
    listAccessories: async () => [],
    submitPurchaseReturn: async (input) => {
      calls.push({ kind: 'submitPurchaseReturn', ...input });
      return { ok: true, batch_no: 'CGTH-1', detail_count: (input.entries || []).length };
    },
    ensurePurchaseAmount: async () => ({ ok: true }),
    writePurchaseAmount: async () => ({ ok: true }),
  };
};

const appFor = (write, lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.requestId = 'req_return_sizes'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup }, gateway: {}, writeService: write, startSnapshot: false,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const getReturnBlock = async (base, query = '?from=purchase_return') => {
  const response = await fetch(`${base}/s/${ENCODED}${query}`, { headers: { cookie: COOKIE } });
  const html = await response.text();
  const start = html.indexOf('realm-block--purchase_return');
  assert.notEqual(start, -1, '退货那一块必须在页面上');
  const end = html.indexOf('</section>', start);
  return { status: response.status, html, block: html.slice(start, end === -1 ? undefined : end + 10) };
};

/** 把一块 HTML 里的 `<div class="size-row">…</div>` 逐行切出来（要断"每行有尺码 + 数量"）。 */
const sizeRowsOf = (block) => [...block.matchAll(/<div class="size-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT0 现状：勾选框 + 数量输入**本来就有**（别照 brief 的字面结论白改一遍）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT0 退货块的**尺码勾选框 / 数量输入本来就有**（`return_sizes` / `return_qty_<尺码>`）', async () => {
  const write = fakeWriteService();
  let block;
  await withServer(appFor(write), async (base) => { block = (await getReturnBlock(base)).block; });
  assert.ok(block.includes(`name="${SCAN_WRITE.fields.returnSizes}"`), '勾选框字段名走既有配置 ✓');
  // ⭐⭐ task-28（2026-10-15 她逐字：「退货严格按照实时库存里的数据来，**只展示有数量的尺码**」）
  //   ⚠️ 逐字记录（改前 → 改后 → 依据）：
  //     改前逐字：`for (const size of ['40', '41', '42']) {`（**41 码库存 0 也列**）
  //     改后逐字：`for (const size of ['40', '42']) {`（只遍历**有数量**的码）＋ 下面那条"41 不列"的断言
  //     依据：她 2026-10-15 逐字（同上）＋「（缺码）现在也退不了 …… 只展示有数量的尺码」
  //     ⇒ **判据没丢**：字段名的判据仍在（只是对象 = 列出来的那些码），**额外多钉一条"0 不列"** ✓
  for (const size of ['40', '42']) {
    assert.ok(block.includes(`value="${size}"`), `${size} 码要列出来 ✓`);
    assert.ok(block.includes(`name="${SCAN_WRITE.fields.returnQuantityPrefix}${size}"`), `${size} 要有自己的数量输入 ✓`);
  }
  assert.equal(block.includes('value="41"'), false, '⭐ 库存 0 的码（41）**不列**（能真红）✓');
  assert.ok(block.includes(`value="${SCAN_WRITE.actions.purchaseReturn}"`), '退货动作名走既有配置 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT1 每行要有「尺码 + 当前库存数量」（她原话要的就是这个）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT1 ⭐ 每个尺码一行：**尺码** + **当前库存数量**（0 用「—」；来自扫码已取到的 `sellable`）', async () => {
  const write = fakeWriteService();
  let block;
  await withServer(appFor(write), async (base) => { block = (await getReturnBlock(base)).block; });
  const rows = sizeRowsOf(block);
  // ⚠️ 逐字记录（改前 → 改后 → 依据）：
  //   改前逐字：`assert.equal(rows.length, 3, '三个尺码三行 ✓');` ＋ `assert.match(rowFor('41'), /—/, ...)`
  //   改后逐字：`assert.equal(rows.length, 2, '只列有数量的两个码 ✓');` ＋ 下面那条"41 不列"
  //   依据：她 2026-10-15 逐字「**只展示有数量的尺码**」⇒ 0 库存的码**不进清单**（不是显示「—」✗）；
  //     ⚠️ 判据没丢：每行"尺码 + 当前库存数量"这条照旧断言（只是对象少了一个 0 库存的码 ✓）。
  assert.equal(rows.length, 2, '只列**有数量**的两个码（40 / 42）✓');
  assert.equal(block.includes('value="41"'), false, '⛔ 库存 0 的 41 码不进清单 ✓');
  const rowFor = (size) => rows.find((row) => row.includes(`value="${size}"`));
  // 40 ⇒ 库存 3（门盒 2 + 样品 1）；42 ⇒ 1
  assert.match(rowFor('40'), /3/, '40 码要显示当前库存数量 3 ✓（能真红：删掉数量列 ⇒ 红）');
  assert.match(rowFor('42'), /1/, '42 码要显示 1 ✓');
  // 数量列必须**只**是这个数（别把别的东西当数量）：钉住一个稳定的锚点
  assert.ok(block.includes('data-view="return-stock"'), '数量列有个稳定锚（测试/真机都对得上）✓');
  // ⚠️ 这一行仍是"勾选 + 数量输入"，与补货**同形**（她是对照着看的 ✓）
  assert.ok(rowFor('40').includes('type="checkbox"'), '还是勾选框 ✓');
  assert.ok(rowFor('40').includes('size-qty'), '还是数量输入 ✓');
  // ⭐ 数量默认值**走配置**（不是写死 1）：钉住"渲染层确实读了写侧那一份配置" ✓
  //   （能真红：把 `defaultQuantity` 写回字面量 1 ⇒ 这条红）
  const rendererSrc = rendererSource();
  assert.match(rendererSrc, /defaultQuantity: returnConfig\.defaultQuantity/,
    '⭐ 退货数量默认值来自 `SCAN_WRITE.purchaseReturn.defaultQuantity`（唯一真源 ✓）');
  assert.equal(SCAN_WRITE.purchaseReturn.defaultQuantity, 1, '（当前配置值就是 1；换值不用改代码 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT2 勾 2 个 + 填数量 ⇒ 真提交 ⇒ 写服务收到**恰好那两行**（后端字段名一个没改）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT2 ⭐ 勾 2 个尺码 + 填数量 ⇒ 提交后 `entries` **恰好那两行**（后端字段名一个字没改）', async () => {
  const write = fakeWriteService();
  await withServer(appFor(write), async (base) => {
    const body = new URLSearchParams();
    body.append('action', SCAN_WRITE.actions.purchaseReturn);
    body.append(SCAN_WRITE.fields.submitKey, 'scan_return:probe:1');
    body.append(SCAN_WRITE.fields.purchaseAmount, '798');   // 退货整单金额（必填，既有闸门 ✓）
    body.append(SCAN_WRITE.fields.returnSizes, '40');
    body.append(SCAN_WRITE.fields.returnSizes, '42');
    body.append(`${SCAN_WRITE.fields.returnQuantityPrefix}40`, '2');
    body.append(`${SCAN_WRITE.fields.returnQuantityPrefix}42`, '1');
    const response = await fetch(`${base}/s/${ENCODED}?from=purchase_return`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    assert.ok(response.status === 200 || response.status === 303, `提交不该报错（实际 ${response.status}）`);
    await response.text().catch(() => '');
  });
  const call = write.calls.find((item) => item.kind === 'submitPurchaseReturn');
  assert.ok(call, '要真的调到退货写服务 ✓');
  assert.deepEqual(call.entries, [{ size: '40', quantity: '2' }, { size: '42', quantity: '1' }],
    '⭐ 勾了哪两个码、各自几双，原样到写服务（能真红）');
  // ⭐ 没勾的尺码**不许**混进去（41 码一个字段都没带 ⇒ 不许凭空补一行 ✗）
  assert.equal(call.entries.some((entry) => entry.size === '41'), false, '没勾的码不许进 entries ✗');
});

test('AC-RT2b `parseReturnEntries`：勾了但没填数量 ⇒ 按配置的 `defaultQuantity`（既有语义没动）', () => {
  const { parseReturnEntries } = require('../src/routes/scanPage');
  const entries = parseReturnEntries(
    { [SCAN_WRITE.fields.returnSizes]: ['40', '42'] }, SCAN_WRITE.fields, SCAN_WRITE,
  );
  assert.deepEqual(entries, [
    { size: '40', quantity: SCAN_WRITE.purchaseReturn.defaultQuantity },
    { size: '42', quantity: SCAN_WRITE.purchaseReturn.defaultQuantity },
  ], '没填数量 ⇒ 既有兜底（配置值）✓ —— 这条**后端语义一个字没改** ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 页面那段**唯一**脚本的行为（AC-RT3 / AC-RT4）——
//   ⚠️ 用 `vm` 把**页面里真实那段脚本**跑起来，配一个**最小假 DOM**（只实现脚本用到的那几个 API）。
//      判据是**行为**（`preventDefault` 有没有被调 + 人话有没有被填上），不是"源码里有没有那段字" ✓
// ═══════════════════════════════════════════════════════════════════════════

/** 极简假元素：只实现脚本用到的那几个 API（`[name=…]` / `button[type=submit]` 两种选择器）。 */
const fakeElement = (attrs = {}, opts = {}) => {
  const element = {
    tagName: opts.tagName || 'div',
    className: '',
    textContent: opts.textContent || '',
    value: opts.value === undefined
      ? String(attrs.value === undefined ? '' : attrs.value)   // `<input value="40">` ⇒ `.value === '40'` ✓
      : String(opts.value),
    checked: Boolean(opts.checked),
    disabled: false,
    _attrs: { ...attrs },
    _children: [],
    _focused: false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    removeAttribute(name) { delete this._attrs[name]; },
    _handlers: [],
    addEventListener(type, handler) { this._handlers.push({ type, handler }); },
    focus() { this._focused = true; },
    appendChild(node) { this._children.push(node); return node; },
    insertBefore(node) { this._children.unshift(node); return node; },
    closest() { return null; },
    matchesSelector(selector) {
      const nameMatch = selector.match(/^\[name="(.*)"\]$/);
      if (nameMatch) return this.getAttribute('name') === nameMatch[1];
      const viewMatch = selector.match(/^\[data-view="(.*)"\]$/);
      if (viewMatch) return this.getAttribute('data-view') === viewMatch[1];
      const buttonMatch = selector.match(/^button\[type="(.*)"\]$/);
      if (buttonMatch) return this.tagName === 'button' && this.getAttribute('type') === buttonMatch[1];
      return false;
    },
    querySelector(selector) {
      if (this.matchesSelector(selector)) return this;
      for (const child of this._children) {
        const hit = child.querySelector(selector);
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        if (node.matchesSelector(selector)) out.push(node);
        for (const child of node._children) visit(child);
      };
      for (const child of this._children) visit(child);
      return out;
    },
  };
  return element;
};

/** 把页面里那段脚本跑起来，返回"提交那一刻"的观察结果。 */
const runSubmitGuard = (html, form) => {
  const start = html.indexOf('<script data-view="submit-feedback">');
  assert.notEqual(start, -1, '页面必须有那段（唯一）脚本');
  const script = html.slice(start + '<script data-view="submit-feedback">'.length, html.indexOf('</script>', start));
  const head = fakeElement({}, { tagName: 'body' });
  head._children.push(form);
  const sandbox = {
    document: {
      querySelectorAll: (selector) => (selector === 'form' ? [form] : head.querySelectorAll(selector)),
      createElement: (tag) => fakeElement({}, { tagName: tag }),
      addEventListener: () => {},
    },
    navigator: {},
    location: { pathname: '/' },
    window: null,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    console: { log: () => {}, warn: () => {} },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  let prevented = false;
  // ⚠️ 脚本是挂在**这个表单**上的（`forms[i].addEventListener('submit', …)`）——
  //    所以从**表单自己**记下的处理器里找（不是 document 那一层的埋点处理器 ✓）。
  const submitHandler = form._handlers.find((item) => item.type === 'submit');
  assert.ok(submitHandler, '脚本要在这个表单上挂 submit 处理器 ✓');
  const event = {
    target: form,
    defaultPrevented: false,
    preventDefault() { prevented = true; this.defaultPrevented = true; },
  };
  submitHandler.handler(event);
  return {
    prevented,
    hint: form.querySelector('[data-view="return-form-hint"]'),
    submitButton: form.querySelector('button[type="submit"]'),
  };
};

/** 照**页面真实属性**搭一个退货表单（属性值全部从渲染结果里抄 ⇒ 判据不是"另写一份"✓）。 */
const returnFormFrom = (html, { checked = [], quantities = {} } = {}) => {
  // ⚠️ **切片边界的迁移（2026-10-16 晚 · 与"退货块去折叠壳"同一刀）** —— AC-RT3 / AC-RT4 / AC-RT7 /
  //    AC-RT7b 四条都经这个工具，所以边界只在这里改一次（**判据本身一个字没放宽** ✓）：
  //   改前逐字：
  //     const start = html.indexOf('data-view="purchase-return"');
  //     const formTag = html.slice(html.indexOf('<form', start), html.indexOf('>', html.indexOf('<form', start)) + 1);
  //   改后逐字：下面这五行
  //   依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //     ⇒ 退货块的 `<details class="disclosure" data-view="purchase-return" open>` 与 `<summary …>` 两行**删掉**；
  //       ⭐ 定位标记 `data-view="purchase-return"` **迁到 `<form>` 自己的属性行上**（标记不许删 ✗）
  //   ⇒ 旧写法从锚**往后**找 `<form`：锚已在**本表单自己的属性行里** ⇒ 找不到本表单（返 -1）
  //     ⇒ `formTag` 切出空串 ⇒ `data-return-sizes-field` 抄不到 ⇒ 四条判据在这里**假红** ✗
  //   ⇒ 起点要在锚**之前**找回那个 `<form>`（`lastIndexOf` ✓）；两条 `assert.notEqual` 是**加严**：
  //     锚被删 / 标记没挂在 `<form>` 上 ⇒ 当场红，**绝不让切片静默空跑**（空切片 = 假绿 ✗）
  const start = html.indexOf('data-view="purchase-return"');
  assert.notEqual(start, -1, '退货表单的定位标记必须在（标记被删 ⇒ 这里就该红，别让切片静默空跑 ✗）');
  const formStart = html.lastIndexOf('<form', start);
  assert.notEqual(formStart, -1, '定位标记必须挂在那个 `<form>` 上（结构变了 ⇒ 红 ✓）');
  const formTag = html.slice(formStart, html.indexOf('>', formStart) + 1);
  const attrs = {};
  for (const match of formTag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  const form = fakeElement(attrs, { tagName: 'form' });
  // 页面里那个"人话槽"（`<p class="hint" data-view="return-form-hint" hidden>`）——照真实结构摆上 ✓
  form._children.push(fakeElement({ 'data-view': attrs['data-return-hint-view'] }, { tagName: 'p' }));
  const sizesField = attrs['data-return-sizes-field'];
  assert.ok(sizesField, '退货表单要带 `data-return-sizes-field`（脚本靠它认这块 ✓）');
  const qtyPrefix = attrs['data-return-qty-prefix'];
  assert.ok(qtyPrefix, '退货表单要带 `data-return-qty-prefix` ✓');
  for (const size of ['40', '41', '42']) {
    // ⚠️ **逐字照页面上的那一行抄**（`data-qty-name` / `data-stock` 都从渲染结果里取 ✓）——
    //   自己拼一份属性清单就会"测出一个页面上并不存在的行为"✗（我第一版就漏了 `data-stock` ⇒ 涨红过）。
    const checkboxTag = (html.match(new RegExp(`<input type="checkbox"[^>]*name="${sizesField}"[^>]*value="${size}"[^>]*>`)) || [])[0] || '';
    const checkboxAttrs = { name: sizesField, value: size };
    for (const match of checkboxTag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) checkboxAttrs[match[1]] = match[2];
    if (!checkboxAttrs['data-qty-name']) checkboxAttrs['data-qty-name'] = `${qtyPrefix}${size}`;
    form._children.push(fakeElement(checkboxAttrs, { tagName: 'input', checked: checked.includes(size) }));
    form._children.push(fakeElement({ name: `${qtyPrefix}${size}` }, {
      tagName: 'input', value: quantities[size] === undefined ? String(SCAN_WRITE.purchaseReturn.defaultQuantity) : quantities[size],
    }));
  }
  form._children.push(fakeElement({ type: 'submit', 'data-submit-feedback': '正在提交…' }, { tagName: 'button' }));
  return form;
};

test('AC-RT3 ⭐ 一个都不勾 ⇒ **前端就拦住**（`preventDefault` + 人话 + **不发请求**）', async () => {
  // ⚠️ **切片边界迁移（2026-10-16 晚 · 与退货块去折叠壳同一刀）** —— 本用例的表单夹具走共享工具 `returnFormFrom`：
  //   改前逐字：`html.indexOf('<form', start)`（从锚 `data-view="purchase-return"` **往后**找表单）
  //   改后逐字：`html.lastIndexOf('<form', start)`（锚已迁到 `<form>` 自己的属性行上 ⇒ 起点要在锚**之前**找）
  //   依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //     ⇒ `<details>` / `<summary>` 删掉、标记迁到 `<form>`；本用例的判据（拦住 / 人话 / 不置灰）一个字没放宽 ✓
  const write = fakeWriteService();
  let html;
  await withServer(appFor(write), async (base) => { html = (await getReturnBlock(base)).html; });
  const result = runSubmitGuard(html, returnFormFrom(html, { checked: [] }));
  assert.equal(result.prevented, true, '⭐ 一个都没勾 ⇒ 必须拦住（能真红：删掉那段判据 ⇒ 红）');
  assert.ok(result.hint, '要给她一句人话（不新增第二段脚本 ✓）');
  assert.equal(result.hint.textContent, SCAN_PAGE.returnForm.sizesRequiredText,
    '人话来自配置（`config/scanPage.js`）✓');
  assert.equal(result.submitButton.disabled, false, '被拦住时**不许**把按钮置灰（她改一下就能再点 ✓）');
  // ⚠️ 后端那道**仍在**（两层都有 ✓）：源码哨兵 —— 写服务里的 return_empty 一个字没动
  const writeSrc = fs.readFileSync(path.join(__dirname, '../src/services/scanWriteService.js'), 'utf8');
  assert.match(writeSrc, /return_empty/, '后端那道 `return_empty` 不许删（前端拦是"更早"、不是"替代"✓）');
});

test('AC-RT4 ⭐ 退货数量非法 ⇒ 前端拦住 + 人话；**合法 ⇒ 不拦**（不许修过头 ✗）', async () => {
  // ⚠️ **切片边界迁移（2026-10-16 晚 · 与退货块去折叠壳同一刀）** —— 本用例的表单夹具走共享工具 `returnFormFrom`：
  //   改前逐字：`html.indexOf('<form', start)`（从锚 `data-view="purchase-return"` **往后**找表单）
  //   改后逐字：`html.lastIndexOf('<form', start)`（锚已迁到 `<form>` 自己的属性行上 ⇒ 起点要在锚**之前**找）
  //   依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //     ⇒ `<details>` / `<summary>` 删掉、标记迁到 `<form>`；本用例的判据（非法拦 / 合法放 / 人话）一个字没放宽 ✓
  const write = fakeWriteService();
  let html;
  await withServer(appFor(write), async (base) => { html = (await getReturnBlock(base)).html; });
  const max = SCAN_WRITE.purchaseReturn.maxQuantity;
  const bad = ['', '0', '-1', '1.5', 'abc', String(max + 1)];
  for (const raw of bad) {
    const result = runSubmitGuard(html, returnFormFrom(html, { checked: ['40', '42'], quantities: { 40: raw, 42: '1' } }));
    assert.equal(result.prevented, true, `数量 "${raw}" 必须拦住 ✓`);
    assert.equal(result.hint.textContent, SCAN_PAGE.returnForm.quantityInvalidText, '人话来自配置 ✓');
  }
  // 合法：1 / **这一行的库存上限**（40 码库存 3），都**不许**拦（否则她正常退货被挡 ✗）
  //   ⚠️ 这里**故意不写 `String(max)`（99）** —— 她 2026-10-15 晚定了"不许超过当前库存"，
  //      99 对 40 码（库存 3）**已经是非法的**了 ⇒ 拿它当"合法样例"就自相矛盾 ✗（我第一版就是这么错的）。
  for (const raw of ['1', '3']) {
    const result = runSubmitGuard(html, returnFormFrom(html, { checked: ['40'], quantities: { 40: raw } }));
    assert.equal(result.prevented, false, `数量 "${raw}"（≤ 库存 3）是合法的 ⇒ 不许拦 ✗`);
  }
  assert.ok(max >= 1, `上限配置仍在（${max}）—— 它管的是"单次最多几双"那一条 ✓`);
  // 勾太多（> maxSizes）也拦住
  const many = Array.from({ length: SCAN_WRITE.purchaseReturn.maxSizes + 1 }, (_, index) => `S${index}`);
  const form = returnFormFrom(html, { checked: [] });
  const sizesField = form.getAttribute('data-return-sizes-field');
  const qtyPrefix = form.getAttribute('data-return-qty-prefix');
  for (const size of many) {
    form._children.push(fakeElement({ name: sizesField, value: size, 'data-qty-name': `${qtyPrefix}${size}` }, { tagName: 'input', checked: true }));
    form._children.push(fakeElement({ name: `${qtyPrefix}${size}` }, { tagName: 'input', value: '1' }));
  }
  const tooMany = runSubmitGuard(html, form);
  assert.equal(tooMany.prevented, true, `勾超过 ${SCAN_WRITE.purchaseReturn.maxSizes} 个码 ⇒ 拦住 ✓`);
  assert.equal(tooMany.hint.textContent, SCAN_PAGE.returnForm.sizesLimitText, '人话来自配置 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT5 取不到库存 ⇒ 如实说，不显示假数字
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT5 尺码取不到 / 库存取不到 ⇒ **如实提示**（那句人话来自配置），不显示假数字 ✗', async () => {
  const write = fakeWriteService();
  // ① 尺码这一读**没取到**（`view.rows` 空 ⇒ 连 `write.sizes` 也是空的）⇒
  //    退货那一块**仍在**、如实说一句人话、**绝不硬编一串假尺码 / 假数量** ✗
  let emptyBlock;
  await withServer(appFor(write, async () => view({ rows: [], total: 0, missing_count: 0 })), async (base) => {
    emptyBlock = (await getReturnBlock(base)).block;
  });
  assert.ok(emptyBlock.includes('realm-block--purchase_return'), '退货那一块仍在（不许整块消失 ✗）✓');
  assert.ok(emptyBlock.includes(SCAN_PAGE.returnForm.sizesUnknown), '⭐ 尺码取不到 ⇒ 如实说 ✓');
  assert.equal(sizeRowsOf(emptyBlock).length, 0, '⛔ 不许编尺码（能真红：随手写死几个码 ⇒ 红）');
  // ② 尺码有、**库存没有**（渲染层的兜底：`sellable` 不是数字）⇒ 那一格如实说"取不到"，**不显示假数字** ✗
  const { renderScanPage } = require('../src/views/scanPageRenderer');
  const fallbackWrite = {
    enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: '/s/x?from=purchase_return', returnKey: 'scan_return:k:1',
    sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  };
  const html = renderScanPage(view({ rows: [] }), SCAN_PAGE, fallbackWrite, 'purchase_return', {});
  const start = html.indexOf('realm-block--purchase_return');
  const block = html.slice(start, html.indexOf('</section>', start) + 10);
  assert.equal(sizeRowsOf(block).length, 2, '尺码要列出来（她能勾）✓');
  assert.ok(block.includes(SCAN_PAGE.returnForm.stockUnknown), '⭐ 库存取不到 ⇒ 如实说一句人话 ✓');
  assert.equal(/data-view="return-stock"[^>]*>\s*\d/.test(block), false,
    '⛔ **不许**拿假数字冒充库存（能真红：写死一个数 ⇒ 红）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT7 ⭐⭐ 她的拍板（2026-10-15 晚，逐字）：「退货数量要限制"不能超过当前库存数量"」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT7 ⭐⭐ 退货数量**不许超过当前库存**：库存 2 填 3 ⇒ 拦住（人话带尺码与库存）；填 2 ⇒ 放行', async () => {
  // ⚠️ **切片边界迁移（2026-10-16 晚 · 与退货块去折叠壳同一刀）** —— 本用例的表单夹具走共享工具 `returnFormFrom`：
  //   改前逐字：`html.indexOf('<form', start)`（从锚 `data-view="purchase-return"` **往后**找表单）
  //   改后逐字：`html.lastIndexOf('<form', start)`（锚已迁到 `<form>` 自己的属性行上 ⇒ 起点要在锚**之前**找）
  //   依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //     ⇒ `<details>` / `<summary>` 删掉、标记迁到 `<form>`；本用例的判据（超库存拦 / 等于库存放 / 逐码算）一个字没放宽 ✓
  const write = fakeWriteService();
  let html;
  await withServer(appFor(write), async (base) => { html = (await getReturnBlock(base)).html; });
  // 这一版的 `view()`：40 码有 3 双 · 41 码 0 双 · 42 码 1 双
  // ① 40 码库存 3、填 4 ⇒ 拦住，且**人话里带上尺码与库存**
  const over = runSubmitGuard(html, returnFormFrom(html, { checked: ['40'], quantities: { 40: '4' } }));
  assert.equal(over.prevented, true, '超过库存 ⇒ 必须当场拦住（能真红）✓');
  assert.equal(over.hint.textContent, SCAN_PAGE.returnForm.stockLimitText
    .split('{size}').join('40').split('{stock}').join('3'),
  '人话要带"哪个码、库存几双"（配置模板 + 客户端填 ✓）');
  // ② 正好等于库存 ⇒ **放行**（不许修过头 ✗）
  const equal = runSubmitGuard(html, returnFormFrom(html, { checked: ['40'], quantities: { 40: '3' } }));
  assert.equal(equal.prevented, false, '等于库存是合法的 ⇒ 不许拦 ✗');
  // ③ 42 码库存 1、填 2 ⇒ 拦住（不同尺码各自算，别拿整款总数糊弄）
  const otherSize = runSubmitGuard(html, returnFormFrom(html, { checked: ['42'], quantities: { 42: '2' } }));
  assert.equal(otherSize.prevented, true, '按**这一行**的库存判 ✓');
  assert.equal(otherSize.hint.textContent, SCAN_PAGE.returnForm.stockLimitText
    .split('{size}').join('42').split('{stock}').join('1'), '人话里的尺码/库存要对应这一行 ✓');
  // ④ 库存 0 的码（41 码缺码）—— ⚠️ **逐字记录（改前 → 改后 → 依据）**：
  //   改前逐字：断言"41 码库存 0 ⇒ 拦住 + 人话说库存 0"（那时 41 还在清单里）
  //   改后逐字：断言"41 码**根本不在清单里**"（`returnFormFrom` 拿不到它的勾选框 ⇒ 她勾不到 ✓）
  //   依据：她 2026-10-15 逐字「只展示有数量的尺码」⇒ 0 库存的码**不进清单**；
  //     判据没丢：那一条"0 库存不能退"现在由"**不列**"承载（更彻底 ✓），并且**不许被 0 库存的码勾选** ✓
  assert.equal(html.includes('value="41"'), false, '⭐ 0 库存的码不列（她勾不到 ⇒ 也退不了 ✓）');
});

test('AC-RT7b ⭐ 库存**取不到**的行：**不许拿 0 当库存**拦住她（只显示"取不到"那句人话 ✓）', async () => {
  // ⚠️ **切片边界迁移（2026-10-16 晚 · 与退货块去折叠壳同一刀）** —— 本用例的表单夹具走共享工具 `returnFormFrom`：
  //   改前逐字：`html.indexOf('<form', start)`（从锚 `data-view="purchase-return"` **往后**找表单）
  //   改后逐字：`html.lastIndexOf('<form', start)`（锚已迁到 `<form>` 自己的属性行上 ⇒ 起点要在锚**之前**找）
  //   依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //     ⇒ `<details>` / `<summary>` 删掉、标记迁到 `<form>`；本用例的判据（取不到 ⇒ 不许按 0 拦 / 如实说）一个字没放宽 ✓
  const { renderScanPage } = require('../src/views/scanPageRenderer');
  const fallbackWrite = {
    enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: '/s/x?from=purchase_return', returnKey: 'scan_return:k:1',
    sizes: [{ size_text: '40', missing: false }, { size_text: '42', missing: false }],
  };
  const html = renderScanPage(view({ rows: [] }), SCAN_PAGE, fallbackWrite, 'purchase_return', {});
  const result = runSubmitGuard(html, returnFormFrom(html, { checked: ['40'], quantities: { 40: '5' } }));
  assert.equal(result.prevented, false, '⛔ 库存取不到 ⇒ **不许**按 0 拦（否则她一律退不了 ✗）');
  assert.ok(html.includes(SCAN_PAGE.returnForm.stockUnknown), '但页面上要如实说"库存取不到"✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RT6 既有判据没放宽（补货那一块逐字不变）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT6 补货那一块**逐字不变**（`value="1"` 照旧、没有数量列）—— 视觉对齐不等于"顺手改它" ✗', async () => {
  const write = fakeWriteService();
  let replenishBlock;
  await withServer(appFor(write), async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}?from=replenish`, { headers: { cookie: COOKIE } });
    const html = await response.text();
    const start = html.indexOf('realm-block--replenish');
    replenishBlock = html.slice(start, html.indexOf('</section>', start) + 10);
  });
  assert.ok(replenishBlock.includes(`name="${SCAN_WRITE.fields.replenishSizes}"`), '补货勾选框名照旧 ✓');
  assert.equal(replenishBlock.includes('data-view="return-stock"'), false, '补货块**不许**多出退货的数量列 ✗');
  assert.ok(replenishBlock.includes(
    `name="${SCAN_WRITE.fields.replenishQuantityPrefix}40" value="1"`,
  ), `补货数量默认值**逐字**还是 1 ✓（字段名走配置：${SCAN_WRITE.fields.replenishQuantityPrefix}40）`);
});
