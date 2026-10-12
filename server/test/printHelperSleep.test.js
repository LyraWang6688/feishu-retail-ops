/**
 * ⭐⭐ 「打印小助手」防睡眠 + 断线自愈 + 逐字操作说明 —— 验收标准（业务负责人 2026-10-12，**先写后做**）。
 *
 * 她的真机问题（逐字）：
 *   「小助手会断线是因为我的电脑锁屏了吗？」
 *   「是否能做个迭代，让**小助手在开启时能保持后台运行**，这样我**就不用让电脑一直亮屏**了？」
 * Lead 查到的日志：今天 16:54:26 / 16:54:46 / 16:55:44 三次 disconnected，**17:09:53 才 connected**
 *   （空了约 15 分钟）⇒ 疑似电脑【睡眠/休眠】（**锁屏本身不会断**）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC-S1 防睡眠命令**逐字正确**：含 `ES_CONTINUOUS` + `ES_SYSTEM_REQUIRED`，
 *          **不含** `ES_DISPLAY_REQUIRED`（**只防睡眠、不拦关屏**）；释放命令只回 `ES_CONTINUOUS`。
 *   AC-S2 `createAntiSleep`：开机调一次 enable、退出调一次 release，状态如实（开 / 关）。
 *   AC-S3 ⭐ **调不通只记一条日志**：不抛、不当成致命错误（父母那台机器不许因为"防不住睡眠"就打印不了）。
 *   AC-S4 `start()` ⇒ 真的调过防睡眠（假 runner 收到命令）；状态页上有一行「防睡眠：开」。
 *   AC-S5 `stop()` ⇒ 释放（`ES_CONTINUOUS`）。
 *   AC-S6 ⭐ **防睡眠失败不影响打印**（回归）：runner 一直失败，照样能把一条排队任务打成纸。
 *   AC-S7 ⭐ **断线自愈不等满退避**：唤醒 / 网络恢复（时钟跳变）⇒ **立刻重连**；
 *          正常断线仍走退避；日志里能看到「断线已 N 分钟」。
 *   AC-S8 `README.md` 里她要看的那几句话**逐字在**（锁屏不断 / 睡眠才断 / 睡眠=从不 /
 *          屏幕可以关 / 合盖 / 手动点睡眠仍会断 / 怎么确认防睡眠=开 / 开机自启）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const helper = require('../../print-helper/helper.js');
const README = fs.readFileSync(path.join(__dirname, '../../print-helper/README.md'), 'utf8');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'print-helper-sleep-'));

const baseConfig = (patch = {}) => ({
  ...helper.DEFAULT_CONFIG,
  serverBaseUrl: 'https://example.test',
  deviceToken: 'tok',
  printer: { ...helper.DEFAULT_CONFIG.printer },
  ...patch,
});

/** 假 PowerShell：记下每一条命令，按脚本回答（默认成功）。 */
const fakeRunner = (result = { code: 0, stderr: '' }) => {
  const commands = [];
  const runner = async (command) => {
    commands.push(String(command));
    return typeof result === 'function' ? result(command) : result;
  };
  runner.commands = commands;
  return runner;
};

const noopLogger = (bag = []) => ({
  info: (event, data) => bag.push(['info', event, data]),
  warn: (event, data) => bag.push(['warn', event, data]),
  error: (event, data) => bag.push(['error', event, data]),
});

/** 一个"够用"的假服务器：pending / next / artifact / ack / heartbeat / status。 */
const fakeServer = (job) => {
  const calls = [];
  const artifact = Buffer.from('%PDF-1.4 fake label');
  const sha = crypto.createHash('sha256').update(artifact).digest('hex');
  let claimed = false;
  const fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ method: init.method || 'GET', pathname });
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      headers: { get: (name) => (name === 'x-label-print-sha256' ? sha : null) },
      json: async () => body,
      arrayBuffer: async () => artifact.buffer.slice(artifact.byteOffset, artifact.byteOffset + artifact.byteLength),
    });
    if (pathname === '/api/label-print/pending') return json({ success: true, jobs: [], online: true });
    if (pathname === '/api/label-print/jobs/next') {
      if (claimed || !job) return json({ success: true, job: null });
      claimed = true;
      return json({ success: true, job: { ...job } });
    }
    if (/\/artifact$/.test(pathname)) return json({});
    if (/\/ack$/.test(pathname) || pathname === '/api/label-print/heartbeat' || pathname === '/api/label-print/status') {
      return json({ success: true, online: true });
    }
    return json({ success: true });
  };
  fetch.calls = calls;
  return fetch;
};

