'use strict';

/**
 * ⭐⭐ 2026-10-15（#597 · task-24）**SSE 断线清理窗口**的验收用例（AC-SSE1…SSE4）。
 *
 * 改的是 `src/routes/labelPrintDevice.js` 的 `/stream`：断开监听（`req/res.on('close'|'error')`）
 *   **必须挂在所有 `await` 之前**（改前挂在 `await listPending()` 之后 ⇒ 那个窗口里断开**没人听** ⇒
 *   订阅残留，要等下一次事件/心跳才摘）。
 *
 * 判据（每条都尽量**能真红**）：
 *  · **AC-SSE1** 在 "`hello` 已发、`subscribe()` 还没做" 这个窗口里断开 ⇒
 *      **立刻**观察到断开（`label_print.stream.disconnected`）+ 那次慢读回来后 **绝不订阅**、订阅数恒为 0。
 *      🔴 改前：会照旧 `subscribe()`（订阅数 1）且**永远没人摘** ⇒ 本条红。
 *  · **AC-SSE2** 正常连上 ⇒ 恰 1 个订阅者；断开 ⇒ 摘掉（与既有 `AC-R3` 同一语义，逐字不变）。
 *  · **AC-SSE3** 事件推送与心跳照旧。
 *  · **AC-SSE4** 源码哨兵：SSE 端点全仓只有一处；`req.on('close')` 早于该端点里**任何** `await`；
 *      且"断开过就不订阅"那道闸在 `subscribe()` 之前（同形状排查结论也钉在这里）。
 *
 * ⚠️ 外部世界全是替身：`listPending` 由用例控制何时 resolve（把窗口变成**确定性**的）；
 *    跑的是**真的** `createLabelPrintDeviceRouter` + 真的 SSE 写法。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sse_close_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sse_close_test_secret';

const { createLabelPrintDeviceRouter } = require('../src/routes/labelPrintDevice');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');

const SRC_DIR = path.join(__dirname, '..', 'src');
const DEVICE_TOKEN = 'sse-close-window-token';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 轮询等一个条件（默认 1.5s）——"立即被摘"也用同一个口径量（只是更快满足）。 */
const waitFor = async (predicate, timeoutMs = 1500) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
  return predicate();
};

/**
 * 假队列：`listPending` **由用例决定什么时候 resolve**（= 把"hello 与 subscribe 之间"那个窗口拉长成确定性）。
 * 订阅语义照真实现（`subscribers` 是 Set，`subscriberCount()` 就是它的 size）。
 */
const createFakeQueue = () => {
  const listeners = new Set();
  let pendingResolve = null;
  const state = { subscribeCalls: 0, unsubscribeCalls: 0, heartbeatCalls: 0, listPendingCalls: 0 };
  return {
    state,
    subscriberCount: () => listeners.size,
    listPending: () => {
      state.listPendingCalls += 1;
      return new Promise((resolve) => { pendingResolve = resolve; });
    },
    /** 让那次"慢读"回来（窗口关闭）。 */
    resolvePending: (jobs = []) => { const resolve = pendingResolve; pendingResolve = null; if (resolve) resolve(jobs); },
    subscribe: (listener) => {
      state.subscribeCalls += 1;
      listeners.add(listener);
      return () => { if (listeners.delete(listener)) state.unsubscribeCalls += 1; };
    },
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    heartbeat: () => { state.heartbeatCalls += 1; },
    status: async () => ({ online: true, last_seen_at: new Date().toISOString(), counts: {} }),
  };
};

