'use strict';

/**
 * ⭐ 2026-10-15（task-17 顺带诊断）：`AC-R3`（SSE 断开后摘订阅者 / 订阅计数）那次偶发
 *   `subscriberCount() 0 !== 1` 到底是哪一类。
 *
 * 两种候选机制（本脚本只判第 ① 种能不能成立）：
 *   ① **"订阅还没注册就先断言"**：SSE 处理器把 `hello`/`backlog` 写出去**早于** `subscribe()`
 *      （`routes/labelPrintDevice.js:131/138` 写事件，`:141` 才 subscribe）⇒ 如果客户端能在这中间
 *      跑起来，`subscriberCount()` 就会是 0。
 *   ② **连接早断**：请求是打在一个"被复用 origin"的池化 socket 上、被 RST（= task-16 那类）⇒
 *      客户端可能已经收到 hello/backlog，而服务端 `res.on('close')` 走到 `cleanup()` 把订阅**摘掉**
 *      ⇒ 客户端手里有 2 条事件、服务端计数却是 0。
 *
 * 本脚本把 `listPending`（就是那唯一的 `await`）**人为拖慢**，然后：
 *   · 收到 `hello` 之后立刻读一次 `subscriberCount()`  → 期望 **0**（证明窗口①存在）
 *   · 收到 `backlog` 之后再读一次                        → 期望 **1**（证明①**不足以**造成那次红：
 *     单线程里 `sendEvent(backlog)` 与 `subscribe()` 之间没有 await ⇒ 客户端不可能在两者之间插进来）
 *
 * ⚠️ 同 `stabilityRepro.cjs`：**默认什么都不做**（`node --test` 会把 `test/**` 下的文件当测试加载），
 *    手动跑：`SSE_ORDER_DIAG=1 node test/sseSubscriberOrderDiag.cjs`
 */
if (process.env.SSE_ORDER_DIAG !== '1') {
  module.exports = {};
  return;
}

/* eslint-disable no-console */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_diag';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'diag_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'sse_order_diag_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createLabelPrintQueueRouter } = require('../src/routes/labelPrintQueue');
const { createLabelPrintDeviceRouter } = require('../src/routes/labelPrintDevice');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');

const DEVICE_TOKEN = 'diag-device-token';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const main = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-order-diag-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  // ⭐ 把 `listPending` 依赖的那一次读**拖慢**（放大窗口①）—— 真实里这是一次文件系统读。
  const rawListClaimable = store.listClaimable.bind(store);
  let delayMs = 0;
  store.listClaimable = async (...args) => {
    if (delayMs) await sleep(delayMs);
    return rawListClaimable(...args);
  };
  const service = createLabelPrintQueueService({
    store,
    labelPrint: { listLabels: async () => ({ labels: [], total_matched: 0, total_returned: 0 }) },
    config: { ...LABEL_PRINT_QUEUE, storeDir: dir, device: { ...LABEL_PRINT_QUEUE.device, token: DEVICE_TOKEN } },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/workbench/label-print', createLabelPrintQueueRouter({ service }));
  app.use('/api/label-print', createLabelPrintDeviceRouter({ service, config: { ...LABEL_PRINT_QUEUE, device: { ...LABEL_PRINT_QUEUE.device, token: DEVICE_TOKEN } } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;

  // 记录 subscribe 被调用的时刻（相对"客户端收到 hello"的时间轴）。
  const subscribedAt = [];
  const rawSubscribe = service.subscribe.bind(service);
  service.subscribe = (listener) => {
    subscribedAt.push(Date.now());
    return rawSubscribe(listener);
  };

  try {
    // 读数轮：delay 0 / 50ms（拖慢那次 await，放大窗口①）
    for (const delay of [0, 50]) {
      delayMs = delay;
      subscribedAt.length = 0;
      const response = await fetch(`${base}/api/label-print/stream`, {
        headers: { 'x-label-print-token': DEVICE_TOKEN },
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let text = '';
      const readEvent = async () => {
        for (;;) {
          const index = text.indexOf('\n\n');
          if (index >= 0) {
            const raw = text.slice(0, index);
            text = text.slice(index + 2);
            const name = (raw.match(/^event:\s*(.*)$/m) || [])[1] || '';
            if (name) return { name, at: Date.now() };
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done) return null;
          text += decoder.decode(chunk.value, { stream: true });
        }
      };
      const hello = await readEvent();
      const countAfterHello = service.subscriberCount();
      const backlog = await readEvent();
      const countAfterBacklog = service.subscriberCount();
      events.push(hello, backlog);
      console.log(`\n轮次 delay=${delay}ms`);
      console.log(`  收到 hello=${hello && hello.name}  ⇒ subscriberCount=${countAfterHello}`);
      console.log(`  收到 backlog=${backlog && backlog.name} ⇒ subscriberCount=${countAfterBacklog}`);
      console.log(`  subscribe() 调用时刻相对 hello：${subscribedAt.length ? `${subscribedAt[0] - hello.at}ms（hello 之后）` : '尚未调用'}`);
      console.log(`  backlog 是否比 subscribe 早到客户端：${backlog && subscribedAt.length && backlog.at < subscribedAt[0] ? '是（窗口①成立 ⇒ 断言会读到 0）' : '否（窗口①不成立）'}`);
      reader.cancel().catch(() => undefined);
    }
    console.log('\n结论：若两轮都打印"否"，则 AC-R3 那次 0 不是"订阅还没注册"这类，'
      + '而是"连接早断 ⇒ 服务端 cleanup() 把订阅摘掉"（= task-16 同一族：池化 socket × 端口复用）。');
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
