/**
 * ⭐⭐ 「**扫码打印**」（2026-10-14 晚 · 业务负责人选了 ⓐ「扫完**直接打印这一张**」）。
 *
 * 依据（**都在文件里**）：`docs/scan-to-print-jsapi-2026-10-14.md`（AC-SP1…AC-SP10）
 *   ＋ 她 2026-10-12 逐字：「**新二维码一律 `https://hm.bamamei.online/r/{recordId}`**（旧贴纸**重打**；
 *   `/s/{编号}` 路径保留但不再加功能）」/「**不需要保持兼容**」（`docs/qr-record-id-and-js-2026-10-12.md`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-SP1 ⭐ 有**签名接口** `GET /api/workbench/lark/jsapi-signature`：返回
 *           `appId/timestamp/nonceStr/signature` ✓ —— 而且**响应里不含任何密钥** ✗
 *           （app secret / jsapi_ticket / tenant_access_token 一个字符都不许出现）；
 *   AC-SP2 ⭐ 签名**算得对**（服务端自校验一致）＋ **走既有工作台鉴权闸门**（未登录 401）；
 *   AC-SP3 ⭐ **ticket 缓存**：TTL 内多次调用只向飞书取一次（在 `larkJsapiSign.test.js` 钉细节）；
 *   AC-SP4 ⭐ 扫到的字符串 ⇒ **解析出记录 ID**（`/r/{id}` ✓）；**不是这个形状 ⇒ 人话拒绝** ✓
 *           （旧 `/s/` 码要**可操作**：告诉她这是什么、该怎么办 —— 不是干巴巴"格式不对"）；
 *   AC-SP5 ⭐ 按记录 ID ⇒ **只排这一张**（队列任务的标签数 = 1；同一把 `submit_key` 连点
 *           ⇒ **不重复建任务**）；
 *   AC-SP6 ⭐ **不新开打印接口** ✗：走的是既有 `POST /api/workbench/label-print/jobs`
 *           （源码哨兵 + 真的请求打到那一条）；
 *   AC-SP7 ⭐ 页面：点【扫码打印】⇒ `h5sdk.config` ⇒ `tt.scanCode`（**JSAPI** ✓ **不是跳外链** ✗）；
 *           点了**立刻有反馈**（按钮置灰 + 换文案）✓
 *   AC-SP8 ⭐ 失败**如实**：形状不对 / 记录找不到 / 扫码取消 / 队列报错 ⇒ **人话** ✓ **不当成功** ✗
 *   AC-SP9 ⭐ 命中区 **≥44px** ✓ 文案走配置 ✓
 *   AC-SP10 🔴 旧入口**不回归**：「选择编号打印 / 批量打印」照旧（`labelPrintScanEntry.test.js` /
 *           `labelPrintQueue*.test.js` 继续全绿；本文件只加不改那两条的语义）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');

// 路由模块的 require 链会在模块级求值凭证 / 表 ID（为了让模块能加载；本文件一次飞书都不打）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_to_print_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_to_print_secret';

const { createWorkbenchRouter } = require('../src/routes/workbench');
const { createLabelPrintQueueRouter } = require('../src/routes/labelPrintQueue');
const { createLarkJsapiService, sign } = require('../src/services/larkJsapiService');
const {
  createLabelPrintService, parseLabelScanUrl, buildLabelScanUrl,
} = require('../src/services/labelPrintService');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const { LABEL_PRINT } = require('../src/config/labelPrint');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');
const { SCAN_URL } = require('../src/config/tagQrCode');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const sourceOf = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

const SESSION_SECRET = 'scan_to_print_secret';
const APP_SECRET = process.env.LARK_AGENT_APP_SECRET;
const F = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
const P = V1_BITABLE_SCHEMA.tables.product.fields;

const sessionCookie = (openId = 'ou_scan_print_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

// ── AC-SP1/SP2：签名接口（**真的** workbench 路由 + **真的**签名 service，只把 fetch 换成假的）──

const fakeFetch = (calls, { ticket = 'ticket_scan_print', token = 'token_scan_print' } = {}) => async (url) => {
  calls.push(String(url));
  if (String(url).includes('tenant_access_token')) {
    return { ok: true, status: 200, json: async () => ({ tenant_access_token: token }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { ticket } }) };
};

const signatureApp = (env = {}) => {
  const calls = [];
  const larkJsapi = createLarkJsapiService({
    env: { LARK_AGENT_APP_ID: 'cli_scan_to_print_app', LARK_AGENT_APP_SECRET: APP_SECRET, ...env },
    fetch: fakeFetch(calls),
    randomNonce: () => 'nonce_scan_print',
    now: () => 1700000000000,
  });
  const app = express();
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
    labelPrint: { listLabels: async () => ({ labels: [] }) },
    larkJsapi,
  }));
  return { app, calls };
};

test('AC-SP1/SP2 ⭐ 签名接口：四件套齐 + 算得对 + **响应里一个密钥都没有**', async () => {
  login();
  const { app } = signatureApp();
  await withServer(app, async (base) => {
    const pageUrl = 'https://hm.bamamei.online/workbench/label-print.html?scan=1';
    const response = await fetch(`${base}/api/workbench/lark/jsapi-signature?url=${encodeURIComponent(pageUrl)}`,
      { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.appId, 'cli_scan_to_print_app');
    assert.equal(body.nonceStr, 'nonce_scan_print');
    assert.equal(body.timestamp, 1700000000);
    assert.equal(body.url, pageUrl, '签名用的就是页面 URL');
    // ⭐ AC-SP2：与服务端自算逐字一致（换 ticket 就红 ⇒ 这条能真红）。
    assert.equal(body.signature, sign({
      ticket: 'ticket_scan_print', nonceStr: 'nonce_scan_print', timestamp: 1700000000, url: pageUrl,
    }));
    // ⭐ AC-SP1：**形状钉死** —— 只有这七样，多一个键（例如谁顺手把 secret 塞进去）就红。
    assert.deepEqual(Object.keys(body).sort(), [
      'appId', 'jsApiList', 'jssdkUrl', 'nonceStr', 'signature', 'success', 'timestamp', 'url',
    ].sort());
    const json = JSON.stringify(body);
    for (const secret of [APP_SECRET, 'ticket_scan_print', 'token_scan_print']) {
      assert.equal(json.includes(secret), false, `响应里不许出现 ${secret} ✗`);
    }
  });
});

test('AC-SP2 ⭐ 签名接口**在既有鉴权闸门之内**：没登录 401 / 认证没启用 503', async () => {
  login();
  const { app } = signatureApp();
  await withServer(app, async (base) => {
    const anonymous = await fetch(`${base}/api/workbench/lark/jsapi-signature?url=${encodeURIComponent('https://hm.bamamei.online/x')}`);
    assert.equal(anonymous.status, 401, '没 session ⇒ 401（不新开鉴权、也不许匿名拿签名）');
  });
  // 认证没启用 ⇒ 503（与工作台其它接口**同一个函数**给的那一句）。
  process.env.LARK_WEB_AUTH_ENABLED = 'false';
  await withServer(app, async (base) => {
    const off = await fetch(`${base}/api/workbench/lark/jsapi-signature?url=${encodeURIComponent('https://hm.bamamei.online/x')}`,
      { headers: { cookie: sessionCookie() } });
    assert.equal(off.status, 503);
  });
  login();
});

test('AC-SP2 签名接口：域名不在允许范围 ⇒ 400 + 人话（**不 500、不静默**）', async () => {
  login();
  const { app } = signatureApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/lark/jsapi-signature?url=${encodeURIComponent('https://evil.example.com/x')}`,
      { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.reason, 'host_not_allowed');
    assert.ok(String(body.error || '').length > 4, '要给人话 ✓');
  });
});

// ── AC-SP4：解析（**纯函数**，形状不对 ⇒ 人话拒绝）──────────────────────────

test('AC-SP4 ⭐ 扫到 `/r/{记录 ID}` ⇒ 解析出记录 ID；别的形状 ⇒ **可操作的人话**', () => {
  const ok = parseLabelScanUrl(buildLabelScanUrl('recABC123'));
  assert.deepEqual(ok, { ok: true, mode: 'recordId', value: 'recABC123' }, '出码与解析是一对反函数 ✓');
  assert.equal(SCAN_URL.recordIdTemplate, 'https://hm.bamamei.online/r/{recordId}', '形状唯一真源仍在 config ✓');

  // ⭐ 旧贴纸（`/s/{编号}`）：**认得出这是什么** ⇒ 人话必须告诉她"重打新标签"（不是"格式不对"）。
  const legacy = parseLabelScanUrl('https://hm.bamamei.online/s/XHB8095%7C%E9%BB%91%E8%89%B2%7CA');
  assert.equal(legacy.ok, false);
  assert.equal(legacy.reason, 'legacy_sticker');
  assert.match(legacy.message, /旧版二维码/, '要点明这是什么');
  assert.match(legacy.message, /重新打印|重打/, '要给出下一步（可操作）');
  assert.equal(legacy.message, LABEL_PRINT.scanPrint.texts.legacySticker, '文案唯一真源在 config');

  // 别人的二维码 / 一段文字 / 空串 ⇒ 一律**拒**（**不猜** ✗：形状不对就是不对）。
  for (const raw of ['hello world', 'https://example.com/r/rec1', 'https://hm.bamamei.online/r/', '']) {
    const out = parseLabelScanUrl(raw);
    assert.equal(out.ok, false, raw);
    assert.ok(out.message.length > 4, '每种拒绝都要有人话');
  }
  assert.equal(parseLabelScanUrl('').reason, 'empty');
  assert.equal(parseLabelScanUrl('hello world').reason, 'not_label_code');
});

// ── AC-SP5/SP6/SP8：扫码 ⇒ 排进**既有**队列（恰好一张）──────────────────────

/** 一条「实时库存」记录（一双一条）。 */
const stockRecord = (id, { stockKey, state = '门盒' } = {}) => ({
  record_id: id,
  fields: { [F.stockKey]: stockKey, [F.state]: state },
});

