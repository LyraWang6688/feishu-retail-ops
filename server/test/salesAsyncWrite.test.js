'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ ⑨ B **异步写入** 的验收用例（`docs/sales-async-write-2026-10-14.md` 的 AC-AS1…AS10）。
 *
 * 她的逐字：「**单号一出立刻回**…**明细/库存/交付转后台**；失败落「**写入失败**」、
 *   工作台显示「**未完成，可点重试**」；重试**只走 `submitSale` 同一把 `submitKey`**
 *   （**绝不直调 `_confirm`**、**绝不重复写/重复扣**）」
 *   ＋ 晚版文案：「**统一文字改成：本单已创建成功（单号），其余文字不需要**，**销售和配品都这样**」
 *
 * 🔴 **本刀（⑨a）里开关默认 `false`**（Lead 2026-10-15 的硬约束：重试入口在 ⑨b 才做，
 *   默认开 = 她会卡在"可点重试却点不了"⇒ 比现在更糟）⇒ 本文件**显式打开开关**来验异步那半边，
 *   并用**同一套入参**跑一遍"开关关着"的**回归锁**：结果与老同步路径**逐字同形** ✓。
 *
 * 判据（逐条）：
 *  · **AC-AS1** 点按钮 ⇒ 响应里**先有单号** ＋ 文案**逐字** = 「本单已创建成功（单号）」（一个字不多 ✗）
 *  · **AC-AS2** 注入很慢的后台（300ms）⇒ 她那次调用**不被拖住**（<150ms 就回来 ✓）
 *  · **AC-AS3** 后台真跑完 ⇒ 走**同一个**既有 `sales.confirm(...)`（入参与同步路径**逐字相同** ✓）
 *  · **AC-AS4a** 🔴 后台失败 ⇒ 主表**如实落「写入失败」**（**不许假成功** ✗）
 *    ⚠️ 只覆盖"**落表**那一半"；工作台那颗「可点重试」的**入口**是 ⑨b（AC-AS4/5/9）
 *  · **AC-AS6** 🔴 源码 + 行为双哨兵：**没有任何路径**直调 `_confirm`
 *  · **AC-AS7** 🔴 幂等键**一个字没变**（后台那一跑拿的是**同一把** `submitKey` ✓）
 *  · **AC-AS8** 配置先行：开关是**显式布尔**（`readFlag`，默认 `false`）、文案/超时可配、无 `||` 兜底 ✗
 *  · **AC-AS10** 与资金页两步走不冲突：① 点提交 ⇒ **零写入**；② 点按钮 ⇒ 单号先出 + 后台写 ✓
 *  · **AC-AS-LOCK**（本刀最重要）开关关着 ⇒ 与老同步路径**逐字同形**（保证 ⑨a 行为零变化 ✓）
 *
 * ⚠️ 外部世界（飞书 / 建单 / 业务层 / 状态写入）**全是替身**；跑的是**真的**
 *   `createScanWriteService.submitSale` + 真的 `routes/scanPage.js` ✓
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_async_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'async_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';
const ORDER_NO = 'XSD-20261015-0001';
const OPEN_ID = 'ou_async_1';
const ORDER_NO_FIELD = V1_BITABLE_SCHEMA.tables.salesEntry.fields.orderNo;
// ⭐ 异步那半边（显式打开；配置对象是 frozen 的 ⇒ 走**可注入**的那个口 ✓）
const ASYNC_ON = Object.freeze({
  enabled: true,
  doneBodyTemplate: SCAN_WRITE.sale.asyncWrite.doneBodyTemplate,
  backgroundTimeoutMs: 60000,
});
const ASYNC_OFF = Object.freeze({ enabled: false, doneBodyTemplate: '', backgroundTimeoutMs: 0 });

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 一套"真的在跑"的写服务：外部世界全是替身，用来**数调用**与**注入延时/失败**。
 * ⚠️ `sales` 替身上**同时**放 `confirm` 与 `_confirm` 两个口 ⇒ 「有没有直调 `_confirm`」是**数出来的** ✓
 */
