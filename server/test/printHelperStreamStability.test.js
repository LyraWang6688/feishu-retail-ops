/**
 * ⭐⭐ 两个真机 bug（她贴的 Windows 日志）—— 验收标准（**先写后做**）。
 *
 * ① 防睡眠**从来没成功过**（她的原始报错，逐字）：
 *    `无法将 SetThreadExecutionState 的参数 esFlags（值为 -2147483647）转换为 System.UInt32`
 *    根因：`ES_CONTINUOUS | ES_SYSTEM_REQUIRED` = `0x80000001` = **2147483649**，
 *    在 PowerShell/C# 里这个位模式被当成 **Int32** ⇒ **-2147483647** ⇒ 塞进 `uint` 参数 ⇒ 转换失败。
 *    ⇒ 修法：**实参位置显式 `[uint32]` 转换**（并用十进制正数常量，避免位模式再次变成负数）。
 *
 * ② 长连接**每 1~2 秒就断一次再连**（她与服务端两侧都看到）：
 *    `connected → disconnected(failures:1, reason:"This operation was aborted") → connected → …`
 *    ⚠️ `This operation was aborted` **只可能来自我们自己的 `AbortController.abort()`**
 *    （服务端 `res.end()` 会是"长连接被服务器/网络关掉了"，socket 断了会是 `terminated`/`fetch failed`）。
 *    ⇒ 修法：**自愿重连统一走一个入口** + ① 刚连上 N 秒内**不许自发重连**（防"1 秒一断"风暴）
 *      ② **单飞**（同一时刻只许一条长连接，不再产生孤儿连接）③ 每次 abort **点明是谁要求的**（下次一眼看出）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AC
 *   AC-A1 命令里**实参位置**有显式 `[uint32]`（`SetThreadExecutionState([uint32]…)`），且**没有**负数字面量。
 *   AC-A2 常量仍是 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`，**不含** `ES_DISPLAY_REQUIRED`（屏幕仍可关）。
 *   AC-A3 把这条真机报错**写进源码注释**（0x80000001 在 Int32 下是负数 ⇒ 必须显式转 uint）。
 *   AC-A4 调不通 ⇒ 只记 warn、状态如实、不影响打印（回归）。
 *   AC-B1 ⭐ **单飞**：同一时刻连 5 次 ⇒ 只发 **1** 个流请求（不再有孤儿连接）。
 *   AC-B2 ⭐ **空闲 60 秒不出连接/断开循环**（假时钟 60 秒，只连 1 次、0 次断开）。
 *   AC-B3 ⭐ 刚连上就要求重连 ⇒ **被挡**（不 abort）；**手动点「重新连接」仍然有效**（force）。
 *   AC-B4 真·唤醒（时钟跳 60 秒）⇒ 仍然**立刻重连**，且只重连一次（不回归）。
 *   AC-B5 断线后重连仍按**退避**（不回归）。
 *   AC-B6 有任务 ⇒ 长连接上**立刻收到**并打成纸（不回归）。
 *   AC-B7 每次自愿 abort 都要在日志里**点明是谁要求的**（下次一眼定位）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const helper = require('../../print-helper/helper.js');
const HELPER_SOURCE = fs.readFileSync(path.join(__dirname, '../../print-helper/helper.js'), 'utf8');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'print-helper-stream-'));

const noopLogger = (bag = []) => ({
  info: (event, data) => bag.push(['info', event, data]),
  warn: (event, data) => bag.push(['warn', event, data]),
  error: (event, data) => bag.push(['error', event, data]),
});

const baseConfig = (patch = {}) => ({
  ...helper.DEFAULT_CONFIG,
  serverBaseUrl: 'https://example.test',
  deviceToken: 'tok',
  printer: { ...helper.DEFAULT_CONFIG.printer, mode: 'command', command: 'echo', args: ['{file}'] },
  ...patch,
});

/**
 * 一个**不会自己结束**的假 SSE 流（可手动推帧）。
 * `calls` 记每次 `/stream` 请求；`aborted` 记被我们 abort 掉的次数。
 */
