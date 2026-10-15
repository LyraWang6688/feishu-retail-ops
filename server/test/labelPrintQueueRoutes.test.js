/**
 * 打印链路的**接口护栏**：手机侧（`/api/workbench/label-print/*`）与电脑侧（`/api/label-print/*`）。
 *
 * 这里钉的几件事（每条用例名就是一条 AC）：
 *   · AC-R1 手机侧走**既有**工作台身份闸门（认证没启用 503 / 未登录 401 / 白名单外 403）——不新开鉴权；
 *   · AC-R2 电脑侧走**独立设备令牌**；**没配令牌 ⇒ 503 + 大声报错**（不是静默放行）；
 *   · AC-R3 ⭐ **SSE 事件推送**：手机入队 → 正开着长连接的小助手**秒级**收到 `job` 事件
 *           （顺带验证"两条路由**共用同一个队列实例**"——这是这条链路的命门）；
 *   · AC-R4 ⭐⭐ **启动补拉**：电脑关着时入队的任务，开机后 `GET /pending` 一次取回；
 *   · AC-R5 SSE 响应的头必须能穿过 Nginx：`X-Accel-Buffering: no`（不然事件会被憋住）+ 心跳；
 *   · AC-R6 认领 → 回执 → 状态；失败回执缺原因 ⇒ 400；
 *   · AC-R7 产物下载：PDF / PNG、`Content-Type`、`x-label-print-sha256`、过期 ⇒ 410、不存在 ⇒ 404；
 *   · AC-R8 长轮询备选通道：`POST /jobs/next?waitMs=` 有任务时**立刻**返回（不是定时轮询）；
 *   · AC-R9 端口错误口径：她填错 400 / 系统坏 502（原因原样回页面）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// 路由模块的 require 链会在模块级求值 `config/v1BitableSchema`（读飞书表 ID）——
// 给一对假凭证只为让模块能加载（本用例一次飞书都不打；与 `labelPrintRoute.test.js` 同一做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

const { createLabelPrintQueueRouter } = require('../src/routes/labelPrintQueue');
const { createLabelPrintDeviceRouter } = require('../src/routes/labelPrintDevice');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');
const { LABEL_PRINT } = require('../src/config/labelPrint');

const SESSION_SECRET = 'label_print_queue_test_secret';
const DEVICE_TOKEN = 'device-token-for-tests';
const NUMBER = 'XHB8095|棕色|A';

const sessionCookie = (openId = 'ou_test_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const label = () => ({
  key: NUMBER, number: NUMBER, item_no: 'XHB8095', color: '棕色', category: '休闲鞋', category_code: 'A',
  sizes: [{ size: 36, qty: 1 }], size_lines: [[{ size: 36, qty: 1 }]], size_overflow: false, total_qty: 1,
  states: ['门盒'], state_text: '门盒', price: 198, price_text: '¥198', brand_text: '邯美皮鞋',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
  footer_text: NUMBER,
});

const labelPrintStub = () => ({
  async listLabels() {
    const labels = [label()];
    return { labels, total_matched: 1, total_returned: 1, total_pairs: 1, layout: LABEL_PRINT };
  },
});

/** 一份**手机侧 + 电脑侧共用**的队列（= `labelPrintQueueRuntime` 在真机上做的事）。 */
const buildHarness = (patch = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-print-routes-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  const config = {
    ...LABEL_PRINT_QUEUE,
    storeDir: dir,
    device: { ...LABEL_PRINT_QUEUE.device, token: DEVICE_TOKEN },
    ...patch,
  };
  const service = createLabelPrintQueueService({
    store,
    labelPrint: labelPrintStub(),
    config,
    renderLabels: patch.renderLabels,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/label-print', createLabelPrintQueueRouter({ service }));
  app.use('/api/label-print', createLabelPrintDeviceRouter({ service, config }));
  return {
    app, service, store, config, dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  // ⭐⭐ 2026-10-15（task-16 · T-3）：**测试服务器不保持 keep-alive 空闲连接** ——
  //   根因（实测复现见 `test/stabilityRepro.cjs`，AC-R4 那一次偶发就是这个）：
  //   内置 `fetch`（undici）按 origin 池化 socket；本助手每个用例起一个 `listen(0)` 临时服务器、
  //   收尾 `server.close()`（**下面那句 `closeAllConnections()` 救不了这一条** —— 实测 40/40 照旧红）
  //   ⇒ 那条池化 socket 在**临时端口被 OS 复用**给下一个用例的服务器时会被重新挑中
  //   ⇒ 对端不识这个连接 ⇒ RST ⇒ `fetch failed` / `cause: read ECONNRESET`（**不是**断言错）。
  //   ⚠️ 它**不影响**下面的 SSE 长连接收尾：`keepAliveTimeout` 只在**响应结束之后**才计时。
  //   🔴 只加这一行启动参数：任何用例的**判据一个字都没动** ✗
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    // ⚠️ SSE 长连接**本来就不会自己结束**（那正是它的用途）⇒ 用例收尾必须**强制**关连接，
    //    否则 `server.close()` 会一直等它，测试挂死（踩过一次）。这一条与"断言失败也要能收尾"是同一件事。
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const phone = (base, url, options = {}) => fetch(`${base}/api/workbench/label-print${url}`, {
  ...options,
  headers: { 'content-type': 'application/json', cookie: sessionCookie(), ...(options.headers || {}) },
  body: options.body === undefined ? undefined : JSON.stringify(options.body),
});

const device = (base, url, options = {}) => fetch(`${base}/api/label-print${url}`, {
  ...options,
  headers: { 'x-label-print-token': DEVICE_TOKEN, 'content-type': 'application/json', ...(options.headers || {}) },
  body: options.body === undefined ? undefined : JSON.stringify(options.body),
});

/** 打开一条 SSE 长连接，并给它一个"等下一条事件"的读取器。 */
const openSse = async (base, token = DEVICE_TOKEN) => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/label-print/stream`, {
    headers: { 'x-label-print-token': token },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = [];
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        let text = decoder.decode(value, { stream: true });
        while (text.includes('\n\n')) {
          const index = text.indexOf('\n\n');
          const raw = text.slice(0, index);
          text = text.slice(index + 2);
          const event = { event: 'message', data: '', json: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event.event = line.slice(6).trim();
            else if (line.startsWith('data:')) event.data += line.slice(5).trim();
          }
          if (event.data) {
            try { event.json = JSON.parse(event.data); } catch { event.json = null; }
          }
          // ⚠️ 有等待者就**交给它**，否则才排队 —— 两个都做的话事件会被读两遍（踩过一次）。
          if (waiters.length) waiters.shift()(event);
          else queue.push(event);
        }
      }
    } catch {
      // 被 abort / 服务端关掉 —— 正常收尾。
    } finally {
      ended = true;
      while (waiters.length) waiters.shift()(null);
    }
  })();
  pump.catch(() => undefined);
  const next = (timeoutMs = 3000) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    if (ended) return resolve(null);
    const timer = setTimeout(() => reject(new Error(`等 SSE 事件超时（${timeoutMs}ms）`)), timeoutMs);
    return waiters.push((event) => { clearTimeout(timer); resolve(event); });
  });
  return { response, next, close: () => controller.abort(), queue };
};

// ── AC-R1：手机侧鉴权 ──────────────────────────────────────────────────────

test('AC-R1 手机侧：认证没启用 503 / 未登录 401 / 白名单外 403 —— 与工作台同一道闸门', async () => {
  const harness = buildHarness();
  try {
    // ① 认证没启用
    delete process.env.LARK_WEB_AUTH_ENABLED;
    await withServer(harness.app, async (base) => {
      const response = await fetch(`${base}/api/workbench/label-print/status`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /认证尚未启用/);
    });
    // ② 未登录
    login();
    await withServer(harness.app, async (base) => {
      const response = await fetch(`${base}/api/workbench/label-print/status`);
      assert.equal(response.status, 401);
    });
    // ③ 白名单外
    process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_someone_else';
    await withServer(harness.app, async (base) => {
      const response = await phone(base, '/status');
      assert.equal(response.status, 403);
    });
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  } finally {
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
    harness.cleanup();
  }
});

// ── AC-R2：电脑侧令牌 ──────────────────────────────────────────────────────

test('AC-R2 电脑侧：没配令牌 ⇒ 503 且明确说"没配"（绝不静默放行）', async () => {
  const harness = buildHarness();
  harness.config.device.token = '';
  const app = express();
  app.use(express.json());
  app.use('/api/label-print', createLabelPrintDeviceRouter({
    service: harness.service,
    config: { ...harness.config, device: { ...harness.config.device, token: '' } },
  }));
  try {
    await withServer(app, async (base) => {
      for (const [url, options] of [['/pending', {}], ['/jobs/next', { method: 'POST' }], ['/stream', {}]]) {
        const response = await fetch(`${base}/api/label-print${url}`, options);
        assert.equal(response.status, 503, url);
        const body = await response.json();
        assert.equal(body.device_token_missing, true);
        assert.match(body.error, /令牌没有配置/);
      }
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R2 电脑侧：令牌缺失/不对 ⇒ 401；对了 ⇒ 200', async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const missing = await fetch(`${base}/api/label-print/pending`);
      assert.equal(missing.status, 401);
      const wrong = await device(base, '/pending', { headers: { 'x-label-print-token': 'nope' } });
      assert.equal(wrong.status, 401);
      // ⚠️ 长度不同也要 401（定长比较的边界）。
      const short = await device(base, '/pending', { headers: { 'x-label-print-token': 'x' } });
      assert.equal(short.status, 401);
      const ok = await device(base, '/pending');
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).success, true);
    });
  } finally {
    harness.cleanup();
  }
});

// ── AC-R3 / AC-R5：SSE 事件推送 ────────────────────────────────────────────

test('AC-R5 SSE 的头必须能穿过 Nginx：text/event-stream + X-Accel-Buffering: no + no-transform', async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const sse = await openSse(base);
      assert.equal(sse.response.status, 200);
      assert.match(sse.response.headers.get('content-type'), /text\/event-stream/);
      assert.equal(sse.response.headers.get('x-accel-buffering'), 'no', '这一个头决定"事件会不会被 Nginx 憋住"');
      assert.match(sse.response.headers.get('cache-control'), /no-cache/);
      assert.match(sse.response.headers.get('cache-control'), /no-transform/);
      const hello = await sse.next();
      assert.equal(hello.event, 'hello');
      const backlog = await sse.next();
      assert.equal(backlog.event, 'backlog');
      assert.deepEqual(backlog.json.jobs, [], '此刻没有排队的任务');
      sse.close();
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R3 ⭐ 手机入队 ⇒ 正开着长连接的小助手秒级收到 job 事件（两条路由共用同一个队列）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const sse = await openSse(base);
      await sse.next(); // hello
      await sse.next(); // backlog

      const response = await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } });
      assert.equal(response.status, 200);
      const enqueued = await response.json();
      assert.equal(enqueued.success, true);
      assert.equal(enqueued.job.status, 'queued');
      assert.equal(enqueued.total_labels, 1);
      assert.equal(enqueued.status.online, true, '长连接活着 ⇒ 在线');

      const pushed = await sse.next(3000);
      assert.ok(pushed, '必须收到推送（事件驱动，不是等她下次轮询）');
      assert.equal(pushed.event, 'job');
      assert.equal(pushed.json.job_id, enqueued.job_id);
      assert.equal(pushed.json.status, 'queued');
      // 推送里**不塞产物字节**（只有引用与状态）。
      assert.equal(pushed.json.artifact, undefined);
      sse.close();
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R3 SSE 断开后订阅者被摘掉（不会越积越多）', async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const sse = await openSse(base);
      await sse.next();
      await sse.next();
      assert.equal(harness.service.subscriberCount(), 1);
      sse.close();
      // 给"关闭"事件一点时间传到服务端。
      for (let i = 0; i < 50 && harness.service.subscriberCount() > 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(harness.service.subscriberCount(), 0, '断开后必须摘掉订阅者');
    });
  } finally {
    harness.cleanup();
  }
});

// ── AC-R4：启动补拉 ────────────────────────────────────────────────────────

test('AC-R4 ⭐⭐ 启动补拉：电脑关着时手机点了两次打印，开机后 GET /pending 一次取回（先进先出）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      // ① 电脑关着：她先在手机上点了两次。
      // ⚠️ 2026-10-11 改夹具（**"补拉按先进先出"这个本意没变**）：
      //   改前：两次都是 `{ mode:'single', number }`（一模一样）。
      //   改后：第二次带 `again: true` = **她明确要再打一张**。
      //   理由：真机反馈"连点导致多打"之后，同一份请求在窗口内现在是**同一个任务**
      //        （防连点，见 `labelPrintQueue.test.js` 的 AC16）⇒ 用"两次一样的提交"
      //        再也造不出两条排队任务；而 `again` 正是"她真想再打一张"那条真实的路。
      const first = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } })).json();
      const second = await (await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, again: true },
      })).json();
      assert.notEqual(second.job_id, first.job_id);
      const statusWhileOffline = await (await phone(base, '/status')).json();
      assert.equal(statusWhileOffline.online, false, '电脑没连过 ⇒ 未连接');
      assert.equal(statusWhileOffline.status.counts.queued, 2, '任务在排队（不是丢了）');

      // ② 电脑开机：第一件事就是补拉。
      const pending = await (await device(base, '/pending')).json();
      assert.deepEqual(pending.jobs.map((job) => job.job_id), [first.job_id, second.job_id]);
      assert.equal(pending.online, true, '任何一次通过令牌的请求都算心跳 ⇒ 补拉之后立刻变在线');

      // ②b 长连接断了也有兜底：显式心跳让手机继续看到"在线"。
      const beat = await (await device(base, '/heartbeat', { method: 'POST' })).json();
      assert.equal(beat.success, true);
      assert.equal(beat.online, true);
      assert.equal(beat.device_id, 'store-pc');

      // ③ 逐个认领 → 回执 → 手机看到"已打印"。
      const claimed = await (await device(base, '/jobs/next', { method: 'POST' })).json();
      assert.equal(claimed.job.job_id, first.job_id);
      assert.equal(claimed.job.status, 'claimed');
      const ack = await device(base, `/jobs/${first.job_id}/ack`, { method: 'POST', body: { status: 'done' } });
      assert.equal(ack.status, 200);
      assert.equal((await ack.json()).job.status, 'done');
      const statusAfter = await (await phone(base, '/status')).json();
      assert.equal(statusAfter.status.counts.done, 1);
      assert.equal(statusAfter.status.counts.queued, 1);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R8 长轮询备选通道：任务来了立刻返回（不是等满 waitMs 再返回）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const startedAt = Date.now();
      // 先挂上长轮询，1 秒后再入队 —— 它应该在任务进来的那一刻就返回。
      const pending = device(base, '/jobs/next?waitMs=20000', { method: 'POST' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } });
      const response = await pending;
      const body = await response.json();
      const elapsed = Date.now() - startedAt;
      assert.ok(body.job, '必须拿到任务');
      assert.ok(elapsed < 5000, `必须在任务进来时就返回（实际 ${elapsed}ms，远小于 waitMs=20000）`);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R8 长轮询等不到就按时返回 job: null（不是错误、也不会挂死）', async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const response = await device(base, '/jobs/next?waitMs=300', { method: 'POST' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).job, null);
    });
  } finally {
    harness.cleanup();
  }
});

// ── AC-R6 / R7 / R9：回执、产物、错误口径 ─────────────────────────────────

test('AC-R6 回执：失败缺原因 ⇒ 400；带原因 ⇒ 状态与原因都留在任务上', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const { job_id: jobId } = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } })).json();
      await device(base, '/jobs/next', { method: 'POST' });
      const bad = await device(base, `/jobs/${jobId}/ack`, { method: 'POST', body: { status: 'failed' } });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /原因/);
      const ok = await device(base, `/jobs/${jobId}/ack`, {
        method: 'POST', body: { status: 'failed', reason: '打印机没开' },
      });
      assert.equal(ok.status, 200);
      const job = (await ok.json()).job;
      assert.equal(job.status, 'failed');
      assert.equal(job.failure_reason, '打印机没开');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R7 产物下载：PDF 的 Content-Type / 文件名 / sha256 头，且字节与落盘一致；png 走 ?format=png', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const { job_id: jobId } = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } })).json();
      const stored = await harness.service.getJob(jobId);

      const response = await device(base, `/jobs/${jobId}/artifact`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.match(response.headers.get('content-disposition'), new RegExp(`${jobId}\\.pdf`));
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.match(bytes.toString('latin1'), /^%PDF-1\.4/);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), response.headers.get('x-label-print-sha256'),
        'sha256 头必须与被下载的字节一致（小助手据此判断有没有下坏）');
      assert.equal(bytes.length, fs.statSync(harness.service.artifactPath(stored.artifact.pdf)).size);

      const png = await device(base, `/jobs/${jobId}/artifact?format=png`);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');

      // 产物没了（过期清理）⇒ 410；任务不存在 ⇒ 404。
      await fs.promises.rm(harness.service.artifactPath(stored.artifact.pdf), { force: true });
      assert.equal((await device(base, `/jobs/${jobId}/artifact`)).status, 410);
      assert.equal((await device(base, '/jobs/no-such-job/artifact')).status, 404);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R7 补打（电脑侧本地页面那颗按钮）：生成新任务、原任务不动', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const { job_id: jobId } = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } })).json();
      await device(base, '/jobs/next', { method: 'POST' });
      await device(base, `/jobs/${jobId}/ack`, { method: 'POST', body: { status: 'failed', reason: '卡纸' } });
      const again = await (await device(base, `/jobs/${jobId}/reprint`, { method: 'POST' })).json();
      assert.equal(again.success, true);
      assert.notEqual(again.job_id, jobId);
      assert.equal(again.job.reprint_of, jobId);
      assert.equal((await harness.service.getJob(jobId)).status, 'failed');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R9 错误口径：她填错 ⇒ 400 原样回；系统坏 ⇒ 502（都不静默）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      // 编号没库存 ⇒ service 回 400，原因原样到页面。
      const bad = await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: 'NOT-THERE|X|A' } });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /没有找到编号/);
      // 认领不存在的任务 ⇒ 400。
      const ack = await device(base, '/jobs/no-such/ack', { method: 'POST', body: { status: 'done' } });
      assert.equal(ack.status, 400);
      // 未知任务查详情 ⇒ 404。
      assert.equal((await phone(base, '/jobs/no-such')).status, 404);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R9 产物渲染失败 ⇒ 手机侧 502 且不回显内部细节之外的路径信息', async () => {
  const harness = buildHarness({ renderLabels: async () => { throw new Error('sharp 画不出来'); } });
  login();
  try {
    await withServer(harness.app, async (base) => {
      const response = await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.match(body.error, /打印文件生成失败/);
      assert.equal((await harness.store.listAll()).length, 0, '不许留半条任务');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R5 手机侧 status / jobs 的返回形状：状态中文名 + 在线 + 计数（她一眼看得见）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } });
      const body = await (await phone(base, '/status')).json();
      assert.equal(body.success, true);
      assert.equal(body.online, false);
      assert.equal(body.status.counts.queued, 1);
      assert.deepEqual(body.states.map((state) => state.id), ['queued', 'claimed', 'done', 'failed']);
      assert.deepEqual(body.states.map((state) => state.label), ['待打印', '已取走', '已打印', '失败']);
      assert.equal(body.jobs[0].status_label, '待打印');
      assert.equal(body.jobs[0].total_labels, 1);
    });
  } finally {
    harness.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-11 方向口径纠正】手机侧也能**按这一次**指定方向（试 90°/270° 不用重启）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R10 ⭐ 手机侧带 `rotate` ⇒ 这一条任务按这个方向印（并留痕在任务上）；不传 ⇒ 跟随配置', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const rotated = await (await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, rotate: 270 },
      })).json();
      assert.equal(rotated.success, true);
      assert.equal((await harness.service.getJob(rotated.job_id)).rotate, 270,
        '任务上要能看出"这一张是按 270° 印的"（试方向时对账全靠它）');
      // 不传 ⇒ 跟随服务器配置（默认 0）。
      const follow = await (await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, again: true },
      })).json();
      assert.equal((await harness.service.getJob(follow.job_id)).rotate, 0);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R10 手机侧非法角度 ⇒ 400（原因原样回页面，绝不静默按 0 印）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const response = await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, rotate: 45 },
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /只能是 0 \/ 90 \/ 180 \/ 270/);
      assert.equal((await harness.store.listAll()).length, 0, '被拒的请求不许留下任务');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R10 试方向不会被防连点挡住：90° 与 270° 各出一条任务', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const a = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER, rotate: 90 } })).json();
      const b = await (await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER, rotate: 270 } })).json();
      assert.notEqual(a.job_id, b.job_id, '两个方向是两件事');
      assert.equal(b.reused, undefined);
      assert.equal((await harness.store.listAll()).length, 2);
    });
  } finally {
    harness.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-11 真机三组对照】画布方向（竖版 = 旋转画布 ⇒ 方向对 + 原尺寸铺满）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R11 ⭐ 手机侧带 `canvas: portrait` ⇒ 这一条走"旋转画布"（原尺寸铺满）；不传 ⇒ 跟随配置', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const response = await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, canvas: 'portrait' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const job = await harness.service.getJob(body.job_id);
      assert.equal(job.canvas, 'portrait', '任务上要留痕"这一张是 portrait（原构图 1:1）"');
      assert.equal(job.rotate, 0, 'portrait：页面内容 = 原构图本身（原尺寸、不转、不换页面）');
      // ⚠️ 2026-10-12 二次改断言（**"portrait = 原尺寸铺满 + 构图不变"这个本意没变**）：
      //   改前（上一版）：页面声明成 30×40（85.0394×113.3858）
      //   改后（Lead 定的正解）：**页面保持 40×30**（113.3858×85.0394）
      //   理由：页面一旦改成 30×40，驱动"看到页面形状与纸型不一致"就会**再转 90°**、
      //        方向又反（真机 C 组）。保持 40×30 + 内容原构图 1:1，才是"方向✓ 构图✓ 铺满✓"。
      assert.equal(job.artifact.width_pt, 113.3858, 'portrait：页面仍是 40×30');
      assert.equal(job.artifact.height_pt, 85.0394);
      assert.equal(job.artifact.scale, 1, '原尺寸，不许缩');
      assert.equal(job.artifact.dpi, 203);
      // 不传 ⇒ 跟随服务器配置（默认 landshape）。
      const follow = await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, again: true },
      });
      assert.equal((await harness.service.getJob((await follow.json()).job_id)).canvas, 'landscape');
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R11 手机侧非法 canvas ⇒ 400（不许静默按横版印一堆方向反的标签）', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const response = await phone(base, '/jobs', {
        method: 'POST', body: { mode: 'single', number: NUMBER, canvas: 'diagonal' },
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /landscape \/ portrait/);
      assert.equal((await harness.store.listAll()).length, 0);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-R11 试方向不会被防连点挡住：竖版 / 横版 90° / 横版原样 各出一条任务', async () => {
  const harness = buildHarness();
  login();
  try {
    await withServer(harness.app, async (base) => {
      const send = (body) => phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER, ...body } })
        .then((response) => response.json());
      const a = await send({ canvas: 'portrait' });
      const b = await send({ canvas: 'landscape', rotate: 90 });
      const c = await send({ canvas: 'landscape', rotate: 0 });
      const ids = [a.job_id, b.job_id, c.job_id];
      assert.equal(new Set(ids).size, 3, '三个方向方案必须各建一条任务（她要挨个打一张对比）');
      assert.equal((await harness.store.listAll()).length, 3);
    });
  } finally {
    harness.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 真机"打印要等 ~30 秒"】提速相关：心跳活着 + 长轮询被钳死
// ═══════════════════════════════════════════════════════════════════════════

test('AC-L1 ⭐ SSE 心跳：默认 20 秒（< Nginx proxy_read_timeout 60 秒），且真的在发 `: ping`', async () => {
  // ① 默认值必须安全：Nginx 的 `proxy_read_timeout` 默认 60 秒，心跳超过它就会被判空闲掐断。
  assert.equal(LABEL_PRINT_QUEUE.ssePingMs, 20000, '默认心跳 20 秒');
  assert.ok(LABEL_PRINT_QUEUE.ssePingMs < 60000, '心跳必须小于 Nginx 的 60 秒');
  assert.ok(LABEL_PRINT_QUEUE.ssePingMs <= 25000, '留足余量：心跳 ≤25 秒');

  // ② 真连一次，把心跳调成 1 秒 ⇒ 1.5 秒内必须收到 `: ping`（不真等 20 秒）
  const harness = buildHarness({ ssePingMs: 1000 });
  const controller = new AbortController();
  try {
    await withServer(harness.app, async (base) => {
      const response = await fetch(`${base}/api/label-print/stream`, {
        headers: { 'x-label-print-token': DEVICE_TOKEN, signal: controller.signal },
      });
      assert.equal(response.headers.get('x-accel-buffering'), 'no', '心跳要能穿过 Nginx（不被缓冲）');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const startedAt = Date.now();
      let text = '';
      while (Date.now() - startedAt < 1500 && !text.includes('ping')) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();
      assert.match(text, /event: ping/, `1.5 秒内必须收到心跳（收到的是 ${JSON.stringify(text.slice(0, 80))}）`);
    });
  } finally {
    controller.abort();
    harness.cleanup();
  }
});

test('AC-L1 ⭐ 长轮询挂起时长**被配置钳死**（客户端传多大都不许超过 longPollWaitMs）', async () => {
  // 站到"客户端乱传 waitMs=999999"这一边：服务端必须钳到 longPollWaitMs（这里设 1000ms 好量）。
  const harness = buildHarness({ longPollWaitMs: 1000 });
  try {
    await withServer(harness.app, async (base) => {
      const startedAt = Date.now();
      const response = await device(base, '/jobs/next', { method: 'POST', body: { waitMs: 999999 } });
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200);
      assert.equal((await response.json()).job, null, '没有任务 ⇒ job: null（不是错误）');
      assert.ok(elapsed >= 900, `必须**真的挂住**等任务（实测 ${elapsed}ms）`);
      assert.ok(elapsed < 3000, `必须被 longPollWaitMs=1000 钳死（实测 ${elapsed}ms，否则会被 Nginx 掐断）`);
    });
  } finally {
    harness.cleanup();
  }
});

test('AC-L1 ⭐ 长轮询期间任务进来 ⇒ **立刻**返回（这是"降级也不用等"的根）', async () => {
  const harness = buildHarness({ longPollWaitMs: 25000 });
  try {
    await withServer(harness.app, async (base) => {
      const startedAt = Date.now();
      const pending = device(base, '/jobs/next', { method: 'POST', body: { waitMs: 25000 } });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      await phone(base, '/jobs', { method: 'POST', body: { mode: 'single', number: NUMBER } });
      const body = await (await pending).json();
      const elapsed = Date.now() - startedAt;
      assert.ok(body.job, '挂在长轮询上的请求必须拿到这条任务');
      assert.ok(elapsed < 2000, `任务一入队就要返回（实测 ${elapsed}ms，远小于 25000）`);
    });
  } finally {
    harness.cleanup();
  }
});
