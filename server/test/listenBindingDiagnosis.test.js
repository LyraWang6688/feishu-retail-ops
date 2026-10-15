/**
 * ⭐⭐ 2026-10-15（task-29 · AC-LB2）：**确定性演示**「绑回环」为什么能治那个"空 body/404 玄学"。
 *
 * 🔴 背景（#600/#608 已确证，本文件只是把它**确定性地**演一遍，不靠概率 ✓）：
 *   · `app.listen(0, cb)` ⇒ Node 默认绑**通配地址**（`TCP *:PORT`）
 *   · 本机桌面应用（现场：豆包 `Electron … TCP 127.0.0.1:61150`）可能占着**同一个端口的 127.0.0.1**
 *   · 两者**能共存**（地址范围不同：`*:P` vs `127.0.0.1:P`）⇒ 内核按"**更具体优先**"把
 *     `127.0.0.1:P` 上的连接交给**别人的应用** ⇒ 我们收到**别人的 404 + 空 body**
 *     （铁证：失败响应**没有**我们的头；本用例服务器收到请求数 **0**）
 *
 * 本用例钉三件**确定性**的事（每一步都不依赖"端口恰好被分配到她那个"这种运气 ✓）：
 *   ① 她应用占着 `127.0.0.1:P` 时，客户端打 `127.0.0.1:P` 拿到的**就是她的** 404 + 空 body ✓
 *   ② 我们**显式绑回环到 P** ⇒ **当场 `EADDRINUSE`**（**大声失败**，绝不静默拿到别人的响应 ✓）
 *   ③ 我们用 `listen(0, '127.0.0.1')` 起的服务器 ⇒ 拿到的是**我们自己的 200 + 我们自己的头** ✓
 *      （而通配绑定 `listen(0)` 才可能被分到 P ⇒ 这正是要改掉的那一行 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const listen = (server, ...args) => new Promise((resolve, reject) => {
  // ⚠️ 本仓规矩（#589/#594）：**凡起临时服务器的用例文件**都要
  //   `keepAliveTimeout = 1`（池里不留死 socket ⇒ 不会偶发 ECONNRESET）——
  //   由 `test/testServerKeepAliveSentinel.test.js` 的 AC-P1 哨兵钉着 ✓ 本文件照办 ✓
  server.keepAliveTimeout = 1;
  server.once('error', reject);
  server.listen(...args, () => resolve(server));
});
const close = (server) => new Promise((resolve) => { server.close(() => resolve()); });
const addressOf = (server) => server.address().port;

test('AC-LB2 ⭐ 确定性演示：她应用占着 127.0.0.1:P ⇒ 我们的用例服务器**要么大声失败、要么绑到别的口**（绝不静默吃她的 404）', async () => {
  // ① 假"别人的应用"：占住 127.0.0.1:P，任何路径都回 **404 + 空 body**（复刻现场形状）
  const foreign = http.createServer((request, response) => { response.statusCode = 404; response.end(''); });
  await listen(foreign, 0, '127.0.0.1');
  const port = addressOf(foreign);
  try {
    const theirs = await fetch(`http://127.0.0.1:${port}/api/workbench/sales/orders`);
    assert.equal(theirs.status, 404, '打到她占的那个口 ⇒ 拿到**她的** 404 ✓（这就是那次的现象）');
    assert.equal(await theirs.text(), '', '而且是**空 body** ✓（正是 `Unexpected json input` 的来源）');
    assert.equal(theirs.headers.get('x-srv'), null, '🔴 铁证之一：**没有我们的头** ✓');

    // ② 我们**显式绑回环到同一个口** ⇒ 内核直接拒绝（**大声失败**）⇒ 不可能出现"我们以为在测自己"✗
    const clash = http.createServer(() => {});
    await assert.rejects(() => listen(clash, port, '127.0.0.1'), /EADDRINUSE/,
      '绑回环到已被占用的口 ⇒ 当场 EADDRINUSE ✓（这就是"修好之后"的行为：要么报错、要么换口）');
    clash.close();

    // ③ 我们用**回环 + 端口 0**起自己的服务器 ⇒ 拿到的一定是**我们自己的** 200
    const ours = http.createServer((request, response) => {
      response.setHeader('x-srv', 'ours');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true }));
    });
    await listen(ours, 0, '127.0.0.1');
    try {
      const mine = await fetch(`http://127.0.0.1:${addressOf(ours)}/api/workbench/sales/orders`);
      assert.equal(mine.status, 200, '我们自己的口 ⇒ 200 ✓');
      assert.equal(mine.headers.get('x-srv'), 'ours', '带的是**我们的**头 ✓（与 ① 的"没有头"正好成对）');
      assert.deepEqual(await mine.json(), { success: true });
      // 顺带钉住**地址族**：回环绑定必须只出现在 127.0.0.1 上（不是 `*` / `::`）
      assert.equal(ours.address().address, '127.0.0.1', '显式绑回环 ⇒ 地址就是 127.0.0.1 ✓');
    } finally { await close(ours); }
  } finally { await close(foreign); }
});

test('AC-LB2b ⭐ 对照：**通配绑定**拿到的地址**不是**回环（这就是要改掉的那一行 ✗）', async () => {
  const wildcard = http.createServer(() => {});
  await listen(wildcard, 0);
  try {
    const address = wildcard.address();
    assert.notEqual(address.address, '127.0.0.1',
      '通配绑定 ⇒ 地址是 `::`/`0.0.0.0`（**不是**回环）⇒ 才可能与"占着 127.0.0.1:P 的她应用"共存 ✗');
    assert.ok(address.family === 'IPv6' || address.address === '0.0.0.0', `实际地址族：${address.family}`);
  } finally { await close(wildcard); }
});