const createHarness = ({ asyncWrite = ASYNC_ON, slowMs = 0, failConfirm = false } = {}) => {
  const dir = tempDir();
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir });
  const calls = { entry: [], confirm: [], underscoreConfirm: [], status: [] };
  const service = createScanWriteService({
    gateway: {},
    config: SCAN_WRITE,
    sessions,
    readCache: false,
    saleAsyncWrite: asyncWrite,
    createSalesEntry: async (_gateway, task) => {
      calls.entry.push(task);
      return { recordId: 'entry_1', record: { fields: { [ORDER_NO_FIELD]: ORDER_NO } } };
    },
    sales: {
      confirm: async (input, options) => {
        calls.confirm.push({ input, options });
        if (slowMs) await sleep(slowMs);
        if (failConfirm) throw new Error('后台写入失败（用例注入）');
        return { detailRecordIds: ['det_1'], paymentRecordIds: ['pay_1'] };
      },
      _confirm: async (input) => {
        calls.underscoreConfirm.push(input);
        return { detailRecordIds: ['det_x'], paymentRecordIds: [] };
      },
    },
    status: { write: async (id, dims, correlation) => { calls.status.push({ id, dims, correlation }); } },
  });
  return { service, sessions, calls, dir, cleanup: () => rmDir(dir) };
};

/** 她点资金页按钮那一下的入参（**两次跑用同一份** ⇒ "逐字相同"才可比 ✓）。 */
const submitInputOf = (session) => ({
  openId: OPEN_ID,
  submitKey: session.sale.key,
  payments: [{ method: '微信', amount: '399' }],
  lineAmounts: ['399'],
  paymentStatus: PAYMENT_STATUS.full,
  paidAmount: '399',
  pendingLine: {
    productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
    size: '41', amount: '399', gift: '', inStock: true,
  },
});

/** 取会话（没有就建 —— 她扫开就提交是完全正常的用法 ✓ 与生产同一条路）。 */
const sessionOf = async (harness) => (await harness.sessions.get(OPEN_ID))
  || (await harness.sessions.ensure(OPEN_ID));

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS2 / AC-AS3 / AC-AS7：单号先出 · 后台真跑 · 幂等键没变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS2 ⭐ 后台很慢（300ms）⇒ 她那次调用**不被拖住**（单号先出，几十毫秒就回）', async () => {
  const h = createHarness({ slowMs: 300 });
  try {
    const session = await sessionOf(h);
    const startedAt = Date.now();
    const result = await h.service.submitSale(submitInputOf(session));
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.deferred, true, '这一跑是"单号先出、余下转后台" ✓');
    assert.equal(result.order_no, ORDER_NO, '响应里**先有单号** ✓');
    assert.ok(elapsed < 150, `她那次调用不被后台拖住（实测 ${elapsed}ms < 150ms ✓）`);
    // 后台那一跑**还没**写完（证明"不等它"不是因为它恰好很快）
    assert.equal(h.calls.confirm.length, 0, '立刻回来时后台那一步还没跑 ✓');
    await sleep(500);
    assert.equal(h.calls.confirm.length, 1, '后台随后真的跑了 ✓');
  } finally { h.cleanup(); }
});

