/**
 * 「**给父母用的桌面一键启动**」的验收标准（业务负责人 2026-10-11）。
 *
 * 她的原话：「启动可不可以做成一个**桌面版的小图标，点一下就能启动**？因为这个是**给我爸妈用的**，
 *            所以想在桌面上放个**快捷启动**的方式，方便他们一点击就能直接操作」
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-D1  ⭐ **桌面快捷方式**：一键在桌面放一个「打印小助手」的快捷方式 ——
 *          目标 = 同目录的 `start.bat`、**工作目录 = 脚本所在目录**（`%~dp0`/相对定位，
 *          **绝不写死 `D:\print-helper`**，因为她的文件夹已经搬到
 *          `%USERPROFILE%\Documents\print-helper`）、**最小化启动**（7 = minimized）、
 *          **Windows 自带图标**（`shell32.dll,167`，不新增任何文件依赖）；
 *   AC-D2  ⭐⭐ **单实例**：小助手已经在跑（`localPort` 被占，且探到的是**我们自己**）⇒
 *          **绝不起第二个**（不连长连接、不补拉、不认领任务 = 不会两个小助手抢任务/重复打印），
 *          而是**直接打开状态页** + 明确说「已经在运行了」；
 *          ⚠️ 端口被**别的程序**占着 ⇒ **不许误判成"已在运行"**：大声报错、但照常能打印；
 *   AC-D3  ⭐ **启动后自动打开状态页** `http://127.0.0.1:<port>/`（配置可关）；
 *   AC-D4  ⭐ **出错留痕**：日志同时写 `helper.log`（**有上限**，超出就轮转，绝不无限增长），
 *          异常**不吞**（写进文件，父母拍窗口/发文件都行）；
 *   AC-D5  ⭐⭐ **所有 `.bat` / `.vbs` 一律 CRLF + 纯 ASCII + 无 BOM**
 *          （上一轮真踩过：换行/编码不对，她那边报了一屏乱命令）——
 *          中文一律不进 bat，都放在 Node（UTF-8）与 README 里。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const helper = require('../../print-helper/helper.js');

const HELPER_DIR = path.join(__dirname, '../../print-helper');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'print-helper-desktop-'));

const baseConfig = (patch = {}) => ({
  ...helper.DEFAULT_CONFIG,
  serverBaseUrl: 'https://example.test',
  deviceToken: 'tok',
  printer: { ...helper.DEFAULT_CONFIG.printer, mode: 'command', command: 'C:\\print.exe', args: ['{file}'] },
  ...patch,
});

/** 假服务器：只记录被调过哪些接口（单实例那几条 AC 靠"有没有调 /stream、/jobs/next"来判）。 */
const fakeServer = () => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ method: init.method || 'GET', pathname });
      const json = (body) => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => body, arrayBuffer: async () => Buffer.from('').buffer,
      });
      if (pathname === '/api/label-print/status') return json({ success: true, online: true, jobs: [] });
      if (pathname === '/api/label-print/pending') return json({ success: true, jobs: [], online: true });
      if (pathname === '/api/label-print/jobs/next') return json({ success: true, job: null });
      if (pathname === '/api/label-print/heartbeat') return json({ success: true });
      if (pathname === '/api/label-print/stream') {
        return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
      }
      return json({ success: true });
    },
    paths: () => calls.map((call) => call.pathname),
  };
};

/** 一个"已经在跑的"小助手（本机端口上挂着我们的标记接口）。 */
const startExistingHelper = async (marker = { app: 'label-print-helper', pid: 1 }) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/__helper') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(marker));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>status page</body></html>');
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  return { server, port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
};