const makeHelper = (overrides = {}) => {
  const dir = tmpDir();
  const job = overrides.job === undefined
    ? { job_id: 'job-1', status: 'claimed', numbers: ['XHB8095|棕色|A'], total_labels: 1 }
    : overrides.job;
  const fetch = overrides.fetch || fakeServer(job);
  const printed = [];
  const logs = []; // ⚠️ 传进 logger 的是这个**数组**（`noopLogger(bag)` 只回 logger 对象）
  const logger = overrides.logger || noopLogger(logs);
  const instance = helper.createPrintHelper({
    config: baseConfig({
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      ...(overrides.config || {}),
    }),
    fetch,
    print: async (file) => { printed.push(file); },
    logger,
    validateOptions: { exists: () => true, checkPaths: false },
    runPowerShell: overrides.runPowerShell || fakeRunner(),
    now: overrides.now,
    startLocalPage: false,
    connectStream: false,
  });
  return { instance, fetch, printed, logs, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-S1 命令逐字（只防睡眠，不拦关屏）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S1 防睡眠命令含 ES_CONTINUOUS + ES_SYSTEM_REQUIRED，**不含** ES_DISPLAY_REQUIRED', () => {
  const enable = helper.buildAntiSleepCommand();
  assert.ok(enable.includes('ES_CONTINUOUS'), '必须带 ES_CONTINUOUS（常驻，不然一会儿就失效）');
  assert.ok(enable.includes('ES_SYSTEM_REQUIRED'), '必须带 ES_SYSTEM_REQUIRED（防睡眠）');
  assert.equal(enable.includes('ES_DISPLAY_REQUIRED'), false,
    '**不许带** ES_DISPLAY_REQUIRED —— 她只要求"不用一直亮屏"，屏幕该关就关');
  assert.ok(enable.includes('SetThreadExecutionState'), '就是调 SetThreadExecutionState');

  const release = helper.buildAntiSleepReleaseCommand();
  assert.ok(release.includes('SetThreadExecutionState'), '释放也是它');
  assert.ok(release.includes('ES_CONTINUOUS'), '释放 = 只留 ES_CONTINUOUS（恢复系统默认电源行为）');
  assert.equal(release.includes('ES_SYSTEM_REQUIRED'), false, '释放里不许再要 ES_SYSTEM_REQUIRED');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S2 / AC-S3 createAntiSleep：调一次 / 调不通只记日志
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S2 enable 调一次防睡眠、release 调一次释放，状态如实', async () => {
  const runner = fakeRunner({ code: 0, stderr: '' });
  const antiSleep = helper.createAntiSleep({ runPowerShell: runner, logger: noopLogger() });
  assert.equal(antiSleep.isOn(), false, '一开始是关的');

  const enabled = await antiSleep.enable();
  assert.equal(enabled, true, 'enable 成功');
  assert.equal(antiSleep.isOn(), true);
  assert.equal(runner.commands.length, 1, '只调一次');
  assert.equal(runner.commands[0], helper.buildAntiSleepCommand(), '命令逐字 = buildAntiSleepCommand()');

  await antiSleep.release();
  assert.equal(antiSleep.isOn(), false, '释放之后回到"关"');
  assert.equal(runner.commands.length, 2);
  assert.equal(runner.commands[1], helper.buildAntiSleepReleaseCommand());
});

