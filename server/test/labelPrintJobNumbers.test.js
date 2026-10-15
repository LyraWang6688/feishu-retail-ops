/**
 * ⭐⭐ 2026-10-15 晚（业务负责人真机：那一单是 `L6950|黑色|A`，页面上只能显示"这一张"）：
 *   根因 = **`POST /api/workbench/label-print/jobs` 的响应里没有 `numbers`**
 *   （服务端自己的日志有 ✓、HTTP 响应没有 ✗）⇒ 页面拿不到编号 ⇒ 大字退回"这一张" ✗。
 *
 * 修法：`services/labelPrintQueueService.js` 的三条返回路径（**新建 / 快路复用 / 持锁后复用**）
 *   共用一个 `enqueuedOf(job, extra)` ⇒ 一律带上 `numbers`；**加字段，既有字段一个不动** ✓。
 *   ⚠️ 「扫码打印」那条**复用**路径最容易漏（她真机上正是"又扫了一次/同一把 submit_key"那种）⇒
 *      本文件 **fresh 与 reused 两条都断言** ✓。
 *
 * 判据来源：她 2026-10-15 真机截图 ＋ Lead 转述的服务端日志那一单（`L6950|黑色|A`）。
 * ⚠️ 这半是**真的**路由 + **真的**队列 service + **真的**标签 service（只读假网关；
 *    产物渲染换成假的 ⇒ 不打真飞书、不写打印文件）。
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-A5b `/jobs`（scan 单张 / 按编号）响应带 `numbers`（= 那一张的编号）✓
 *   AC-A5c **复用**那条路径也带 `numbers`（`reused:true` 时照样有）✓
 *   AC-A5d **既有字段一个不动**（`job` / `job_id` / `total_labels` / `reused` 逐字还在）✓
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// 路由/服务的 require 链会在模块级求值凭证与表 ID（本文件一次飞书都不打）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_job_numbers_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'job_numbers_secret';

const { createLabelPrintQueueRouter } = require('../src/routes/labelPrintQueue');
const { createLabelPrintService } = require('../src/services/labelPrintService');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const F = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
const P = V1_BITABLE_SCHEMA.tables.product.fields;

const SESSION_SECRET = 'job_numbers_secret';
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_job_numbers') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 'T', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // ⭐ 与 task-16 的诊断结论同一行加固：`fetch`（undici）**进程级 keep-alive 池**会复用到
  //    临时端口被 OS 复用后的**死 socket** ⇒ 偶发 `ECONNRESET`。给临时服务器 1ms keep-alive
  //    ⇒ socket 不会活着被下一个用例捡到（本仓正在全仓推广，这里先在自己的新文件里加上）。
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    // ⚠️ 与既有用例同一姿势：先断 keep-alive 连接再 close（避免偶发 ECONNRESET 噪声）。
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 一条「实时库存」记录（一双一条）—— 真机那一单的编号逐字：`L6950|黑色|A`。 */
const stockRecord = (id, { stockKey, state = '门盒' } = {}) => ({
  record_id: id,
  fields: { [F.stockKey]: stockKey, [F.state]: state },
});
const productRecord = (id, { number, price } = {}) => ({
  record_id: id,
  fields: { [P.number]: number, ...(price === undefined ? {} : { [P.price]: price }) },
});

/** 只读假网关（与 `scanToPrint.test.js` 同一形状）。 */
const gatewayOf = ({ liveInventory = [], product = [] } = {}) => ({
  async listAll(tableKey) {
    if (tableKey === 'liveInventory') return liveInventory;
    if (tableKey === 'product') return product;
    throw new Error(`这条链路不该读：${tableKey}`);
  },
  async get(tableKey, recordId) {
    if (tableKey !== 'product') throw new Error('只按记录 ID 读「货品信息」');
    return product.find((record) => record.record_id === recordId) || null;
  },
  create() { throw new Error('只读链路：不许 create'); },
  update() { throw new Error('只读链路：不许 update'); },
  delete() { throw new Error('只读链路：不许 delete'); },
});

const fakeRenderLabels = async () => ({
  pdf: Buffer.from('%PDF-1.4 job-numbers'),
  pngFirst: Buffer.from('png'),
  pages: 1,
  meta: {
    page_count: 1, pdf_bytes: 22, width_pt: 113.4, height_pt: 85, dpi: 203,
    width_mm: 40, height_mm: 30, canvas: 'landscape', rotate: 0, scale: 1,
  },
});

