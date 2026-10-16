'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ task-60（2026-10-16 · 业务负责人真机 05:34 + **她当日亲口选的方案 ②**）
 *
 * ## 她的原话（逐字）
 * 我问：「你扫 A 货品、点「销售」，却被顶到**上一单**的资金页 ✗ ⇒
 *   ① 接管前先核对"是不是这个货品" 还是 ② 重扫同一个货品就从头开始（清掉那条未完成）？」
 * 她答：**「② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）」**
 *
 * ## 真毛病（上一任的只读诊断，Lead 已认可 —— 这里直接引用，不重新论证）
 * `routes/scanPage.js` 那段"**刷新仍给资金页**"的接管（10-14 晚 + 10-15 晚两次收紧）
 * **只认标记、只认领域，不认"这一单是不是当前这个货品"** ✗ ⇒
 * 会话里只要留着一条"未完成"（`paymentStep:'pending'`），她**扫 A 货品、点「销售」**
 * 就被顶到**上一单的资金页** ✗（她截图正是这个形状）。
 * ⚠️ 会话里**没有**货品身份（`submitPending` 只有尺码/金额/收款那一套 ⇒ 见提交那一步那一笔）
 * ⇒ 方案 ① 需要**新增**货品身份那一路；她选的是 ②（**不需要**身份 ⇒ 重扫就从头开始 ✓）。
 *
 * ## 这一刀（她选的 ②）
 * **扫到货品、点「销售」那一发**（= 显式 `?from=sales`；realm tab 的链接就是它，
 *   见 `views/scanPageRenderer.js:437` 的 `href="?from=${id}"`）⇒
 * **先把那条"未完成"的标记清掉** ⇒ 这一发**从货品页开始** ✓（不再被上一单的资金页顶掉 ✗）。
 *
 * 🔴 **清的范围（别清过头 ✗）**：
 *   · 只清 **`paymentStep`** ＋ 与它同笔的 **`submitPending`**（她 2026-10-15 定的那份草稿）；
 *   · **`lines` / `order_no` / `master_record_id` / `status` / `completed` / `seq` 一个字都不碰**；
 *   · **只写她这条会话**（openId 来自签名 cookie ⇒ 别人的会话碰不到 ✗）；
 *   · **零业务表写入**（这一段只调 `sessions.saveDraftLines` ⇒ 已落库 / 已提交的单一个字节没动 ✓）。
 * 🔴 **不清什么**（这些**逐字仍在**，一条都不许动）：
 *   · **裸扫仍然接管** —— 那是她 2026-10-14 定的"**资金页刷新不丢**"
 *     （`test/scanSalePayFront.test.js` AC-PF4 · `test/scanPaymentStepStale.test.js` AC-SM2/SM3/SM7/SM8）；
 *   · **非销售领域**一律不接管、也不清（10-14 晚那条边界）；
 *   · `?data=1`（骨架自取那一发）**绕过**这一整段（那道闸门逐字未动）；
 *   · **残标记自清理**那条既有分支（`scan.payment_step.stale_cleared`）**一个字没改** ✓。
 *
 * ## 验收标准（**先写后做**；每条能真红）
 * · **AC-LR1** 未完成（`pending` + `submitPending`）+ 点「销售」⇒ **货品页** ＋ **标记真的被清** ＋
 *   **一条 `scan.payment_step.reset_on_scan`**（带旧值/旧状态/清没清）—— **把清除去掉 ⇒ 红** ✓
 * · **AC-LR1b** **扫任意货品**（换一个编号）都是同一个结果（② 不带"是不是这个货品"的核对 ✓）
 * · **AC-LR2a** 已提交的单 / 已落库数据**一个字都不动**（除那两个键外，会话对象**逐字相等** ＋ 零业务写）
 * · **AC-LR2b** **别人的会话**一个字不碰（只写她这条 openId）
 * · **AC-LR2c** **不清过头**：非销售领域 / `?data=1` / **裸扫** ⇒ 一律**不清**
 *   （裸扫仍走既有接管 ⇒ 顺带钉住 `pending_mark:lines|order|status_not_submitted` 三条 trigger）
 * · **AC-LR3** 既有「残标记自清理」分支**逐字未动**（源码哨兵）＋ 行为哨兵（裸扫那次仍打 `stale_cleared`）
 *
 * ⚠️ 本文件是**新建**的（`server/test/**` 同时有别的任务在改 ⇒ 按"scan 相关、新文件优先"办）
 *    —— **一个字都不去动别人的用例文件** ✓（只"成对迁移"两条被本刀行为变化波及的既有判据，
 *    迁移记录写在各自那一行上：改前逐字 → 改后逐字 → 依据 = 她 2026-10-16 选 ②）。
 * ⚠️ 本文件按**骨架屏关**那个形状跑（裸扫 ⇒ 走既有接管 ⇒ 才验得了"裸扫不清"这条边界）；
 *    骨架屏**开**那个形状（线上取值）在 `test/scanPageRenderedLog.test.js` 里 ✓。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// 路由模块在 require 时就会 `new V1BitableGateway()`（构造时读飞书凭证）；给一对假凭证只为能加载。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_landing_reset';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_landing_reset_secret';
