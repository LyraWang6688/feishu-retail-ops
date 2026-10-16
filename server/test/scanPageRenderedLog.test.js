'use strict';

/**
 * ⭐⭐ task-58（2026-10-16 早 · 业务负责人真机 05:34，逐字）：
 *   「我用你最新的线上版本测试了一下，静态感觉很好，扫描了几个货品二维码，
 *     **但是有一个货品点击了之后出现的是这个资金页** ✗」
 *
 * ## 症状 vs 日志的**盲区**（这一刀要治的正是它）
 * 她拉的线上日志里**每一次都打了 `scan.page.viewed`** —— 因为"资金页接管"那条路
 * **也**要先 `service.lookup()`（`routes/scanPage.js:1167`），而 `scan.page.viewed`
 * 正是 `service.lookup` 里面打的（`services/scanPageService.js:1356` / 命中缓存 `:1070`）。
 * ⇒ **日志只能证明"服务端查过货品"，一个字都没说"最后渲染了哪一页"** ✗✗
 * ⇒ 真机再出现这个现象时，只能靠猜（"是哪种形状？"）。
 *
 * ## 这一刀（**只加日志，零判定改动** ✗）
 * 新增一条 `scan.page.rendered`（事件名落 `config/scanPage.js` 的 `EVENTS` ✓ 配置先行）：
 *   · `page`       —— `skeleton` | `pay` | `goods` | `success` | `not_found` | `bad_number` | `failed`
 *   · `trigger`    —— **哪条条件命中**（`skeleton_first_entry` /
 *                     `pending_mark:lines|order|status_not_submitted`（= 命中"有东西要付"的那一条判据）/
 *                     `realm:<领域>:<explicit|remembered|default>` / `write_ok` / `lookup_not_found` …）
 *   · `query_keys` —— **只字段名**（不记值 ✗ 与 `app.js:80` 同一口径）
 *   · `number`     —— 这次扫的是哪个编号 / 记录 ID（与 `scan.page.viewed` 同口径 ✓）
 * ⇒ 下一次真机：grep `scan.page.rendered` 就能**一眼**看出"她那次是哪种形状" ✓
 *
 * 🔴 **红线**：不改任何判定 / 不改 `services/scanWriteService.js`（冻结）/ 不动渲染层 ✗。
 *    判据钉住的就是"日志**如实**反映已经发生的那个落点"——**页面 HTML 一个字都不许变** ✓
 *    （AC-RL10：同一形状下，加日志前后渲染出来的 HTML 逐字节一致）。
 *
 * ## 验收标准（**先写后做**；每条能真红 —— 见 PR 里的变异表）
 * · **AC-RL1** 裸扫（骨架屏开）⇒ 一条 `page:'skeleton'` + `trigger:'skeleton_first_entry'`；
 *   紧接着 `?data=1` ⇒ 一条 `page:'goods'`（**骨架那条路也留痕** ✓）
 * · **AC-LR4**（⭐ task-60 加）**四个出口**（骨架 / 货品页 / 资金页 / 成功页）各一条 `scan.page.rendered`，
 *   且 `page`·`trigger`·`query_keys`·`number` ＋ `request_id` **一个字段都不缺**（她点名要的那条 ✓）
 * · **AC-RL5** 残标记（`pending` + 0 行 + `submitted`）⇒ **`page:'goods'`**（不给资金页 ✓
 *   这一条是"修对了"的正面证据 —— 与 `scanPaymentStepStale.test.js` 的 AC-SM1 同形）
 * · **AC-RL6** `?data=1` + `pending`（骨架自取那一发）⇒ `page:'goods'`（**绕过接管** ✓ 说得出）
 * · **AC-RL7** `?from=inventory` + `pending` ⇒ `page:'goods'`（非销售领域不接管 ✓）
 * · **AC-RL8** `query_keys` **只记字段名**（`?from=sales&data=1` ⇒ `['data','from']`；
 *   ⚠️ **一个字的值都不许进这条日志** ✗）
 * · **AC-RL9** 每次 GET **恰好一条** rendered（不重不漏）+ `success` / `not_found` 两个出口也留痕
 * · **AC-RL10** 既有边界**不放宽**：`salesContext` / `pendingMark === 'pending'` 那几条 **逐字仍在**；
 *   并且 `sendPaymentStep` 里那条日志**在 `sendHtml` 之前**（能真红：挪到后面就红）
 *
 * ⭐⭐ **task-60 搬移记录（**不许删判据** —— 判据一条没丢，只是换了文件 ✓）**：
 *   原 **AC-RL2 / AC-RL3 / AC-RL4**（三条 `pending_mark:lines|order|status_not_submitted` 的 GET 接管用例）
 *   在本文件里**够不着**了 —— 理由是**结构性**的，不是判据失效：
 *     · 本文件按**线上形状**跑（`SCAN_PAGE_SKELETON_ENABLED=true` + `firstEntryOnly`）
 *       ⇒ **裸扫**先回骨架（拿不到"资金页"那一发）；
 *     · 而 `?from=sales`（那三条原来用的形状）**从 2026-10-16 起按她亲口选的 ② 先清掉未完成标记**
 *       ⇒ 出货品页、**不再**给资金页（正面判据见 `test/scanLandingResetOnScan.test.js` 的 **AC-LR1**）。
 *   ⇒ 那三条**搬到** `test/scanLandingResetOnScan.test.js` 的 **AC-LR2c ③**（那个文件**骨架屏关**，
 *     裸扫真的走接管 ⇒ 三条 trigger **逐条原样**断言 ✓）—— **强度一点没降、一条没丢** ✓。
 *
 * ⚠️ 本文件是**新建**的（`server/test/**` 同时有别的任务在改 ⇒ 按"scan 相关、新文件优先"办）
 *    —— **一个字都不去动别人的用例文件** ✓。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// 路由模块在 require 时就会 `new V1BitableGateway()`（构造时读飞书凭证）；给一对假凭证只为能加载。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_rendered_log';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_rendered_log_secret';
// ⭐ 线上取值（她的日志里有 `scan.page.skeleton`）⇒ 本文件按**线上那个形状**跑。
process.env.SCAN_PAGE_SKELETON_ENABLED = 'true';

// ⭐⭐ 成对迁移（2026-10-16 · `SCAN_DRAFT_ENABLED` 缺省翻 true 之后）—— 本文件测的不是草稿：
//   它测的是 `scan.page.rendered` 那条渲染日志（四个出口各一条）。
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

const SESSION_SECRET = 'scan_rendered_log_secret';
const NUMBER = '832-321-H|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const OPEN_ID = 'ou_scan_rendered_log';
const RENDERED = 'scan.page.rendered';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  record_id: 'rec28e01D2f4cG',
  item_no: '832-321-H',
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
  updated_at_text: '2026-10-16 05:34',
  ...overrides,
});

const fakeWriteService = (sale = {}) => {
  const patches = [];
  const calls = [];
  const session = { sale: { ...sale } };
  const sessions = {
    async get() { return { sale: { ...session.sale } }; },
    async submitKeyFor() { return 'scan_sale:key:1'; },
    async saveSaleProgress(unusedOpenId, patch) {
      patches.push(patch);
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
    calls,
    sessions,
    saveDraftLines: (openId, patch) => sessions.saveSaleProgress(openId, patch),
    listAccessories: async () => [],
    submitSale: async (input) => {
      calls.push({ kind: 'submitSale', submitKey: input?.submitKey });
      return { ok: true, order_no: 'XSD-RL9', sales_entry_record_id: 'rec_rl9', payment_count: 0 };
    },
  };
};

const appFor = ({ write, found = true } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // 生产里每个请求都带 `req.requestId`（`app.js` 的中间件）⇒ 照摆一个（"日志里带 requestId"才是真跑出来的）
  app.use((req, res, next) => { req.requestId = 'req_scan_rendered_log'; next(); });
  const router = createScanPageRouter({
    service: { lookup: async () => (found ? view() : { found: false, number: NUMBER, reason: 'unknown' }) },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return app;
};

const getPage = async (base, query = '') => {
  const response = await fetch(`${base}/s/${ENCODED}${query}`, { headers: { cookie: sessionCookie() } });
  return { status: response.status, html: await response.text() };
};

const post = (base, body) => fetch(`${base}/s/${ENCODED}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

const submitOrderBody = () => ({
  action: SCAN_WRITE.actions.submitOrder,
  [SCAN_WRITE.fields.size]: '41',
  [SCAN_WRITE.fields.amount]: '399',
});
const payBody = () => ({
  action: SCAN_PAGE.paymentStep.payAction,
  [SCAN_WRITE.fields.paymentStatus]: '',
  [SCAN_WRITE.fields.submitKey]: 'scan_sale:key:1',
});

/** 结构化日志的出口就是 console.log/warn/error（`src/utils/logger.js`）。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    rendered: () => lines
      .filter((line) => line.includes(`"event":"${RENDERED}"`))
      .map((line) => JSON.parse(line)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

/** 跑一段（捕获日志）并返回这一段的 rendered 事件。 */
const withLogs = async (run) => {
  const logs = captureLogs();
  try {
    const result = await run();
    return { result, rendered: logs.rendered() };
  } finally { logs.restore(); }
};

