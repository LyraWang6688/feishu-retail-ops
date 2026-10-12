/**
 * ⭐⭐ 「打印小助手」换包后的**配置体验**：自动迁移 + 自助指引 + 防睡眠给原因 + 一行人话 ——
 * 验收标准（业务负责人 2026-10-12 真机截图，**先写后做**）。
 *
 * 她换文件夹后的真机状态页原文（两条长报错 + 页面只说"见日志"）：
 *   `printer.sumatraExe: 找不到这个文件: C:\Users\HUAWEI\Documents\print-helper\SumatraPDF-3.6.1-64.exe （把 SumatraPDF.exe 放过去，或把这一项改成实际路径）`
 *   `printer.args: `args` 里不要再写 `-print-settings` —— 它已经由 `printerSettings` 负责，两份会打架（改这一档请写 printSettings）`
 *   `防睡眠：关（没起来 —— 见日志…）`
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC1 `args` 里含 `-print-settings …` ⇒ **自动搬到 `printSettings`**、`args` 里删掉、**不报错**、**幂等**。
 *   AC2 两边都写了 ⇒ **以 `printSettings` 为准**（`args` 那份丢掉），并把这件事**说清楚**。
 *   AC3 走一遍真实 `createPrintHelper`（旧写法 config）⇒ 不报错、日志有"已自动迁移"、
 *       状态页有那一行、**打印命令与迁移前逐字相同**（迁移不改行为）。
 *   AC4 缺 `sumatraExe`（她那次就是路径带版本号 / 文件没了）⇒ 状态页给**下载地址 + 改名说明**（一两句，不长篇）。
 *   AC5 防睡眠失败 ⇒ 状态页**直接写出原因**（注入假 runner）+ 兜底提示「请把 Windows 睡眠设为『从不』」。
 *   AC6 配置容错：缺字段用默认不报错；**每条问题只一行**（不再一次堆两大段）。
 *   AC7 正常配置 ⇒ 状态页原有各行**逐字不变**（回归）。
 *   AC8 README 与页面文案**一致**（同一个下载地址 + 同一句改名说明）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helper = require('../../print-helper/helper.js');
const README = fs.readFileSync(path.join(__dirname, '../../print-helper/README.md'), 'utf8');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'print-helper-cfg-'));

const baseConfig = (patch = {}) => ({
  ...helper.DEFAULT_CONFIG,
  serverBaseUrl: 'https://example.test',
  deviceToken: 'tok',
  printer: { ...helper.DEFAULT_CONFIG.printer },
  ...patch,
});

const noopLogger = (bag = []) => ({
  info: (event, data) => bag.push(['info', event, data]),
  warn: (event, data) => bag.push(['warn', event, data]),
  error: (event, data) => bag.push(['error', event, data]),
});

/** 一个"够用"的假服务器（只回答状态/心跳/队列，够翻状态页用）。 */
const fakeFetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ success: true, jobs: [], online: true }),
  arrayBuffer: async () => new ArrayBuffer(0),
});

const makeHelper = (overrides = {}) => {
  const dir = tmpDir();
  const logs = [];
  const instance = helper.createPrintHelper({
    config: baseConfig({
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      ...(overrides.config || {}),
    }),
    fetch: overrides.fetch || fakeFetch,
    print: async () => {},
    logger: overrides.logger || noopLogger(logs),
    validateOptions: { exists: () => true, checkPaths: false, ...(overrides.validateOptions || {}) },
    runPowerShell: overrides.runPowerShell || (async () => ({ code: 0, stderr: '' })),
    startLocalPage: false,
    connectStream: false,
    openUrl: () => true,
  });
  return { instance, logs, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC1 / AC2 自动迁移（幂等 · 冲突以 printSettings 为准）
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 args 里的 -print-settings 自动搬到 printSettings，且**幂等**', () => {
  const old = {
    mode: 'sumatra',
    sumatraExe: 'C:\\print-helper\\SumatraPDF.exe',
    args: ['-print-to-default', '-silent', '-print-settings', 'disable-auto-rotation,center', '{file}'],
    printSettings: [],
  };
  const first = helper.migratePrinterConfig(old);
  assert.equal(first.changed, true, '第一次要报告"迁移过"');
  assert.deepEqual(first.printer.printSettings, ['disable-auto-rotation', 'center'], '值被搬过来了');
  assert.deepEqual(first.printer.args, ['-print-to-default', '-silent', '{file}'], 'args 里那一段被删掉（{file} 还在）');

  const second = helper.migratePrinterConfig(first.printer);
  assert.equal(second.changed, false, '**幂等**：再跑一次不再改动');
  assert.deepEqual(second.printer, first.printer);

  // 没写这一项 ⇒ 什么都不做（不动别人的配置）
  const untouched = helper.migratePrinterConfig({ args: ['-print-to-default', '{file}'], printSettings: ['center'] });
  assert.equal(untouched.changed, false);
  assert.deepEqual(untouched.printer.printSettings, ['center']);
});

