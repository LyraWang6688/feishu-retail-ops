'use strict';

/**
 * ⭐⭐ 2026-10-15（task-16 · T-3）**测试稳定性复现脚本** ——
 *   「测试用内置 `fetch` 打自己起的临时服务器，偶发 `TypeError: fetch failed` /
 *     `cause: read ECONNRESET`」的**最小复现 + 候选修法对照 + 修法生效证据**。
 *
 * ⚠️ **默认什么都不做**（下面的 env 闸门）：`node --test`（= `pnpm test` / CI）会把
 *    `test/**` 下的**所有** `.js/.cjs` 当成测试文件加载（实测过 ✓），所以这里必须"没开闸门就秒退"，
 *    否则每次 CI 都会多跑一分钟的场景。
 *    手动跑：`STABILITY_REPRO=1 node test/stabilityRepro.cjs [每档轮数，默认 60]`
 *
 * ## 机制（三段都必要，缺一不可 —— 这就是"什么条件下会 ECONNRESET"）
 *   ① **客户端**：Node 内置 `fetch`（undici）有**进程级全局 keep-alive 连接池**，按 origin
 *      （`host:port`）池化；响应读完，这条 socket 仍留在池子里（默认 `keepAliveTimeout` 4s）。
 *   ② **服务端**：既有 `withServer` 每开一个用例就 `app.listen(0)` 起**临时服务器**，收尾
 *      `server.close()`（有的再加 `closeAllConnections()`）⇒ 客户端那条池化 socket 此刻**已经死了**。
 *   ③ **端口复用**：临时端口由操作系统分配；**同一进程内后面的服务器可能拿到同一个端口**
 *      ⇒ origin **逐字相同** ⇒ 下一次 `fetch` 去池子里挑到那条**死 socket** ⇒ 写到它上面
 *      ⇒ 新服务器不认识这个连接 ⇒ 内核回 **RST** ⇒ `read ECONNRESET`（**不是**断言错）。
 *   ⭐ 实测（下面 A 段）：响应读完到收尾之间**只要有 ≥1ms 的空闲**，这三段一齐时**必然复现**
 *      （100%）；idle=0（同一个 tick 里立刻收尾）才躲得过。真实用例里这两步之间有一堆断言/别的
 *      请求 ⇒ 永远有 ≥1ms 的空闲 ⇒ **只差"端口被复用"这一件**（所以线上是"偶发"而不是"必现"）。
 *
 * ## 本脚本做什么
 *   A. **机制窗口**：idle = 0 / 1 / 20ms（同一档收尾、同一端口复用）⇒ 失败率
 *   B. **候选修法对照**（跨服务器 · 强制端口复用 · idle=20ms）
 *   C. **修法副作用**（同一服务器内两次请求、中间空闲 0/1/2/5/20ms）
 *   D. **修法生效的直接证据**：响应后 20ms，服务器上还剩几条连接
 *   ⇒ 每档都打印**失败率 + 错误形状**（`UND_ERR_SOCKET` / `ECONNRESET` 各几条）✓
 *
 * 🔴 只读诊断：不写任何业务表、不碰任何业务代码。
 */
if (process.env.STABILITY_REPRO !== '1') {
  // 被 `node --test` 当成测试文件加载时：直接退出（不定义任何用例、不跑场景）✓
  module.exports = {};
  return;
}

/* eslint-disable no-await-in-loop, no-console */
const express = require('express');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const ITERATIONS = Number(process.argv[2] || 60);

/** 起一个测试服务器：`mode` = 候选修法。`port` 固定 = 主动制造"端口复用"。 */
const makeServer = async (mode, port = 0) => {
  const app = express();
  if (mode === 'serverHeader') {
    // 修法 B：服务器侧**每个响应都关连接**（`Connection: close`）
    app.use((_req, res, next) => { res.setHeader('Connection', 'close'); next(); });
  }
  app.get('/ping', (_req, res) => { res.end('pong'); });
  const server = await new Promise((resolve) => { const s = app.listen(port, () => resolve(s)); });
  if (mode === 'keepAlive1') {
    // 修法 A（本次落地的那一条）：测试服务器**不保持 keep-alive 空闲连接**
    server.keepAliveTimeout = 1;
  }
  return server;
};

