'use strict';

/**
 * ⭐ 2026-10-15（task-25 · #600）**诊断脚本**：`larkEventHeartbeat.test.js` 那条偶发
 *   `SyntaxError: Unexpected end of JSON input`（= `response.json()` 读到**空 body**）到底从哪来。
 *
 * ⚠️ 与 `test/stabilityRepro.cjs` 同一约定：**默认什么都不做**（`node --test` 会把 `test/**` 下的文件
 *    当测试加载）；手动跑：`EMPTY_BODY_DIAG=1 node test/larkHeartbeatEmptyBodyRepro.cjs [每档轮数]`
 *
 * 三件事：
 *  ① **失败模式映射（能真红）**：故意造一个"**先发响应头、再干净 FIN、body 一个字节都不发**"的服务器
 *     ⇒ 看客户端是不是恰好报 `SyntaxError: Unexpected end of JSON input`（而不是 ECONNRESET）。
 *  ② **形状压测**：完全照被测用例的形状（每个用例一个 `listen(0)` 临时服务器、**一发** `fetch`+`.json()`、
 *     收尾 `close()`），跑 N 轮，看**空 body 会不会出现**；顺带对照 `keepAliveTimeout` 三档
 *     （`1`（现役） / 默认 5000 / 0）与"收尾要不要 `closeAllConnections()`"。
 *  ③ **端口复用压力**：把"上一个服务器的端口"强制复用给下一个服务器（task-16 那套），
 *     看这一形态会不会**变成空 body**（而不是 ECONNRESET）。
 *
 * 🔴 只读诊断：不写任何业务表、不碰业务代码。
 */
if (process.env.EMPTY_BODY_DIAG !== '1') {
  module.exports = {};
  return;
}

/* eslint-disable no-console */
// keep-alive-exempt: 本诊断脚本要**对照** `keepAliveTimeout` 三档（1 / 默认 / 0）才能证明
//   "空 body 与 keepAliveTimeout 无关" ⇒ 不能一律设成 1（task-25 · #600）。
const http = require('node:http');
const express = require('express');
const { execSync } = require('node:child_process');

/** 失败那一刻：这个端口上到底是谁在听（best-effort）。 */
const listenersOn = (port) => {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: 'utf8' }).trim() || '<lsof 没输出>';
  } catch (error) {
    return `<lsof 跑不动：${error.message}>`;
  }
};

const ITERATIONS = Number(process.argv[2] || 2000);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let SRV_SEQ = 0;
const buildHealthApp = (srvId, log) => {
  const app = express();
  app.use((req, res, next) => { res.setHeader('x-srv', srvId); log.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/lark/events/health', (_req, res) => {
    res.json({ success: true, mode: 'p2p+group', hasData: false, status: 'ok', staleMinutes: 180 });
  });
  return app;
};

