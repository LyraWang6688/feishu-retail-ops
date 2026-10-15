'use strict';

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
 * · **AC-SM3** `pending` + **有已建单号**（`order_no` / `master_record_id`）但没付 ⇒ **照旧给资金页** ✓
 * · **AC-SM4** 非销售领域（`from=inventory|replenish|return`）⇒ **一律不接管**（既有行为不变 ✓，
 *   且**不许**顺手清标记 —— 那不是这一块的账 ✗）
 * · **AC-SM5** 清掉之后**再扫一次** ⇒ 正常扫码页（回归：不再被顶到资金页 ✓）
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

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');

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
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
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
  assert.deepEqual(Object.keys(write.patches[0]), ['paymentStep'], '只动这一个键（别的字段一个都不许碰）');
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

test('AC-SM2b ⭐ `pending` + 草稿有行 ⇒ 刷新**不丢**（这就是原来那条 AC，判据没放宽）', async () => {
  login();
  const write = fakeWriteService({ paymentStep: 'pending', lines: [{ product_number: 'N05', size: 41, quantity: 1 }] });
  await withServer(appFor({ write }), async (base) => {
    const first = await getPage(base, '?from=sales');
    const second = await getPage(base, '?from=sales');
    assert.ok(first.html.includes(PAYMENT_PAGE_MARK), 'from=sales 刷新 ⇒ 资金页 ✓');
    assert.ok(second.html.includes(PAYMENT_PAGE_MARK), '再刷一次仍是资金页 ✓（她在资金页刷新不丢）');
  });
  assert.deepEqual(write.patches, [], '两次刷新都不许清标记 ✓');
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
});
