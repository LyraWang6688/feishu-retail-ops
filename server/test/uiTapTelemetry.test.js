'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 埋点 P0 剩余三条（业务负责人 2026-10-14 晚批准的五条里剩下的 ②④⑤）：
 *   · ② `tap_id` + **结果事件**（200/400 + **原因码** + `duration_ms`）
 *   · ④ **重复点击** ⇒ 独立事件 `ui.tap.repeated`
 *   · ⑤ **工作台接同一套上报**（同一份实现、不抄第二份）
 *
 * 依据（文件里）：`docs/remaining-queue-2026-10-14-night.md` 第 7 行（埋点 P0）＋
 *   `docs/HANDOVER-2026-10-14-night.md` 第 80 行；①（`data-tap-target`，发布 #548）与
 *   ③（失败日志带人话原因码，发布 #549）**已上线**，本文件只管剩下的三条。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-UT1 **一套配置**：三个事件名 + 字段名 + ④ 窗口都可配（`readFlag` 显式布尔：
 *         空串 = **关掉**；认不出的值当场抛错）；客户端那半（`config/telemetry.js` /
 *         `shared/ui-tap.js`）与服务端那半**逐字一致**（用例钉住，不许漂移 ✗）。
 *  AC-UT2 ④ **重复点击 = 独立事件**：窗口内同一个 target 第二次 ⇒ `ui.tap.repeated`
 *         （**纯函数**判据 + 端点回执头 `x-ui-tap-event` ⇒ 不用去拦日志 sink 也能真红）；
 *         窗口外 / 没有 `since_ms` ⇒ 仍是 `ui.tap`；缺 `target` ⇒ 400（逐字不变）。
 *  AC-UT3 ② **结果事件**：带 `tap_id` 的写请求 ⇒ 一条 `ui.tap.result`
 *         （`tap_id` + `status` + `code`（原因码）+ `duration_ms`）；**不带** `tap_id` ⇒ 一条都不记。
 *  AC-UT4 ⑤ **工作台接同一套**：同一个 `handleUiTap` / 同一个 `uiTapResultMiddleware`
 *         —— 工作台端点走**既有**身份闸门（未登录 401 且不记埋点）；工作台任意写请求带
 *         `tap_id` 也记结果事件；扫码页那一页**仍然只有一段脚本**（把共享实现**内联**进去 ✓）。
 *  AC-UT5 客户端**唯一一份**（`shared/ui-tap.js`）：两个前端都用它；
 *         它**只报事实**（target / tap_id / since_ms / page —— **不带任何表单值** ✗）；
 *         且必须是 **ASCII**、且**不许出现 `<script` 字面量**（那一页有"只有一段脚本"闸门 ✗ 我踩过）。
 */

// `routes/scanPage` / `routes/workbench` 在 require 链上要凭证（模块级 `new V1BitableGateway()`）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_ui_tap_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'ui_tap_test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const express = require('express');

const SERVER_DIR = path.join(__dirname, '..');
const WORKBENCH = path.join(SERVER_DIR, 'public', 'workbench');
const SHARED_CLIENT = path.join(WORKBENCH, 'shared', 'ui-tap.js');

/**
 * ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人 2026-10-12 逐字「我可没有说过，
 *   **我们是能够进行动态交互的**」＋ 她 2026-10-16 亲口点的「页面标注模式」（扫码页 + 工作台 ✓））：
 *
 *   改前逐字：`assert.equal((html.match(/<script[\s>]/gi) || []).length, 1, '整页仍然只有一段脚本 ✓');`
 *   改后逐字：`assert.equal((html.match(/<script[\s>]/gi) || []).length, 1, '整页仍然只有一段**业务**脚本 ✓');`
 *
 *   依据：「扫码页零 JS」是**我方（agent 侧）**的约束、**不是她的口径**；而"带 `?annotate=1`
 *     才出现"这道闸门**只能落在脚本内部** —— 查询串只有 `routes/scanPage.js` 拿得到，
 *     那个文件**不在本任务写作用域内**（另有主）。
 *   ⚠️ **没放宽**：这一段"内联共享实现、只有一段"的判据照旧（只是点明成业务脚本），
 *     另外**新增**一条"标注那一段必须早退"✓
 */