test('AC-S3 调不通 ⇒ 只记一条 warn、不抛、状态保持"关"', async () => {
  const logs = [];
  const antiSleep = helper.createAntiSleep({
    runPowerShell: fakeRunner({ code: -1, stderr: 'powershell: command not found' }),
    logger: noopLogger(logs),
  });
  assert.equal(await antiSleep.enable(), false, 'enable 如实返回 false（不假装成功）');
  assert.equal(antiSleep.isOn(), false);
  const warned = logs.find((entry) => entry[1] === 'print_helper.anti_sleep.unavailable');
  assert.ok(warned, '要有一条 print_helper.anti_sleep.unavailable 日志');
  assert.equal(logs.some((entry) => entry[0] === 'error'), false, '不许记成 error（这不是致命问题）');
  // 抛异常也算"调不通"，同样不往外抛
  const throwing = helper.createAntiSleep({
    runPowerShell: async () => { throw new Error('spawn powershell ENOENT'); },
    logger: noopLogger(logs),
  });
  assert.equal(await throwing.enable(), false);
  await throwing.release(); // 没开过 ⇒ 不该调 runner，也不该抛
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S4 / AC-S5 start / stop 接线 + 状态页那一行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S4 start() 真的调过防睡眠；状态页有一行「防睡眠：开」', async () => {
  const runner = fakeRunner({ code: 0, stderr: '' });
  const { instance, logs, cleanup } = makeHelper({ runPowerShell: runner });
  try {
    await instance.start();
    const enableCalls = runner.commands.filter((command) => command.includes('ES_SYSTEM_REQUIRED'));
    assert.equal(enableCalls.length, 1, 'start() 里防睡眠只调一次');
    assert.equal(enableCalls[0].includes('ES_DISPLAY_REQUIRED'), false, '不许顺手拦关屏');
    assert.equal(instance.state.antiSleepEnabled, true, '状态如实写进 state');
    const html = await instance.localPageHtml();
    assert.ok(html.includes('防睡眠'), '状态页要有「防睡眠」这一行');
    assert.match(html, /防睡眠[\s\S]{0,120}?开/, '显示「开」');
    assert.ok(logs.some((entry) => entry[1] === 'print_helper.anti_sleep.enabled'), '日志里记一条"已开启"');
  } finally {
    await instance.stop();
    cleanup();
  }
});

test('AC-S5 stop() ⇒ 释放（ES_CONTINUOUS）', async () => {
  const runner = fakeRunner({ code: 0, stderr: '' });
  const { instance, cleanup } = makeHelper({ runPowerShell: runner });
  try {
    await instance.start();
    await instance.stop();
    const releaseCalls = runner.commands.filter((command) => command.includes('SetThreadExecutionState') && !command.includes('ES_SYSTEM_REQUIRED'));
    assert.equal(releaseCalls.length, 1, '退出时释放一次');
    assert.equal(instance.state.antiSleepEnabled, false, '释放后状态回到关');
  } finally {
    cleanup();
  }
});