const harness = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-numbers-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  const gateway = gatewayOf({
    liveInventory: [
      stockRecord('st1', { stockKey: 'L6950|黑色|A|40' }),
      // 同一个货号、**另一个颜色** —— 按编号打的时候不许把它也带上 ✓
      stockRecord('st2', { stockKey: 'L6950|棕色|A|40' }),
    ],
    product: [
      productRecord('rec_black', { number: 'L6950|黑色|A', price: 268 }),
      productRecord('rec_brown', { number: 'L6950|棕色|A', price: 268 }),
    ],
  });
  const service = createLabelPrintQueueService({
    store,
    labelPrint: createLabelPrintService(gateway),
    config: { ...LABEL_PRINT_QUEUE, storeDir: dir },
    renderLabels: fakeRenderLabels,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/label-print', createLabelPrintQueueRouter({ service }));
  return { app, service, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const postJobs = (base, body) => fetch(`${base}/api/workbench/label-print/jobs`, {
  method: 'POST',
  headers: { cookie: sessionCookie(), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A5b / AC-A5c / AC-A5d
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A5b ⭐⭐ `/jobs` 的响应带上 `numbers`（真机那一单 = L6950|黑色|A）—— 页面大字才拿得到编号', async () => {
  login();
  const { app, cleanup } = harness();
  try {
    await withServer(app, async (base) => {
      const response = await postJobs(base, { mode: 'single', number: 'L6950|黑色|A', submit_key: 'k-numbers-1' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      // 🔴 本任务的核心：响应里必须有编号（改前只有服务端日志里有 ✗）
      assert.deepEqual(body.numbers, ['L6950|黑色|A'], `响应必须带 numbers（实际：${JSON.stringify(body.numbers)}）`);
      // 既有字段一个不动（加字段，不是改形状 ✓）
      assert.equal(body.total_labels, 1);
      assert.ok(body.job && body.job.job_id === body.job_id, 'job / job_id 照旧');
      assert.deepEqual(body.job.numbers, ['L6950|黑色|A'], '既有 job.numbers 也照旧在');
      assert.ok(body.status && typeof body.status.online === 'boolean', 'status 那一段照旧');
      // 不能把**别的颜色**也带上（按编号打 = 精确那一张 ✓）
      assert.equal(body.numbers.includes('L6950|棕色|A'), false);
    });
  } finally {
    cleanup();
  }
});

test('AC-A5c ⭐⭐ **复用**那条路径（同 submit_key 再扫一次）也带 `numbers` —— 她真机上就是这一种', async () => {
  login();
  const { app, cleanup } = harness();
  try {
    await withServer(app, async (base) => {
      const first = await (await postJobs(base, { mode: 'single', number: 'L6950|黑色|A', submit_key: 'k-same' })).json();
      assert.deepEqual(first.numbers, ['L6950|黑色|A']);
      const second = await (await postJobs(base, { mode: 'single', number: 'L6950|黑色|A', submit_key: 'k-same' })).json();
      assert.equal(second.reused, true, '同一把 submit_key ⇒ 复用同一个任务 ✓');
      assert.deepEqual(second.numbers, ['L6950|黑色|A'],
        '🔴 复用这条路**也要有** numbers（她真机上正是"又扫了一次"；漏了这一条 ⇒ 页面又退回"这一张" ✗）');
    });
  } finally {
    cleanup();
  }
});

test('AC-A5d 源码哨兵：三条返回路径共用**同一处**（不许某一条路又漏掉 numbers）', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'labelPrintQueueService.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'labelPrintQueue.js'), 'utf8');
  const enqueuedOf = service.slice(service.indexOf('const enqueuedOf'), service.indexOf('const notify'));
  assert.ok(enqueuedOf.includes('numbers: job.numbers || []'),
    '`enqueuedOf` 里产出 numbers（三条返回路径共用 ⇒ 不会再漏）');
  assert.equal((service.match(/return enqueuedOf\(/g) || []).length, 3,
    '新建 / 快路复用 / 持锁后复用 —— 三条都走 `enqueuedOf` ✓');
  assert.ok(/\.\.\.result/.test(route), '响应里原样展开 service 的结果（加字段自动带到 HTTP ✓）');
});