// 🔴 **顺序很重要**：`utils/uiTapReport.js` 在 require 时就把 `logInfo` 解构走了 ⇒
//    必须在 require 它**之前**替换掉 logger 上那个函数，否则捕获不到（这条我踩过：日志 sink
//    在模块加载时绑死 ⇒ 用例里拦不到 ✗）。本文件里其余模块都在这之后 require ✓。
const logger = require('../src/utils/logger');
const logged = [];
logger.logInfo = (event, meta) => { logged.push({ event, meta }); };
const logsOf = (event) => logged.filter((item) => item.event === event);

const { UI_TAP } = require('../src/config/uiTap');
const {
  tapEventName, resultCodeOf, tapResultFields, handleUiTap, uiTapResultMiddleware,
} = require('../src/utils/uiTapReport');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createWorkbenchRouter } = require('../src/routes/workbench');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SESSION_SECRET = 'ui-tap-telemetry-test-secret';
const NUMBER = 'YD6693-2|黑色|A';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
// ⚠️ 本文件凡走 HTTP 的用例都要先开身份闸门（`LARK_WEB_AUTH_ENABLED`）——
//    否则扫码路由的闸门回 503（"飞书身份认证尚未启用"），看起来像"写入口没接" ✗（我踩过）。
login();
const sessionCookie = (openId = 'ou_ui_tap') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 扫码页那一条（够 `/ui-tap` 与"未知动作 ⇒ 400"两条路用；不碰任何业务表）。 */
const scanApp = () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ found: false, number: NUMBER }) },
    gateway: {},
    writeService: { sessions: {}, submitOrder: async () => ({ ok: true }) },
  }));
  return app;
};

/** 工作台那一条（真路由 ⇒ 身份闸门是**真的**在拦；业务 service 全给桩）。 */
const workbenchApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
  }));
  return app;
};

/** 假的 `res`：`handleUiTap` 只用 `status/set/type/end`（不真起 HTTP ⇒ 断言更直接）。 */
const fakeRes = () => {
  const res = {
    statusCode: 0, headers: {}, body: null, ended: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[String(key).toLowerCase()] = value; return this; },
    type() { return this; },
    send(text) { this.body = text; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-UT1 一套配置（可配 + 客户端/服务端一致）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UT1 「点击埋点」是**一套**配置：三个事件名 + 字段名 + ④ 窗口都可配（空串 = 关掉）', () => {
  // 三个事件名互不相同（否则 grep 分不出"点了" / "点了两次" / "点成了没有"）
  const names = Object.values(UI_TAP.events);
  assert.equal(new Set(names).size, 3, '三个事件名必须互不相同');
  assert.equal(UI_TAP.events.tap, 'ui.tap');
  assert.equal(UI_TAP.events.repeated, 'ui.tap.repeated', '④ 独立事件 ✓');
  assert.equal(UI_TAP.events.result, 'ui.tap.result', '② 结果事件 ✓');
  assert.equal(UI_TAP.fields.tapId, 'tap_id', '② 的关联键');
  assert.equal(UI_TAP.fields.sinceMs, 'since_ms', '④ 的事实字段（客户端只报事实）');
  assert.equal(UI_TAP.fields.eventHeader, 'x-ui-tap-event', '④ 的回执头（204 没 body ⇒ 只能靠头）');
  assert.equal(UI_TAP.paths.workbenchFull, '/api/workbench/ui-tap');
  assert.ok(UI_TAP.repeatedWindowMs > 0, '④ 的窗口是个正数');
  assert.equal(UI_TAP.enabled, true);

  // ⭐ **真读一次**（子进程）：可配 + `readFlag` 那套语义（空串 = 关掉，不是回退默认 ✗）
  const inChild = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
    "const c=require('./src/config/uiTap').UI_TAP;"
    + 'process.stdout.write(JSON.stringify({ enabled: c.enabled, win: c.repeatedWindowMs,'
    + ' repeated: c.events.repeated, full: c.paths.workbenchFull }));',
  ], { cwd: SERVER_DIR, env: { ...process.env, ...env }, encoding: 'utf8' }));
  assert.equal(inChild({ UI_TAP_ENABLED: '' }).enabled, false, '空串 = **关掉**（不是回退默认 ✓）');
  assert.equal(inChild({ UI_TAP_ENABLED: 'false' }).enabled, false);
  assert.equal(inChild({ UI_TAP_REPEATED_WINDOW_MS: '300' }).win, 300, '④ 的窗口可配');
  assert.equal(inChild({ UI_TAP_EVENT_REPEATED: 'ui.tap.again' }).repeated, 'ui.tap.again', '事件名可配');
  assert.equal(inChild({ UI_TAP_WORKBENCH_FULL_PATH: '/api/workbench/tap2' }).full, '/api/workbench/tap2');

  // ⭐ 客户端那半与服务端那半**逐字一致**（两处手写 = 迟早漂移 ⇒ 用例钉住）
  const clientConfig = fs.readFileSync(path.join(WORKBENCH, 'config', 'telemetry.js'), 'utf8');
  assert.ok(clientConfig.includes(`path: '${UI_TAP.paths.workbenchFull}'`),
    '工作台客户端的路径 = 服务端唯一真源（不许漂移 ✗）');
  assert.ok(clientConfig.includes(`formField: '${UI_TAP.fields.formField}'`), '字段名两边一致');
  const shared = fs.readFileSync(SHARED_CLIENT, 'utf8');
  assert.ok(shared.includes(`DEFAULT_FORM_FIELD = '${UI_TAP.fields.formField}'`),
    '共享客户端里的表单字段名 = 服务端配置 ✓');
});