// ⭐ 本文件要的就是"**裸扫走既有接管**"那个形状 ⇒ 骨架屏**显式关**（缺省也是关 ✓ 这里写死只为不受环境干扰）
process.env.SCAN_PAGE_SKELETON_ENABLED = 'false';

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const SESSION_SECRET = 'scan_landing_reset_test_secret';
// 她真机那双（Lead 的生产日志里就是 `N05`）。
const NUMBER = 'N05|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
// AC-LR1b 用：**另一个**货品（"扫任意货品"里的那个"任意"）。
const NUMBER_B = '832-321-H|黑色|A';
const ENCODED_B = encodeURIComponent(NUMBER_B);
const OPEN_ID = 'ou_scan_landing_reset';
const OTHER_OPEN_ID = 'ou_someone_else';
const RESET_EVENT = 'scan.payment_step.reset_on_scan';
const STALE_EVENT = 'scan.payment_step.stale_cleared';
const PAYMENT_PAGE_MARK = 'data-view="payment-step"';

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
  // ⭐ 2026-10-15 task-17（AC-P1）：测试服务器**不保持 keep-alive**（根因见 `test/stabilityRepro.cjs`）。
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  // ⚠️ **要把 run 的返回值带回来**（下面 `withLogs(() => withServer(...))` 要拿这一发的页面 ＋ 日志 ✓）
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** 一条"商品找得到"的只读视图（够渲染销售块）。 */
const view = (number = NUMBER) => ({
  found: true,
  number,
  item_no: String(number).split('|')[0],
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
});

/**
 * 假 writeService —— **按 openId 分槽**、会话**可变**（`saveSaleProgress` 真的把 patch 合进去，
 * `undefined` 的键**真的消失** ⇒ "清掉之后再扫一次"是**真跑了一遍**，不是"看着像清掉了" ✓）。
 */
const writeServiceFor = ({ mine = {}, others = {} } = {}) => {
  const sessions = new Map();
  sessions.set(OPEN_ID, { sale: { ...mine } });
  for (const [openId, sale] of Object.entries(others)) sessions.set(openId, { sale: { ...sale } });
  const patches = [];
  const calls = [];
  const api = {
    async get(openId) {
      const found = sessions.get(String(openId));
      return found ? { sale: { ...found.sale } } : { sale: {} };
    },
    async submitKeyFor() { return 'scan_sale:key:1'; },
    async saveSaleProgress(openId, patch) {
      patches.push({ openId: String(openId), patch });
      const found = sessions.get(String(openId)) || { sale: {} };
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) delete found.sale[key];
        else found.sale[key] = value;
      }
      sessions.set(String(openId), found);
      return { sale: { ...found.sale } };
    },
  };
  return {
    patches,
    calls,
    sessions: api,
    saveDraftLines: (openId, patch) => api.saveSaleProgress(openId, patch),
    listAccessories: async () => [],
    // AC-LR2a 用：**业务写入**一律记账（这一段**一次都不该进来** ✓）
    submitSale: async (input) => {
      calls.push({ kind: 'submitSale', submitKey: input?.submitKey });
      return { ok: true, order_no: 'XSD-LR', sales_entry_record_id: 'rec_lr', payment_count: 0 };
    },
    saleOf: (openId) => ({ ...((sessions.get(String(openId)) || { sale: {} }).sale) }),
  };
};