/** 一条「货品信息」记录。 */
const productRecord = (id, { number, price } = {}) => ({
  record_id: id,
  fields: { [P.number]: number, ...(price === undefined ? {} : { [P.price]: price }) },
});

/** 只读的假网关（`listAll` 挑标签 + `get` 按记录 ID 读那一条）。 */
const gatewayOf = ({ liveInventory = [], product = [] } = {}) => ({
  calls: [],
  async listAll(tableKey) {
    this.calls.push(tableKey);
    if (tableKey === 'liveInventory') return liveInventory;
    if (tableKey === 'product') return product;
    throw new Error(`扫码打印这条链路不该读：${tableKey}`);
  },
  async get(tableKey, recordId) {
    this.calls.push(`get:${tableKey}`);
    if (tableKey !== 'product') throw new Error('只按记录 ID 读「货品信息」');
    return product.find((record) => record.record_id === recordId) || null;
  },
  create() { throw new Error('只读链路：不许 create'); },
  update() { throw new Error('只读链路：不许 update'); },
  delete() { throw new Error('只读链路：不许 delete'); },
});

const fakeRenderLabels = async () => ({
  pdf: Buffer.from('%PDF-1.4 scan-to-print'),
  pngFirst: Buffer.from('png'),
  pages: 1,
  meta: {
    page_count: 1, pdf_bytes: 22, width_pt: 113.4, height_pt: 85, dpi: 203,
    width_mm: 40, height_mm: 30, canvas: 'landscape', rotate: 0, scale: 1,
  },
});