test('AC-AS3 ⭐ 后台跑完 ⇒ 走**同一个**既有 `sales.confirm(...)`，入参与同步路径**逐字相同**', async () => {
  // ① 异步那一跑
  const on = createHarness();
  let onConfirm = null;
  try {
    const session = await sessionOf(on);
    const result = await on.service.submitSale(submitInputOf(session));
    assert.equal(result.deferred, true);
    await sleep(120);
    assert.equal(on.calls.confirm.length, 1, '后台写明细/收款那一跑恰一次 ✓');
    onConfirm = on.calls.confirm[0];
  } finally { on.cleanup(); }

  // ② 老同步那一跑（开关关着 ⇒ 同一套入参走老路径）
  const off = createHarness({ asyncWrite: ASYNC_OFF });
  try {
    const session = await sessionOf(off);
    const result = await off.service.submitSale(submitInputOf(session));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(!!result.deferred, false, '开关关着 ⇒ 不是异步（老路径 ✓）');
    assert.equal(off.calls.confirm.length, 1);
    // 🔴 "结果与同步写逐字相同"：**同一个业务函数的入参**逐字相等
    //   ⚠️ 除 `onRecordPersisted` 那一个键 —— 它是**每次新建的闭包**（拿两个闭包比字节永远不等 ✗）；
    //      所以对它的判据是"**两边都有**（都是函数 ✓）"，其余键仍逐字比 ✓（不是放宽 ✗）。
    const comparable = (input) => {
      const { onRecordPersisted, ...rest } = input;
      return { ...rest, has_on_record_persisted: typeof onRecordPersisted === 'function' };
    };
    assert.equal(comparable(onConfirm.input).has_on_record_persisted, true,
      '后台那一跑也带着"写到一半崩了也能接着写"那个回调 ✓');
    assert.deepEqual(comparable(onConfirm.input), comparable(off.calls.confirm[0].input),
      '后台那一跑交给业务层的入参，与老同步路径**逐字相同**（除那个每次新建的回调 ✓）');
    assert.deepEqual(onConfirm.options, off.calls.confirm[0].options,
      '关联键那一份（`correlation`）也逐字相同 ✓');
  } finally { off.cleanup(); }
});