const appFor = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // 生产里每个请求都带 `req.requestId`（`app.js` 的中间件）⇒ 照摆一个（"日志里带 requestId"才是真跑出来的）
  app.use((req, res, next) => { req.requestId = 'req_scan_landing_reset'; next(); });
  const router = createScanPageRouter({
    // ⚠️ 按 URL 上那个编号回答 ⇒ "扫另一个货品"（AC-LR1b）走的是**同一条生产路** ✓
    service: {
      lookup: async ({ number } = {}) => view(number || NUMBER),
    },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return app;
};

const getPage = async (base, query = '', encoded = ENCODED, openId = OPEN_ID) => {
  const response = await fetch(`${base}/s/${encoded}${query}`, { headers: { cookie: sessionCookie(openId) } });
  return { status: response.status, html: await response.text() };
};

const post = (base, body, query = '') => fetch(`${base}/s/${ENCODED}${query}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

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

const withLogs = async (run) => {
  const logs = captureLogs();
  try {
    const result = await run();
    return { result, logs };
  } catch (error) {
    logs.restore();
    throw error;
  }
};

/** 她真机那一份会话的**形状**（Lead 拉的线上会话快照：pending + draft + submitPending + 无单号）。 */
const UNFINISHED = {
  paymentStep: 'pending',
  status: 'draft',
  message: '',
  order_no: '',
  master_record_id: '',
  lines: [],
  submitPending: { size: '43', amount: '240', gift: '' },
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-LR1 点「销售」（?from=sales）⇒ 货品页 + 标记被清 + 一条 reset_on_scan
// ═══════════════════════════════════════════════════════════════════════════

test('AC-LR1 ⭐⭐ 未完成（pending + submitPending）+ 点「销售」⇒ **货品页**（不再被上一单的资金页顶掉）+ **标记被清** + **一条 reset_on_scan**', async () => {
  login();
  const write = writeServiceFor({ mine: { ...UNFINISHED } });
  const { result: page, logs } = await withLogs(() => withServer(
    appFor(write), (base) => getPage(base, '?from=sales'),
  ));

  // ① 她看到的是**货品页**（她选的 ②：从头开始 ✓）
  assert.equal(page.status, 200);
  assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false,
    '⭐ 不许再被"上一单的资金页"顶掉（把清除那一句去掉 ⇒ 这一条必红 ✓）');
  assert.ok(page.html.includes('realm-block--sales'), '照旧渲染**销售**那一块（货品页 ✓）');

  // ② 标记**真的被清了**（正好一笔、只有那两个键、只写她这条会话）
  assert.equal(write.patches.length, 1, '正好清一次（不许反复清 / 不许清别的）');
  assert.deepEqual(Object.keys(write.patches[0].patch).sort(), ['paymentStep', 'submitPending'],
    '⭐ 同笔清这两个键（别的字段一个都不许碰）');
  assert.equal(write.patches[0].patch.paymentStep, undefined, '清成"没走到资金这一步"的既有表示（= 这个键不在）');
  assert.equal(write.patches[0].openId, OPEN_ID, '⭐ 只写**她这条**会话');
  assert.equal(Object.prototype.hasOwnProperty.call(write.saleOf(OPEN_ID), 'paymentStep'), false,
    '清完之后会话里**真的**没有这个键了（下一次读就不会再被顶到资金页 ✓）');

  // ③ 如实记一条日志（真机排查用）：**清掉了什么 + 旧状态是什么**
  const events = logs.events(RESET_EVENT);
  assert.equal(events.length, 1, '⭐ 必须有一条 `scan.payment_step.reset_on_scan`（删掉就红）');
  const payload = JSON.parse(events[0]);
  assert.equal(payload.raw, 'pending', '如实带旧值');
  assert.equal(payload.lines, 0, '如实带旧形状（草稿 0 行）');
  assert.equal(payload.has_order, false, '如实带"有没有已建单号"');
  assert.equal(payload.sale_status, 'draft', '如实带旧状态');
  assert.equal(payload.had_submit_pending, true, '如实带"那条 submitPending 在不在"');
  assert.equal(payload.reset, true, '"清掉了"这件事要说得出来');
  assert.ok(String(payload.request_id || '').length > 0, '带 requestId ✓');
  assert.ok(String(payload.open_id || '').length > 0, '带 openId（logger 按既有规则脱敏 ✓）');
});

test('AC-LR1c ⭐ 清掉之后再点一次「销售」⇒ 仍是货品页，且**不再**清第二笔（真跑了一遍，不是"看着像"）', async () => {
  login();
  const write = writeServiceFor({ mine: { ...UNFINISHED } });
  await withServer(appFor(write), async (base) => {
    const first = await getPage(base, '?from=sales');
    const second = await getPage(base, '?from=sales');
    const third = await getPage(base, '?from=sales');
    for (const page of [first, second, third]) {
      assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, '每次都该是货品页（不再被顶 ✗）');
      assert.ok(page.html.includes('realm-block--sales'), '每次都是销售那一块 ✓');
    }
  });
  assert.equal(write.patches.length, 1, '只在**第一次**清一次（后面没有标记可清 ⇒ 不再写会话 ✓）');
});

test('AC-LR1b ⭐ **扫任意货品**都是同一个结果（她 2026-10-16 选的是 ②，**不带**"是不是这个货品"的核对）', async () => {
  login();
  const write = writeServiceFor({ mine: { ...UNFINISHED } });
  const page = await withServer(
    appFor(write), (base) => getPage(base, '?from=sales', ENCODED_B),
  );
  assert.equal(page.status, 200);
  assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false,
    '⭐ 扫**另一个**货品也**不许**被顶到上一单的资金页 ✗（这正是她真机那一下）');
  assert.ok(page.html.includes('realm-block--sales'), '出货品页 ✓');
  assert.equal(write.patches.length, 1, '照样清一次 ✓（② 不需要货品身份 ⇒ 与编号无关）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-LR2 清除的**范围**：只清"未完成"那部分，别的（含别人的会话）一个字不碰
// ═══════════════════════════════════════════════════════════════════════════

test('AC-LR2a ✅ 已提交的单 / 已落库的数据**一个字都不动**：除那两个键外，会话对象**逐字相等** ＋ 零业务写入', async () => {
  login();
  // 已建单、已落库那一单的形状（单号 / 主表记录 id / 状态 / 草稿行 / 完成记录 / seq 都在）
  const before = {
    paymentStep: 'pending',
    status: 'submitted',
    order_no: 'XSD-20261016-0007',
    master_record_id: 'rec_master_7',
    lines: [{ product_number: NUMBER, size: 41, quantity: 1, sale_unit_price: 399 }],
    completed: ['XSD-20261016-0006'],
    seq: 7,
    submitPending: { size: '41', amount: '399' },
  };
  const write = writeServiceFor({ mine: { ...before } });
  const { result: page, logs } = await withLogs(() => withServer(
    appFor(write), (base) => getPage(base, '?from=sales'),
  ));

  assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, '这一发仍是货品页（从头开始 ✓）');

  // ⭐ 最强的那条：**除了那两个键，会话逐字相等**（多清一个键 / 改一个值 ⇒ 红 ✓）
  const expected = { ...before };
  delete expected.paymentStep;
  delete expected.submitPending;
  assert.deepEqual(write.saleOf(OPEN_ID), expected,
    '⭐ 只少了 `paymentStep` / `submitPending` 两个键，**别的字段一个字都没变**');
  assert.equal(write.saleOf(OPEN_ID).order_no, 'XSD-20261016-0007', '已建单号原样还在（单子没被碰 ✓）');
  assert.equal(write.saleOf(OPEN_ID).master_record_id, 'rec_master_7', '主表记录 id 原样还在 ✓');

  // 已落库的数据 = **业务写入一次都没有**（零业务表写入 / 零建单 / 零库存）
  assert.deepEqual(write.calls, [], '⭐ 这一段**一次业务写入都不许有**（已落库那单的数据不受影响 ✓）');
  assert.equal(logs.lines.filter((line) => line.includes('bitable.record.')).length, 0,
    '⭐ 一条 `bitable.record.*` 都不许出现（碰了表就红 ✓）');
  assert.equal(logs.events('v1.sale.posted').length, 0, '一条 `v1.sale.posted` 都不许出现 ✓');
});

test('AC-LR2b ✅ **别人的会话**一个字不碰（只写她这条 openId 的那一份）', async () => {
  login();
  const otherBefore = {
    paymentStep: 'pending', status: 'draft', lines: [{ product_number: 'X|黑|A', size: 40, quantity: 1 }],
    submitPending: { size: '40', amount: '399' },
  };
  const write = writeServiceFor({ mine: { ...UNFINISHED }, others: { [OTHER_OPEN_ID]: { ...otherBefore } } });
  await withServer(appFor(write), (base) => getPage(base, '?from=sales'));

  assert.equal(write.patches.length, 1, '只清一笔 ✓');
  assert.equal(write.patches[0].openId, OPEN_ID, '⭐ 清的是**她**那条会话');
  assert.deepEqual(write.saleOf(OTHER_OPEN_ID), otherBefore,
    '⭐ **别人的会话逐字未动**（连 paymentStep / submitPending 都还在 ✓）');
});

test('AC-LR2c ✅ **不清过头**：非销售领域 / `?data=1` / **裸扫** 一律**不清**（裸扫仍走既有接管 ✓）', async () => {
  login();
  // ① 非销售领域：不接管、也不清（10-14 晚那条边界 ✓）
  for (const realm of ['inventory', 'replenish', 'purchase_return']) {
    const write = writeServiceFor({ mine: { ...UNFINISHED, lines: [{ size: 41, quantity: 1 }] } });
    // eslint-disable-next-line no-await-in-loop
    await withServer(appFor(write), async (base) => {
      const page = await getPage(base, `?from=${realm}`);
      assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, `${realm} 不许被资金页接管 ✓`);
      assert.ok(page.html.includes(`realm-block--${realm}`), `${realm} 照旧那一块 ✓`);
    });
    assert.deepEqual(write.patches, [], `${realm} 不是这一块的账 ⇒ **不许**顺手清标记 ✗`);
  }

  // ② `?data=1`（骨架自取那一发）：穿过这一整段 ⇒ 既不清、也不接管（那道闸门逐字未动 ✓）
  const dataWrite = writeServiceFor({ mine: { ...UNFINISHED } });
  await withServer(appFor(dataWrite), async (base) => {
    const page = await getPage(base, '?data=1');
    assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, '?data=1 绕过接管 ⇒ 不是资金页 ✓');
    assert.ok(page.html.includes('realm-block--sales'), '是货品页 ✓');
    // 同一发带上 from=sales（人工拼出来的形状）：`data=1` 那道闸门仍然优先 ⇒ 也不清
    const combo = await getPage(base, '?data=1&from=sales');
    assert.equal(combo.html.includes(PAYMENT_PAGE_MARK), false, '?data=1&from=sales 也不给资金页 ✓');
  });
  assert.deepEqual(dataWrite.patches, [], '?data=1 那一发**不许**清标记（绕过段一个字不改 ✓）');

  // ③ 🔴 **裸扫仍然接管**（她 2026-10-14 定的"资金页刷新不丢"⇒ 本刀**不许**动它）
  //    顺带把"哪条判据把她顶到资金页"那三条 trigger 逐条钉住（真机再出现时一眼看得出来 ✓）
  const cases = [
    { sale: { ...UNFINISHED, lines: [{ size: 41, quantity: 1, amount: '399' }] }, trigger: 'pending_mark:lines' },
    { sale: { ...UNFINISHED, order_no: 'XSD-20261016-0001' }, trigger: 'pending_mark:order' },
    { sale: { ...UNFINISHED }, trigger: 'pending_mark:status_not_submitted' },
  ];
  for (const { sale, trigger } of cases) {
    const write = writeServiceFor({ mine: { ...sale } });
    const { result: page, logs } = await withLogs(() => withServer(
      appFor(write), (base) => getPage(base),
    ));
    assert.ok(page.html.includes(PAYMENT_PAGE_MARK),
      '⭐ **裸扫**（不带 from）仍给资金页 —— 那是"刷新不丢"，清它 = 清过头 ✗');
    assert.deepEqual(write.patches, [], '裸扫那一发**不许**清（她还要回来付 ✗）');
    const rendered = logs.events('scan.page.rendered').map((line) => JSON.parse(line));
    assert.equal(rendered.length, 1, '每一发恰好一条 rendered 日志 ✓');
    assert.equal(rendered[0].page, 'pay', '渲染的是资金页 ✓');
    assert.equal(rendered[0].trigger, trigger, `⭐ 命中的是哪一条判据：${trigger}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-LR3 既有「残标记自清理」分支**逐字未动**（源码哨兵 ＋ 行为哨兵）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 🔴 **改前那一份的逐字冻结**（`routes/scanPage.js` 里那条"残标记自清理"分支：
 *    `// 🔴 **残标记**（0 行 + 没单号 + 已 submitted）…` 起到 `had_submit_pending: hadSubmitPending,` 那笔 `});`）。
 *    这份字符串是从**当前源码**里逐字节抽出来的 ⇒ 谁改这个分支一个字就红 ✓。
 */
const STALE_BRANCH_FROZEN = [
  "          // 🔴 **残标记**（0 行 + 没单号 + 已 `submitted`）⇒ **不给资金页**，并把标记清成\"**没走到资金这一步**\"",
  "          //   的**既有表示** = 这个键**不在**（`services/scanSessionService.js` 的默认 `sale` 里就**没有**",
  "          //   `paymentStep` ✓）⇒ 清成 `undefined`：`saveSaleProgress` 是 `{...当前 sale, ...patch}`、",
  "          //   store 是 `JSON.stringify`（`jsonTaskStore`）⇒ 这个键就**没了** ✓。",
  "          //   ⚠️ **不是** `'created'`（那是\"**这一单已经建过**\"的既有含义，写上去就是撒谎 ✗）；",
  "          //   ⚠️ **不是**空串（那是**另造一个值**，注释里也点名过不许 ✗）；",
  "          //   ⚠️ 清标记**失败不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出正常页 ✓。",
  "          //   ⭐⭐ 2026-10-15 晚（task-22）：**`submitPending` 同一笔清掉**（纯卫生 ✓）——",
  "          //      `paymentStep` 一清，它在代码里就**再没有读点**（pay / skip 两处都在",
  "          //      `paymentStep === 'pending'` 的门内 ⇒ 这颗残留 payload 只会误导下次真机排查；",
  "          //      Lead 手工清她会话时也把它一起清了 ✓）。",
  "          //      🔴 **顺序不能反**：必须在\"提交那一步把 `status` 落回 `draft`\"（见提交分支）**之后**才敢这么清 ✗",
  "          //         —— 否则第 2 单刚提交那一下也会命中这条残标记分支 ⇒ 把她**点按钮要写的那一双**抹掉 ⇒ 建不了单 ✗。",
  "          const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);",
  "          const clearing = writeService.saveDraftLines?.(",
  "            openIdOf(req), { paymentStep: undefined, submitPending: undefined },",
  "          );",
  "          await Promise.resolve(clearing).catch((error) => {",
  "            logWarn('scan.payment_step.stale_clear_failed', {",
  "              request_id: requestId, error: error.message,",
  "            });",
  "          });",
  "          // **不静默**：真机排查时这一条说明\"那次残标记是被我们清掉的，不是她自己清掉的\"。",
  "          logWarn('scan.payment_step.stale_cleared', {",
  "            request_id: requestId,",
  "            open_id: openIdOf(req),",
  "            raw: String(pendingMark).slice(0, 32),",
  "            lines: pendingLines.length,",
  "            has_order: hasOrder,",
  "            sale_status: saleStatus,",
  "            had_submit_pending: hadSubmitPending,",
  "          });"
].join('\n');

test('AC-LR3 🔴 既有「残标记自清理」分支**逐字未动**（源码哨兵：改一个字就红）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.ok(src.includes(STALE_BRANCH_FROZEN),
    '⭐ 残标记自清理那一段（含它的注释、清法、日志字段）必须**逐字节原样**（不许改 / 不许搬 / 不许删 ✗）');
  // 它的两条日志名照旧（既有真机排查靠它们）
  assert.match(src, /scan\.payment_step\.stale_cleared/, '`stale_cleared` 照旧 ✓');
  assert.match(src, /scan\.payment_step\.stale_clear_failed/, '`stale_clear_failed` 照旧 ✓');
  // 本刀新加的那一段**不许**把这行判据换掉（只许**在它之前**把本地标记置空）
  assert.match(src, /pendingMark === 'pending' && salesContext/,
    '⭐ 接管那条判据的子串照旧在（AC-SM6 / AC-PS1 的哨兵不许被本刀挤掉 ✓）');
  assert.match(src, /if \(pendingLines\.length > 0 \|\| hasOrder \|\| saleStatus !== submittedStatus\)/,
    '⭐ "有东西要付"那条三选一判据逐字仍在 ✓');
});

