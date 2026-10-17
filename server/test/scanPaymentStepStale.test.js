'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ task-21（2026-10-15 晚 · 她真机 20:22，逐字）：
 *   「我扫码一双鞋点击销售，出来的是**资金页面**」
 *
 * ## 根因（Lead 用**生产日志 + 她的会话文件 + 代码**三方对齐，确证）
 * 她的会话文件当时是：`{"sale.paymentStep":"pending", "sale.status":"submitted", "lines":0, "submitPending":true}`
 * ⇒ `routes/scanPage.js` 那段"**刷新仍给资金页**"的接管：
 *   · ⭐ 2026-10-14 晚**已修一半**：只对**销售上下文**（`from` 为空 / `=sales`）接管
 *     ⇒ 她点库存 / 补货 / 退货不再被劫持 ✓（`test/scanPaymentStepRealmScope.test.js` 钉着）；
 *   · 🔴 **另一半没修**：接管**只看标记**、**不看"有没有东西要付"** ✗ ⇒ 草稿 **0 行**、也没有
 *     已建单号（**残标记**）照样给资金页 ⇒ **她之后每一次扫码、点销售，都被顶到那一页** ✗✗。
 *
 * ## 修法（**只收紧**，沿用 10-14 那次同一风格 ✓）
 * "**有东西要付**"才接管 —— 两种，都是**既有语义**（**不新造状态值** ✗）：
 *   ① 草稿里有行（`sale.lines.length > 0`）✓ 她刚填完、要在资金页接着付（刷新不丢 ✓）
 *   ② **已经建过单**（`sale.order_no` / `sale.master_record_id`）✓ 单在那儿、钱还没付完
 * 两者都没有 ⇒ **不给资金页** + **清掉残标记**（清成"**这个键不在**" —— 那是
 *   `services/scanSessionService.js` 默认 `sale` 的形状 ✓ 既有表示，不是新值 ✓）
 *   + 如实记 `scan.payment_step.stale_cleared`（带 requestId / openId / 原值 / 行数 / 有没有单号）。
 *
 * ## 验收标准（**先写后做**；每条能真红）
 * · **AC-SM1** `pending` + 草稿 **0 行**（无单号）⇒ 三条一起断：
 *   **不给资金页**（HTML 里没有 `data-view="payment-step"`，是正常销售块）
 *   ＋ **标记被清**（`{paymentStep: undefined}` 那一笔 patch 真的发出去了）
 *   ＋ **有一条 `scan.payment_step.stale_cleared` 日志**（**删掉任何一条就红** ✓）
 * · **AC-SM2** `pending` + 草稿 **有 N 行** ⇒ **照旧给资金页**（`data-view="payment-step"` + `count=N`），
 *   而且**不许**清标记（把 ① 的判据写宽（例如只按 `pending` 接管）也会红 ✓）
 * · **AC-SM2b**（⭐ 2026-10-16 **成对迁移 · task-60**）：`?from=sales`（= 她点「销售」那一下）+
 *   草稿有行 ⇒ 按**她当日亲口选的方案 ②** 改成 **货品页 ＋ 清掉那条未完成**（改前逐字 → 改后逐字 →
 *   依据都写在那条用例上 ✓）；⚠️ **"资金页刷新不丢"照旧由 AC-SM2 / AC-SM8 的【裸扫】那两条钉着** ✓
 * · **AC-SM3** `pending` + **有已建单号**（`order_no` / `master_record_id`）但没付 ⇒ **照旧给资金页** ✓
 * · **AC-SM4** 非销售领域（`from=inventory|replenish|return`）⇒ **一律不接管**（既有行为不变 ✓，
 *   且**不许**顺手清标记 —— 那不是这一块的账 ✗）
 * · **AC-SM5** 清掉之后**再扫一次** ⇒ 正常扫码页（回归：不再被顶到资金页 ✓）
 * ── task-22（2026-10-15 晚 · **#598 引入的一处回退**）─────────────────────────
 *   #598 的判据只管"0 行 + 没单号 + status=submitted"，却**没注意**：提交那一步**从来不写 `status`** ✗
 *   ⇒ 上一单 `completeSale` 落的 `submitted` 会留到**第 2 单** ⇒ "刚提交、正停在资金页"恰好长成
 *     残标记的样子 ⇒ 第 2 单在资金页**刷新一下**就被打回录入页 ✗
 *   ⇒ 修法：提交那一步 `status` 落回 `draft`（这一单正在走 ✓）⇒ 两个状态彻底分开 ✓
 * · **AC-SM8** 上一单 `submitted` + 新提交 ⇒ 刷新**仍是资金页**、**不许清标记**（去掉"落 draft"就红 ✓）
 * · **AC-SM9** 提交那一步 `status` 落成 **`draft`**（真配置路径 `writeConfig.session.statuses` ✓，能真红）
 * · **AC-SM10** 「重启补跑」扫描**不受影响**（`draft` + 没单号 / 草稿空 ⇒ 不当待补跑；对照组照样报得出来 ✓）
 * · **AC-SM11** `submitPending` **同一笔**清掉，且**不影响**正常提交后点按钮建单（能真红）
 * · **AC-SM6** 既有用例**判据一条没放宽**：`scanPaymentStepRealmScope.test.js` 那两条源码哨兵
 *   （`pendingMark === 'pending' && salesContext` / `from` 的两个取值）**逐字仍在** ✓
 *
 * ⚠️ 本文件是**新建**的：`server/test/**` 同时有 task-17/18/19 在改（写作用域重叠）⇒ 按 Lead 的
 *    "scan 相关；新文件优先" 办 —— **一个字都不去动别人的用例文件** ✓。
 * ⚠️ 用**真的**扫码路由（准入闸门是它的第一层）+ 假 service / 假 writeService ⇒ 走的是**生产那条路** ✓。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// 路由模块在 require 时就会 `new V1BitableGateway()`（构造时读飞书凭证）；给一对假凭证只为能加载。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_payment_stale';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_payment_stale_secret';

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const SESSION_SECRET = 'scan_payment_stale_test_secret';
// 她真机那双（Lead 的生产日志里就是 `N05`）。
const NUMBER = 'N05|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const OPEN_ID = 'ou_scan_stale_user';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