test('AC-AS7 🔴 幂等键**一个字没变**：后台那一跑拿的是**同一把** `submitKey`（`correlation.task_id` 相同）', async () => {
  const h = createHarness();
  try {
    const session = await sessionOf(h);
    const key = session.sale.key;
    await h.service.submitSale(submitInputOf(session));
    await sleep(120);
    assert.equal(h.calls.confirm.length, 1);
    assert.equal(h.calls.confirm[0].options.correlation.task_id, key,
      '后台那一跑的 `task_id` = 她点按钮时那把 `submitKey`（没另发一把、没拆幂等 ✓）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS6 `_confirm` 源码 + 行为双哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS6 🔴 源码 + 行为双哨兵：**没有任何路径**直调 `salesOrderService._confirm`', async () => {
  // ① 行为：跑一整趟（开关开着），`_confirm` 那个口**一次都没被碰** ✓
  const h = createHarness();
  try {
    const session = await sessionOf(h);
    await h.service.submitSale(submitInputOf(session));
    await sleep(120);
    assert.equal(h.calls.underscoreConfirm.length, 0, '后台那一跑**绝不**直调 `_confirm` ✗');
    assert.equal(h.calls.confirm.length, 1, '走的是**既有** `confirm`（幂等那一份 ✓）');
  } finally { h.cleanup(); }

  // ② 源码：`._confirm(` 这种调用**只许留在既有那两个内部件里**（销售服务自己的串行包装 ✓）
  //   ⚠️ 依据（2026-10-15 只读核过）：`salesOrderService.js` 的 `confirm` 把 `_confirm` 包进队列、
  //      `secondDeliveryService.js` 复用同一份 —— 这两处是**合并前就有**的设计 ✓；
  //      本哨兵要拦的是"**扫码/异步那条路另开一个口直调 `_confirm`**" ✗（那正是拆幂等的口子）。
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      // ⚠️ 只认**调用**（`. _confirm(`），定义/注释里提到名字不算
      if (/\.\s*_confirm\s*\(/.test(source)) offenders.push(path.relative(SERVER_SRC, full));
    }
  };
  walk(SERVER_SRC);
  assert.deepEqual(offenders.sort(), [
    path.join('services', 'salesOrderService.js'),
    path.join('services', 'secondDeliveryService.js'),
  ].sort(), `\`_confirm\` 的调用只许在既有那两个内部件里（实际：${JSON.stringify(offenders)}）——`
    + '扫码 / 异步这条路上**一处都不许有** ✗（那是拆幂等的口子）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS-LOCK：开关关着 ⇒ 与老同步路径逐字同形（⑨a 行为零变化）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS-LOCK ⭐⭐ 开关**默认 true**（⑨b-2 已翻）· 显式布尔 · 关着时与老路径**逐字同形**', async () => {
  // ⭐⭐ 2026-10-15（⑨b-2）**成对翻新**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(SCAN_WRITE.sale.asyncWrite.enabled, false,
  //              '默认必须是 `false`（Lead 的硬约束：重试入口还没做 ⇒ 不许让 main 出现"可点重试却点不了" ✗）');`
  //            ＋ `assert.match(cfgSource, /readFlag\(process\.env, 'SCAN_SALE_ASYNC_WRITE_ENABLED', false\)/, …)`
  //   改后逐字：默认 **`true`**（⑨b-2 的**全部意义**就是把开关打开）+ 同样的 `readFlag` 显式布尔检查（默认值改 `true`）
  //   依据：**她 2026-10-15 的裁决**「单号一出立刻回…明细/库存/交付转后台」——
  //     ⑨b-1 的三件（后台句柄 #568 / 工作台续写入口 #569 / 工作台「未完成，可点重试」UI #570）
  //     **都已合并进 main** ⇒ ⑨a 当时那条硬约束「重试入口还没做 ⇒ 不许默认开」
  //     （怕她在 main 上看到"可点重试却点不了"）**已经解除** ✓。
  //   ⚠️ 判据**没放宽**：显式布尔 / 不许 `||` 兜底 / "关着时与老路径逐字同形"三条**一条不少** ✓
  assert.equal(SCAN_WRITE.sale.asyncWrite.enabled, true,
    '⑨b-2：默认**开**（重试入口三件已合并 ⇒ 先前那条"不许默认开"的约束解除 ✓）');
  const cfgSource = fs.readFileSync(path.join(SERVER_SRC, 'config', 'scanWrite.js'), 'utf8');
  assert.match(cfgSource, /readFlag\(process\.env, 'SCAN_SALE_ASYNC_WRITE_ENABLED', true\)/,
    '开关走 `readFlag` + 显式默认 `true` ✓');
  assert.equal(/SCAN_SALE_ASYNC_WRITE_ENABLED[\s\S]{0,40}\|\|/.test(cfgSource), false,
    '不许用 `||` 兜底（那样"清空变量"关不掉 ✗）');

  // ② 行为：关着时**同步**跑完（返回里没有 deferred、业务层那一步在**返回之前**就跑完了）
  const off = createHarness({ asyncWrite: ASYNC_OFF });
  try {
    const session = await sessionOf(off);
    const result = await off.service.submitSale(submitInputOf(session));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(off.calls.confirm.length, 1, '老路径：明细/收款在她那次请求里就写完了 ✓');
    assert.equal(result.deferred, undefined, '老路径的返回里**没有** `deferred`（形状一个字没变 ✓）');
  } finally { off.cleanup(); }

  // ③ 开关**开着**时才会出现异步返回（对照，证明 ② 不是"开关没生效"）
  const on = createHarness();
  try {
    const session = await sessionOf(on);
    const result = await on.service.submitSale(submitInputOf(session));
    assert.equal(result.deferred, true, '开着才是异步 ✓（②③ 对照成立）');
  } finally {
    await sleep(120);
    on.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS4a 后台失败 ⇒ 主表如实落「写入失败」（**不许假成功** ✗）
//   ⚠️ 这一刀（⑨a）只覆盖"**落表**那一半"；工作台那颗「可点重试」的入口是 ⑨b（AC-AS4/5/9）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS4a 🔴 后台写失败 ⇒ 主表**如实落「写入失败」**（不许假成功 ✗）· 她那次响应照旧 200+单号', async () => {
  const h = createHarness({ failConfirm: true });
  try {
    const session = await sessionOf(h);
    const result = await h.service.submitSale(submitInputOf(session));
    // ① 她那次**照旧**拿到单号（后台失败**不许**反过来把她那次请求变成失败页 ✗）
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.deferred, true);
    assert.equal(result.order_no, ORDER_NO);
    // ② 后台那一跑真的失败了
    await sleep(150);
    assert.equal(h.calls.confirm.length, 1, '后台试过一次 ✓');
    // ③ 🔴 主表那一列**如实落「写入失败」**（既有状态维度的值 + 既有写入器 ✓）
    const failed = h.calls.status.filter((call) => call.dims && call.dims.sales === '写入失败');
    assert.equal(failed.length, 1, `要落一条「写入失败」（实际：${JSON.stringify(h.calls.status)}）`);
    assert.equal(failed[0].id, 'entry_1', '落的是**这一单**那条主表记录 ✓');
    // ④ 其余维度**不许**被顺手写坏（只写 sales 这一维 ✓）
    assert.deepEqual(Object.keys(failed[0].dims), ['sales'], '只写「销售」这一维 ✓');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS1 / AC-AS8 / AC-AS10：路由那一层（那句文案 · 配置先行 · 两步走不冲突）
// ═══════════════════════════════════════════════════════════════════════════

const ROUTE_SECRET = 'async-route-secret';
const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 't', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', ROUTE_SECRET).update(payload).digest('base64url')}`;
};

/** 路由那一层的台子：`writeService` 是**替身**（只为看"她点按钮那一下收到了什么"）。 */
const withRoute = async (run) => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = ROUTE_SECRET;
  const dir = tempDir();
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir });
  const calls = [];
  const writeService = {
    sessions,
    submitSale: async (input) => {
      calls.push(input);
      return {
        ok: true, reused: false, deferred: true,
        order_no: ORDER_NO, sales_entry_record_id: 'entry_1', detail_count: 1, payment_count: 1,
      };
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ found: true, number: NUMBER, product_record_id: 'prod_1' }) },
    gateway: {},
    writeService,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ base, sessions, calls, writeService });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmDir(dir);
  }
};