test('AC-UT1b 源码哨兵：开关走 `readFlag`（显式布尔），**不用** `||` 兜底那种"清空关不掉"的写法', () => {
  const config = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'uiTap.js'), 'utf8');
  assert.ok(config.includes("readFlag(process.env, 'UI_TAP_ENABLED', true)"), '显式布尔开关');
  assert.equal(config.includes("'UI_TAP_ENABLED') ||"), false, '不许 `process.env.X || fallback` ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-UT2 ④ 重复点击 ⇒ 独立事件（纯函数 + 端点回执头；两个入口同一套判据）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UT2 ④ 判据（纯函数）：窗口内第二次 ⇒ repeated；窗口外 / 没事实 ⇒ 仍是 ui.tap', () => {
  const windowMs = UI_TAP.repeatedWindowMs;
  assert.equal(tapEventName(null), UI_TAP.events.tap, '第一次点（没有 since_ms）⇒ ui.tap');
  assert.equal(tapEventName(undefined), UI_TAP.events.tap);
  assert.equal(tapEventName(''), UI_TAP.events.tap, '空串 ⇒ 按普通点击（不猜 ✗）');
  assert.equal(tapEventName(0), UI_TAP.events.repeated, '同一毫秒内又点了一次 ⇒ 重复 ✓');
  assert.equal(tapEventName(windowMs), UI_TAP.events.repeated, '正好在窗口边上 ⇒ 算重复 ✓');
  assert.equal(tapEventName(windowMs + 1), UI_TAP.events.tap, '出了窗口 ⇒ 是两次正常操作 ✓');
  assert.equal(tapEventName(-5), UI_TAP.events.tap, '负数（旧页面/脏数据）⇒ 不猜成重复 ✗');
  assert.equal(tapEventName('abc'), UI_TAP.events.tap);
});