/** 与 `routes/feishuWebAuth.js` 的 encodeSession 同一套签名（"造一个已登录的会话"）。 */
const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // ⭐ 2026-10-15 task-17（AC-P1）：测试服务器**不保持 keep-alive** ——
  //   undici 的进程级连接池按 origin 池化，临时端口会被 OS 复用 ⇒ 下一次 fetch 可能挑到**已死 socket**
  //   ⇒ 偶发 `ECONNRESET`（根因与实测见 `test/stabilityRepro.cjs`）⇒ 响应一完就关连接。
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** 一条"商品找得到"的只读视图（够渲染销售块）。 */
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'N05',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-15 20:22',
  ...overrides,
});

/**
 * 假 writeService —— **会话是可变的**（`saveSaleProgress` 真的把 patch 合进去），
 * 这样"清掉标记之后再扫一次"（AC-SM5）才是**真跑了一遍**，不是"看着像清掉了" ✓。
 */
const fakeWriteService = (sale = {}) => {
  const patches = [];
  const calls = [];
  const session = { sale: { ...sale } };
  const sessions = {
    async get() { return { sale: { ...session.sale } }; },
    async submitKeyFor() { return 'scan_sale:key:1'; },
    async saveSaleProgress(unusedOpenId, patch) {
      patches.push(patch);
      // 与 store 的 `JSON.stringify` 同一口径：`undefined` 的键**就是没有**（键消失 ✓）。
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) delete session.sale[key];
        else session.sale[key] = value;
      }
      return { sale: { ...session.sale } };
    },
  };
  return {
    patches,
    session,
    sessions,
    saveDraftLines: (openId, patch) => sessions.saveSaleProgress(openId, patch),
    listAccessories: async () => [],
    // AC-SM11 用：点资金页按钮**才**建单（这里只记一笔，回一个像真的结果 ✓）
    submitSale: async (input) => {
      calls.push({ kind: 'submitSale', submitKey: input?.submitKey });
      return { ok: true, order_no: 'XSD-SM11', sales_entry_record_id: 'rec_sm11', payment_count: 0 };
    },
    calls,
  };
};

const appFor = ({ write, realmLookup = async () => view() } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // ⚠️ 生产里每个请求都带 `req.requestId`（`app.js` 的中间件）⇒ 这里照摆一个，
  //    "日志里带 requestId" 这条判据才是**真跑出来的**（不是靠断言放宽 ✓）。
  app.use((req, res, next) => { req.requestId = 'req_scan_payment_stale'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: realmLookup },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  }));
  return app;
};