test('AC2 两边都写了 ⇒ 以 printSettings 为准，并如实说清（args 那份丢掉）', () => {
  const migrated = helper.migratePrinterConfig({
    mode: 'sumatra',
    args: ['-silent', '-print-settings', 'rotate=180', '{file}'],
    printSettings: ['disable-auto-rotation', 'center'],
  });
  assert.equal(migrated.changed, true, 'args 里的那一段本来就不该留 ⇒ 仍然算"迁移/清理"过');
  assert.deepEqual(migrated.printer.printSettings, ['disable-auto-rotation', 'center'], '以 printSettings 为准');
  assert.deepEqual(migrated.printer.args, ['-silent', '{file}'], 'args 里那一段删掉（{file} 还在）');
  assert.deepEqual(migrated.ignoredFromArgs, ['rotate=180'], '被丢掉的那份要能说出来（给页面/日志用）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 真实链路：旧写法 config ⇒ 不报错 + 日志/状态页说清楚 + 打印命令不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 旧写法 config 走真实 createPrintHelper：不报错、日志有"已自动迁移"、打印命令逐字不变', async () => {
  const config = baseConfig({
    printer: {
      ...helper.DEFAULT_CONFIG.printer,
      args: ['-print-to-default', '-silent', '-print-settings', 'disable-auto-rotation,center', '{file}'],
      printSettings: [],
    },
  });
  const h = makeHelper({ config });
  try {
    await h.instance.start();
    // ① 校验**不再报错**（她那次就是被这条卡住）
    assert.equal(h.instance.state.configErrors.length, 0, `不该再报配置错误：${JSON.stringify(h.instance.state.configErrors)}`);
    // ② 日志里写明"已自动迁移"
    const migrated = h.logs.find((entry) => entry[1] === 'print_helper.config.migrated');
    assert.ok(migrated, '要有一条 print_helper.config.migrated');
    // ③ 状态页也说明白
    const html = await h.instance.localPageHtml();
    assert.match(html, /已自动迁移/, '状态页要写"已自动迁移"');
    assert.ok(!/打印程序还没配好/.test(html), '迁移过的配置不该再顶一条"还没配好"');
    // ④ 打印命令与迁移前逐字相同（迁移**不改行为**）
    const { command, args } = helper.buildPrintCommand(h.instance.config, 'C:\\tmp\\x.pdf');
    assert.ok(args.includes('-print-settings'), '仍然带 -print-settings');
    assert.equal(args[args.indexOf('-print-settings') + 1], 'disable-auto-rotation,center', '参数值逐字不变');
    assert.equal(args[args.length - 1], 'C:\\tmp\\x.pdf', '{file} 仍是最后一个位置参数');
    assert.ok(command.includes('SumatraPDF.exe'));
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 SumatraPDF 找不到 ⇒ 自助指引
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 找不到 SumatraPDF.exe ⇒ 状态页给下载地址 + 改名说明（一两句）', async () => {
  const h = makeHelper({
    config: baseConfig({ printer: { ...helper.DEFAULT_CONFIG.printer, sumatraExe: 'C:\\print-helper\\SumatraPDF-3.6.1-64.exe' } }),
    validateOptions: { exists: () => false, checkPaths: true },
  });
  try {
    await h.instance.start();
    const html = await h.instance.localPageHtml();
    assert.ok(h.instance.state.configErrors.length > 0, '这种情况要如实报错（打印不了）');
    assert.ok(html.includes(helper.SUMATRA_PORTABLE_URL), `状态页要有下载地址：${helper.SUMATRA_PORTABLE_URL}`);
    assert.ok(html.includes(helper.SUMATRA_RENAME_ADVICE), '状态页要有"改名 SumatraPDF.exe"那句');
    assert.match(helper.SUMATRA_RENAME_ADVICE, /SumatraPDF\.exe/, '那句里必须逐字出现 SumatraPDF.exe');
    assert.match(helper.SUMATRA_RENAME_ADVICE, /去掉版本号/, '并说明"去掉版本号"');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 防睡眠失败 ⇒ 页面直接给原因 + 兜底提示
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 防睡眠失败 ⇒ 状态页写出**原因**（不是"见日志"）+ 兜底提示「请把 Windows 睡眠设为『从不』」', async () => {
  const h = makeHelper({ runPowerShell: async () => ({ code: 1, stderr: 'Set-ExecutionPolicy : Access is denied' }) });
  try {
    await h.instance.start();
    const html = await h.instance.localPageHtml();
    const row = /<tr><th>防睡眠<\/th><td[^>]*>([\s\S]*?)<\/td><\/tr>/.exec(html);
    assert.ok(row, '状态页要有「防睡眠」那一行');
    assert.match(row[1], /被策略禁止|权限/, `那一行要写出原因，现在是：${row[1]}`);
    assert.equal(/见日志/.test(row[1]), false, '不许只写"见日志"');
    assert.ok(html.includes('请把 Windows 睡眠设为'), '要给兜底提示（手动把睡眠改成"从不"）');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

test('AC5b 原因归类：PowerShell 找不到 / 被禁止 / 其它 ⇒ 都是一行人话', () => {
  assert.match(helper.describeAntiSleepFailure({ code: -1, stderr: 'spawn powershell ENOENT' }), /找不到 PowerShell/);
  assert.match(helper.describeAntiSleepFailure({ code: 1, stderr: 'Access is denied' }), /被策略禁止/);
  assert.match(helper.describeAntiSleepFailure({ code: 1, stderr: '这条被组策略禁止了' }), /被策略禁止/);
  const other = helper.describeAntiSleepFailure({ code: 1, stderr: 'something odd happened here' });
  assert.ok(other.length > 0 && !other.includes('\n'), '其它情况也要给一行不长的话');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 配置容错：缺字段用默认；每条问题只有一行
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 缺字段走默认（不报错）；真有问题时**每条只一行**', async () => {
  // ① 只填必需的几项，其余全缺 ⇒ 全用默认，不许有任何错误
  const minimal = helper.createPrintHelper({
    config: { serverBaseUrl: 'https://example.test', deviceToken: 'tok' },
    fetch: fakeFetch,
    logger: noopLogger(),
    validateOptions: { exists: () => true, checkPaths: false },
    runPowerShell: async () => ({ code: 0 }),
    startLocalPage: false,
    connectStream: false,
    openUrl: () => true,
  });
  assert.deepEqual(helper.validateConfig(minimal.config, { exists: () => true, checkPaths: false }).errors, [],
    '缺字段 ⇒ 走默认值，不该报错');

  // ② 故意写错几项 ⇒ 每条错误都只有一行、且带字段名
  const bad = helper.validateConfig({
    ...helper.DEFAULT_CONFIG,
    serverBaseUrl: 'https://example.test',
    deviceToken: 'tok',
    printer: { ...helper.DEFAULT_CONFIG.printer, mode: 'sumatra', sumatraExe: 'D:\\x\\SumatraPDF.exe', args: [] },
    pollFallbackMs: 10,
  }, { exists: () => false, checkPaths: true });
  assert.ok(bad.errors.length >= 2, '这几项确实有问题');
  for (const error of bad.errors) {
    assert.ok(error.field && error.message, '每条都要带字段名');
    assert.equal(error.message.includes('\n'), false, `每条只一行：${error.message}`);
    assert.ok(error.message.length <= 60, `一行别太长（${error.message.length} 字）：${error.message}`);
  }
  // ③ 页面把它们渲染成一行一条（不是两大段）
  const h = makeHelper({
    config: baseConfig({ printer: { ...helper.DEFAULT_CONFIG.printer, sumatraExe: 'D:\\x\\SumatraPDF.exe' } }),
    validateOptions: { exists: () => false, checkPaths: true },
  });
  try {
    await h.instance.start();
    const html = await h.instance.localPageHtml();
    const notice = /<div class="notice">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(notice, '有问题时顶一条 notice');
    const lines = notice[1].split('<br>').filter((line) => line.trim() && !line.includes('打印程序还没配好'));
    assert.equal(lines.length, h.instance.state.configErrors.length, '一条问题一行（不合并成段）');
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 正常配置 ⇒ 状态页原有各行逐字不变（回归）
// ═══════════════════════════════════════════════════════════════════════════

test('AC7 正常配置：状态页原有各行逐字还在；不该多出迁移/报错横幅', async () => {
  const h = makeHelper({});
  try {
    await h.instance.start();
    const html = await h.instance.localPageHtml();
    for (const needle of ['服务器', '手机看到的状态', '长连接（SSE）', '打印程序', '打印参数', '本地台账', '最近一次出纸', '防睡眠']) {
      assert.ok(html.includes(`<th>${needle}</th>`), `状态页少了这一行：${needle}`);
    }
    assert.ok(!/打印程序还没配好/.test(html), '正常配置不该顶报错横幅');
    assert.ok(!/已自动迁移/.test(html), '没迁移就不该显示迁移提示');
    assert.equal(h.instance.state.configMigration.changed, false);
  } finally {
    await h.instance.stop();
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 README 与页面文案一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC8 README 与页面用同一个下载地址 / 同一句改名说明 / 同一句兜底提示', () => {
  assert.ok(README.includes(helper.SUMATRA_PORTABLE_URL), `README 要有同一个下载地址：${helper.SUMATRA_PORTABLE_URL}`);
  assert.ok(README.includes(helper.SUMATRA_RENAME_ADVICE), 'README 要有同一句改名说明');
  assert.ok(README.includes('请把 Windows 睡眠设为'), 'README 要有同一句兜底提示');
  assert.ok(README.includes('-print-settings'), 'README 要说明 args 里的老写法会自动迁移');
});