const fakeStreamServer = () => {
  const state = { streamCalls: 0, aborted: 0, controllers: [], push: null, failStream: false, job: null, ack: false };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    if (pathname === '/api/label-print/stream') {
      state.streamCalls += 1;
      if (state.failStream) throw new Error('fetch failed');
      let controllerRef = null;
      const body = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          state.controllers.push(controller);
          state.push = (event, data) => controller.enqueue(
            new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        },
        cancel() { /* 客户端 abort ⇒ 这里被调 */ },
      });
      init.signal?.addEventListener('abort', () => {
        state.aborted += 1;
        try { controllerRef?.error(new Error('This operation was aborted')); } catch { /* 已关 */ }
      });
      return { ok: true, status: 200, headers: { get: () => null }, body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (pathname === '/api/label-print/pending') return json({ success: true, jobs: [], online: true });
    if (pathname === '/api/label-print/jobs/next') {
      const job = state.job;
      if (!job) return json({ success: true, job: null });
      state.job = null;
      return json({ success: true, job });
    }
    if (/\/artifact$/.test(pathname)) {
      const bytes = Buffer.from('%PDF-1.4 fake');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'x-label-print-sha256' ? undefined : null) },
        json: async () => ({}),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    if (/\/ack$/.test(pathname)) {
      state.ack = true;
      return json({ success: true, online: true });
    }
    return json({ success: true, online: true });
  };
  return { state, fetchImpl };
};