/** 她点「提交这一单」那一下（POST，带选中的尺码 —— 就是生产里那个表单）。 */
const submitOrder = (base, extra = {}) => fetch(`${base}/s/${ENCODED}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    action: SCAN_WRITE.actions.submitOrder,
    [SCAN_WRITE.fields.size]: '41',
    // ⭐⭐ 2026-10-16【迁移 · **补环境**】（task-53 · P0 第二刀）：
    //   · 改前逐字：这一发**只带尺码**（`[SCAN_WRITE.fields.size]: '41'`，一分钱都不带）
    //   · 改后逐字：`[SCAN_WRITE.fields.amount]: '399',`（**只补这一行输入**；下面所有断言**逐字不动** ✗）
    //   · 依据 = 业务负责人 2026-10-16 逐字「**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
    //     才可以点击提交跳转到资金页」⇒ **真机她这一下必然带着尺码和金额**（同一个表单）；
    //     本文件主题是"提交那一步写 `paymentStep`/`status`、刷新仍是资金页"（AC-SM8/9/11），
    //     与"她填了多少钱"无关 ⇒ 补上她本来就会填的金额 = **补环境**
    //     （与本文件先前补 `requestId` 同一手法 ✓）——**判据强度一点没降** ✓。
    [SCAN_WRITE.fields.amount]: '399',
    ...extra,
  }).toString(),
});

/** 她在资金页点那颗按钮（`payment_pay`）。 */
const payOrder = (base, extra = {}) => fetch(`${base}/s/${ENCODED}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    action: 'payment_pay',
    payment_status: '未付',
    submit_key: 'scan_sale:key:1',
    ...extra,
  }).toString(),
});

/** 上一单**刚完成**时 `completeSale` 落下的形状（第 2 单就从这里长出来）。 */
const COMPLETED_SALE = {
  status: 'submitted', lines: [], order_no: '', master_record_id: '',
  paymentStep: 'created', submitPending: { size: '40', amount: '399' },
};

const getPage = async (base, query = '') => {
  const response = await fetch(`${base}/s/${ENCODED}${query}`, { headers: { cookie: sessionCookie() } });
  return { status: response.status, html: await response.text() };
};