const buildApp = (queue) => {
  const app = express();
  app.use(express.json());
  app.use('/api/label-print', createLabelPrintDeviceRouter({
    service: queue,
    config: {
      ...LABEL_PRINT_QUEUE,
      device: { ...LABEL_PRINT_QUEUE.device, token: DEVICE_TOKEN },
      ssePingMs: 60_000, // 心跳远远来不了 ⇒ 断言只可能被"断线清理"满足（不是被 ping 顺带满足）
    },
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 开一条 SSE 长连接（`abort()` = 客户端断开，与真机"小助手被杀掉"同形）。 */
const openSse = async (base) => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/label-print/stream`, {
    headers: { 'x-label-print-token': DEVICE_TOKEN },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = [];
  let ended = false;
  let text = '';
  const pump = (async () => {
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (;;) {
          const index = text.indexOf('\n\n');
          if (index < 0) break;
          const raw = text.slice(0, index);
          text = text.slice(index + 2);
          const event = { event: 'message', data: '', json: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event.event = line.slice(6).trim();
            else if (line.startsWith('data:')) event.data += line.slice(5).trim();
          }
          if (event.data) { try { event.json = JSON.parse(event.data); } catch { event.json = null; } }
          if (waiters.length) waiters.shift()(event);
          else queue.push(event);
        }
      }
    } catch {
      // abort / 服务端关掉 —— 正常收尾。
    } finally {
      ended = true;
      while (waiters.length) waiters.shift()(null);
    }
  })();
  pump.catch(() => undefined);
  return {
    response,
    abort: () => controller.abort(),
    next: (timeoutMs = 3000) => new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      if (ended) return resolve(null);
      const timer = setTimeout(() => reject(new Error(`等 SSE 事件超时（${timeoutMs}ms）`)), timeoutMs);
      return waiters.push((event) => { clearTimeout(timer); resolve(event); });
    }),
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-SSE1：窗口内断开 ⇒ 立即摘（且绝不订阅）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SSE1 ⭐⭐ 断开发生在 hello 与 subscribe 之间 ⇒ **立刻**观察到断开 ＋ 那次慢读回来后**绝不订阅**', async () => {
  const queue = createFakeQueue();
  await withServer(buildApp(queue), async (base) => {
    // 就地抓 info 日志（不用外部赋值 ⇒ 避免 TDZ）：`utils/logger` 的 info 就是 `console.log`。
    const entries = [];
    const original = console.log;
    console.log = (line) => { entries.push(String(line)); };
    try {
      const sse = await openSse(base);
      const hello = await sse.next(2000);
      assert.equal(hello && hello.event, 'hello', '第1步：先收到 hello（= 已经进到那个窗口里）');
      // 窗口判据：此刻订阅**还没做**（hello 之后才 await 那次慢读，subscribe 更在后面）
      assert.equal(queue.state.subscribeCalls, 0, '第2步：此刻还没 subscribe（窗口成立）');
      assert.equal(queue.subscriberCount(), 0);
      assert.equal(queue.state.listPendingCalls, 1, '第2步：确实停在那次 await 上');

      sse.abort(); // 客户端断开（真机：小助手被杀 / 网络断）
      // ⭐ 只等事件循环，**不 emit、不等心跳**（心跳配置成 60s ⇒ 只可能被"断线清理"满足）
      const observed = await waitFor(
        () => entries.some((line) => line.includes('label_print.stream.disconnected')), 1000,
      );
      assert.equal(observed, true, '第3步：断开要被**立刻**观察到（不能等到下一次事件/心跳）');

      // 那次慢读现在才回来（改前：它回来之后会照旧 subscribe；改后：closed ⇒ 直接收工）
      queue.resolvePending([]);
      await sleep(50);
    } finally { console.log = original; }

    assert.ok(entries.some((line) => line.includes('label_print.stream.disconnected')),
      '断开必须落一条 `label_print.stream.disconnected`（这是"立刻观察到"的证据）');
    assert.equal(queue.state.subscribeCalls, 0, '🔴 断开过 ⇒ **绝不许订阅**（否则那一个订阅永远没人摘）');
    assert.equal(queue.subscriberCount(), 0, '🔴 窗口内断开 ⇒ 订阅数恒为 0（不残留）');
    assert.equal(queue.state.unsubscribeCalls, 0, '没订阅过 ⇒ 不该有 unsubscribe 调用（语义干净）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SSE2：正常路径逐字不变（连上=1，断开=摘掉）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SSE2 ⭐ 正常连上 ⇒ 恰 1 个订阅者；正常断开 ⇒ 摘掉（与既有 AC-R3 语义逐字相同）', async () => {
  const queue = createFakeQueue();
  await withServer(buildApp(queue), async (base) => {
    const sse = await openSse(base);
    const hello = await sse.next(2000);
    assert.equal(hello.event, 'hello');
    queue.resolvePending([]);
    const backlog = await sse.next(2000);
    assert.equal(backlog.event, 'backlog', 'backlog 照旧发得出去');
    assert.equal(queue.state.subscribeCalls, 1, '正常连上 ⇒ 恰订阅一次');
    assert.equal(queue.subscriberCount(), 1, '正常连上 ⇒ subscriberCount() === 1（语义不变）');

    sse.abort();
    const gone = await waitFor(() => queue.subscriberCount() === 0, 1500);
    assert.equal(gone, true, '断开后必须摘掉订阅者');
    assert.equal(queue.state.unsubscribeCalls, 1, '摘一次');
    assert.equal(queue.subscriberCount(), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SSE3：事件推送 / 心跳照旧
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SSE3 ⭐ 事件推送与心跳照旧：emit ⇒ 客户端收到；订阅计数语义不变', async () => {
  const queue = createFakeQueue();
  await withServer(buildApp(queue), async (base) => {
    const sse = await openSse(base);
    await sse.next(2000); // hello
    queue.resolvePending([]);
    await sse.next(2000); // backlog
    assert.ok(queue.state.heartbeatCalls >= 1, '连上时那条心跳照旧发（中间件 + 端点各一次）');

    queue.emit({ type: 'job', payload: { job_id: 'job_1', status: 'queued' } });
    const pushed = await sse.next(2000);
    assert.equal(pushed.event, 'job', '事件照旧推得出去');
    assert.equal(pushed.json.job_id, 'job_1');
    assert.equal(queue.subscriberCount(), 1, '推一条事件不影响订阅计数语义');

    sse.abort();
    assert.equal(await waitFor(() => queue.subscriberCount() === 0, 1500), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SSE4：源码哨兵 + 同形状排查结论
// ═══════════════════════════════════════════════════════════════════════════

const walk = (dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

/** 去掉注释再找代码 token（否则注释里提到的 `await` 会把"第一个 await"的位置算错）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('AC-SSE4 ⭐ 同形状排查：全仓只有这一个 SSE 端点；且它的 close 监听早于**任何** await、断开闸在 subscribe 之前', () => {
  // ① 全仓只有一处 SSE（`text/event-stream`）⇒ "别的长连接端点也先 await 再挂 close" 这种形状**不存在**
  const sseFiles = walk(SRC_DIR)
    .filter((full) => fs.readFileSync(full, 'utf8').includes('text/event-stream'))
    .map((full) => path.relative(SRC_DIR, full));
  assert.deepEqual(sseFiles, [path.join('routes', 'labelPrintDevice.js')],
    `SSE 端点只许这一处（实际：${JSON.stringify(sseFiles)}）—— 多出来就必须重新做一遍"先 await 再挂 close"的排查`);

  // ② `on('close'` 在 src/ 下的全部落点（清单化；新出现的长连接收尾要过这一眼）
  const closeFiles = walk(SRC_DIR)
    .filter((full) => /\.on\('(close|error)'/.test(fs.readFileSync(full, 'utf8')))
    .map((full) => path.relative(SRC_DIR, full));
  assert.deepEqual(closeFiles, [path.join('routes', 'labelPrintDevice.js')],
    `close/error 断线收尾只许在这一处（实际：${JSON.stringify(closeFiles)}）`);

  // ③ 那一个端点里：`req.on('close', cleanup)` 必须早于**该端点内任何** await
  const source = stripComments(fs.readFileSync(path.join(SRC_DIR, 'routes', 'labelPrintDevice.js'), 'utf8'));
  const streamAt = source.indexOf("router.get('/stream'");
  assert.ok(streamAt > 0, '没有 /stream 端点？');
  const nextRouteAt = source.indexOf('router.get(', streamAt + 10);
  const handler = source.slice(streamAt, nextRouteAt > 0 ? nextRouteAt : undefined);
  const closeAt = handler.indexOf("req.on('close', cleanup)");
  const firstAwaitAt = handler.search(/\bawait\b/);
  assert.ok(closeAt > 0, '必须显式挂 `req.on(\'close\', cleanup)`');
  assert.ok(firstAwaitAt > 0, '端点里应当有 await（否则这条哨兵失去意义）');
  assert.ok(closeAt < firstAwaitAt,
    '🔴 `req.on(\'close\', cleanup)` 必须在**所有 await 之前**（#597：窗口内断开也要立刻摘订阅）');

  // ④ "断开过就不订阅"那道闸必须在 `subscribe()` 之前
  const guardAt = handler.indexOf('if (closed) return');
  const subscribeAt = handler.indexOf('.subscribe(');
  assert.ok(guardAt > 0, '必须有 `if (closed) return`（断开过 ⇒ 不订阅）');
  assert.ok(subscribeAt > 0, '必须还照旧 subscribe');
  assert.ok(guardAt < subscribeAt, '🔴 "断开过就不订阅"必须挡在 subscribe 之前');
});