/** 资金页那张表单的入参（金额两边一致 ⇒ 结算校验放行 ✓）。 */
const payBody = (extra = {}) => new URLSearchParams({
  action: SCAN_WRITE.actions.paymentPay || SCAN_WRITE.paymentStep?.payAction || 'payment_pay',
  submit_key: 'scan_async:key:1',
  [SCAN_WRITE.fields.paymentStatus]: PAYMENT_STATUS.full,
  [SCAN_WRITE.fields.paidAmount]: '399',
  [SCAN_WRITE.fields.lineAmount]: '399',
  [SCAN_WRITE.fields.paymentMethod]: '微信',
  [SCAN_WRITE.fields.paymentAmount]: '399',
  order_no: ORDER_NO,
  count: '1',
  ...extra,
}).toString();

test('AC-AS1 ⭐ 点按钮 ⇒ 响应里**先有单号** ＋ 文案**逐字** =「本单已创建成功（单号）」（其余文字都不要 ✗）', async () => {
  await withRoute(async ({ base, sessions }) => {
    // 会话：她刚点过「提交这一单」⇒ 资金页待确认（`paymentStep:'pending'`）
    await sessions.saveSaleProgress(OPEN_ID, {
      paymentStep: 'pending',
      lines: [{ size: 41, quantity: 1, item_no: 'YD6693-2', number: NUMBER, color: '黑色', amount: '399' }],
      submitPending: { size: '41', amount: '399' },
    });
    const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
      method: 'POST',
      headers: { cookie: cookieOf(OPEN_ID), 'content-type': 'application/x-www-form-urlencoded' },
      body: payBody(),
    });
    assert.equal(response.status, 200, '点按钮 ⇒ 200（单号先出 ✓）');
    const html = await response.text();
    // ⭐ 逐字：那一句（含**真单号** ✓）
    const sentence = SCAN_WRITE.sale.asyncWrite.doneBodyTemplate.replace('{orderNo}', ORDER_NO);
    assert.ok(html.includes(sentence), `页面要有那一句「${sentence}」（实际内容不含 ✗）`);
    // 🔴 其余文字**不要**：老那句"正在写入明细和库存"一个字都不许出现
    assert.equal(html.includes('正在写入明细和库存'), false, '早版那半句**不许**出现（晚版覆盖了它 ✗）');
    // 明细行/双数那种"其余文字"也不给（她是这么说的）
    assert.equal(html.includes('共 1 双'), false, '「共 N 双」那种其余文字不给 ✗');
  });
});