test('AC-UT2b ④ 端点：第二次点同一个 target ⇒ 回执头 `x-ui-tap-event: ui.tap.repeated`（并记独立事件）', () => {
  const fields = UI_TAP.fields;
  // ① 第一次点（没有 since_ms）⇒ ui.tap
  logged.length = 0;
  const first = fakeRes();
  handleUiTap({
    req: { requestId: 'r1', originalUrl: '/s/x/ui-tap', query: { [fields.target]: 'realm:replenish', [fields.page]: 'scan', [fields.tapId]: 'tap-a' } },
    res: first,
    scope: 'scan',
    realm: 'replenish',
  });
  assert.equal(first.statusCode, 204, '正常上报 ⇒ 204（判据逐字不变 ✓）');
  assert.equal(first.headers[fields.eventHeader], UI_TAP.events.tap);
  assert.equal(logsOf(UI_TAP.events.tap).length, 1, '记一条 ui.tap');
  assert.equal(logsOf(UI_TAP.events.tap)[0].meta.tap_id, 'tap-a', '② 的关联键要进日志');

  // ② 同一个 target 在窗口内又点了一下（客户端只报 since_ms=200 这个**事实**）
  logged.length = 0;
  const second = fakeRes();
  handleUiTap({
    req: { requestId: 'r2', originalUrl: '/s/x/ui-tap', query: { [fields.target]: 'realm:replenish', [fields.page]: 'scan', [fields.tapId]: 'tap-b', [fields.sinceMs]: '200' } },
    res: second,
    scope: 'scan',
    realm: 'replenish',
  });
  assert.equal(second.statusCode, 204);
  assert.equal(second.headers[fields.eventHeader], UI_TAP.events.repeated, '④ 独立事件（回执头可见 ⇒ 用例能真红 ✓）');
  assert.equal(logsOf(UI_TAP.events.repeated).length, 1, '记的是 ui.tap.repeated（不是 ui.tap）');
  assert.equal(logsOf(UI_TAP.events.tap).length, 0, '这一下**不许**再记成普通点击');
  assert.equal(logsOf(UI_TAP.events.repeated)[0].meta.since_ms, 200, '把事实（间隔毫秒）留在日志里');

  // ③ 缺 target ⇒ 400（与改前逐字一致；不静默吞 ✓）
  logged.length = 0;
  const missing = fakeRes();
  handleUiTap({ req: { requestId: 'r3', originalUrl: '/s/x/ui-tap', query: {} }, res: missing, scope: 'scan' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body, 'missing target');
  assert.equal(logged.length, 0, '没 target ⇒ 不记任何埋点');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-UT3 ② 结果事件（原因码 + 状态 + 耗时）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UT3 ② 原因码（纯函数）：有具体业务码就用它；没有就按状态分类 ok / rejected / failed', () => {
  assert.equal(resultCodeOf({ status: 200 }), UI_TAP.resultCodes.ok);
  assert.equal(resultCodeOf({ status: 303 }), UI_TAP.resultCodes.ok, '303 跳转也是成了 ✓');
  assert.equal(resultCodeOf({ status: 400 }), UI_TAP.resultCodes.rejected);
  assert.equal(resultCodeOf({ status: 500 }), UI_TAP.resultCodes.failed);
  assert.equal(resultCodeOf({ status: 400, code: 'amount_mismatch' }), 'amount_mismatch',
    '拿得到业务码就用它（与 ③「失败日志带人话原因码」同一个口径 ✓）');
  assert.equal(resultCodeOf({}), UI_TAP.resultCodes.failed, '连状态都没有 ⇒ 只敢说 failed ✗ 不编 ok');
  // 载荷形状：**只有我们的标识与结果**，没有表单值 / 金额
  const payload = tapResultFields({
    req: { requestId: 'r9', originalUrl: '/s/x?from=sales', body: { action: 'submit_order' } },
    scope: 'scan', tapId: 'tap-9', status: 400, code: 'purchase_amount_required', durationMs: 1234,
  });
  assert.deepEqual(payload, {
    request_id: 'r9', scope: 'scan', tap_id: 'tap-9', status: 400,
    code: 'purchase_amount_required', duration_ms: 1234, action: 'submit_order', path: '/s/x',
  }, '② 的载荷逐字：tap_id + 状态 + 原因码 + 耗时（**没有**表单值 ✗）');
  assert.equal(typeof tapResultFields({ req: {}, tapId: 't', status: 200, durationMs: -5 }).duration_ms, 'number');
  assert.equal(tapResultFields({ req: {}, tapId: 't', status: 200, durationMs: -5 }).duration_ms, 0, '耗时不为负');
});

test('AC-UT3b ② 中间件：带 `tap_id` 的写请求 ⇒ 恰记一条 ui.tap.result；不带 ⇒ 一条都不记', async () => {
  // ① 直接驱动中间件（拿到真实发送出去的状态码）
  logged.length = 0;
  const res = new EventEmitter();
  res.statusCode = 400;
  res.locals = { uiTapCode: 'purchase_amount_required' };
  let nexted = false;
  uiTapResultMiddleware('scan')({
    requestId: 'req-1', originalUrl: '/s/x?from=purchase_return', body: { tap_id: 'tap-77', action: 'return_purchase' },
  }, res, () => { nexted = true; });
  assert.equal(nexted, true, '中间件必须放行（埋点不许挡业务 ✓）');
  assert.equal(logsOf(UI_TAP.events.result).length, 0, '还没响应完 ⇒ 不记（响应 finish 才记 ✓）');
  res.emit('finish');
  const result = logsOf(UI_TAP.events.result);
  assert.equal(result.length, 1, '一次请求恰记一条 ✓');
  assert.equal(result[0].meta.tap_id, 'tap-77');
  assert.equal(result[0].meta.status, 400);
  assert.equal(result[0].meta.code, 'purchase_amount_required', '原因码用出口标的那个 ✓');
  assert.equal(typeof result[0].meta.duration_ms, 'number');

  // ② 不带 tap_id（GET / 别的调用方 / 旧页面）⇒ 一进这条链都不进
  logged.length = 0;
  const res2 = new EventEmitter();
  res2.statusCode = 200;
  res2.locals = {};
  uiTapResultMiddleware('scan')({ requestId: 'req-2', originalUrl: '/s/x', body: {} }, res2, () => {});
  res2.emit('finish');
  assert.equal(logsOf(UI_TAP.events.result).length, 0, '没有 tap_id ⇒ 不记（也零开销 ✓）');

  // ③ 真 HTTP：一个**不写表**的失败提交（未知动作 ⇒ 400）也要带上结果事件
  logged.length = 0;
  await withServer(scanApp(), async (base) => {
    const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'definitely_not_an_action', tap_id: 'tap-http-1' }).toString(),
    });
    assert.equal(response.status, 400, '未知动作 ⇒ 400（既有行为一字未动 ✓）');
  });
  const httpResult = logsOf(UI_TAP.events.result);
  assert.equal(httpResult.length, 1, '带 tap_id 的写请求 ⇒ 恰一条结果事件（扫码页已挂上 ✓）');
  assert.equal(httpResult[0].meta.tap_id, 'tap-http-1');
  assert.equal(httpResult[0].meta.code, 'unknown_action', '原因码 = 业务出口标的那一个 ✓');
  assert.equal(httpResult[0].meta.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-UT4 ⑤ 工作台接同一套（同一份实现 + 既有闸门 + 内联进扫码页那一段）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UT4 ⑤ 工作台端点：走**既有**身份闸门；同一个处理体 ⇒ 204 + 同样的 ④ 回执头', async () => {
  login();
  const url = `${UI_TAP.paths.workbenchFull}?${UI_TAP.fields.target}=tab%3Asales&${UI_TAP.fields.sinceMs}=100&${UI_TAP.fields.tapId}=tap-w1`;
  await withServer(workbenchApp(), async (base) => {
    // ① 未登录 ⇒ 401（**既有**闸门在拦 ⇒ 埋点不新开鉴权 ✓），且**不记**任何埋点
    logged.length = 0;
    const anonymous = await fetch(`${base}${url}`, { method: 'POST' });
    assert.equal(anonymous.status, 401, '未登录 ⇒ 401（同一道闸门 ✓）');
    assert.equal(logged.length, 0, '拦下来的请求**不许**留埋点（不刷日志 ✓）');

    // ② 已登录 ⇒ 204 + 同一个 ④ 回执头（同一份实现 ✓）
    logged.length = 0;
    const ok = await fetch(`${base}${url}`, { method: 'POST', headers: { cookie: sessionCookie() } });
    assert.equal(ok.status, 204, '工作台端点与扫码页同一个契约（204 ✓）');
    assert.equal(ok.headers.get(UI_TAP.fields.eventHeader), UI_TAP.events.repeated,
      '服务端按窗口判重复 —— 与扫码页**同一个判据** ✓');
    const taps = logsOf(UI_TAP.events.repeated);
    assert.equal(taps.length, 1);
    assert.equal(taps[0].meta.scope, 'workbench', '日志要能分清是哪个入口（scope）');
    assert.equal(taps[0].meta.tap_id, 'tap-w1');
    assert.equal(taps[0].meta.target, 'tab:sales');

    // ③ 缺 target ⇒ 400（同一个处理体 ⇒ 契约逐字一致）
    const missing = await fetch(`${base}${UI_TAP.paths.workbenchFull}`, {
      method: 'POST', headers: { cookie: sessionCookie() },
    });
    assert.equal(missing.status, 400);
  });
});