const closeServer = async (server, { closeAll = false } = {}) => {
  if (closeAll && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

const requestOptions = (clientMode) => (clientMode === 'connectionClose'
  ? { headers: { connection: 'close' } } : undefined);

const shapeOf = (error) => `${error?.name || 'Error'}: ${error?.message || error}`
  + ` / cause=${error?.cause?.code || error?.cause?.message || ''}`;

/** A / B 段用：跨服务器（**强制复用同一端口**）*/
const crossServerRound = async ({ serverMode, clientMode, closeAll = false, idleMs = 20 }) => {
  const first = await makeServer(serverMode);
  const port = first.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const options = requestOptions(clientMode);
  const one = await fetch(`${origin}/ping`, options);
  await one.text();
  if (idleMs) await sleep(idleMs);
  await closeServer(first, { closeAll });
  const second = await makeServer(serverMode, port);   // ← 端口复用：origin 逐字相同
  try {
    const two = await fetch(`${origin}/ping`, options); // ← 命中死 socket 就炸
    await two.text();
    return null;
  } catch (error) {
    return shapeOf(error);
  } finally {
    await closeServer(second, { closeAll: true });
  }
};

/** C 段用：同一服务器内的连续两次请求（中间空闲 gap） */
const intraServerRound = async ({ serverMode, clientMode, gapMs = 0 }) => {
  const server = await makeServer(serverMode);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = requestOptions(clientMode);
  try {
    const one = await fetch(`${origin}/ping`, options);
    await one.text();
    if (gapMs) await sleep(gapMs);
    const two = await fetch(`${origin}/ping`, options);
    await two.text();
    return null;
  } catch (error) {
    return shapeOf(error);
  } finally {
    await closeServer(server, { closeAll: true });
  }
};

const run = async (round, options) => {
  let failures = 0;
  const shapes = new Map();
  for (let index = 0; index < ITERATIONS; index += 1) {
    const failure = await round({ ...options });
    if (failure) {
      failures += 1;
      shapes.set(failure, (shapes.get(failure) || 0) + 1);
    }
  }
  return { failures, shapes };
};

const report = (label, { failures, shapes }) => {
  console.log(`  ${String(failures).padStart(3)}/${ITERATIONS}  ${label}`);
  for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    console.log(`         ${count}× ${shape}`);
  }
};

/** D 段：修法生效的**直接证据** —— 响应读完 20ms 后，服务器上还剩几条连接。 */
const connectionCountAfterResponse = async (mode) => {
  const server = await makeServer(mode);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/ping`);
    await response.text();
    await sleep(20);
    return await new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
  } finally {
    await closeServer(server, { closeAll: true });
  }
};

const main = async () => {
  console.log(`每档 ${ITERATIONS} 轮\n`);
  console.log('A. 机制窗口：idle（响应读完 → 收尾之间的空闲）× 同一端口复用 · 只 server.close()');
  for (const idleMs of [0, 1, 20]) {
    report(`idle=${idleMs}ms`, await run(crossServerRound, { idleMs }));
  }

  console.log('\nB. 候选修法对照（跨服务器 · 强制端口复用 · idle=20ms）');
  const candidates = [
    ['① 基线：只 server.close()', { serverMode: 'plain', clientMode: 'plain' }],
    ['② 只加 closeAllConnections()（labelPrint 现有收尾）', { serverMode: 'plain', clientMode: 'plain', closeAll: true }],
    ['③ 修法 A：server.keepAliveTimeout = 1（本次落地）', { serverMode: 'keepAlive1', clientMode: 'plain' }],
    ['④ 修法 B：服务器侧每个响应 Connection: close', { serverMode: 'serverHeader', clientMode: 'plain' }],
    ['⑤ 修法 C：客户端每次请求 connection: close', { serverMode: 'plain', clientMode: 'connectionClose' }],
  ];
  for (const [label, options] of candidates) {
    report(label, await run(crossServerRound, options));
  }

  console.log('\nC. 修法副作用：同一服务器内两次请求（中间空闲 gap）');
  for (const gapMs of [0, 1, 5, 20]) {
    console.log(`  gap=${gapMs}ms`);
    for (const [label, options] of candidates) {
      report(label, await run(intraServerRound, { ...options, gapMs }));
    }
  }

  console.log('\nD. 修法生效的直接证据：响应读完 20ms 后，服务器上还剩几条连接');
  for (const mode of ['plain', 'keepAlive1']) {
    console.log(`  ${mode}: ${await connectionCountAfterResponse(mode)} 条`);
  }

  console.log('\nE. 落地核验：两个出过问题的用例文件里，那一行是否真的在（= 本次修法已落地）');
  const fs = require('node:fs');
  const path = require('node:path');
  let landed = 0;
  for (const relative of ['test/scanSalePaymentStepPay.test.js', 'test/labelPrintQueueRoutes.test.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    const helper = source.slice(source.indexOf('const withServer'), source.indexOf('const withServer') + 800);
    const ok = helper.includes('server.keepAliveTimeout = 1;');
    if (ok) landed += 1;
    console.log(`  ${ok ? '✔' : '✘'} ${relative}`);
  }
  console.log(`  ⇒ ${landed}/2 已落地（0/2 = 回到"修前"，B 段那 40/40 就会真的落在用例上）`);
};

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