test('AC-AS10 ⭐ 两步走不冲突：① 点提交 ⇒ **零写入**；② 点按钮 ⇒ 单号先出 + 后台写', async () => {
  await withRoute(async ({ base, sessions, calls }) => {
    // ① 第一步：只到资金页（`submitOrder` 那一步）⇒ 写服务**一次都没进** ✓
    const step1Action = SCAN_WRITE.actions.submitOrder || 'submit_order';
    const first = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
      method: 'POST',
      headers: { cookie: cookieOf(OPEN_ID), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: step1Action, submit_key: 'scan_async:key:1',
        [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.quantity_41 || 'qty_41']: '1',
        [SCAN_WRITE.fields.lineAmount]: '399', count: '1',
      }).toString(),
    });
    assert.equal(first.status, 200, '第一步照旧 200（只到资金页 ✓）');
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：assert.deepEqual(calls, [], '第一步：写服务**一次都没进**（零写入 ✓）');
    //   改后逐字：assert.equal(calls.length, 1, '第一步：写服务**恰进 1 次**（④ 后：就是【货】那一跑 ✓）');
    assert.equal(calls[0] && calls[0].deferFunds, true, '那一次必须是**货那一跑**（`deferFunds: true` ✓）');
    assert.deepEqual(calls[0] && calls[0].payments, [], '货那一跑**不带收款**（`payments: []` ✓）');
    //   依据 = ④ 口径（点提交就建【货】那一单）＋ 她 22:5x「把新功能都上了，不需要开关」✓
    assert.equal(calls.length, 1, '第一步：写服务**恰进 1 次**（④ 后：就是【货】那一跑 ✓）');
    assert.equal(calls[0] && calls[0].deferFunds, true, '那一次必须是**货那一跑**（`deferFunds: true` ✓）');
    assert.deepEqual(calls[0] && calls[0].payments, [], '货那一跑**不带收款**（`payments: []` ✓）');

    // ② 第二步：点资金页按钮 ⇒ 单号先出 + 那一次写服务调用
    await sessions.saveSaleProgress(OPEN_ID, {
      paymentStep: 'pending',
      lines: [{ size: 41, quantity: 1, item_no: 'YD6693-2', number: NUMBER, color: '黑色', amount: '399' }],
      submitPending: { size: '41', amount: '399' },
    });
    const second = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
      method: 'POST',
      headers: { cookie: cookieOf(OPEN_ID), 'content-type': 'application/x-www-form-urlencoded' },
      body: payBody(),
    });
    assert.equal(second.status, 200, '第二步 ⇒ 200 ✓');
    // 成对迁移：改前逐字 `assert.equal(calls.length, 1, '第二步：写入口恰一次 ✓');` ⇒ ④ 后两跑各一次（货＋钱）＝ 恰 2 次 ✓（依据 = ④ 货/钱分离口径）
    assert.equal(calls.length, 2, '第二步：写入口恰 2 次（第一步货那一跑 ＋ 第二步钱那一跑 ✓）');
    assert.equal(calls[0].openId, OPEN_ID, '入参照旧（老形状 ✓）');
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：assert.ok((await second.text()).includes(`本单已创建成功（${ORDER_NO}）`), '第二步页面 = 那一句 ✓');
    //   改后逐字：assert.ok((await second.text()).includes(ORDER_NO), '结果页上看得到单号（她 23:5x「我肯定能看到这个单号呀」✓）');
    //   依据 = ④ 口径（点提交就建【货】那一单）＋ 她 22:5x「把新功能都上了，不需要开关」✓
    assert.ok((await second.text()).includes(ORDER_NO), '结果页上看得到单号（她 23:5x「我肯定能看到这个单号呀」✓）');
  });
});