test('AC-UT4b ⑤ 工作台的写请求带 `tap_id` ⇒ 也记结果事件（一个 `router.use` 覆盖所有接口）', async () => {
  login();
  await withServer(workbenchApp(), async (base) => {
    // ① 未登录 ⇒ 401 且不记
    logged.length = 0;
    await fetch(`${base}/api/workbench/definitely-not-a-route`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tap_id: 'tap-w9' }),
    });
    assert.equal(logsOf(UI_TAP.events.result).length, 0, '闸门之前不记埋点 ✓');

    // ② 已登录 ⇒ 不管她点的是哪个接口，结果事件都记（这里用一条**不存在**的路由 ⇒ 404，不碰业务表）
    logged.length = 0;
    const response = await fetch(`${base}/api/workbench/definitely-not-a-route`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ tap_id: 'tap-w9' }),
    });
    assert.equal(response.status, 404);
    const results = logsOf(UI_TAP.events.result);
    assert.equal(results.length, 1, '工作台任意写请求带 tap_id ⇒ 记结果事件 ✓');
    assert.equal(results[0].meta.scope, 'workbench');
    assert.equal(results[0].meta.tap_id, 'tap-w9');
    assert.equal(results[0].meta.status, 404);
    assert.equal(results[0].meta.code, UI_TAP.resultCodes.rejected, '原因码按状态分类 ✓');

    // ③ 埋点 beacon 自己（query 里带 tap_id）**不许**被记成结果事件 ⇒ 没有自我噪声 ✓
    logged.length = 0;
    await fetch(`${base}${UI_TAP.paths.workbenchFull}?${UI_TAP.fields.target}=tab%3Asales&${UI_TAP.fields.tapId}=tap-w2`,
      { method: 'POST', headers: { cookie: sessionCookie() } });
    assert.equal(logsOf(UI_TAP.events.result).length, 0, '上报请求自己不许再记一条结果（tap_id 只从 body 读 ✓）');
  });
});

