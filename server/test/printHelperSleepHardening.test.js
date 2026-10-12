/**
 * ⭐⭐ 防睡眠加固（她 2026-10-12 真机：防睡眠 `enabled` ✓ 但机器**真睡过 1h56m** ✗）。
 * 裁定两条：① `powercfg` 补 **电池(DC)** 那一套 ② **每 5 分钟重新声明**"不要睡"（低频日志）。
 * 外加：状态页那行要能看出"在起作用" + 两条她需要自己设的（合盖 / 睡眠时间），README 同一份常量。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helper = require('../../print-helper/helper.js');
const README = fs.readFileSync(path.join(__dirname, '../../print-helper/README.md'), 'utf8');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ph-hard-'));
const noop = (bag = []) => ({ info: (e, d) => bag.push(['info', e, d]), warn: (e, d) => bag.push(['warn', e, d]), error: (e, d) => bag.push(['error', e, d]) });
const fetchStub = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, jobs: [], online: true }), arrayBuffer: async () => new ArrayBuffer(0) });
const make = (over = {}) => {
  const dir = tmp(); const logs = [];
  const instance = helper.createPrintHelper({
    config: { ...helper.DEFAULT_CONFIG, serverBaseUrl: 'https://e.test', deviceToken: 't', stateFile: path.join(dir, 's.json'), downloadDir: path.join(dir, 'd'), ...(over.config || {}) },
    fetch: fetchStub, print: async () => {}, logger: over.logger || noop(logs),
    validateOptions: { exists: () => true, checkPaths: false },
    runPowerShell: over.runPowerShell || (async () => ({ code: 0, stderr: '' })),
    antiSleep: over.antiSleep,
    setTimer: over.setTimer,
    startLocalPage: false, connectStream: false, openUrl: () => true,
  });
  return { instance, logs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('AC1 ⭐ 兜底命令**逐字**：AC + 电池(DC) 两套都在', () => {
  assert.deepEqual(helper.POWERCFG_COMMANDS.ac, ['powercfg /change standby-timeout-ac 0'], '接通电源那套（原来就有）');
  assert.deepEqual(helper.POWERCFG_COMMANDS.dc, ['powercfg /change standby-timeout-dc 0', 'powercfg /change hibernate-timeout-dc 0'], '⭐ 电池那套（本次新增）');
});

test('AC2 ⭐ 启动时 DC 那套**真的调了**，并留一条 dc_applied 便于排查', async () => {
  const cmds = []; const h = make({ runPowerShell: async (c) => { cmds.push(c); return { code: 0, stderr: '' }; } });
  try {
    await h.instance.start();
    await new Promise((r) => setTimeout(r, 60)); // powercfg 是**不阻塞启动**的（fire-and-forget）⇒ 等它跑完再看
    for (const c of helper.POWERCFG_COMMANDS.dc) assert.ok(cmds.includes(c), `要调 ${c}`);
    assert.ok(h.logs.some((e) => e[1] === 'print_helper.powercfg.applied'), 'AC 那条日志还在（回归）');
    assert.ok(h.logs.some((e) => e[1] === 'print_helper.powercfg.dc_applied'), '⭐ 新增 DC 那条');
  } finally { await h.instance.stop(); h.cleanup(); }
});

test('AC3 ⭐ 定期重新声明：**假定时器驱动** ⇒ 次数与日志频率都对（不依赖 wall-clock）', async () => {
  const renews = { n: 0 };
  const antiSleep = { isOn: () => true, enable: async () => true, release: async () => true,
    renew: async () => { renews.n += 1; return true; }, failureReason: () => '' };
  const timers = [];
  // ⚠️ 假定时器会把**所有** setTimer 都收进来（唤醒看门狗 5000ms 等）⇒ 只挑"重调节拍"那一档来驱动
  const h = make({ antiSleep, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { ms }; } });
  try {
    await h.instance.start();
    for (let i = 0; i < 6; i += 1) {
      const index = timers.findIndex((item) => item.ms === 300000);
      assert.ok(index >= 0, `第 ${i + 1} 拍必须排得上（每 5 分钟那档）`);
      const [next] = timers.splice(index, 1);
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(renews.n, 6, '6 拍 ⇒ renew 6 次');
    const renewed = h.logs.filter((e) => e[1] === 'print_helper.anti_sleep.renewed').length;
    assert.equal(renewed, 2, '低频：首拍 1 条 + 满 30 分钟（第 6 拍）1 条 = 2 条（不是每拍都记）');
  } finally { await h.instance.stop(); h.cleanup(); }
});

test('AC4 重调失败 ⇒ 只记 warn、不抛、不影响打印（回归）', async () => {
  const antiSleep = { isOn: () => true, enable: async () => true, release: async () => true, renew: async () => { throw new Error('power shell 被策略禁止'); }, failureReason: () => '' };
  const h = make({ antiSleep, config: { antiSleepRefreshMs: 20, antiSleepLogEveryMs: 1000 } });
  try {
    await h.instance.start();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.logs.some((e) => e[0] === 'error'), false, '不许升级成 error');
    assert.ok(h.instance.state.antiSleepEnabled === true, '状态照旧');
  } finally { await h.instance.stop(); h.cleanup(); }
});

test('AC5 命令仍**不含** ES_DISPLAY_REQUIRED（屏幕仍可关）+ 含 ES_SYSTEM_REQUIRED（回归）', () => {
  const cmd = helper.buildAntiSleepCommand();
  assert.match(cmd, /ES_SYSTEM_REQUIRED/); assert.equal(cmd.includes('ES_DISPLAY_REQUIRED'), false);
});

test('AC6 ⭐ 状态页**两个分支**都要有那两行她需自己设的；README 与页面**同一份常量**', async () => {
  // ① 防睡眠**起来了**（假 runner 返回成功）
  const ok = make({ runPowerShell: async () => ({ code: 0, stderr: '' }) });
  // ② 防睡眠**没起来**（她今晚就是这种）—— 这时更需要那两条 ✗
  const bad = make({ runPowerShell: async () => ({ code: 1, stderr: 'Access is denied' }) });
  try {
    await ok.instance.start();
    const okHtml = await ok.instance.localPageHtml();
    assert.ok(okHtml.includes(helper.ANTI_SLEEP_ON_TEXT), `"开"那页要含：${helper.ANTI_SLEEP_ON_TEXT}`);
    for (const line of helper.SLEEP_SETUP_LINES) assert.ok(okHtml.includes(line), `"开"那页要含：${line}`);

    await bad.instance.start();
    const badHtml = await bad.instance.localPageHtml();
    assert.ok(/防睡眠[\s\S]{0,400}?关（/.test(badHtml), '没起来时应显示"关（原因）"');
    for (const line of helper.SLEEP_SETUP_LINES) {
      assert.ok(badHtml.includes(line), `⭐ 没起来那页**更要**含：${line}`);
    }
    assert.ok(README.includes(helper.ANTI_SLEEP_ON_TEXT), 'README 同一份"开"的文案');
    for (const line of helper.SLEEP_SETUP_LINES) assert.ok(README.includes(line), `README 同一份：${line}`);
  } finally { await ok.instance.stop(); await bad.instance.stop(); ok.cleanup(); bad.cleanup(); }
});