test('AC-LR3b ⭐ 行为哨兵：残标记（pending + 0 行 + 无单号 + `submitted`）**裸扫** ⇒ 照旧 `stale_cleared`（既有分支真的还在跑）', async () => {
  login();
  const write = writeServiceFor({
    mine: { paymentStep: 'pending', status: 'submitted', lines: [], submitPending: { size: '40', amount: '399' } },
  });
  const { result: page, logs } = await withLogs(() => withServer(
    appFor(write), (base) => getPage(base),
  ));
  assert.equal(page.html.includes(PAYMENT_PAGE_MARK), false, '残标记 ⇒ 不给资金页 ✓（#598/#601 那条修法仍在）');
  assert.ok(page.html.includes('realm-block--sales'), '照旧货品页 ✓');
  assert.equal(logs.events(STALE_EVENT).length, 1, '⭐ 既有那条 `scan.payment_step.stale_cleared` 照旧打出来 ✓');
  assert.equal(logs.events(RESET_EVENT).length, 0, '裸扫那一发**不是**本刀那条新日志（两条各司其职 ✓）');
  assert.deepEqual(Object.keys(write.patches[0].patch).sort(), ['paymentStep', 'submitPending'],
    '清法照旧（同笔两个键 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-LR1d 正向：**真的提交一次**（真表单 + 真链路）⇒ 提交那一下仍到资金页；
//        而后**再扫、再点销售** ⇒ 从货品页从头开始（她真机那一串动作的完整复现）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-LR1d ⭐⭐ 真链路一串联：点「提交这一单」⇒ 资金页（照旧 ✓）· 再点「销售」⇒ **货品页从头开始**（她真机那一串）', async () => {
  login();
  const write = writeServiceFor({
    // 上一单刚完成时 `completeSale` 落下的形状（第 2 单就从这里长出来 ✓）
    mine: { status: 'submitted', lines: [], order_no: '', master_record_id: '', paymentStep: 'created' },
  });
  await withServer(appFor(write), async (base) => {
    // ① 她点「提交这一单」⇒ **照旧**到资金页（那是她 2026-10-14 定的两步走 ✓）
    const submitted = await post(base, {
      action: SCAN_WRITE.actions.submitOrder,
      [SCAN_WRITE.fields.size]: '41',
      [SCAN_WRITE.fields.amount]: '399',
    });
    const submittedHtml = await submitted.text();
    assert.equal(submitted.status, 200);
    assert.ok(submittedHtml.includes(PAYMENT_PAGE_MARK), '提交那一下照旧是资金页 ✓');
    assert.equal(write.saleOf(OPEN_ID).paymentStep, 'pending', '提交那一步照旧写 `paymentStep:pending` ✓');

    // ② 她没有点资金页那两颗按钮，就去**重扫/点销售** ⇒ 按她选的 ②：**从头开始**（货品页）
    const again = await getPage(base, '?from=sales');
    assert.equal(again.html.includes(PAYMENT_PAGE_MARK), false,
      '⭐ 她那一串动作的复现：点「销售」**必须**出货品页（不再被那条未完成顶掉 ✗）');
    assert.ok(again.html.includes('realm-block--sales'), '货品页 ✓');
    assert.equal(write.saleOf(OPEN_ID).paymentStep, undefined, '那条未完成标记被清成"没有" ✓');
    // ⚠️ 提交那一步写下的 `status:draft` **不在清除范围**（只清那两个键）—— 如实钉住 ✓
    assert.equal(write.saleOf(OPEN_ID).status, SCAN_WRITE.session.statuses.draft,
      '别的字段（这一单自己的 status）一个字没碰 ✓');
  });
});