const closeServer = async (server, { closeAll = false } = {}) => {
  if (closeAll && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

/** ① 失败模式映射：先发头、再**干净 FIN**、body 一字节都不发。 */
const headerThenCleanFin = async () => {
  const app = express();
  app.get('/x', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    // 干净地结束这条连接（FIN），一个 body 字节都没写。
    res.socket.end();
    res.socket.destroy();
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/x`);
    try {
      return { status: response.status, error: null, body: await response.json() };
    } catch (error) {
      return { status: response.status, error: `${error?.name}: ${error?.message}` };
    }
  } catch (error) {
    return { status: null, error: `fetch 就炸了：${error?.name}: ${error?.message}` };
  } finally {
    await closeServer(server, { closeAll: true });
  }
};

/** ② 形状压测：照用例形状（每轮一个新服务器、一发 GET+json、收尾 close）。 */
const oneRound = async ({ keepAliveTimeoutMs, closeAll, forcePort = 0, previousPort = 0 }) => {
  const srvId = `srv_${SRV_SEQ += 1}`;
  const log = [];
  const server = await new Promise((resolve) => { const s = buildHealthApp(srvId, log).listen(forcePort, () => resolve(s)); });
  if (keepAliveTimeoutMs !== null) server.keepAliveTimeout = keepAliveTimeoutMs;
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/lark/events/health`);
    const clone = response.clone();
    try {
      const body = await response.json();
      return { ok: body && body.success === true, port, error: null, previousPort, reusedPort: port === previousPort };
    } catch (error) {
      const raw = await clone.text().catch(() => '<text() 也炸了>');
      // ⭐ 失败那一刻：这个端口上还有谁在听？再打一次野路径看是谁在回话。
      const probe = await fetch(`http://127.0.0.1:${port}/__probe_${Date.now()}__`)
        .then(async (r) => ({ status: r.status, xSrv: r.headers.get('x-srv'), poweredBy: r.headers.get('x-powered-by'), server: r.headers.get('server'), body: (await r.text()).slice(0, 120) }))
        .catch((error) => ({ error: `${error?.name}: ${error?.message}` }));
      return {
        probe,
        lsof: listenersOn(port),
        ok: false,
        port,
        previousPort,
        reusedPort: port === previousPort,
        status: response.status,
        transferEncoding: response.headers.get('transfer-encoding'),
        contentLength: response.headers.get('content-length'),
        bodyUsed: response.bodyUsed,
        srvId: response.headers.get('x-srv') || '<无 x-srv 头！>',
        url: response.url,
        serverRequests: log.slice(),
        serverGotRequest: log.length > 0,
        error: `${error?.name}: ${error?.message}`,
        raw,
      };
    }
  } catch (error) {
    return { ok: false, port, previousPort, reusedPort: port === previousPort, error: `fetch: ${error?.name}: ${error?.message}` };
  } finally {
    await closeServer(server, { closeAll });
  }
};

const scenario = async (label, options, forcePortReuse = false) => {
  let failures = 0;
  let emptyBodies = 0;
  const shapes = new Map();
  const details = [];
  let lastPort = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await oneRound({ ...options, forcePort: forcePortReuse ? lastPort : 0, previousPort: lastPort });
    lastPort = result.port;
    if (!result.ok) {
      failures += 1;
      const shape = String(result.error || 'ok=false 但没抛错');
      shapes.set(shape, (shapes.get(shape) || 0) + 1);
      if (shape.includes('Unexpected end of JSON input')) emptyBodies += 1;
      if (details.length < 4) details.push(result);
    }
  }
  console.log(`\n【${label}】失败 ${failures}/${ITERATIONS}（空 body ${emptyBodies}）`);
  for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${count}×  ${shape}`);
  }
  for (const detail of details) {
    console.log(`    ── 现场: port=${detail.port} previousPort=${detail.previousPort} reusedPort=${detail.reusedPort}`
      + ` status=${detail.status} te=${detail.transferEncoding} cl=${detail.contentLength} raw=${JSON.stringify(detail.raw)}`
      + `\n        响应 x-srv=${detail.srvId} url=${detail.url}`
      + `\n        这一轮服务器收到的请求=${JSON.stringify(detail.serverRequests)} error=${detail.error}`
      + `\n        失败后立刻再打一次野路径 ⇒ ${JSON.stringify(detail.probe)}`
      + `\n        那一刻这个端口上在听的：${JSON.stringify(detail.lsof)}`);
  }
  return { failures, emptyBodies };
};

/**
 * ④ 确定性演示（照真机现场：macOS 上 `Electron/DoubaoWor` 等**桌面应用**占着 `127.0.0.1:P`，
 *    而测试服务器用**通配地址** `listen(P)`（Node 的 `listen(0)` 默认就是 `::` 通配）——两者能共存，
 *    于是客户端打 `127.0.0.1:P` 时**内核把连接交给了那个更具体的** `127.0.0.1` **监听者** ⇒
 *    拿到别人应用的 404 + 空 body ⇒ `response.json()` 抛 `Unexpected end of JSON input`）。
 */
const deterministicDemo = async () => {
  // 1) 先要一个"空闲端口"P（绑 127.0.0.1:0 拿到再关掉）
  const probe = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => resolve(s)); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  // 2) "别人的应用"：占住 127.0.0.1:P，回 404 + **空 body**（与观测到的现场一致）
  const foreignApp = express();
  foreignApp.use((_req, res) => { res.status(404).end(); });
  const foreign = await new Promise((resolve) => { const s = foreignApp.listen(port, '127.0.0.1', () => resolve(s)); });

  const tryFetch = async (url) => {
    try {
      const response = await fetch(url);
      const text = await response.text();
      return `status=${response.status} x-srv=${response.headers.get('x-srv') || '<无>'} body=${JSON.stringify(text)}`;
    } catch (error) {
      return `抛错 ${error?.name}: ${error?.message}`;
    }
  };

  try {
    // 3) 改前姿势：**通配地址**绑同一个 P（与"别人的应用"共存）—— 请求会被交给谁？
    let wildcard = null;
    try {
      wildcard = await new Promise((resolve) => { const s = buildHealthApp('wildcard', []).listen(port, () => resolve(s)); });
    } catch (error) {
      console.log(`    ⚠️ 本机不允许"通配 P + 127.0.0.1:P"共存（${error.code || error.message}）⇒ 该隐患在本机不存在`);
    }
    if (wildcard) {
      console.log(`    改前（listen(${port}) 通配）⇒ ${await tryFetch(`http://127.0.0.1:${port}/api/lark/events/health`)}`);
      await closeServer(wildcard, { closeAll: true });
    }

    // 4) 改后姿势：绑 **127.0.0.1**（与客户端同一个地址）⇒ 内核不会再把它交给别人
    const loopback = await new Promise((resolve) => { const s = buildHealthApp('loopback', []).listen(0, '127.0.0.1', () => resolve(s)); });
    const loopPort = loopback.address().port;
    console.log(`    改后（listen(0, '127.0.0.1') ⇒ 端口 ${loopPort}，别人的应用仍占着 ${port}）`
      + ` ⇒ ${await tryFetch(`http://127.0.0.1:${loopPort}/api/lark/events/health`)}`);
    await closeServer(loopback, { closeAll: true });
  } finally {
    await closeServer(foreign, { closeAll: true });
  }
};

const main = async () => {
  console.log(`每档 ${ITERATIONS} 轮\n`);
  console.log('① 失败模式映射：先发响应头 + 干净 FIN + 零 body ⇒ 客户端报什么？');
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    console.log(`   ${JSON.stringify(await headerThenCleanFin())}`);
  }

  console.log('\n② 形状压测（每个用例一个 listen(0) 服务器 · 一发 fetch+json · 收尾 close()）');
  await scenario('keepAliveTimeout=1（现役）+ 只 close()', { keepAliveTimeoutMs: 1, closeAll: false });
  await scenario('keepAliveTimeout=1（现役）+ closeAllConnections()', { keepAliveTimeoutMs: 1, closeAll: true });
  await scenario('keepAliveTimeout=默认(5000) + 只 close()', { keepAliveTimeoutMs: null, closeAll: false });
  await scenario('keepAliveTimeout=0（不关空闲）+ 只 close()', { keepAliveTimeoutMs: 0, closeAll: false });

  console.log('\n③ 端口复用压力（强制把上一个端口给下一个服务器；task-16 那套）');
  await scenario('keepAliveTimeout=1 + 端口复用', { keepAliveTimeoutMs: 1, closeAll: false }, true);
  await scenario('keepAliveTimeout=默认 + 端口复用', { keepAliveTimeoutMs: null, closeAll: false }, true);
  console.log('\n④ 确定性演示：别人的应用占住 127.0.0.1:P 时，"通配绑 P" 与 "绑 127.0.0.1" 的差别');
  await deterministicDemo();
  console.log('\n（若②③ 全 0 失败、而① 恰好复现 `Unexpected end of JSON input`，'
    + '说明"空 body"只可能来自**传输层**：响应头到了、body 被干净地截断 —— 不是路由逻辑）');
};

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