/** 真的队列 service + 真的标签 service（只读假网关）——"恰好一张"是被真正验证的。 */
const scanPrintHarness = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-to-print-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  const gateway = gatewayOf({
    liveInventory: [
      stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' }),
      stockRecord('st2', { stockKey: 'XHB8095|棕色|A|37' }),
      // 同一个货号、**另一个颜色**：按记录 ID 打的时候**不许**把它也带上（否则就是多打 ✗）。
      stockRecord('st3', { stockKey: 'XHB8095|黑色|A|38' }),
    ],
    product: [
      productRecord('rec_brown', { number: 'XHB8095|棕色|A', price: 198 }),
      productRecord('rec_black', { number: 'XHB8095|黑色|A', price: 198 }),
    ],
  });
  const labelPrint = createLabelPrintService(gateway);
  const config = { ...LABEL_PRINT_QUEUE, storeDir: dir };
  const service = createLabelPrintQueueService({
    store, labelPrint, config, renderLabels: fakeRenderLabels,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/label-print', createLabelPrintQueueRouter({ service }));
  return {
    app, service, store, gateway, dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

const postJobs = (base, body) => fetch(`${base}/api/workbench/label-print/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie() },
  body: JSON.stringify(body),
});

test('AC-SP5/SP6 ⭐ 扫到记录 ID ⇒ **只排这一张**（走既有 /jobs、标签数 = 1）＋ 连点不重复建任务', async () => {
  login();
  const harness = scanPrintHarness();
  try {
    await withServer(harness.app, async (base) => {
      const scanned = buildLabelScanUrl('rec_brown');
      const first = await postJobs(base, { mode: 'single', scan: scanned, submit_key: 'scan-key-1' });
      assert.equal(first.status, 200, await first.clone().text().catch(() => ''));
      const body = await first.json();
      assert.equal(body.success, true);
      assert.equal(body.total_labels, 1, '⭐ 只排这一张（不是两三张）');
      assert.deepEqual(body.job.numbers, ['XHB8095|棕色|A'], '打的是扫到的那一款（黑色那一款不许被带上 ✗）');
      assert.equal(body.reused, undefined, '第一次是真建任务');

      // ⭐ 连点（同一把幂等键 / 同一个内容）⇒ **不重复建任务**（不做的话她会白等一张纸）。
      const again = await postJobs(base, { mode: 'single', scan: scanned, submit_key: 'scan-key-1' });
      const againBody = await again.json();
      assert.equal(againBody.reused, true, '同一份请求 ⇒ 复用同一个任务（没有重复提交）');
      assert.equal(againBody.job_id, body.job_id);

      const jobs = await harness.store.listAll();
      assert.equal(jobs.length, 1, '队列里**只有一条**任务 ✓');
      assert.equal(jobs[0].source, 'workbench', '来源如实记 workbench');
      assert.equal(jobs[0].request.mode, 'single');
      assert.equal(jobs[0].request.recordId, 'rec_brown');
      // ⭐ 源码 + 运行双证据：这条请求真的打到了**既有**的 `/jobs`（没有第二条打印接口）。
      assert.match(sourceOf('src/routes/labelPrintQueue.js'), /router\.post\('\/jobs'/);
      assert.match(sourceOf('src/routes/labelPrintQueue.js'), /parseLabelScanUrl/);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-SP4/SP8 ⭐ 形状不对 ⇒ 400 + **可操作的人话**，而且**一张都没排**', async () => {
  login();
  const harness = scanPrintHarness();
  try {
    await withServer(harness.app, async (base) => {
      for (const scan of ['https://hm.bamamei.online/s/XHB8095%7C%E9%BB%91%E8%89%B2%7CA', '随便一段文字']) {
        const response = await postJobs(base, { mode: 'single', scan });
        assert.equal(response.status, 400, scan);
        const body = await response.json();
        assert.equal(body.success, false);
        assert.ok(String(body.error || '').length > 4, '给人话（不是裸 500）');
      }
      const legacy = await (await postJobs(base, {
        mode: 'single', scan: 'https://hm.bamamei.online/s/XHB8095%7C%E9%BB%91%E8%89%B2%7CA',
      })).json();
      assert.equal(legacy.reason, 'legacy_sticker');
      assert.match(legacy.error, /重新打印|重打/, '旧码要告诉她下一步（可操作）');
      assert.equal((await harness.store.listAll()).length, 0, '⭐ 形状不对 ⇒ 零写入（一张都不许排）');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-SP8 ⭐ 记录读不到 / 这一款没库存 ⇒ 400 人话（不是 500，也不假成功）', async () => {
  login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-to-print-miss-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  // 货品信息里**没有**这个记录 ⇒ `labelForRecord` 给"找不到了"的人话。
  const gateway = gatewayOf({ liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })], product: [] });
  const service = createLabelPrintQueueService({
    store,
    labelPrint: createLabelPrintService(gateway),
    config: { ...LABEL_PRINT_QUEUE, storeDir: dir },
    renderLabels: fakeRenderLabels,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/label-print', createLabelPrintQueueRouter({ service }));
  try {
    await withServer(app, async (base) => {
      const response = await postJobs(base, { mode: 'single', scan: buildLabelScanUrl('rec_missing') });
      assert.equal(response.status, 400, '记录找不到 ⇒ 400（她填错/数据没了那一类）');
      const body = await response.json();
      assert.match(body.error, /找不到了/, '人话要点明"找不到了"');
      assert.equal((await store.listAll()).length, 0, '零写入 ✓');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC-SP7/SP9：页面（JSAPI 扫一扫 + 即时反馈 + 命中区 ≥44px）────────────────

/** 把前端模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）再当模块跑。 */
const loadScanPrintModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-print-ui-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/ui.js'), path.join(dir, 'ui.mjs'));
  fs.writeFileSync(path.join(dir, 'scan-print.mjs'),
    read('features/labels/scan-print.js')
      .split("from '../../core/ui.js'").join("from './ui.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'scan-print.mjs')).href);
};

/** 一个够用的假 DOM（这一块只用到 querySelector / textContent / disabled / 事件）。 */
const fakeContainer = () => {
  const make = () => ({
    textContent: '', className: '', disabled: false, dataset: {}, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  });
  const elements = {
    '[data-action="scan-print"]': make(),
    '[data-view="scan-print-notice"]': make(),
  };
  return { elements, querySelector: (selector) => elements[selector] || null };
};

const fakeWin = ({ scanResult = { result: 'https://hm.bamamei.online/r/rec_brown', errMsg: 'scanCode:ok' }, fail = null } = {}) => {
  const state = { configCalls: [], readyCalls: 0, scanCalls: [] };
  return {
    state,
    win: {
      location: { href: 'https://hm.bamamei.online/workbench/label-print.html?scan=1' },
      h5sdk: {
        config(options) { state.configCalls.push(options); return Promise.resolve(); },
        ready(callback) { state.readyCalls += 1; callback(); },
      },
      tt: {
        scanCode(options) {
          state.scanCalls.push(options);
          if (fail) options.fail(fail); else options.success(scanResult);
        },
      },
    },
  };
};

test('AC-SP7 ⭐ 点一下 ⇒ `h5sdk.config` ⇒ `tt.scanCode`（**JSAPI，不是跳外链**）⇒ 排进既有 /jobs', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();
  const { win, state: winState } = fakeWin();
  const calls = { get: [], post: [] };
  const api = {
    async get(url) { calls.get.push(url); return { appId: 'cli_x', timestamp: 1700000000, nonceStr: 'n1', signature: 'sig1', jssdkUrl: 'https://cdn.test/h5sdk.js' }; },
    async post(url, body) { calls.post.push({ url, body }); return { success: true, total_labels: 1, job_id: 'job-1' }; },
  };
  const action = module.createScanPrintAction({ api, doc: null, win });
  const button = action.mount(container);

  assert.equal(container.elements['[data-action="scan-print"]'].textContent, '📷 扫码打印');
  await button.handlers.click();

  // ① 签名请求：**页面地址原样带上**（签名必须与页面 URL 一致）。
  assert.deepEqual(calls.get, [module.signaturePath(win.location.href)]);
  assert.match(calls.get[0], /^\/api\/workbench\/lark\/jsapi-signature\?url=/);
  // ② JSAPI 三件套：config（四样 + jsApiList）⇒ ready ⇒ scanCode。
  assert.deepEqual(winState.configCalls, [{
    appId: 'cli_x', timestamp: 1700000000, nonceStr: 'n1', signature: 'sig1', jsApiList: ['scanCode'],
  }]);
  assert.equal(winState.readyCalls, 1);
  assert.equal(winState.scanCalls.length, 1);
  assert.deepEqual(winState.scanCalls[0].scanType, ['qrCode']);
  // ③ **既有队列接口**（不新开打印接口 ✗）：`mode:single` + 原样交上扫到的字符串。
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].url, '/api/workbench/label-print/jobs');
  assert.equal(module.SCAN_PRINT_ENDPOINTS.jobs, '/api/workbench/label-print/jobs');
  assert.equal(calls.post[0].body.mode, 'single');
  assert.equal(calls.post[0].body.scan, 'https://hm.bamamei.online/r/rec_brown');
  // ④ 结果如实说 + 按钮恢复（她还能再扫一个）。
  assert.equal(container.elements['[data-view="scan-print-notice"]'].textContent, '✅ 已提交打印：这一张');
  assert.equal(container.elements['[data-action="scan-print"]'].disabled, false);
  // ⑤ **不是跳外链** ✗：这一块里不许出现任何 AppLink / 飞书外链。
  const source = read('features/labels/scan-print.js');
  assert.equal(/applink|feishu\.cn/i.test(source), false, '扫码打印不许跳外链（JSAPI 弹相机 ✓）');
});

test('AC-SP7 点了**立刻**有反馈：跑到一半时按钮已置灰 + 换成"正在唤起扫一扫…"', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();
  const { win } = fakeWin();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const api = {
    get: async () => { await blocked; return { appId: 'x', timestamp: 1, nonceStr: 'n', signature: 's', jssdkUrl: '' }; },
    post: async () => ({ total_labels: 1 }),
  };
  const action = module.createScanPrintAction({ api, doc: null, win });
  const button = action.mount(container);
  const running = button.handlers.click();
  // 还没等到签名回来 —— 按钮必须**已经是**置灰 + 处理中文案（她不许"点了没反应"）。
  assert.equal(container.elements['[data-action="scan-print"]'].disabled, true);
  assert.match(container.elements['[data-action="scan-print"]'].textContent, /正在/);
  release();
  await running;
  assert.equal(container.elements['[data-action="scan-print"]'].disabled, false);
});

test('AC-SP8 ⭐ 失败如实：服务端的人话 / 扫码取消 / 没有 h5sdk ⇒ 三种都说清楚，**不当成功**', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();

  // ① 服务端 400 的人话（旧码 / 记录找不到）—— 原样显示，**不吞**。
  const legacyMessage = LABEL_PRINT.scanPrint.texts.legacySticker;
  const legacyAction = module.createScanPrintAction({
    api: {
      get: async () => ({ appId: 'x', timestamp: 1, nonceStr: 'n', signature: 's', jssdkUrl: '' }),
      post: async () => { throw Object.assign(new Error(legacyMessage), { status: 400 }); },
    },
    doc: null,
    win: fakeWin().win,
  });
  const legacyButton = legacyAction.mount(container);
  await legacyButton.handlers.click();
  assert.equal(container.elements['[data-view="scan-print-notice"]'].textContent, legacyMessage,
    '服务端的人话要原样给她（她自己取消/码不对时看得懂）');

  // ② 她自己取消了扫码 ⇒ 不是错误，如实说"没有打印任何东西"。
  const cancelAction = module.createScanPrintAction({
    api: { get: async () => ({ appId: 'x', timestamp: 1, nonceStr: 'n', signature: 's', jssdkUrl: '' }), post: async () => ({}) },
    doc: null,
    win: fakeWin({ fail: { errMsg: 'scanCode:cancel', errno: 1 } }).win,
  });
  await cancelAction.mount(container).handlers.click();
  assert.equal(container.elements['[data-view="scan-print-notice"]'].textContent, '取消了扫码，没有打印任何东西。');

  // ③ 这台设备没有 h5sdk（电脑 / 自带浏览器）⇒ **人话**，绝不假成功（也不留死按钮）。
  const noSdkAction = module.createScanPrintAction({
    api: { get: async () => ({ appId: 'x', timestamp: 1, nonceStr: 'n', signature: 's', jssdkUrl: '' }), post: async () => ({}) },
    doc: null,
    win: { location: { href: 'https://hm.bamamei.online/x' } },
  });
  await noSdkAction.mount(container).handlers.click();
  assert.match(container.elements['[data-view="scan-print-notice"]'].textContent, /飞书/);
});

test('AC-SP9 ⭐ 命中区 ≥44px + 工作台那一页真的挂上了这一块（`?scan=1` 自动弹一次）', () => {
  const css = read('features/labels/labels.css');
  assert.match(css, /\.scan-print-bar \.btn \{ min-height: 44px; \}/,
    '扫码打印那颗必须是 ≥44px 命中区（手机硬规矩）');
  const page = read('features/labels/index.js');
  assert.match(page, /import \{ createScanPrintAction, scanPrintBarHtml, wantsScanFromSearch \} from '\.\/scan-print\.js';/);
  assert.match(page, /scanPrintBarHtml\(\)/, '页面要真的把这一块画出来');
  assert.match(page, /wantsScanFromSearch\(/, '`?scan=1` 进来 ⇒ 自动弹一次扫一扫');
  // 入口那一格：从 AppLink 改成"落到标签打印页 + scan=1"（JSAPI 那条路的起点）。
  const domains = read('config/domains.js');
  assert.match(domains, /href: '\/workbench\/label-print\.html\?scan=1'/);
  assert.equal(/SCAN_APPLINK/.test(domains), false, '标签打印那一格不再用 AppLink（她选的 ⓐ 是 JSAPI 直扫）');
});

test('AC-SP4 纯函数：签名地址 / config 入参 / 扫到值 / 取消文案 / `?scan=1` 判据', async () => {
  const module = await loadScanPrintModule();
  assert.equal(module.signaturePath('https://a/b?x=1'),
    `/api/workbench/lark/jsapi-signature?url=${encodeURIComponent('https://a/b?x=1')}`);
  assert.deepEqual(module.jsapiConfigOf({ appId: 'a', timestamp: 1, nonceStr: 'n', signature: 's' }), {
    appId: 'a', timestamp: 1, nonceStr: 'n', signature: 's', jsApiList: ['scanCode'],
  });
  assert.equal(module.scannedValueOf({ result: ' https://x ' }), 'https://x');
  assert.equal(module.scannedValueOf({}), '');
  assert.equal(module.scanFailureText({ errMsg: 'scanCode:cancel' }), '取消了扫码，没有打印任何东西。');
  assert.equal(module.scanFailureText({ errMsg: 'scanCode:fail' }), '扫码没有成功，请再试一次。');
  assert.equal(module.wantsScanFromSearch('?scan=1'), true);
  assert.equal(module.wantsScanFromSearch('?keyword=x'), false);
  assert.equal(module.wantsScanFromSearch(''), false);
});