const only = (rendered) => {
  assert.equal(rendered.length, 1, `这一段**恰好一条** ${RENDERED}（不重不漏）`);
  return rendered[0];
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL1 裸扫（骨架）→ ?data=1（货品页）：两个落点都留痕
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RL1 ⭐ 裸扫 ⇒ `page:skeleton`；`?data=1` ⇒ `page:goods`（骨架那条路也说得出来）', async () => {
  login();
  const write = fakeWriteService({ status: 'submitted', lines: [], paymentStep: 'created' });
  await withServer(appFor({ write }), async (base) => {
    const first = await withLogs(() => getPage(base));
    assert.equal(first.result.status, 200);
    assert.ok(first.result.html.includes('data-view="scan-skeleton"'), '裸扫先回骨架（线上取值 ✓）');
    const skeleton = only(first.rendered);
    assert.equal(skeleton.page, 'skeleton', '⭐ 这一发渲染的是骨架屏');
    assert.equal(skeleton.trigger, 'skeleton_first_entry', '⭐ trigger 说得出"为什么是骨架"');
    assert.equal(skeleton.number, NUMBER, '带上这次扫的编号');
    assert.deepEqual(skeleton.query_keys, [], '裸扫没有查询串字段');
    assert.ok(String(skeleton.request_id || '').length > 0, '带 requestId ✓');

    const second = await withLogs(() => getPage(base, '?data=1'));
    assert.ok(second.result.html.includes('realm-block--sales'), '?data=1 ⇒ 货品页（销售块）');
    const goods = only(second.rendered);
    assert.equal(goods.page, 'goods', '⭐ 这一发渲染的是货品页');
    assert.match(goods.trigger, /^realm:sales:(explicit|remembered|default)$/, 'trigger 带领域 + 来源');
    assert.deepEqual(goods.query_keys, ['data'], 'query_keys 如实（只字段名）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ task-60 **搬移**：原 AC-RL2 / AC-RL3 / AC-RL4 在这里（`?from=sales` + pending ⇒ 资金页）
//   —— 她 2026-10-16 亲口选了 ② 之后，`?from=sales` 那一发**先清掉未完成 ⇒ 货品页**
//   （正面判据：`test/scanLandingResetOnScan.test.js` 的 AC-LR1）；
//   而**裸扫**在本文件（骨架屏**开**）够不着资金页那一发。
//   ⇒ 那三条 trigger 断言**原样搬到** `test/scanLandingResetOnScan.test.js` 的 **AC-LR2c ③**
//     （骨架屏关 ⇒ 裸扫真的走接管 ✓，三条 `pending_mark:*` 逐条断言 ✓）。
//   🔴 **判据没删、也没放宽** —— 只是换了"能够让它们真的跑到"的那个文件 ✓。
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-LR4（task-60 加）**四个出口**：都打得出来、字段齐（她点名要的那条 —— 以后每次排查都要用）
//   骨架 · 货品页 · 资金页 · 成功页
// ═══════════════════════════════════════════════════════════════════════════

/** 🔴 AC-LR4 的公共判据：**四个字段一个都不许缺**（＋ requestId）。 */
const assertFieldsComplete = (event, label) => {
  assert.ok(Object.prototype.hasOwnProperty.call(event, 'page'), `${label}：要有 page ✓`);
  assert.ok(String(event.page).length > 0, `${label}：page 不许为空`);
  assert.ok(Object.prototype.hasOwnProperty.call(event, 'trigger'), `${label}：要有 trigger ✓`);
  assert.ok(String(event.trigger).length > 0, `${label}：trigger 不许为空（"哪条条件命中"要说得出来 ✓）`);
  assert.ok(Array.isArray(event.query_keys), `${label}：要有 query_keys（只字段名 ✓）`);
  assert.ok(Object.prototype.hasOwnProperty.call(event, 'number'), `${label}：要有 number ✓`);
  assert.ok(String(event.number).length > 0, `${label}：number 不许为空（这次扫的是哪一件要说得出来 ✓）`);
  assert.ok(String(event.request_id || '').length > 0, `${label}：要有 requestId ✓`);
};

test('AC-LR4 ⭐⭐ 四个出口（骨架 / 货品页 / 资金页 / 成功页）**各一条** `scan.page.rendered`，且 `page`·`trigger`·`query_keys`·`number` 一个字段都不缺', async () => {
  // ⚠️ task-60：资金页那个出口在本文件里用 **POST**（她点「提交这一单」）走到 —— 骨架屏**开**时
  //    GET 那条接管够不着（见上面的搬移记录）；成功页用**POST 点资金页那颗按钮**走到 ✓。
  login();
  const write = fakeWriteService({
    status: 'submitted', lines: [], order_no: '', master_record_id: '', paymentStep: 'created',
    submitPending: { size: '41', amount: '399', gift: '' },
  });
  await withServer(appFor({ write }), async (base) => {
    // ① 骨架屏那个出口
    const skeleton = await withLogs(() => getPage(base));
    const skeletonEvent = only(skeleton.rendered);
    assertFieldsComplete(skeletonEvent, '骨架屏出口');
    assert.equal(skeletonEvent.page, 'skeleton');

    // ② 货品页那个出口（骨架自取那一发）
    const goods = await withLogs(() => getPage(base, '?data=1'));
    const goodsEvent = only(goods.rendered);
    assertFieldsComplete(goodsEvent, '货品页出口');
    assert.equal(goodsEvent.page, 'goods');

    // ③ 资金页那个出口（她点「提交这一单」⇒ POST ⇒ `sendPaymentStep`）
    const pay = await withLogs(async () => {
      const response = await post(base, submitOrderBody());
      return { status: response.status, html: await response.text() };
    });
    assert.equal(pay.result.status, 200);
    assert.ok(pay.result.html.includes('data-view="payment-step"'), '提交那一下照旧到资金页 ✓');
    const payEvent = only(pay.rendered);
    assertFieldsComplete(payEvent, '资金页出口');
    assert.equal(payEvent.page, 'pay');
    assert.equal(payEvent.trigger, 'payment_step', 'POST 那条出口的 trigger 是 `payment_step` ✓');

    // ④ 成功页那个出口（她在资金页点那颗按钮 ⇒ 建单成功）
    const success = await withLogs(async () => {
      const response = await post(base, payBody());
      return { status: response.status, html: await response.text() };
    });
    assert.equal(success.result.status, 200);
    assert.equal(success.result.html.includes('data-view="payment-step"'), false, '建单成功 ⇒ 不再是资金页');
    const successEvent = only(success.rendered);
    assertFieldsComplete(successEvent, '成功页出口');
    assert.equal(successEvent.page, 'success');
    assert.equal(successEvent.trigger, 'write_ok');

    // 四个出口 = 四个不同的 page 值（"渲染了哪一页"一眼分得开 ✓）
    assert.deepEqual(
      [skeletonEvent.page, goodsEvent.page, payEvent.page, successEvent.page],
      ['skeleton', 'goods', 'pay', 'success'],
      '⭐ 四个出口四个 page 值（互不混淆 ✓）',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL5 / AC-RL6 / AC-RL7 三个"**不是**资金页"的形状（修对了的正面证据）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RL5 ⭐ 残标记（`pending` + 0 行 + `submitted`）⇒ `page:goods`（不给资金页 ✓）', async () => {
  login();
  const write = fakeWriteService({ paymentStep: 'pending', status: 'submitted', lines: [] });
  await withServer(appFor({ write }), async (base) => {
    const { result, rendered } = await withLogs(() => getPage(base, '?from=sales'));
    assert.equal(result.html.includes('data-view="payment-step"'), false, '残标记 ⇒ 不给资金页');
    assert.ok(result.html.includes('realm-block--sales'), '照旧货品页');
    const event = only(rendered);
    assert.equal(event.page, 'goods', '⭐ 日志如实说"渲染的是货品页"（不是资金页）');
  });
});

test('AC-RL6 ⭐⭐ `?data=1` + `pending`（骨架自取那一发）⇒ `page:goods`（**绕过接管**说得出）', async () => {
  login();
  const write = fakeWriteService({
    paymentStep: 'pending', status: 'draft', lines: [],
    submitPending: { size: '41', amount: '399' },
  });
  await withServer(appFor({ write }), async (base) => {
    const { result, rendered } = await withLogs(() => getPage(base, '?data=1'));
    assert.equal(result.html.includes('data-view="payment-step"'), false, '?data=1 绕过接管 ⇒ 不是资金页');
    assert.ok(result.html.includes('realm-block--sales'), '是货品页');
    assert.equal(only(rendered).page, 'goods', '⭐ 这一发渲染的是货品页');
  });
});

test('AC-RL7 ⭐ `?from=inventory` + `pending` ⇒ `page:goods`（非销售领域不接管）', async () => {
  login();
  const write = fakeWriteService({ paymentStep: 'pending', status: 'draft', lines: [{ size: 41 }] });
  await withServer(appFor({ write }), async (base) => {
    const { result, rendered } = await withLogs(() => getPage(base, '?from=inventory'));
    assert.ok(result.html.includes('realm-block--inventory'), '是库存块（10-14 晚那条边界 ✓）');
    assert.equal(only(rendered).page, 'goods');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL8 隐私：**只记字段名**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RL8 🔴 `query_keys` 只记**字段名**（值一个字都不进这条日志）', async () => {
  login();
  const write = fakeWriteService({ status: 'submitted', lines: [], paymentStep: 'created' });
  await withServer(appFor({ write }), async (base) => {
    const { rendered } = await withLogs(() => getPage(base, '?from=sales&data=1&number=秘密编号&done=XSD-9999'));
    const event = only(rendered);
    assert.deepEqual(event.query_keys, ['data', 'done', 'from', 'number'], '只字段名，且排序稳定');
    const raw = JSON.stringify(event);
    assert.equal(raw.includes('秘密编号'), false, '🔴 值不许进日志');
    assert.equal(raw.includes('XSD-9999'), false, '🔴 值不许进日志');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL9 成功页 / 找不到：出口也留痕
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RL9a ⭐ 资金页点按钮**建单成功** ⇒ `page:success`', async () => {
  login();
  const write = fakeWriteService({
    status: 'submitted', lines: [], order_no: '', master_record_id: '', paymentStep: 'created',
    submitPending: { size: '40', amount: '399', gift: '' },
  });
  await withServer(appFor({ write }), async (base) => {
    await post(base, submitOrderBody()).then((response) => response.text());
    const { result, rendered } = await withLogs(async () => {
      const response = await post(base, payBody());
      return { status: response.status, html: await response.text() };
    });
    assert.equal(result.status, 200);
    assert.equal(result.html.includes('data-view="payment-step"'), false, '建单成功 ⇒ 不再是资金页');
    assert.equal(only(rendered).page, 'success', '⭐ 渲染的是成功页');
    assert.equal(only(rendered).trigger, 'write_ok');
  });
});

test('AC-RL9b ⭐ 货品找不到 ⇒ `page:not_found`（不再是一条日志都没有）', async () => {
  login();
  const write = fakeWriteService({ status: 'submitted', lines: [], paymentStep: 'created' });
  await withServer(appFor({ write, found: false }), async (base) => {
    // ⚠️ 必须带 `?data=1`：裸扫那一发（骨架屏开着）先回骨架，到不了"找不到"那条出口。
    const { result, rendered } = await withLogs(() => getPage(base, '?data=1'));
    assert.equal(result.status, 404);
    const event = only(rendered);
    assert.equal(event.page, 'not_found');
    assert.equal(event.trigger, 'lookup_not_found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL10 边界不放宽 + "只加日志"（源码哨兵，能真红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RL10 🔴 既有判定**逐字仍在**，且日志**在 sendHtml 之前**（挪到后面就红）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  // ① 10-14 / 10-15 那几条判据原文仍在（谁的判定都没被这一刀碰到 ✓）
  assert.match(src, /const salesContext = /);
  assert.match(src, /pendingMark === 'pending' && salesContext/);
  assert.match(src, /if \(pendingLines\.length > 0 \|\| hasOrder \|\| saleStatus !== submittedStatus\)/,
    '⭐ "有东西要付"那条三选一判据逐字仍在');
  // ② event 名走配置（配置先行），且 `sendPaymentStep` 里那条日志**在** `sendHtml` **之前**
  //
  // ⚠️⚠️ **一处成对迁移（落地轮 2026-10-16 · 见文末「AC-RL10 的那一处成对迁移」）**：
  //   改前逐字：`assert.equal(SCAN_PAGE.events.rendered, RENDERED, '事件名落 config/scanPage.js EVENTS ✓');`
  //   改后逐字（本行起 7 行）：键**一旦让出**就必须逐字一致；**摘键期间**由路由里那个
  //     兜底字面量顶（`config.events?.rendered || 'scan.page.rendered'`，实现形状一个字没改 ✓）。
  if (Object.prototype.hasOwnProperty.call(SCAN_PAGE.events, 'rendered')) {
    assert.equal(SCAN_PAGE.events.rendered, RENDERED,
      '事件名落 config/scanPage.js EVENTS ✓（该键一旦让出 ⇒ 必须逐字等于 scan.page.rendered）');
  }
  assert.match(src, /config\.events\?\.rendered \|\| 'scan\.page\.rendered'/,
    '⭐ 配置先行：路由读 `config.events.rendered`；摘键期间由兜底字面量顶（配置让出后自动改读它 ✓）');
  const step = src.slice(src.indexOf('const sendPaymentStep = '));
  const stepBody = step.slice(0, step.indexOf('\n  };'));
  const logAt = stepBody.indexOf('logRendered(req');
  const htmlAt = stepBody.indexOf('return sendHtml(res, status, renderSalePaymentStepPage(');
  assert.ok(logAt >= 0, '⭐ `sendPaymentStep` 里要有 `logRendered(req` 这一句');
  assert.ok(htmlAt >= 0, '`sendPaymentStep` 的出口仍是原来那一句 `sendHtml`');
  assert.ok(logAt < htmlAt, '⭐ 日志必须**在**发页面之前（她在页面上看到的 = 日志记的）');
  // ③ 🔴 冻结文件一个字没动（`services/scanWriteService.js`）
  assert.equal(/scan\.page\.rendered/.test(
    fs.readFileSync(path.join(__dirname, '../src/services/scanWriteService.js'), 'utf8'),
  ), false, '🔴 `scanWriteService.js` 冻结 —— 这条日志不许出现在它里面');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RL10 的那一处成对迁移（落地轮 2026-10-16 · **唯一**一处偏离原用例的地方）
// ═══════════════════════════════════════════════════════════════════════════
//
// **为什么迁移**：原用例的 11 条里，只有 AC-RL10 的第二条断言**跨到了另一个文件**
//   （`assert.equal(SCAN_PAGE.events.rendered, RENDERED, …)` ⇒ 需要 `config/scanPage.js`
//    的 `EVENTS.rendered` 那个键）。落地这一轮，`server/src/config/scanPage.js`
//   **正被 `replenish-trim`（`.local/replenish-trim`，未提交 ✗）占着** ⇒ 红线：
//   本刀**只碰 `server/src/routes/scanPage.js`** ✗ ⇒ 那条 hunk **摘出来不做** ✓。
//
// **改前逐字**（`.local/landing-diag/landing-diag-rendered-log.test.js:397`）：
//   `assert.equal(SCAN_PAGE.events.rendered, RENDERED, '事件名落 config/scanPage.js EVENTS ✓');`
//
// **改后逐字**（本文件 AC-RL10 的 ②）：
//   ```js
//   if (Object.prototype.hasOwnProperty.call(SCAN_PAGE.events, 'rendered')) {
//     assert.equal(SCAN_PAGE.events.rendered, RENDERED,
//       '事件名落 config/scanPage.js EVENTS ✓（该键一旦让出 ⇒ 必须逐字等于 scan.page.rendered）');
//   }
//   assert.match(src, /config\.events\?\.rendered \|\| 'scan\.page\.rendered'/,
//     '⭐ 配置先行：路由读 `config.events.rendered`；摘键期间由兜底字面量顶（配置让出后自动改读它 ✓）');
//   ```
//
// **依据**：① 实现**形状一个字没改** —— 补丁里那行本来就是
//   `logInfo(config.events?.rendered || 'scan.page.rendered', …)`（配置先行 + 兜底 ✓），
//   摘掉配置 hunk **不影响任何运行时取值**（其余 10 条判据都按 `"event":"scan.page.rendered"`
//   抓日志 ⇒ 运行时事件名已被**逐条钉住** ✓）；② 迁移后的断言**仍能真红**：
//   把 `config.events?.rendered ||` 这个兜底删掉 ⇒ 红；把配置里那个键写成别的值 ⇒ 红；
//   ③ 配置一旦让出（`replenish-trim` 合并）⇒ **把那 7 行换回原来那一行**、
//   并把配置 hunk 补上（见 PR 描述里的「待办 · 等 `config/scanPage.js` 让出」✓）。