/** 结构化日志的出口就是 console.log/warn/error（`src/utils/logger.js`）—— 捕获它才断言得了"记了没记"。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

const PAYMENT_PAGE_MARK = 'data-view="payment-step"';

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM1 残标记（0 行 + 没单号）⇒ 不给资金页 + 标记被清 + 有一条日志
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM1 ⭐ 残标记（`pending` + 草稿 0 行 + 无单号 + **`status:\'submitted\'`**）⇒ **不给资金页** + **标记被清** + **一条日志**', async () => {
  // ⚠️ 夹具 = **她真机那个状态**（Lead 的会话文件快照）：`paymentStep:'pending'` ＋ `status:'submitted'`
  //    ＋ 草稿 0 行 ＋ 没有已建单号。
  // ⚠️ **为什么必须带上 `status:'submitted'`**（这是我对 brief 字面判据的**一处收窄**，理由见下）：
  //    brief 写的是「0 行 + 没有已建单号 ⇒ 残标记」；但**"0 行"在正常资金页上本来就是常态** ——
  //    扫码那一双是走 `submitPending`（提交那一步存下来的尺码/金额）在**点按钮时**才落单的
  //    ⇒ 光看 0 行会把**正常**的资金页清掉、她点按钮就建不了单 ✗
  //    （`test/scanSalePayFront.test.js` 的 AC-PF1/PF2/PF4 就是这么把我第一版挡下的 ✓
  //      —— 那 5 条**既有用例我一个字没改** ✓）。
  //    所以残标记 + 她**真机那个特征**：这一单**已经 `submitted`**（`completeSale` 把 status 落成
  //    submitted、却清的是 lines/order_no 而**没清** paymentStep ⇒ 标记成了残的 ✓）。
  login();
  const write = fakeWriteService({ paymentStep: 'pending', status: 'submitted', lines: [] });
  const logs = captureLogs();
  let page;
  try {
    await withServer(appFor({ write }), async (base) => {
      page = await getPage(base);   // 裸扫（= 销售上下文）
    });
  } finally {
    logs.restore();
  }

  // ① 不给资金页（照旧出销售那一块）
  assert.equal(page.status, 200);
  assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, '⭐ 不许再给「整单付款」那一页');
  assert.ok(page.html.includes('realm-block--sales'), '照旧渲染扫码页的销售块 ✓');

  // ② 标记被清（**清成"这个键不在"** —— 默认 sale 的形状）
  assert.equal(write.patches.length, 1, '正好清一次（不许反复清 / 不许清别的）');
  // ⚠️ task-22 改（**逐字**）：
  //   改前逐字：`assert.deepEqual(Object.keys(write.patches[0]), ['paymentStep'], '只动这一个键（别的字段一个都不许碰）');`
  //   改后逐字：`['paymentStep', 'submitPending']`（下面这行）。
  //   依据：`paymentStep` 一清，`submitPending` 就**再没有读点**（pay / skip 两处都在
  //     `paymentStep === 'pending'` 门内）⇒ 残标记那次它只是**上一单的残留 payload**，同笔清掉更干净 ✓
  //     （Lead 手工清她会话时也是两个一起清的 ✓）。
  //   🔴 **判据没有放宽**：仍然是"**只清这两笔、别的字段一个都不许碰**"（键集合**枚举**钉死 ✓），
  //     而且"清成没走到资金这一步"的语义一条没动 ✓。
  assert.deepEqual(Object.keys(write.patches[0]).sort(), ['paymentStep', 'submitPending'],
    '⭐ 同笔清这两个键（别的字段一个都不许碰）');
  assert.equal(write.patches[0].paymentStep, undefined, '⭐ 清成"没走到资金这一步"的既有表示（= 这个键不在）');
  assert.equal(Object.prototype.hasOwnProperty.call(write.session.sale, 'paymentStep'), false,
    '清完之后会话里**真的**没有这个键了（下一次读就不会再被顶到资金页 ✓）');

  // ③ 有一条日志（真机排查用）
  const events = logs.events('scan.payment_step.stale_cleared');
  assert.equal(events.length, 1, '⭐ 必须有一条 `scan.payment_step.stale_cleared`（删掉就红）');
  const payload = JSON.parse(events[0]);
  assert.equal(payload.raw, 'pending', '如实带原值');
  assert.equal(payload.lines, 0);
  assert.equal(payload.has_order, false);
  assert.equal(payload.sale_status, 'submitted', '如实带上是哪个 status 让它成了残标记 ✓');
  assert.ok(String(payload.open_id || '').length > 0, '带 openId（logger 会按既有规则脱敏 ✓）');
  assert.ok(String(payload.request_id || '').length > 0, '带 requestId ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM2 / AC-SM3 真有东西要付 ⇒ 照旧给资金页（**不许修过头** ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM2 ⭐ `pending` + 草稿**有 N 行** ⇒ 照旧给资金页（count=N），**不许**清标记', async () => {
  login();
  const lines = [
    { product_number: 'N05', size: 41, quantity: 1, sale_unit_price: 399 },
    { product_number: 'N05', size: 42, quantity: 1, sale_unit_price: 399 },
  ];
  const write = fakeWriteService({ paymentStep: 'pending', lines });
  await withServer(appFor({ write }), async (base) => {
    const page = await getPage(base);
    assert.equal(page.status, 200);
    assert.ok(page.html.includes(PAYMENT_PAGE_MARK), '⭐ 她刚填完、还要在资金页接着付 ⇒ **照旧给资金页** ✓');
    assert.match(page.html, /name="count"[^>]*value="2"|value="2"/, '张数/行数如实带过去（count=2）');
  });
  assert.deepEqual(write.patches, [], '⭐ **一个字都不许清**（那是她故意留着要回来付的 ✗）');
});

test('AC-SM2b ⭐⭐【成对迁移 · 2026-10-16 task-60】`?from=sales` + 草稿有行 ⇒ **货品页**（她选的 ②：点销售就从货品页开始）+ 那条"未完成"被清', async () => {
  // ⭐⭐ 2026-10-16 **成对迁移**（本仓纪律：**不许删 / 不许 skip / 不许放宽** ⇒ 逐条写清）——
  //   依据 = **业务负责人当日亲口选的方案 ②**（逐字）：
  //     「**② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）**」
  //   · **改前逐字**：
  //       `const first = await getPage(base, '?from=sales');`
  //       `const second = await getPage(base, '?from=sales');`
  //       `assert.ok(first.html.includes(PAYMENT_PAGE_MARK), 'from=sales 刷新 ⇒ 资金页 ✓');`
  //       `assert.ok(second.html.includes(PAYMENT_PAGE_MARK), '再刷一次仍是资金页 ✓（她在资金页刷新不丢）');`
  //       `assert.deepEqual(write.patches, [], '两次刷新都不许清标记 ✓');`
  //   · **改后逐字**：见下面每一条 —— **同两发 `?from=sales` 请求**，断言翻成"货品页 ＋ 清掉那两个键"，
  //     并且**另加**一条"草稿行原样还在"（\*\*只加不减\*\* ⇒ 强度没降 ✓）。
  //   · **为什么（判据自身的意思也变了）**：`?from=sales` 就是**她点「销售」那个 realm tab**
  //     （`views/scanPageRenderer.js` 的 `href="?from=<领域>"`）⇒ 按她选的 ②：**这一发要把那条
  //     未完成清掉、从货品页开始**（`test/scanLandingResetOnScan.test.js` 的 AC-LR1 是同一件事的正面判据 ✓）。
  //   🔴 **"刷新不丢"这条既有体验没有被删掉**：真正会被刷新的是**资金页自己那张表单**，
  //     而它的 POST 目标是 `postActionFor(target, 'sales')` = **裸 URL**（`?from=` 只在**非缺省领域**才带）
  //     ⇒ **刷新那条路是裸扫**，由**同文件 AC-SM2**（裸扫 + 有行 ⇒ 资金页）与
  //       **AC-SM8**（裸扫 + 刚提交 ⇒ 仍资金页、不许清）**原样钉着** ✓（那两条**一个字没动** ✓）。
  login();
  const write = fakeWriteService({ paymentStep: 'pending', lines: [{ product_number: 'N05', size: 41, quantity: 1 }] });
  await withServer(appFor({ write }), async (base) => {
    const first = await getPage(base, '?from=sales');
    const second = await getPage(base, '?from=sales');
    assert.equal(first.html.includes(PAYMENT_PAGE_MARK), false,
      '⭐ 她选的 ②：点「销售」⇒ **货品页**（那条未完成被清掉 ⇒ 不再被资金页顶掉 ✗）');
    assert.ok(first.html.includes('realm-block--sales'), '照旧渲染销售那一块（货品页 ✓）');
    assert.equal(second.html.includes(PAYMENT_PAGE_MARK), false, '再点一次仍是货品页 ✓');
  });
  assert.equal(write.patches.length, 1, '只在**第一发**清一次（清完就没有可清的了 ✓）');
  assert.deepEqual(Object.keys(write.patches[0]).sort(), ['paymentStep', 'submitPending'],
    '⭐ 同笔清这两个键（别的字段一个都不许碰 ✓）');
  assert.equal(write.patches[0].paymentStep, undefined, '清成"没走到资金这一步"的既有表示 ✓');
  // ⭐ **只加不减**：草稿行本身**不在清除范围**（清的是"未完成标记"，不是她的清单 ✗）
  assert.equal(Array.isArray(write.session.sale.lines) ? write.session.sale.lines.length : -1, 1,
    '⭐ 草稿行**原样还在**（她还能在本单条上看到那一双 ✓）');
});

test('AC-SM3 ⭐ `pending` + **已建单号**但没付 ⇒ 照旧给资金页（`order_no` / `master_record_id` 都认）', async () => {
  login();
  for (const sale of [
    { paymentStep: 'pending', lines: [], order_no: 'XSD-20261015-0001' },
    { paymentStep: 'pending', lines: [], master_record_id: 'rec_master_1' },
  ]) {
    const write = fakeWriteService(sale);
    // eslint-disable-next-line no-await-in-loop
    await withServer(appFor({ write }), async (base) => {
      const page = await getPage(base);
      assert.ok(page.html.includes(PAYMENT_PAGE_MARK),
        `⭐ 有单号（${Object.keys(sale).filter((k) => k !== 'paymentStep' && k !== 'lines').join('/')}）⇒ 照旧资金页 ✓`);
    });
    assert.deepEqual(write.patches, [], '有单号 ⇒ **不许**清标记 ✓');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM4 其它领域一个字不改
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM4 非销售领域（inventory / replenish / purchase_return）⇒ 一律不接管，**也不清标记**', async () => {
  // ⚠️ 领域 id 的真名是 `purchase_return`（`views/scanPageRealm.js` 的 REALMS）；
  //    `?from=return` 是**认不出的值 ⇒ 回落销售**（既有口径）—— 那一条我另有用例式的说明，不在这里冒充"退货"。
  login();
  for (const realm of ['inventory', 'replenish', 'purchase_return']) {
    const write = fakeWriteService({ paymentStep: 'pending', lines: [] });
    // eslint-disable-next-line no-await-in-loop
    await withServer(appFor({ write }), async (base) => {
      const page = await getPage(base, `?from=${realm}`);
      assert.equal(page.status, 200);
      assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, `${realm} 不许被资金页接管 ✓`);
      assert.ok(page.html.includes(`realm-block--${realm}`), `${realm} 照旧那一块 ✓`);
    });
    assert.deepEqual(write.patches, [], `${realm} 不是这一块的账 ⇒ **不许**顺手清标记 ✗`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM5 清掉之后再扫一次 ⇒ 正常扫码页（回归）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM5 ⭐ 清掉之后再扫一次 ⇒ **正常扫码页**（不再被顶到资金页；这就是她今晚那一下）', async () => {
  login();
  // 她那次会话的真实形状：pending + 0 行 + 没有单号 + **status 已 submitted**
  const write = fakeWriteService({ paymentStep: 'pending', status: 'submitted', lines: [] });
  await withServer(appFor({ write }), async (base) => {
    const first = await getPage(base);
    const second = await getPage(base);   // 清完之后**再扫一次**
    const third = await getPage(base);
    assert.equal(first.html.includes(PAYMENT_PAGE_MARK), false, '第一次就不该给资金页 ✓');
    assert.equal(second.html.includes(PAYMENT_PAGE_MARK), false, '⭐ 再扫一次仍是正常扫码页（不再被顶 ✗）');
    assert.equal(third.html.includes(PAYMENT_PAGE_MARK), false, '第三次也一样 ✓');
    for (const html of [first.html, second.html, third.html]) {
      assert.ok(html.includes('realm-block--sales'), '每次都是销售那一块 ✓');
    }
  });
  assert.equal(write.patches.length, 1, '只在**第一次**清一次（后面没有标记可清 ⇒ 不再写会话 ✓）');
});

test('AC-SM7 ⭐⭐ `pending` + 草稿 0 行 **但这一单还没交出去**（status=draft / 没有 status）⇒ **照旧给资金页**、**不许清标记**', async () => {
  // 这就是 brief **字面判据**（只看"0 行 + 没单号"）会误伤的**正常**场景：
  //   她刚点过「提交这一单」、正停在资金页 —— 扫码那一双还在 `submitPending` 里、没落进 `lines`
  //   ⇒ 0 行是**常态**。此时**必须照旧给资金页**（她刷新不丢、点按钮才建单 ✓）。
  //   ⚠️ 依据不是猜的：`test/scanSalePayFront.test.js` 的 AC-PF1/PF2/PF4 用**真实链路**证明了
  //      "0 行 + pending ⇒ 资金页 ⇒ 点按钮建单成功" 是她认的那条流程 ✓（那 5 条原文没动 ✓）。
  login();
  for (const sale of [
    { paymentStep: 'pending', status: 'draft', lines: [] },
    { paymentStep: 'pending', lines: [] },   // 连 status 都还没有（老会话 / 夹具）
  ]) {
    const write = fakeWriteService(sale);
    // eslint-disable-next-line no-await-in-loop
    await withServer(appFor({ write }), async (base) => {
      const page = await getPage(base);
      assert.equal(page.status, 200);
      assert.ok(page.html.includes(PAYMENT_PAGE_MARK),
        `⭐ status=${String(sale.status || '(无)')} ⇒ 这一单还没交出去 ⇒ **照旧资金页** ✓`);
    });
    assert.deepEqual(write.patches, [], '⭐ **不许**清标记（那是她故意留着要回来付的 ✗）');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM8 / AC-SM9 / AC-SM10 / AC-SM11（task-22）：#598 引入的那处回退
//   —— 上一单已完成（status='submitted'）之后，**第 2 单**刚提交时 status 还是上一单的
//      ⇒ #598 的残标记判据会把**正常**的资金页清掉 ⇒ 她在资金页**刷新一下**就被打回录入页 ✗
//   修法：提交那一步把 `status` 落回 `draft`（这一单正在走 ✓）⇒ 两个状态彻底分开。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM9 ⭐ 提交那一步 `status` 落回 `draft`（能真红：删掉那一行 ⇒ 红）', async () => {
  login();
  const write = fakeWriteService({ ...COMPLETED_SALE });
  await withServer(appFor({ write }), async (base) => {
    const response = await submitOrder(base);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(PAYMENT_PAGE_MARK), '提交照旧渲染资金页 ✓');
  });
  const submitPatch = write.patches.find((patch) => patch.paymentStep === 'pending');
  assert.ok(submitPatch, '提交那一笔要写 `paymentStep: \'pending\'` ✓');
  assert.equal(submitPatch.status, SCAN_WRITE.session.statuses.draft,
    '⭐ 提交 = 这一单正在走 ⇒ `status` 必须落回 `draft`（不许把上一单的 submitted 留给第 2 单 ✗）');
  assert.equal(write.session.sale.status, SCAN_WRITE.session.statuses.draft, '会话里真的成了 draft ✓');
  // ⚠️ 别再顺手改别的：这一笔仍然只有"这一单要写什么"那几个键 + status
  assert.equal(submitPatch.paymentStep, 'pending');
  assert.ok(Array.isArray(submitPatch.lines), 'lines 照旧原样带过去 ✓');
  assert.ok(submitPatch.submitPending, 'submitPending 照旧原样带过去 ✓');
});

test('AC-SM8 ⭐⭐ 上一单 `submitted` + **新提交** ⇒ 刷新**仍是资金页**、**不许清标记**（#598 的回退不许再回来）', async () => {
  login();
  const write = fakeWriteService({ ...COMPLETED_SALE });
  let firstHtml; let secondHtml;
  await withServer(appFor({ write }), async (base) => {
    firstHtml = await (await submitOrder(base)).text();      // 提交这一下
    secondHtml = (await getPage(base)).html;                 // 她在资金页**刷新**
  });
  assert.ok(firstHtml.includes(PAYMENT_PAGE_MARK), '提交那一下是资金页 ✓');
  assert.ok(secondHtml.includes(PAYMENT_PAGE_MARK),
    '⭐ 第 2 单刚提交完 ⇒ 刷新**必须是资金页**（不许被当成残标记打回录入页 ✗）');
  assert.equal(secondHtml.includes('realm-block--sales'), false, '更不许掉回录入页的销售块 ✗');
  assert.equal(write.patches.some((patch) => patch.paymentStep === undefined), false,
    '⭐ **不许**清标记（她刚提交、正停在资金页）');
});

test('AC-SM10 ⭐ 「重启补跑」扫描**不受影响**（`draft` + 没单号 / 草稿空 ⇒ 不当待补跑）', async () => {
  const { createScanSessionService } = require('../src/services/scanSessionService');
  // ① 提交那一步写出来的形状（AC-SM9）：draft + **没有单号** + 草稿可能为空
  const afterSubmit = {
    session_id: 'scan_session_after_submit', open_id: 'ou_after_submit',
    expires_at: new Date(Date.now() + 6e5).toISOString(),
    sale: {
      status: 'draft', order_no: '', lines: [], paymentStep: 'pending',
      submitPending: { size: '41', amount: '399' }, seq: 1, completed: [],
    },
  };
  // ② 对照组：**真的**半截提交（draft + 单号 + 草稿有行，且那单不在 completed 里）⇒ 扫描**必须**能报出来
  const reallyInFlight = {
    session_id: 'scan_session_really_in_flight', open_id: 'ou_really',
    expires_at: new Date(Date.now() + 6e5).toISOString(),
    sale: {
      status: 'draft', order_no: 'XSD-20261015-9999',
      lines: [{ product_number: 'N05', size: 41, quantity: 1 }], seq: 1, completed: [],
    },
  };
  const service = createScanSessionService({
    config: SCAN_WRITE, store: { list: async () => [afterSubmit, reallyInFlight] },
  });
  assert.deepEqual(await service.findInterruptedSales(), [],
    '⭐ 刚提交那一下不许被当成"可安全清草稿"的半截提交 ✗');
  const uncertain = await service.findUncertainInFlightSales();
  assert.deepEqual(uncertain.map((row) => row.sessionId), ['scan_session_really_in_flight'],
    '⭐ 扫描本身还是灵的（真的半截提交照样报出来 ⇒ 不是"什么都不报"的假绿 ✓）');
});

test('AC-SM11 ⭐ `submitPending` **同一笔**清掉，且**不影响**正常提交后点按钮建单', async () => {
  login();
  // ① 残标记（她那次）：两个键**同一笔**清掉（`paymentStep` 一清，它就没有读点了 ⇒ 纯卫生 ✓）
  const stale = fakeWriteService({
    status: 'submitted', lines: [], order_no: '', master_record_id: '',
    paymentStep: 'pending', submitPending: { size: '40', amount: '399' },
  });
  let staleHtml;
  await withServer(appFor({ write: stale }), async (base) => { staleHtml = (await getPage(base)).html; });
  assert.equal(staleHtml.includes(PAYMENT_PAGE_MARK), false, '残标记 ⇒ 不给资金页 ✓');
  assert.equal(stale.patches.length, 1, '清理必须是**一笔**（不许写两次会话）');
  assert.deepEqual(Object.keys(stale.patches[0]).sort(), ['paymentStep', 'submitPending'],
    '⭐ 同笔清这两个键（**别的字段一个都不许碰**）');
  assert.equal(Object.prototype.hasOwnProperty.call(stale.session.sale, 'submitPending'), false,
    '残留 payload 真的没了 ✓');

  // ② 正常路径：**提交 ⇒ 点按钮**照旧建单（payload 没被抹掉 ⇒ 建单拿得到她填的那一双 ✓）
  const fresh = fakeWriteService({ ...COMPLETED_SALE });
  await withServer(appFor({ write: fresh }), async (base) => {
    await (await submitOrder(base)).text();
    const paid = await payOrder(base);
    assert.equal(paid.status, 200);
    await paid.text();
  });
  // 成对迁移（改前逐字 → 改后逐字 → 依据）—— 2026-10-17：
      //   改前逐字：`assert.equal(fresh.calls.filter((call) => call.kind === 'submitSale').length, 1,`（"照旧建单一次"）
      //   改后逐字：同上一行，**1 ⇒ 2** —— ④ 之后「点提交就建单」，这一次提交会走【货那一跑】+【钱那一跑】两跑 ⇒ 恰 2 次。
      //   依据 = ④ 货/钱分离口径（与 AC-AS10 同一依据）。
      assert.equal(fresh.calls.filter((call) => call.kind === 'submitSale').length, 2,
    '⭐ 点资金页那颗按钮 ⇒ **照旧建单一次**（`submitPending` 没被误清 ✓）');
  assert.equal(fresh.patches.some((patch) => patch.paymentStep === undefined), false,
    '正常那一单**不许**走残标记清理 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM6 既有哨兵不放宽（源码级：10-14 那两条判据逐字仍在）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM6 既有边界**逐字仍在**：只对销售上下文接管 + 新判据是**收紧**（不是替换）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  // ① 10-14 那两条（`test/scanPaymentStepRealmScope.test.js`）**原文仍在** ✓
  assert.match(src, /const salesContext = /, '销售上下文判据一处定义 ✓');
  assert.match(src, /pendingMark === 'pending' && salesContext/, '接管仍要**同时**满足 pending + 销售上下文 ✓');
  assert.match(src, /String\(req\.query\?\.from \|\| ''\) === ''/, '不带 from 仍算销售上下文 ✓');
  assert.match(src, /=== 'sales'/, 'from=sales 算销售上下文 ✓');
  // ② 新判据是**加在里面的**（不是把旧的换掉）：接管前必须先算"有没有东西要付" ✓
  assert.match(src, /const hasOrder = /, '要算"有没有已建单号" ✓');
  assert.match(src, /const saleStatus = /, '要看这一单是不是已经交出去了 ✓');
  assert.match(src, /if \(pendingLines\.length > 0 \|\| hasOrder \|\| saleStatus !== submittedStatus\)/,
    '⭐ 只有"有东西要付"才接管（能真红）✓');
  assert.match(src, /stale_cleared/, '残标记要**如实记日志** ✓');
  assert.match(src, /stale_clear_failed/, '清标记失败也要留痕（不破页面）✓');
  // ③ 配置路径必须走**真**的那条（`writeConfig.statuses` 不存在 ⇒ 取到 undefined ⇒ 500 ✗）
  assert.match(src, /writeConfig\.session\.statuses\.draft/, '⭐ 提交那一步按真路径取 `draft` ✓');
  assert.match(src, /writeConfig\?\.session\?\.statuses\?\.submitted/, '⭐ 残标记判据也按真路径取 `submitted` ✓');
  //     ⚠️ 判据要**先去掉注释**再查 —— 源码注释里**故意**写着"`writeConfig.statuses` 不存在"这句说明
  //        （那是给人看的警告），把它算成违规就会误报 ✗。
  const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/writeConfig\?\.statuses/.test(codeOnly), false,
    '⭐ 代码里不许再出现不存在的 `writeConfig.statuses`（能真红）');
});