/** 造一个 helper：**不自动连**（用例自己控制），时钟可注入。 */
const makeHelper = (overrides = {}) => {
  const dir = tmpDir();
  const logs = [];
  const clock = { value: 1_000_000 };
  const instance = helper.createPrintHelper({
    config: baseConfig({
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'd'),
      wakeWatchMs: 1000, // ⚠️ 实现里有 1000ms 下限 —— 用例按"最少次数"跑
      ...(overrides.config || {}),
    }),
    fetch: overrides.fetch,
    print: async () => {},
    logger: overrides.logger || noopLogger(logs),
    validateOptions: { exists: () => true, checkPaths: false },
    runPowerShell: async () => ({ code: 0, stderr: '' }),
    now: overrides.now || (() => clock.value),
    startLocalPage: false,
    connectStream: false,
    openUrl: () => true,
  });
  return {
    instance, logs, dir, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ═══════════════════════════════════════════════════════════════════════════
// ① 防睡眠：参数类型（她真机报错的那一条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A1 ⭐ 实参位置显式转 uint32，且命令里没有负数字面量（她真机就是这么断的）', () => {
  const enable = helper.buildAntiSleepCommand();
  const release = helper.buildAntiSleepReleaseCommand();

  assert.match(enable, /SetThreadExecutionState\(\[uint32\]/,
    `开启命令必须在**实参位置**显式转 uint32（PowerShell 才知道要 UInt32）：${enable}`);
  assert.match(release, /SetThreadExecutionState\(\[uint32\]/,
    `释放命令同理：${release}`);

  // ⚠️ 根因：0x80000001 的位模式在 Int32 下是 **-2147483647** ⇒ 当初就是这么把 uint 参数喂炸的
  for (const [label, command] of [['开启', enable], ['释放', release]]) {
    assert.equal(/-2147483647/.test(command), false, `${label}命令里不许出现负数字面量（-2147483647）`);
  }

  // ⭐ 把"值"算一遍（把根因写成可执行的断言）：2147483648 + 1 = 2147483649 > Int32 上限 ⇒ 必须 uint
  const continuous = Number(/ES_CONTINUOUS=(\d+)/.exec(enable)?.[1]);
  const required = Number(/ES_SYSTEM_REQUIRED=(\d+)/.exec(enable)?.[1]);
  assert.equal(continuous, 2147483648, 'ES_CONTINUOUS = 0x80000000 = 2147483648');
  assert.equal(required, 1, 'ES_SYSTEM_REQUIRED = 0x00000001 = 1');
  assert.equal(continuous + required, 2147483649, '合起来 = 0x80000001 = 2147483649（Int32 装不下）');
  assert.ok(continuous + required > 2147483647, '超出 Int32 正数上限 ⇒ 这正是必须显式转 uint32 的原因');
  assert.ok(continuous + required <= 4294967295, 'UInt32 装得下');
  // 十进制正数常量（不用 `0x…`：位模式在 Int32 下会变负数 —— 真机报错就是它）
  assert.equal(/0x8000/ .test(enable), false, '不要再用 0x80000000 这种会变负数的字面量');
});

test('AC-A2 常量仍是 连续 | 系统必需，**不含** 显示必需（屏幕仍然可以关）', () => {
  const enable = helper.buildAntiSleepCommand();
  assert.match(enable, /ES_CONTINUOUS/);
  assert.match(enable, /ES_SYSTEM_REQUIRED/);
  assert.equal(enable.includes('ES_DISPLAY_REQUIRED'), false, '不许顺手拦关屏');
  const release = helper.buildAntiSleepReleaseCommand();
  assert.match(release, /ES_CONTINUOUS/);
  assert.equal(release.includes('ES_SYSTEM_REQUIRED'), false, '释放就是"恢复默认电源行为"');
});

test('AC-A3 那条真机报错写进源码注释（免得以后又踩）', () => {
  assert.match(HELPER_SOURCE, /-2147483647/, '注释里要有真机报错里的那个值');
  assert.match(HELPER_SOURCE, /System\.UInt32/, '注释里要提到 UInt32');
  assert.match(HELPER_SOURCE, /Int32/, '注释要讲清"位模式在 Int32 下是负数"');
});

test('AC-A4 调不通 ⇒ 只记 warn、状态如实、不影响打印（回归）', async () => {
  const logs = [];
  const h = makeHelper({ logger: noopLogger(logs), fetch: fakeStreamServer().fetchImpl });
  try {
    await h.instance.start();
    // 让防睡眠失败一次（注入假 runner）
    const antiSleep = helper.createAntiSleep({
      runPowerShell: async () => ({ code: 1, stderr: '无法将值 -2147483647 转换为 System.UInt32' }),
      logger: noopLogger(logs),
      enabled: true,
    });
    assert.equal(await antiSleep.enable(), false, '失败返回 false（不抛）');
    assert.equal(antiSleep.isOn(), false);
    const warn = logs.find((entry) => entry[1] === 'print_helper.anti_sleep.unavailable');
    assert.ok(warn, '要有一条 warn');
    assert.equal(logs.some((entry) => entry[0] === 'error'), false, '不许升级成 error');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-A5 防抖/看门狗的配置也要"一行人话"地校验（不让坏配置再造出抖/连风暴）', () => {
  const check = (patch) => helper.validateConfig(
    baseConfig(patch), { exists: () => true, checkPaths: false },
  );
  assert.equal(check({}).ok, true, '默认配置必须合法');
  assert.equal(check({ wakeWatchMs: 1000, wakeGapMs: 15000, streamMinLifetimeMs: 5000 }).ok, true, '正常值放行');

  const tooSmallGap = check({ wakeWatchMs: 5000, wakeGapMs: 1000 });
  assert.equal(tooSmallGap.ok, false, '唤醒阈值比看门狗节拍还小 ⇒ 必然抖 ⇒ 必须拦住');
  const error = tooSmallGap.errors.find((item) => item.field === 'wakeGapMs');
  assert.ok(error, '要指到 wakeGapMs');
  assert.equal(error.message.includes('\n'), false, '一行人话');

  assert.equal(check({ wakeWatchMs: 0 }).ok, false, '看门狗节拍不能是 0');
  assert.equal(check({ streamMinLifetimeMs: -1 }).ok, false, '防抖窗口不能是负数');
  for (const bad of [check({ wakeWatchMs: 'abc' }), check({ streamMinLifetimeMs: 'x' })]) {
    assert.equal(bad.ok, false, '非数字也要拦');
    for (const item of bad.errors) assert.ok(item.message.length <= 60 && !item.message.includes('\n'), '一行、别太长');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 长连接：单飞 / 不抖 / 仍能立刻收到 / 退避不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B1 ⭐ 单飞：同时连 5 次 ⇒ 只发 1 个流请求（不再产生孤儿连接）', async () => {
  const server = fakeStreamServer();
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    for (let index = 0; index < 5; index += 1) void h.instance.connectStream();
    await tick(30);
    assert.equal(server.state.streamCalls, 1, `同一时刻只许一条长连接（实际 ${server.state.streamCalls}）`);
    assert.ok(h.logs.some((entry) => entry[1] === 'print_helper.sse.connect_skipped'), '重复的连接请求要记一条 skip');
    assert.equal(server.state.aborted, 0, '没有谁被 abort ⇒ 服务端不会看到 1 秒一断');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-B2 ⭐ 空闲 60 秒（假时钟）⇒ 只连 1 次、0 次断开（不出现 1~2 秒的断/连循环）', async () => {
  const server = fakeStreamServer();
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    void h.instance.connectStream();
    await tick(30);
    assert.equal(h.instance.state.sseConnected, true, '先确认真的连上了');

    // 假时钟：每 1 秒真实时间推进 10 秒（模拟空闲；每步 < wakeGapMs=15 秒 ⇒ 不该判定为"刚被唤醒"）
    for (let step = 0; step < 7; step += 1) {
      h.clock.value += 10_000;
      await tick(1100); // 让 1 秒的看门狗真的跑一拍
    }
    const simulatedMs = h.clock.value - 1_000_000;
    assert.ok(simulatedMs >= 60_000, `模拟了 ${simulatedMs / 1000} 秒空闲（要 ≥60 秒）`);
    assert.equal(server.state.streamCalls, 1, `空闲期间不该重连（实际 ${server.state.streamCalls} 次）`);
    assert.equal(server.state.aborted, 0, '空闲期间不该 abort（这就是"1 秒一断"的根源）');
    assert.equal(h.logs.filter((entry) => entry[1] === 'print_helper.sse.disconnected').length, 0, '不该有断开');
    assert.equal(h.instance.state.sseConnected, true, '60 秒后仍然是连着的');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-B3 ⭐ 刚连上就要求重连 ⇒ 被挡（不抖动）；**手动点「重新连接」仍然有效**', async () => {
  const server = fakeStreamServer();
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    void h.instance.connectStream();
    await tick(30);
    assert.equal(h.instance.state.sseConnected, true);

    // 刚连上（假时钟没走）⇒ 自发重连要被闸门挡住
    await h.instance.reconnectNow('wake');
    await tick(20);
    assert.equal(server.state.aborted, 0, '刚连上不许 abort（防"1 秒一断"风暴）');
    assert.ok(h.logs.some((entry) => entry[1] === 'print_helper.sse.reconnect_skipped'), '要记一条"先不抖"');
    assert.equal(server.state.streamCalls, 1, '没有重连');

    // ⭐ 但她是**主动**点的（force）⇒ 必须照做（不然"重新连接"这个按钮就废了）
    await h.instance.reconnectNow('manual', { force: true });
    await tick(30);
    assert.equal(server.state.aborted, 1, '手动重连要真的断开重连');
    assert.equal(server.state.streamCalls, 2, '并且要重新连上');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-B4 真·唤醒（时钟跳 60 秒）⇒ 仍然立刻重连，且只重连一次（不回归）', async () => {
  const server = fakeStreamServer();
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    void h.instance.connectStream();
    await tick(30);
    // 连上之后正常过 6 秒（**超过 5 秒防抖闸门、但小于 15 秒唤醒阈值** ⇒ 这一拍是"正常"的）
    h.clock.value += 6_000;
    await tick(1100); // 看门狗一拍（正常）
    assert.equal(server.state.aborted, 0, '正常流逝不该被当成唤醒（6 秒 < 15 秒阈值）');
    // 现在时钟再跳 60 秒 = 电脑睡了一觉回来
    h.clock.value += 60_000;
    await tick(1100); // 看门狗这一拍发现时钟跳变 ⇒ 立刻重连
    assert.ok(h.logs.some((entry) => entry[1] === 'print_helper.wake.detected'), '要认出"刚被唤醒"');
    assert.equal(server.state.aborted, 1, '唤醒后要断开重连（一次）');
    assert.equal(server.state.streamCalls, 2, '并且立刻重连（不等退避）');

    await tick(1100);
    assert.equal(server.state.aborted, 1, '只重连一次，不许反复抖');
    assert.equal(server.state.streamCalls, 2);
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-B5 断线后重连仍按退避（不回归）', async () => {
  const server = fakeStreamServer();
  server.state.failStream = true;
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    void h.instance.connectStream();
    await tick(80);
    const afterFirst = server.state.streamCalls;
    assert.ok(afterFirst >= 1, '第一次尝试要发生');
    // ⚠️ 退避表 `[500, 1000, …]` 用**失败次数**当下标：第 1 次失败后取的是第 2 档 = **1000ms**
    //    （既有行为，本批**没有改**）⇒ 100ms 内绝不该有第二次，1150ms 后应该正好来第二次。
    assert.equal(afterFirst, 1, `第一次失败后要等退避（100ms 内不该重试，实际 ${afterFirst} 次）`);
    await tick(1150);
    assert.equal(server.state.streamCalls, 2, '到退避档（1000ms）之后才重试');
    assert.ok(h.instance.state.streamFailures >= 1, '失败次数要如实记着');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC-B6 有任务 ⇒ 长连接上立刻收到并打成纸（不回归）', async () => {
  const server = fakeStreamServer();
  server.state.job = { job_id: 'job-1', status: 'claimed', numbers: ['XHB8095|棕色|A'], total_labels: 1 };
  const printed = [];
  const dir = tmpDir();
  const h = makeHelper({ fetch: server.fetchImpl, config: {} });
  try {
    await h.instance.stop(); // 把上面那个 helper 先停掉（只借用它的 fetch）
    const instance = helper.createPrintHelper({
      config: baseConfig({
        stateFile: path.join(dir, 'state.json'),
        downloadDir: path.join(dir, 'd'),
      }),
      fetch: server.fetchImpl,
      print: async (file) => { printed.push(file); },
      logger: noopLogger(h.logs),
      validateOptions: { exists: () => true, checkPaths: false },
      runPowerShell: async () => ({ code: 0 }),
      startLocalPage: false,
      connectStream: false,
      openUrl: () => true,
    });
    await instance.start();
    void instance.connectStream();
    await tick(30);
    assert.equal(instance.state.sseConnected, true, '先连上');
    server.state.push('job', { job_id: 'job-1' }); // ⭐ 长连接上推一条
    await tick(200);
    assert.equal(printed.length, 1, '长连接上收到任务 ⇒ 立刻打成纸');
    assert.equal(server.state.ack, true, '并且回了执');
    await instance.stop();
  } finally {
    h.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-B7 每次自愿 abort 都要点明「谁要求的」（下次一眼定位）', async () => {
  const server = fakeStreamServer();
  const h = makeHelper({ fetch: server.fetchImpl });
  try {
    await h.instance.start();
    void h.instance.connectStream();
    await tick(30);
    h.clock.value += 30_000;
    await h.instance.reconnectNow('wake');
    await tick(30);
    const requested = h.logs.find((entry) => entry[1] === 'print_helper.sse.reconnect_requested');
    assert.ok(requested, '要有 print_helper.sse.reconnect_requested');
    assert.equal(requested[2]?.why, 'wake', '要写清是"唤醒"要求的');
    const disconnected = h.logs.find((entry) => entry[1] === 'print_helper.sse.disconnected');
    assert.equal(disconnected?.[2]?.aborted_by, 'wake', '断开那条日志也要带上一句"谁断的"');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});