const makeHelper = ({ config, server, opened = [], spawns = [] } = {}) => {
  const dir = tmpDir();
  const instance = helper.createPrintHelper({
    config: baseConfig({
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      logFile: path.join(dir, 'helper.log'),
      ...config,
    }),
    fetch: (server || fakeServer()).fetch,
    print: async () => {},
    logger: helper.createLogger({ sink: { log: () => {}, error: () => {} }, fileLog: null }),
    openUrl: (url) => opened.push(url),
    runPowerShell: (command) => { spawns.push(command); return Promise.resolve({ code: 0, stderr: '' }); },
    validateOptions: { exists: () => true, checkPaths: false },
    ...(config?.__deps || {}),
  });
  return { instance, dir, opened, spawns, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// ── AC-D1：桌面快捷方式 ───────────────────────────────────────────────────

test('AC-D1 ⭐ 快捷方式规格：目标=start.bat · 工作目录=脚本所在目录 · 最小化(7) · 自带图标 · 名字=打印小助手', () => {
  const spec = helper.shortcutSpec('desktop', {
    here: 'C:\\Users\\hm\\Documents\\print-helper',
    userProfile: 'C:\\Users\\hm',
    systemRoot: 'C:\\Windows',
  });
  assert.equal(spec.linkPath, 'C:\\Users\\hm\\Desktop\\打印小助手.lnk');
  assert.equal(spec.targetPath, 'C:\\Users\\hm\\Documents\\print-helper\\start.bat');
  assert.equal(spec.workingDirectory, 'C:\\Users\\hm\\Documents\\print-helper');
  assert.equal(spec.windowStyle, 7, '7 = 最小化启动（父母不被打扰，但任务栏上还看得见、能关）');
  assert.equal(spec.iconLocation, 'C:\\Windows\\System32\\shell32.dll,167', '用 Windows 自带图标，不新增文件依赖');
  assert.match(spec.description, /打印小助手/);
});

test('AC-D1 ⭐ 快捷方式脚本**不写死任何路径**（她的文件夹已经搬过家）+ ASCII 安全', () => {
  const spec = helper.shortcutSpec('desktop', {
    here: 'C:\\Users\\another\\Documenti\\print-helper', userProfile: 'C:\\Users\\another', systemRoot: 'C:\\Windows',
  });
  const script = helper.shortcutScript(spec);
  assert.ok(script.includes('C:\\Users\\another\\Documenti\\print-helper\\start.bat'));
  assert.equal(script.includes('D:\\print-helper'), false, '绝不写死 D:\\print-helper');
  assert.ok(script.includes('WindowStyle = 7'), '最小化');
  assert.ok(script.includes('shell32.dll,167'), '图标');
  assert.ok(script.includes('WorkingDirectory'), '工作目录必须显式给（双击时 cwd 才是脚本目录）');
  // 中文名走 PowerShell 参数（Node → CreateProcessW 是 UTF-16，安全）；脚本里字面量也允许有中文，
  // 但**不能有裸的引号把命令拼坏**：单引号必须成对（PowerShell 里两个单引号 = 一个）。
  const quotes = (script.match(/'/g) || []).length;
  assert.equal(quotes % 2, 0, '单引号必须成对（否则父母的机器上会报一屏乱命令）');
});

test('AC-D1 开机自启快捷方式：同一条生成逻辑，落在「启动」文件夹', () => {
  const spec = helper.shortcutSpec('autostart', {
    here: 'C:\\Users\\hm\\Documents\\print-helper', userProfile: 'C:\\Users\\hm', systemRoot: 'C:\\Windows',
  });
  assert.match(spec.linkPath, /Start Menu[\\/]Programs[\\/]Startup[\\/]打印小助手\.lnk$/);
  assert.equal(spec.targetPath, 'C:\\Users\\hm\\Documents\\print-helper\\start.bat');
  assert.equal(spec.windowStyle, 7);
});

test('AC-D1 安装/卸载真的去跑 PowerShell（并且把脚本原样交给它）', async () => {
  const { instance, spawns, cleanup } = makeHelper();
  try {
    const installed = await instance.installShortcut('desktop');
    assert.equal(installed.ok, true);
    assert.equal(spawns.length, 1);
    assert.match(spawns[0], /CreateShortcut/);
    assert.match(spawns[0], /打印小助手\.lnk/);
    const removed = await instance.uninstallShortcut('desktop');
    assert.equal(removed.ok, true);
    assert.equal(spawns.length, 2);
    assert.match(spawns[1], /Remove-Item|Delete/);
  } finally {
    cleanup();
  }
});

// ── AC-D2：单实例 ─────────────────────────────────────────────────────────

test('AC-D2 ⭐⭐ 已经在跑 ⇒ **绝不起第二个**（不补拉 / 不连长连接 / 不认领任务）+ 打开状态页提示"已在运行"', async () => {
  const existing = await startExistingHelper();
  const server = fakeServer();
  const logs = [];
  const opened = [];
  const dir = tmpDir();
  const instance = helper.createPrintHelper({
    config: baseConfig({
      localPort: existing.port,
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      logFile: path.join(dir, 'helper.log'),
    }),
    fetch: server.fetch,
    print: async () => { throw new Error('第二个实例绝不该打印任何东西'); },
    logger: { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }), error: (event, fields) => logs.push({ event, fields }) },
    openUrl: (url) => opened.push(url),
    validateOptions: { exists: () => true, checkPaths: false },
  });
  try {
    const result = await instance.start({ connectStream: true });
    assert.equal(result.alreadyRunning, true, '必须识别出"已经在运行了"');
    assert.equal(instance.state.alreadyRunning, true);
    // 🔴 关键：**一个队列请求都不许发**（发了就可能变成"两个小助手抢任务"）。
    assert.deepEqual(server.paths(), [], `已经在跑时不许碰队列（实际发了：${server.paths().join(', ')}）`);
    assert.ok(logs.some((line) => line.event === 'print_helper.already_running'), '要留一条明确的日志');
    // 直接把她带到状态页（不新开一个进程）。
    // ⚠️ 2026-10-11 改断言（**"要提示已经在运行了"这个本意没变、而且是加强**）：
    //   改前：`http://127.0.0.1:<port>/`
    //   改后：`http://127.0.0.1:<port>/?already=1`
    //   理由：快捷方式是**最小化启动**的 ⇒ 他们**看不到控制台那行字**，
    //        所以"已经在运行了"必须出现在**他们会看的那个页面**上（页面据此渲染一条绿条）。
    assert.equal(opened.length, 1);
    assert.equal(opened[0], `http://127.0.0.1:${existing.port}/?already=1`);
  } finally {
    await instance.stop();
    await existing.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-D2 ⭐ 端口被**别的程序**占着 ⇒ 不许误判成"已在运行"：大声报错，但照常能打印', async () => {
  // 占着端口的是"别人"（标记接口不是我们的）
  const foreign = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  const port = await new Promise((resolve) => { foreign.listen(0, '127.0.0.1', () => resolve(foreign.address().port)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  foreign.keepAliveTimeout = 1;
  const server = fakeServer();
  const logs = [];
  const dir = tmpDir();
  const instance = helper.createPrintHelper({
    config: baseConfig({
      localPort: port,
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      logFile: path.join(dir, 'helper.log'),
    }),
    fetch: server.fetch,
    print: async () => {},
    logger: { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }), error: (event, fields) => logs.push({ event, fields }) },
    openUrl: () => {},
    validateOptions: { exists: () => true, checkPaths: false },
  });
  try {
    const result = await instance.start({ connectStream: false });
    assert.equal(result.alreadyRunning, undefined, '端口被外人占着 ≠ 我们已经在跑');
    assert.ok(logs.some((line) => line.event === 'print_helper.local_page.port_busy'), '要大声报错（含怎么改）');
    // 打印那条链路照常（本地页面只是诊断用，不该因为它起不来就不干活）。
    assert.ok(server.paths().includes('/api/label-print/pending'), '照常补拉');
  } finally {
    await instance.stop();
    await new Promise((resolve) => { foreign.closeAllConnections?.(); foreign.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-D2 ⭐ 正常启动时，本机 `GET /__helper` 能探到"这是打印小助手"（单实例判据的落点）', async () => {
  const server = fakeServer();
  const dir = tmpDir();
  const instance = helper.createPrintHelper({
    config: baseConfig({
      localPort: 0, // 随机端口
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      logFile: path.join(dir, 'helper.log'),
    }),
    fetch: server.fetch,
    print: async () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    openUrl: () => {},
    validateOptions: { exists: () => true, checkPaths: false },
  });
  try {
    await instance.start({ connectStream: false });
    const port = instance.state.localPort;
    assert.ok(port > 0, '起在随机端口上时要回报实际端口');
    const response = await fetch(`http://127.0.0.1:${port}/__helper`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.app, 'label-print-helper');
    assert.equal(typeof body.pid, 'number');
    // 状态页本身也照常能开
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /打印小助手/);
  } finally {
    await instance.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-D2 `probeHelperMarker`：是我们 ⇒ true；别人 / 连不上 ⇒ false（不许猜）', async () => {
  const mine = await startExistingHelper();
  const foreign = http.createServer((req, res) => { res.writeHead(404); res.end('x'); });
  const foreignPort = await new Promise((resolve) => { foreign.listen(0, '127.0.0.1', () => resolve(foreign.address().port)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  foreign.keepAliveTimeout = 1;
  try {
    assert.equal(await helper.probeHelperMarker({ port: mine.port, fetchImpl: fetch }), true);
    assert.equal(await helper.probeHelperMarker({ port: foreignPort, fetchImpl: fetch }), false);
    assert.equal(await helper.probeHelperMarker({ port: 1, fetchImpl: fetch, timeoutMs: 300 }), false);
  } finally {
    await mine.close();
    await new Promise((resolve) => { foreign.closeAllConnections?.(); foreign.close(resolve); });
  }
});

// ── AC-D3：自动打开状态页 ─────────────────────────────────────────────────

test('AC-D3 ⭐ 启动后自动打开状态页（默认开）；`openStatusPageOnStart:false` ⇒ 不开', async () => {
  assert.equal(helper.DEFAULT_CONFIG.openStatusPageOnStart, true, '默认要自动打开（父母点一下就看见状态）');
  // 开
  {
    const server = fakeServer();
    const opened = [];
    const dir = tmpDir();
    const instance = helper.createPrintHelper({
      config: baseConfig({ localPort: 0, stateFile: path.join(dir, 'state.json'), downloadDir: path.join(dir, 'downloads'), logFile: path.join(dir, 'helper.log') }),
      fetch: server.fetch, print: async () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} },
      openUrl: (url) => opened.push(url), validateOptions: { exists: () => true, checkPaths: false },
    });
    try {
      await instance.start({ connectStream: false });
      assert.deepEqual(opened, [`http://127.0.0.1:${instance.state.localPort}/`]);
    } finally {
      await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // 关
  {
    const server = fakeServer();
    const opened = [];
    const dir = tmpDir();
    const instance = helper.createPrintHelper({
      config: baseConfig({
        localPort: 0, openStatusPageOnStart: false,
        stateFile: path.join(dir, 'state.json'), downloadDir: path.join(dir, 'downloads'), logFile: path.join(dir, 'helper.log'),
      }),
      fetch: server.fetch, print: async () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} },
      openUrl: (url) => opened.push(url), validateOptions: { exists: () => true, checkPaths: false },
    });
    try {
      await instance.start({ connectStream: false });
      assert.deepEqual(opened, [], '配置关掉就不开');
    } finally {
      await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── AC-D4：helper.log ────────────────────────────────────────────────────

test('AC-D4 ⭐ 日志同时写文件（每行一个 JSON）+ **有上限、超出就轮转**（绝不无限增长）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'helper.log');
    const fileLog = helper.createFileLog({ file, maxBytes: 400 });
    for (let index = 0; index < 50; index += 1) {
      fileLog.write(JSON.stringify({ level: 'info', event: 'x', index }));
    }
    const size = fs.statSync(file).size;
    assert.ok(size <= 400 + 200, `文件不许无限长（现在 ${size} 字节，上限 400）`);
    assert.ok(fs.existsSync(`${file}.1`), '超出上限要轮转成 helper.log.1（老的留着几条给女儿看）');
    // 每行都是合法 JSON
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-D4 ⭐ 出错**不吞**：异常与失败原因都进 helper.log（他们拍窗口 / 发文件都行）', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'helper.log');
    const fileLog = helper.createFileLog({ file, maxBytes: 10 * 1024 * 1024 });
    const logger = helper.createLogger({ sink: { log: () => {}, error: () => {} }, fileLog });
    const server = fakeServer();
    const instance = helper.createPrintHelper({
      config: baseConfig({ stateFile: path.join(dir, 'state.json'), downloadDir: path.join(dir, 'downloads'), logFile: file }),
      fetch: server.fetch,
      print: async () => { throw new Error('打印机没开（退出码 2）'); },
      logger,
      openUrl: () => {},
      validateOptions: { exists: () => true, checkPaths: false },
    });
    instance.ledger.load();
    await instance.handleJob({ job_id: 'job-log', status: 'claimed', total_labels: 1, numbers: ['A|B|C'] });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /print_helper\.job\.failed/, '失败事件要落文件');
    assert.match(text, /打印机没开/, '原因要原样落文件（不吞）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-D4 日志目录不存在也能自动建（父母那台电脑上第一次跑就是这样）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'nested', 'deeper', 'helper.log');
    const fileLog = helper.createFileLog({ file, maxBytes: 1000 });
    fileLog.write('{"event":"a"}');
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC-D5：CRLF + ASCII 哨兵 ─────────────────────────────────────────────

test('AC-D5 ⭐⭐ 所有 `.bat` / `.vbs` 一律 **CRLF + 纯 ASCII + 无 BOM**（上一轮真踩过）', () => {
  const files = fs.readdirSync(HELPER_DIR).filter((name) => /\.(bat|vbs)$/i.test(name));
  assert.ok(files.length >= 4, `至少要有 start / install-desktop-shortcut / install-autostart / uninstall-autostart（实际：${files.join(', ')}）`);
  for (const name of files) {
    const buffer = fs.readFileSync(path.join(HELPER_DIR, name));
    const text = buffer.toString('latin1');
    // ① 纯 ASCII（一个非 ASCII 字节都不许有 —— 中文一律放 Node 与 README）
    const bad = [...text].map((char, index) => ({ char, index })).filter((item) => item.char.charCodeAt(0) > 0x7f);
    assert.equal(bad.length, 0, `${name} 里有 ${bad.length} 个非 ASCII 字节（第 ${bad[0]?.index} 字节起）`);
    // ② 不许有 BOM
    assert.notEqual(buffer.slice(0, 3).toString('hex'), 'efbbbf', `${name} 不许有 UTF-8 BOM`);
    // ③ 每个 \n 前面必须是 \r（纯 CRLF；混着 LF 的 bat 在某些机器上会报"命令不认识"）
    const loneLf = text.split('').reduce((count, char, index) => (
      char === '\n' && text[index - 1] !== '\r' ? count + 1 : count
    ), 0);
    assert.equal(loneLf, 0, `${name} 里有 ${loneLf} 个裸 LF（必须是 CRLF）`);
    assert.ok(text.includes('\r\n'), `${name} 必须是 CRLF 换行`);
  }
});

test('AC-D5 关键 bat 都在，且都只调用 node（真正的活全在 UTF-8 的 helper.js 里）', () => {
  for (const name of ['start.bat', 'install-desktop-shortcut.bat', 'install-autostart.bat', 'uninstall-autostart.bat']) {
    const text = fs.readFileSync(path.join(HELPER_DIR, name), 'latin1');
    assert.match(text, /node/i, `${name} 必须把活交给 node`);
    assert.match(text, /%~dp0/i, `${name} 用 %~dp0 定位自己（不写死路径）`);
    assert.match(text, /pause/i, `${name} 结束前要 pause（父母才能看清那一屏字）`);
  }
  // 编码/换行那两条是**所有** bat 的硬约束（上面那条 AC 已逐文件断言）。
  assert.match(fs.readFileSync(path.join(HELPER_DIR, 'start.bat'), 'latin1'), /chcp\s+65001/i,
    'start.bat 要切到 UTF-8 代码页，这样 Node 打出来的中文才不是乱码');
});

test('AC-D5 README 里要有「给家人用的一页说明」（中文进 README，不进 bat）', () => {
  const text = fs.readFileSync(path.join(HELPER_DIR, 'README.md'), 'utf8');
  assert.match(text, /给家人/);
  assert.match(text, /桌面/);
  assert.match(text, /已经在运行|已在运行/);
});

test('AC-D2 ⭐ 「已经在运行了」要出现在**页面上**（不是只在最小化的控制台里）', async () => {
  const server = fakeServer();
  const dir = tmpDir();
  const instance = helper.createPrintHelper({
    config: baseConfig({ localPort: 0, stateFile: path.join(dir, 'state.json'), downloadDir: path.join(dir, 'downloads'), logFile: path.join(dir, 'helper.log') }),
    fetch: server.fetch, print: async () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} },
    openUrl: () => {}, validateOptions: { exists: () => true, checkPaths: false },
  });
  try {
    const withFlag = await instance.localPageHtml({ already: true });
    assert.match(withFlag, /已经在运行了/, '带 ?already=1 时页面上要有这句话');
    assert.match(withFlag, /class="ok"/, '而且要显眼（绿条）');
    const normal = await instance.localPageHtml({});
    assert.equal(normal.includes('已经在运行了'), false, '正常打开时不该有这句');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