test('AC-UT4c ⑤ **同一份实现**：两个路由都 require 同一个 util；扫码页那一页仍只有一段脚本（内联共享实现）', async () => {
  const scanRoute = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');
  const wbRoute = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'), 'utf8');
  for (const [name, source] of [['scanPage', scanRoute], ['workbench', wbRoute]]) {
    assert.ok(source.includes("require('../utils/uiTapReport')"), `${name} 要用**同一个** util`);
    assert.ok(source.includes('handleUiTap('), `${name} 的端点用**同一个** handleUiTap`);
    assert.equal(source.includes("logInfo('ui.tap'"), false, `${name} 不许自己再拼一份 ui.tap ✗`);
  }
  assert.equal((scanRoute.match(/uiTapResultMiddleware\('scan'\)/g) || []).length, 1);
  assert.equal((wbRoute.match(/uiTapResultMiddleware\('workbench'\)/g) || []).length, 1);

  // 扫码页那一页：脚本**还是只有一段**，而共享实现被**内联**进去了
  const renderer = rendererSource();
  assert.match(renderer, /UI_TAP_SHARED_SOURCE = fs\.readFileSync\(/, '共享实现是**读文件内联**（不抄第二份 ✓）');
  // ⚠️ 那一页的脚本只在"有带反馈属性的提交按钮"时才渲染（`content.includes('data-submit-feedback=')`）
  //    ⇒ 直接用**渲染层自己的入口**渲染一页（补货表单就有）—— 不走 HTTP，判据更直接 ✓
  const view = {
    number: NUMBER, item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋', category_code: 'A',
    price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
    rows: [{ size_text: '41', cells: [{ key: '门盒', count: 0 }], total: 0, missing: true }],
    missing_count: 1, sizes_degraded: false, notes: [], updated_at_text: '2026-10-14 23:00',
    product_record_id: 'prod_1',
  };
  const writeLike = {
    enabled: true, saleEnabled: false, replenishEnabled: true, returnEnabled: true,
    texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: `/s/${encodeURIComponent(NUMBER)}?from=replenish`,
    replenishKey: 'scan_replenish:key:1', returnKey: 'scan_return:key:1',
    sizes: [{ size_text: '41', missing: true, checked: true }],
    draft: { lines: [] }, accessories: [], paymentRows: [], notice: '', errorText: '',
    paymentStatus: '', defaultPaymentStatus: '', paymentMethods: [], defaultPaymentMethod: '',
  };
  const html = renderScanPage(view, SCAN_PAGE, writeLike, 'replenish', {});
  // 扫码页那一页：脚本**还是只有一段**（业务脚本），而共享实现被**内联**进去了
  // ⭐ 2026-10-16 成对迁移（逐字对照见本文件 `businessScriptCountOf` 上面那段注释）
  assert.equal((html.match(/<script[\s>]/gi) || []).length, 1, '整页仍然只有一段**业务**脚本 ✓');
  assert.ok(html.includes('dshUiTap'), '那一段里就是**共享**的客户端实现（同一个 API ✓）');
  assert.ok(html.includes('ui-tap'), '上报路径仍在 ✓');
  assert.ok(html.includes('data-submit-feedback='), '（前提）这一页确实有带反馈属性的按钮 ✓');

  // 工作台的三个页面都先加载**同一个文件**（模块脚本读 `window.dshUiTap` ⇒ 顺序不能反）
  for (const page of ['index.html', 'inventory-adjustment.html', 'label-print.html']) {
    const html = fs.readFileSync(path.join(WORKBENCH, page), 'utf8');
    const sharedAt = html.indexOf('/workbench/shared/ui-tap.js');
    const moduleAt = html.indexOf('<script type="module"');
    assert.ok(sharedAt > 0, `${page} 要加载共享客户端`);
    assert.ok(sharedAt < moduleAt, `${page} 里共享客户端必须**先于**模块脚本（顺序反了就读不到 ✓）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-UT5 客户端只有一份 + 只报事实 + 不许把"一段脚本"闸门打红
// ═══════════════════════════════════════════════════════════════════════════

test('AC-UT5 共享客户端：ASCII-only、**不许出现 `<script` 字面量**（它会被内联进那一页）', () => {
  const source = fs.readFileSync(SHARED_CLIENT, 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.equal(/[^\x00-\x7F]/.test(source), false, '必须 ASCII（那一页有硬编码中文闸门 + 内联模板 ✗）');
  // 🔴 这条是本次真踩到的坑：注释里写 `<script>` ⇒ 被"整页只有一段脚本"的哨兵数成第二段 ✗
  assert.equal(/<script/i.test(source), false, '文件里**不许**出现 script 元素的开标签字面量 ✗');
  assert.equal(/XMLHttpRequest/.test(source), false,
    '不许用 XHR（扫码页那一段被钉住"只做置灰/换文案/计时"，已有 AC-PF3 ✗）');
  assert.equal(/preventDefault/.test(source), false, '绝不许吞点击（她"点了不跳"的老 bug ✓）');
});

test('AC-UT5b 共享客户端**只报事实**：URL 里只有 target / tap_id / since_ms / page（不带任何表单值 ✗）', () => {
  const source = fs.readFileSync(SHARED_CLIENT, 'utf8');
  const sent = [];
  const sandbox = {
    Date, Math, encodeURIComponent, JSON,
    navigator: { sendBeacon: (url) => { sent.push(url); return true; } },
    document: {
      addEventListener() {},
      createElement: () => ({ setAttribute() {}, }),
      querySelector: () => null,
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const reporter = sandbox.dshUiTap;
  assert.ok(reporter && typeof reporter.track === 'function', '共享实现要挂到 window.dshUiTap ✓');
  assert.equal(reporter.formField, UI_TAP.fields.formField, '表单字段名 = 服务端配置 ✓');
  assert.equal(reporter.targetAttr, 'data-tap-target', '属性名与扫码页一致 ✓');

  // ① 第一次点：没有 since_ms（客户端只报"我没记过上一次"）
  const firstId = reporter.track('realm:replenish', { path: '/s/ui-tap', page: 'scan' });
  assert.ok(firstId, '要给这次点击一个 tap_id ✓');
  assert.equal(reporter.currentTapId(), firstId, 'api-client 读的就是它（写请求带回去 ✓）');
  const first = sent[0];
  assert.ok(first.startsWith('/s/ui-tap?'), `路径来自调用方（配置）：${first}`);
  assert.match(first, /target=realm%3Areplenish/);
  assert.match(first, new RegExp(`${UI_TAP.fields.tapId}=${firstId}`));
  assert.match(first, /page=scan/);
  assert.equal(/since_ms/.test(first), false, '第一次点 ⇒ **不许**编一个 since_ms ✗');

  // ② 同一个 target 再点一次 ⇒ 带上"距上一次多少毫秒"这个**事实**（算不算重复由服务端判 ✓）
  reporter.track('realm:replenish', { path: '/s/ui-tap', page: 'scan' });
  assert.match(sent[1], /since_ms=\d+/, '第二次点要报间隔事实 ✓');
  // ③ 换了 target ⇒ 又是"第一次"（不许把别的格子的时间算进来 ✗）
  reporter.track('realm:inventory', { path: '/s/ui-tap', page: 'scan' });
  assert.equal(/since_ms/.test(sent[2]), false, '换 target ⇒ 从零开始 ✓');

  // ④ **只报事实**：URL 的 query **只有**这四个键（绝无表单值 ✗）
  const keys = [...new URL(`http://x${sent[1]}`).searchParams.keys()].sort();
  assert.deepEqual(keys, [UI_TAP.fields.page, UI_TAP.fields.sinceMs, UI_TAP.fields.tapId, UI_TAP.fields.target].sort(),
    '只带 target / tap_id / since_ms / page 四个键 ✓');

  // ⑤ 表单盖章：提交前把 tap_id 塞进表单（写请求随之带回 ⇒ ② 结果事件才连得上 ✓）
  const appended = [];
  const form = {
    querySelector: () => null,
    appendChild: (node) => { appended.push(node); },
  };
  const fakeInput = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  sandbox.document.createElement = () => fakeInput;
  reporter.stampForm(form, { tapId: 'tap-stamped' });
  assert.equal(appended.length, 1, '要新建一个隐藏字段 ✓');
  assert.equal(fakeInput.attrs.name, UI_TAP.fields.formField);
  assert.equal(fakeInput.attrs.value, 'tap-stamped');
  assert.equal(fakeInput.attrs.type, 'hidden');
});

test('AC-UT5c 工作台那半只用**同一个**实现：api-client 从 `window.dshUiTap` 读，不 import 第二份配置', () => {
  const client = fs.readFileSync(path.join(WORKBENCH, 'core', 'api-client.js'), 'utf8');
  assert.match(client, /window\.dshUiTap/, '从共享实现读 tap_id ✓');
  assert.ok(client.includes('reporter.formField'), '字段名也从共享实现读（只有一处定义 ✓）');
  // ⚠️ 不许 import 兄弟配置：那个文件会被测试**拷进临时目录**再 import ⇒ 会 ERR_MODULE_NOT_FOUND ✗（踩过）
  assert.equal(/from '\.\.\/config\//.test(client), false, 'api-client 不许 import 兄弟配置模块 ✗');
  const main = fs.readFileSync(path.join(WORKBENCH, 'main.js'), 'utf8');
  const standalone = fs.readFileSync(path.join(WORKBENCH, 'standalone.js'), 'utf8');
  for (const [name, source] of [['main.js', main], ['standalone.js', standalone]]) {
    assert.match(source, /dshUiTap/, `${name} 要绑那一份共享实现 ✓`);
    assert.ok(source.includes('TAP_TELEMETRY.formField'), `${name} 的字段名来自配置 ✓`);
  }
  // 她点一级 tab ⇒ 走**同一份**上报实现（`main.js` 里那个点击监听调 `trackTap`）
  //   ⚠️ **不给 tab 加属性**：tab 的 HTML 形状被好几条哨兵逐字钉着（一加就集体红 ✗ 我踩过）
  //   ⇒ 上报放在**既有**的点击监听里，别的文件一行不动 ✓ 判据没放宽 ✓
  const tabs = fs.readFileSync(path.join(WORKBENCH, 'core', 'tabs.js'), 'utf8');
  assert.equal(/data-tap-target/.test(tabs), false, 'core/tabs.js 的 HTML 形状保持逐字不变 ✓');
  assert.ok(main.includes("trackTap(`tab:${tab.dataset.module}`)"), 'main.js 在既有监听里上报 tab 点击 ✓');
  assert.ok(main.includes('function trackTap('), '上报入口只有一处（埋点失败静默 ✓）');
});