test('AC-AS8 配置先行：开关是显式布尔（默认 false）· 那句文案可配 · 后台超时可配（无 `||` 兜底 ✗）', () => {
  const cfg = SCAN_WRITE.sale.asyncWrite;
  assert.equal(typeof cfg.enabled, 'boolean', '开关取出来必须是**布尔** ✓');
  assert.equal(typeof cfg.doneBodyTemplate, 'string');
  assert.ok(cfg.doneBodyTemplate.includes('{orderNo}'), '文案用 `{orderNo}` 占位（拿不到真单号就不编 ✗）');
  assert.equal(Number.isInteger(cfg.backgroundTimeoutMs), true, '后台看门狗超时可配且是整数 ✓');
  const cfgSource = fs.readFileSync(path.join(SERVER_SRC, 'config', 'scanWrite.js'), 'utf8');
  // 三个键都从环境变量读（一处配置管销售+配品 ✓）
  for (const envName of ['SCAN_SALE_ASYNC_WRITE_ENABLED', 'SCAN_SALE_ASYNC_DONE_BODY', 'SCAN_SALE_ASYNC_TIMEOUT_MS']) {
    assert.ok(cfgSource.includes(envName), `${envName} 要走配置 ✓`);
  }
  // 文案**只有一处**（销售与配品共用同一句 ✓ 不许两处各写一份 ✗）
  assert.equal((cfgSource.match(/本单已创建成功（\{orderNo\}）/g) || []).length, 1,
    '那句文案只许有**一处**定义（销售与配品共用 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS11（⑨b-1）：后台句柄 —— "等后台那一跑跑完"的口子（**不是页面字段** ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS11 ⭐ 后台句柄：`await result.background` 之后端状态**全都就绪**（等于"等后台跑完"）', async () => {
  const h = createHarness({ slowMs: 200 });
  try {
    const session = await sessionOf(h);
    const result = await h.service.submitSale(submitInputOf(session));
    assert.equal(result.deferred, true);
    // 句柄是个 thenable（Promise）——不是字符串、不是被序列化过的什么 ✗
    assert.equal(typeof result.background?.then, 'function', '`background` 必须是可 await 的句柄 ✓');
    // 立刻看：后台还没跑完（慢在 200ms 上）
    assert.equal(h.calls.confirm.length, 0, '拿到句柄那一刻后台还没跑 ✓');
    // ⭐ 等它 ⇒ 后台那一跑跑完 ⇒ 业务写入与状态都就绪
    await result.background;
    assert.equal(h.calls.confirm.length, 1, 'await 句柄之后，后台那一跑**跑完了** ✓');
    assert.equal(h.calls.underscoreConfirm.length, 0, '（顺带）仍然没有直调 `_confirm` ✓');
    // 端状态就绪 = 明细/收款那一份入参已交给业务层（用例语义的"写完了"）
    assert.ok(h.calls.confirm[0].input.salesEntryRecordId, '入参带主表记录 id ✓');
  } finally { h.cleanup(); }
});

test('AC-AS11b 🔴 句柄**不进页面**：渲染出的 HTML 里一个字都不许出现（公开形状没变 ✓）', async () => {
  await withRoute(async ({ base, sessions }) => {
    await sessions.saveSaleProgress(OPEN_ID, {
      paymentStep: 'pending',
      lines: [{ size: 41, quantity: 1, item_no: 'YD6693-2', number: NUMBER, color: '黑色', amount: '399' }],
      submitPending: { size: '41', amount: '399' },
    });
    const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
      method: 'POST',
      headers: { cookie: cookieOf(OPEN_ID), 'content-type': 'application/x-www-form-urlencoded' },
      body: payBody(),
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    // ① 页面照旧只有那一句（含真单号）
    assert.ok(html.includes(`本单已创建成功（${ORDER_NO}）`), '那一句照旧 ✓');
    // ② 🔴 句柄（Promise）**不许**被渲染进去
    assert.equal(html.includes('[object Promise]'), false, '页面里**不许**出现 `[object Promise]` ✗');
    // ⚠️ 不能拿"页面里有没有 background 这个词"当判据 —— 页面的 CSS 里就有 `background:` ✗（我第一版写错了）；
    //    换成**源码哨兵**：路由**没有**把这个句柄当数据读（`.background` 这种属性访问一处都不许有 ✓）
    const routeSource = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'scanPage.js'), 'utf8');
    assert.equal(/\.background\b/.test(routeSource), false,
      '路由不许读 `createdResult.background`（句柄不是页面字段 ✗）');
  });
});