test('AC-S4b 配置可以关掉它（显式布尔 preventSleep=false ⇒ 一条都不调）', async () => {
  const runner = fakeRunner({ code: 0, stderr: '' });
  const { instance, cleanup } = makeHelper({ runPowerShell: runner, config: { preventSleep: false } });
  try {
    await instance.start();
    assert.equal(runner.commands.length, 0, '关掉之后不调防睡眠');
    assert.equal(instance.state.antiSleepEnabled, false);
  } finally {
    await instance.stop();
    cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S6 防睡眠失败 ⇒ 打印照常（回归）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S6 防睡眠一直失败（powershell 调不通）⇒ 任务照样打成纸、回执照发', async () => {
  const runner = fakeRunner({ code: -1, stderr: 'powershell: command not found' });
  const { instance, printed, logs, fetch, cleanup } = makeHelper({ runPowerShell: runner });
  try {
    await instance.start();
    await instance.drain();
    assert.equal(printed.length, 1, '打印**真的发生了**（防睡眠失败与打印无关）');
    // ⚠️ 这里钉**可观测的后果**（打成纸 + 回执照发），不钉 drain() 的返回值形状
    //    （那个形状由既有 `printHelper.test.js` 的 AC-H9 端到端用例钉着，本用例不重复）。
    assert.ok(fetch.calls.some((call) => /\/ack$/.test(call.pathname)), '回执照发了');
    assert.ok(!logs.some((entry) => entry[0] === 'error'), '防睡眠失败不许升级成 error');
    assert.ok(logs.some((entry) => entry[1] === 'print_helper.anti_sleep.unavailable'), '失败只留一条 warn');
  } finally {
    await instance.stop();
    cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S7 断线自愈：唤醒/网络恢复 ⇒ 立刻重连，不等满退避
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S7 唤醒（时钟跳变）⇒ 重连延迟 0；普通断线仍按退避（封顶 3 秒）', () => {
  const backoffMs = [500, 1000, 1000, 2000, 3000];

  // 正常断线：按失败次数走退避
  assert.equal(helper.reconnectDelayMs({ streamFailures: 0, backoffMs }), 500);
  assert.equal(helper.reconnectDelayMs({ streamFailures: 4, backoffMs }), 3000, '用到最后一档就一直按最后一档');
  assert.equal(helper.reconnectDelayMs({ streamFailures: 99, backoffMs }), 3000, '不会超过退避上限');

  // 唤醒 / 网络恢复：**立刻**重连（不等满退避）
  assert.equal(helper.reconnectDelayMs({ streamFailures: 4, backoffMs, wakeGap: true }), 0,
    '唤醒之后立刻重连 —— 这正是她"空了 15 分钟"的那一下');

  // 「是不是刚被唤醒」= 时钟跳变（假时钟）
  assert.equal(helper.wakeGapDetected(1_000_000, 1_000_000 + 4_999, 5_000), false, '小抖动不算唤醒');
  assert.equal(helper.wakeGapDetected(1_000_000, 1_000_000 + 5_000, 5_000), true, '跳变 ≥ 阈值 ⇒ 判定为刚被唤醒');
  assert.equal(helper.wakeGapDetected(1_000_000, 1_000_000 + 15 * 60 * 1000, 5_000), true,
    '15 分钟的睡眠一定判得出来');
  assert.equal(helper.wakeGapDetected(undefined, Date.now(), 5_000), false, '不知道上次什么时候 ⇒ 不猜');

  // 日志里能看出"断了多久"
  assert.equal(helper.formatDisconnectedFor(15 * 60 * 1000 + 33_000), '断线已 15 分钟');
  assert.equal(helper.formatDisconnectedFor(45_000), '断线已 1 分钟');
  assert.equal(helper.formatDisconnectedFor(3_000), '断线已 1 分钟', '不足 1 分钟也算 1 分钟（不写 0.05 分钟）');
});

test('AC-S7b state 里能看到"上一次活动时间"与"断线起始时间"（接线）', async () => {
  const { instance, cleanup } = makeHelper({});
  try {
    await instance.start();
    assert.equal(typeof instance.state.lastTickAt, 'number', 'state.lastTickAt 要有（唤醒判据靠它）');
    assert.ok(instance.state.lastTickAt > 0);
  } finally {
    await instance.stop();
    cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S8 README：她要看的那几句话逐字在
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S8 README 逐字含：锁屏不断 / 睡眠才断 / 睡眠=从不 / 屏幕可以关 / 合盖 / 手动点睡眠 / 防睡眠怎么看 / 开机自启', () => {
  for (const needle of [
    '锁屏不会断；睡眠/休眠才会断',
    '设置 → 系统 → 电源和睡眠 → 睡眠 = 从不',
    '屏幕可以关',
    '合盖',
    '手动点睡眠',
    '防睡眠：开',
    '开机自启',
  ]) {
    assert.ok(README.includes(needle), `README 里少了这句（逐字）：${needle}`);
  }
  // 兜底那条也要写清楚（她不一定懂"管理员"，所以写成人话）
  assert.ok(README.includes('管理员'), 'powercfg 兜底要说明"可能要管理员权限，失败也不影响打印"');
});
