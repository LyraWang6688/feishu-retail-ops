#!/usr/bin/env node
/**
 * **打印小助手** —— 店里那台 Windows 电脑上跑的小程序（Node 单文件、**零第三方依赖**）。
 *
 * 它只干一件事：**把服务器已经画好的 PDF 送进打印机**。
 * 业务（印什么、几张、给谁）一个字都不懂 —— 全部留在服务器（`server/src/services/labelPrint*.js`）。
 *
 * 业务负责人 2026-10-11 的口径（唯一权威）：
 *   「这个打印小助手，**不一定会常开着机，需要打标签的时候才会开**，所以**可以做事件触发吗**？」
 * ⇒ 本文件的三条命门：
 *   ① ⭐ **事件驱动**：连服务器的 **SSE 长连接**（`/api/label-print/stream`），她一点打印**秒级**出纸。
 *      **绝不**每 2-3 秒轮询（兜底轮询默认 15 秒，且只在长连接断掉时才启用）。
 *   ② ⭐⭐ **启动补拉**：进程一起来**先** `GET /pending` 把"电脑关着期间排队"的任务取回来，
 *      *再* 连长连接（两道保险；长连接每次重连后也会再补拉一次 —— 断线期间入队的不能漏）。
 *   ③ ⭐ **幂等**：本地台账记着"哪些 job_id 已经打过了"。
 *      · 已经打过 ⇒ 只补一条回执，**绝不重新打印**；
 *      · 上次打印中途崩了（台账里是 `attempting`）⇒ **绝不自动重打**，只回一条"结果未知"的失败，
 *        让她在本地页面点【补打】（人工决定）。
 *
 * 用法：
 *   node helper.js                 # 用同目录的 config.json
 *   node helper.js --config D:\x\config.json
 *   Windows 上双击 `start.bat` 即可。
 *
 * ⚠️ **本文件可被 require**（导出纯函数供单测用），只有直接运行时才启动常驻循环 ——
 *    这样 `server/test/printHelper.test.js` 能在**不联网、不打印**的前提下把逻辑跑一遍。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const DEFAULT_CONFIG_FILE = path.join(HERE, 'config.json');

/** 默认配置（`config.json` 里没写的项用这一份；**每一项都能在配置文件里改**）。 */
const DEFAULT_CONFIG = Object.freeze({
  // 服务器地址（她手机上点打印的那个站点）。⚠️ 结尾的斜杠会被自动去掉。
  serverBaseUrl: 'https://hm.bamamei.online',
  // 服务器 `.env` 里的 `LABEL_PRINT_DEVICE_TOKEN` —— **必须一模一样**（这是小助手的身份）。
  deviceToken: '',
  deviceId: 'store-pc',
  // 本地小页面（看状态 / 测试打印 / 补打）。只监听 127.0.0.1，外网访问不到。
  localPort: 8799,
  // ⭐ 2026-10-11（业务负责人：「这个是**给我爸妈用的**，点一下就能直接操作」）：
  //   启动后**自动打开状态页** `http://127.0.0.1:<localPort>/` —— 他们双击图标就能看见
  //   「打印电脑在线 / 未连接」。不想要就把这一项设成 false。
  openStatusPageOnStart: true,
  // ⭐ 日志同时落这个文件（父母那台电脑出问题时，**把窗口拍给女儿 / 直接发这个文件**都行）。
  //   ⚠️ **有上限**（`maxLogBytes`），超出就轮转成 `helper.log.1` —— 绝不无限增长撑爆硬盘。
  logFile: 'helper.log',
  maxLogBytes: 256 * 1024,
  // 跑数据放哪（留空 = 与本文件同目录）。
  stateFile: '',
  downloadDir: '',
  // ⚠️ 兜底轮询间隔（毫秒）：**只在"长连接断了、连长轮询也失败"时才用**（最后一道兜底）。
  //    ⭐ 2026-10-12 改（真机实测"要等 ~30 秒"之后）：15000 → **3000**。
  //    改前那条"定时轮询不许小于 10 秒"的规矩**本意是"实时性不能靠定时轮询"** ——
  //    这个本意**没有放松**，只是换成了更强的机制来守：降级时**优先长轮询**
  //    （`longPollWaitMs`：服务器 hold 住、任务一到立刻返回，延迟≈0），
  //    定时轮询只是"连长轮询都不行"时的最后兜底。
  pollFallbackMs: 3000,
  heartbeatMs: 30000,
  // 长连接连续失败几次 ⇒ 启用兜底（**先长轮询**）。
  streamFailuresBeforeFallback: 3,
  // ⭐ 降级时的**首选**通道：长轮询挂多久（毫秒）。服务器 hold 住，任务一到**立刻**返回。
  //    ⚠️ 必须小于 Nginx 的 `proxy_read_timeout`（默认 60s），否则会被中间设备掐断 —— 默认 25 秒。
  longPollWaitMs: 25000,
  // 重连退避（毫秒）；用完最后一档就一直按最后一档重试。
  //    ⭐ 2026-10-12 改（真机实测）：[1000,2000,5000,10000,30000] → **[500,1000,1000,2000,3000]**。
  //    理由：封顶 30 秒意味着"服务重启一次，助手最坏盲 30 秒"（她体感就是"点了没反应"）。
  //    现在封顶 3 秒，而且 `validateConfig` 会**拒绝上限超过 3 秒**的配置（从根上不留这个坑）。
  reconnectBackoffMs: [500, 1000, 1000, 2000, 3000],
  // 本地台账最多记多少条"已打印"（超出丢最老的）。
  maxPrintedLedger: 1000,
  printer: {
    // sumatra = SumatraPDF 便携版（默认，推荐）；command = 任意命令行打印器；dialog = 系统默认程序。
    mode: 'sumatra',
    sumatraExe: 'C:\\print-helper\\SumatraPDF.exe',
    // `{file}` = 下载下来的 PDF 的路径（会被替换）。
    args: ['-print-to-default', '-silent', '{file}'],
    // ⭐⭐ 2026-10-12：SumatraPDF 的 `-print-settings`（**逗号分隔的一段**）。
    //    🔴 默认 `disable-auto-rotation` —— 这是"横版标签被转 90°、还缩到 73.5%"的**真凶**：
    //      SumatraPDF 默认会把"宽 > 高"的页面**自动转 90° 去塞进纸**（官方文档 3.5+ 有这一项）。
    //      我们的页面是 40×30（宽>高）⇒ 被自动转 ⇒ 品牌顺着短边；而"不转就塞不下"根本不存在。
    //    ⇒ 关掉它，**原始横版就能原样打印：方向对 + 100% 铺满**。
    //    🧰 排障（万一某台机器方向还是反的）：在这一档里加 `rotate=90` / `rotate=180` / `rotate=270`
    //      一档一档试（它们是在自动旋转之上**再**转）。清空数组 = 回到 SumatraPDF 的默认行为。
    printSettings: ['disable-auto-rotation'],
    // mode=command 时用这个（args 同样支持 {file}）。
    command: '',
    printTimeoutMs: 60000,
  },
});

/** 本地状态页上的"这是谁"标记（单实例判据靠它：探到它才说明**我们已经在跑**）。 */
const HELPER_APP_ID = 'label-print-helper';
/** 桌面快捷方式的名字（要给她父母看的，所以是中文；**只出现在 UTF-8 的文件/参数里**）。 */
const SHORTCUT_NAME = '打印小助手';

// ── 日志：一行一个 JSON（与服务器日志同一风格，排障时好 grep）────────────────
/**
 * 日志**落文件**（父母那台电脑出问题时，拍窗口 / 发文件都行）。
 * ⚠️ **有上限**：超过 `maxBytes` 就把当前文件挪成 `<file>.1`（老的 `.1` 覆盖掉）——
 *    只留最近两份，**绝不无限增长**。写不进去也**绝不把程序弄崩**（日志是辅助，不是业务）。
 */
const createFileLog = (options = {}) => {
  const file = options.file;
  if (!file) return null;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 256 * 1024;
  const write = (line) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size >= maxBytes) {
          fs.rmSync(`${file}.1`, { force: true });
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        // 文件还不存在（第一次跑）—— 正常。
      }
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      // 磁盘满 / 没权限：忽略。日志写不进去不该影响打印。
    }
  };
  return {
    file,
    maxBytes,
    write,
    size: () => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    },
  };
};

/**
 * 建一个 logger。两种调用形状都认（老代码 `createLogger(console)` / `createLogger()`）。
 * 每一行走 ① **stdout**（父母窗口里看得见）② **文件**（`fileLog`，给他们发出来）。
 */
const createLogger = (options = {}) => {
  const sink = options && typeof options.log === 'function'
    ? options
    : (options?.sink || console);
  const fileLog = options?.fileLog || null;
  const write = (level, event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    if (fileLog) fileLog.write(line);
    if (level === 'error') sink.error(line);
    else sink.log(line);
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
};

/** 配置里的路径：留空 = 与本文件同目录。`~` 展开（Mac 上调试时用得上）。 */
const resolvePath = (value, fallbackName, baseDir = HERE) => {
  const raw = String(value || '').trim();
  if (!raw) return path.join(baseDir, fallbackName);
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
};

/**
 * **Windows 路径拼接**（`\` 分隔）。
 * ⚠️ 刻意不用 `path.join`：那个按**当前运行平台**的分隔符走 ——
 *    在 Mac/CI 上拼 Windows 路径会拼出 `C:\Users\hm/Desktop` 这种四不像，
 *    而生成快捷方式的那段代码**只在 Windows 上跑**，路径必须是 Windows 形状。
 */
const winJoin = (...parts) => parts
  .filter((part) => part !== undefined && part !== null && String(part) !== '')
  .map((part, index) => {
    const text = String(part);
    return index === 0
      ? text.replace(/[\\/]+$/, '')
      : text.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  })
  .join('\\');

/**
 * ⭐⭐ **快捷方式的规格**（业务负责人 2026-10-11：父母双击桌面图标就能启动）。
 *
 * `kind = 'desktop'` ⇒ 桌面上一个「打印小助手」；`kind = 'autostart'` ⇒ 开机自启那个。
 *   · `targetPath`      —— 同目录的 `start.bat`（**由 `here` 推出来**，绝不写死路径：
 *                          她的文件夹已经从别处搬到了 `%USERPROFILE%\Documents\print-helper`）；
 *   · `workingDirectory`—— **必须以脚本目录为工作目录**（双击时 cwd 才稳）；
 *   · `windowStyle: 7`  —— **最小化启动**（父母不被打扰），但**任务栏上还看得见、能关**；
 *   · `iconLocation`    —— 用 **Windows 自带**图标（`shell32.dll,167`）⇒ 不新增任何文件依赖；
 *   · `description`     —— 中文说明（只在 UTF-8 的路径/参数里，不进 `.bat`）。
 */
const shortcutSpec = (kind, options = {}) => {
  const here = String(options.here || HERE);
  const userProfile = String(options.userProfile || process.env.USERPROFILE || os.homedir() || '');
  const systemRoot = String(options.systemRoot || process.env.SystemRoot || 'C:\\Windows');
  const linkDir = kind === 'autostart'
    ? winJoin(userProfile, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : winJoin(userProfile, 'Desktop');
  return {
    kind: kind === 'autostart' ? 'autostart' : 'desktop',
    linkPath: winJoin(linkDir, `${SHORTCUT_NAME}.lnk`),
    targetPath: winJoin(here, 'start.bat'),
    workingDirectory: here,
    windowStyle: 7,
    iconLocation: `${winJoin(systemRoot, 'System32', 'shell32.dll')},167`,
    description: `${SHORTCUT_NAME}（这个窗口别关）`,
  };
};

/** PowerShell 里的单引号字符串（单引号本身要写成两个 —— 不转义拼坏会报一屏乱命令）。 */
const psQuote = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

/** 生成"创建快捷方式"的 PowerShell 脚本（**纯函数**，可断言）。 */
const shortcutScript = (spec) => [
  '$ws = New-Object -ComObject WScript.Shell;',
  `$s = $ws.CreateShortcut(${psQuote(spec.linkPath)});`,
  `$s.TargetPath = ${psQuote(spec.targetPath)};`,
  `$s.WorkingDirectory = ${psQuote(spec.workingDirectory)};`,
  `$s.WindowStyle = ${Number(spec.windowStyle)};`,
  `$s.IconLocation = ${psQuote(spec.iconLocation)};`,
  `$s.Description = ${psQuote(spec.description)};`,
  '$s.Save();',
].join(' ');

/** 生成"删除快捷方式"的 PowerShell 脚本（**纯函数**）。 */
const shortcutRemoveScript = (spec) => `Remove-Item -LiteralPath ${psQuote(spec.linkPath)} -Force -ErrorAction SilentlyContinue;`;

/**
 * ⭐ **单实例判据**：探测本机那个端口上的东西**是不是我们自己**。
 * 200 + `{"app":"label-print-helper"}` ⇒ 是（小助手已经在跑）；
 * 别人占着 / 连不上 / 超时 ⇒ **false（不猜）**。
 */
const probeHelperMarker = async ({ port, fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) => {
  if (!port || typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 1500));
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}/__helper`, { signal: controller.signal });
    if (!response?.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.app === HELPER_APP_ID;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** 用系统默认浏览器打开一个网址（父母那边：双击图标就**直接看到状态页**）。 */
const defaultOpenUrl = (url) => {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : (platform === 'darwin' ? 'open' : 'xdg-open');
  // ⚠️ Windows 上必须是 `cmd /c start "" <url>`：第一个空参数是"窗口标题"占位（少了它 start 会把网址当标题）。
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
  if (typeof child.unref === 'function') child.unref();
  return true;
};

/** 跑一段 PowerShell（可注入，用例不真去动快捷方式）。 */
const defaultRunPowerShell = (command) => new Promise((resolve) => {
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
  } catch (error) {
    resolve({ code: -1, stderr: error.message });
    return;
  }
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-800); });
  child.on('error', (error) => resolve({ code: -1, stderr: error.message }));
  child.on('close', (code) => resolve({ code, stderr }));
});

/** 服务器地址规范化（去掉结尾斜杠；没写协议时补 https）。 */
const normalizeBaseUrl = (value) => {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
};

// ── SSE 分帧（纯函数，单测直接喂字符串）────────────────────────────────────
/**
 * 从一段（可能不完整的）SSE 文本里切出**完整的帧**。
 *
 * ⚠️ **必须自己分帧**：一个网络 chunk 里可能有 0 帧、1 帧、3 帧，也可能只有半帧 ——
 *    把"这一 chunk 里没切到完整的帧"当成错误、或者把半帧丢掉，都会**丢事件**（= 她点了没反应）。
 * ⇒ 返回 `{ frames, rest }`，`rest` 要**留着**与下一个 chunk 拼起来再切。
 *
 * 认四种东西（服务器只发这几种）：
 *   `event: job` / `data: {...}` / 空行（一帧结束）/ `: ping`（注释，**丢掉**，它只用来保活）。
 */
const parseSseFrames = (buffer) => {
  const frames = [];
  let rest = String(buffer ?? '');
  for (;;) {
    const index = rest.indexOf('\n\n');
    if (index === -1) break;
    const raw = rest.slice(0, index);
    rest = rest.slice(index + 2);
    let event = 'message';
    const dataLines = [];
    let isComment = false;
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) {
        isComment = true;
        continue;
      }
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (isComment && !dataLines.length) continue;
    const data = dataLines.join('\n');
    let json = null;
    if (data) {
      try {
        json = JSON.parse(data);
      } catch {
        json = null;
      }
    }
    frames.push({ event, data, json });
  }
  return { frames, rest };
};

// ── 配置校验（**缺了就大声报错**，不许静默）────────────────────────────────
/**
 * 校验配置。返回 `{ ok, errors: [{ field, message }] }`。
 * ⚠️ 这里**只**回答"能不能打"：缺令牌 / 缺打印程序 / 路径不存在 / 轮询间隔太密
 *    都会变成一条明确的错误（字段名 + 人话），由调用方**大声说出**（本地页面 + 日志 + 回执失败）。
 */
const validateConfig = (config, options = {}) => {
  const exists = options.exists || ((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  if (!normalizeBaseUrl(config?.serverBaseUrl)) push('serverBaseUrl', '没填服务器地址');
  if (!String(config?.deviceToken || '').trim()) {
    push('deviceToken', '没填设备令牌（要与服务器 .env 里的 LABEL_PRINT_DEVICE_TOKEN 一模一样）');
  }
  const printer = config?.printer || {};
  const mode = String(printer.mode || '').trim();
  if (!['sumatra', 'command', 'dialog'].includes(mode)) {
    push('printer.mode', `打印方式只能是 sumatra / command / dialog，当前是「${mode || '空'}」`);
  }
  const args = Array.isArray(printer.args) ? printer.args : null;
  if (mode === 'sumatra') {
    const exe = String(printer.sumatraExe || '').trim();
    if (!exe) push('printer.sumatraExe', '没填 SumatraPDF.exe 的路径');
    else if (!/\.exe$/i.test(exe)) push('printer.sumatraExe', `SumatraPDF 的路径要指向 .exe，当前是「${exe}」`);
    else if (options.checkPaths !== false && !exists(exe)) {
      push('printer.sumatraExe', `找不到这个文件：${exe}（把 SumatraPDF.exe 放过去，或把这一项改成实际路径）`);
    }
    if (!args || !args.some((item) => String(item).includes('{file}'))) {
      push('printer.args', '打印参数里必须有 {file}（用来放这一份 PDF 的路径）');
    }
  } else if (mode === 'command') {
    if (!String(printer.command || '').trim()) push('printer.command', 'mode=command 时必须填要执行的命令');
    if (!args || !args.some((item) => String(item).includes('{file}'))) {
      push('printer.args', '打印参数里必须有 {file}（用来放这一份 PDF 的路径）');
    }
  }
  // ⭐ 2026-10-12：下限从 10000 放宽到 500（真机实测后默认改成 3000）。
  //    ⚠️ 但"实时性不能靠定时轮询"这条**没有放松** —— 它现在由下面几件事一起守着：
  //      ① 降级时**优先长轮询**（`longPollWaitMs`，任务一到立刻返回，延迟≈0）；
  //      ② 定时轮询只是"连长轮询都失败"时的最后兜底；
  //      ③ 重连退避**封顶 3 秒**（下面那条），把"断连后的盲区"压到秒级。
  // ⭐ 打印参数（`-print-settings`）：数组、非空字符串、**不许重复**、**不许带逗号**（会被拼成两档）。
  const settings = config?.printer?.printSettings;
  if (!Array.isArray(settings)) {
    push('printer.printSettings', '打印参数必须是一个字符串数组（例如 ["disable-auto-rotation"]；空数组 = 不加这一档）');
  } else {
    const bad = settings.find((item) => typeof item !== 'string' || !item.trim()
      || item.includes(',') || /\s/.test(item.trim()));
    const seen = new Set();
    const dup = settings.find((item) => {
      const key = String(item).trim();
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (bad !== undefined) {
      push('printer.printSettings', `打印参数里每一项都要是**不含空格与逗号**的非空字符串（现在有「${bad}」）`
        + ' —— 逗号会被当成"两档参数"，空格会被 SumatraPDF 当成另一个参数');
    } else if (dup !== undefined) {
      push('printer.printSettings', `打印参数里不许有重复项（「${dup}}」出现了两次）`);
    }
  }
  // ⚠️ `args` 里自带 `-print-settings` ⇒ 会和上面那一档**打两份**，谁生效看顺序 ⇒ 明确拒绝。
  if (String(config?.printer?.mode || '').trim() === 'sumatra'
    && (config?.printer?.args || []).some((arg) => String(arg).trim() === '-print-settings')) {
    push('printer.args', '`args` 里不要再写 `-print-settings` —— 它已经由 `printer.printSettings` 负责，'
      + '两份会打架（改这一档请写 printSettings）');
  }
  const poll = Number(config?.pollFallbackMs);
  if (!Number.isFinite(poll) || poll < 500) {
    push('pollFallbackMs', `兜底轮询间隔不能小于 500 毫秒（现在 ${config?.pollFallbackMs}）—— 那等于拿服务器刷请求`);
  }
  const longPoll = Number(config?.longPollWaitMs);
  if (!Number.isFinite(longPoll) || longPoll < 1000 || longPoll > 55000) {
    push('longPollWaitMs', `长轮询挂起时长要在 1000~55000 毫秒之间（现在 ${config?.longPollWaitMs}）`
      + ' —— 必须小于 Nginx 的 proxy_read_timeout（默认 60 秒），否则会被中间设备掐断');
  }
  // ⭐ 退避上限 3 秒：上限越大，"服务重启那一下"要盲等的时间越长（实测最坏 30 秒 ⇒ 她以为没点上）。
  const backoff = config?.reconnectBackoffMs;
  if (!Array.isArray(backoff) || backoff.length === 0) {
    push('reconnectBackoffMs', '重连退避必须是一个非空的毫秒数组（例如 [500, 1000, 1000, 2000, 3000]）');
  } else {
    const bad = backoff.find((value) => !Number.isFinite(Number(value)) || Number(value) <= 0);
    const max = Math.max(...backoff.map((value) => Number(value)));
    if (bad !== undefined) {
      push('reconnectBackoffMs', `重连退避里每一项都要是正数毫秒（现在有「${bad}」）`);
    } else if (max > 3000) {
      push('reconnectBackoffMs', `重连退避**上限不能超过 3000 毫秒**（现在最大 ${max}）`
        + ' —— 上限一大，服务器重启那一下助手就会盲等那么久（实测最坏 30 秒，她体感是"点了没反应"）');
    }
  }
  const port = Number(config?.localPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    push('localPort', `本地页面端口要是 1024~65535 的整数（现在 ${config?.localPort}）`);
  }
  return { ok: errors.length === 0, errors };
};

/** 配置错误 → 一句人话（给她看 / 进回执原因）。 */
const configErrorText = (errors) => `打印小助手的配置有问题：${(errors || [])
  .map((error) => `${error.field} ${error.message}`).join('；')}`;

// ── 打印命令（**进配置**，不写死）──────────────────────────────────────────
/**
 * 由配置拼出真正要执行的命令。
 *   · `sumatra`：`SumatraPDF.exe -print-to-default -silent <file>`（便携版、免安装，推荐）
 *   · `command`：任意命令行打印器（同样 `{file}` 占位）
 *   · `dialog` ：**没有 SumatraPDF 时的备选**：交给系统默认 PDF 程序打印 ——
 *                ⚠️ 这条路会**弹出系统打印对话框、需要人工点**，所以它是备选而不是默认。
 */
const buildPrintCommand = (config, filePath) => {
  const printer = config?.printer || {};
  const mode = String(printer.mode || '').trim();
  const file = String(filePath || '');
  const fill = (arg) => String(arg).split('{file}').join(file);
  if (mode === 'sumatra') {
    // ⚠️ `{file}` 是**位置参数**：`-print-settings` 必须落在它**之前**（放到文件后面会被当成文件名）。
    // ⚠️ `-print-settings` 的值是**一个逗号分隔的参数**（SumatraPDF 的语法），不是多个 argv。
    const rawArgs = printer.args || [];
    const settings = Array.isArray(printer.printSettings)
      ? printer.printSettings.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const args = rawArgs.map(fill);
    if (settings.length) {
      const fileIndex = rawArgs.findIndex((arg) => String(arg).includes('{file}'));
      const at = fileIndex >= 0 ? fileIndex : args.length;
      args.splice(at, 0, '-print-settings', settings.join(','));
    }
    return { command: String(printer.sumatraExe || ''), args };
  }
  if (mode === 'command') {
    return { command: String(printer.command || ''), args: (printer.args || []).map(fill) };
  }
  if (mode === 'dialog') {
    // PowerShell 里用单引号包路径（含空格也安全），路径里的单引号要写成两个。
    const quoted = `'${file.replace(/'/g, "''")}'`;
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', `Start-Process -FilePath ${quoted} -Verb Print`],
    };
  }
  throw new Error(`不认识的打印方式：${mode || '空'}`);
};

// ── 本地台账（幂等的唯一依据）──────────────────────────────────────────────
/**
 * ⭐ **这一条就是"绝不重复打印"**：job_id → 已经打过了。
 *
 * 落盘形状：`{ printed: { id: {at} }, attempting: { id: {at} } }`
 * 🔴 顺序是硬要求：**打印命令返回成功之后**才写 `printed`；调用打印命令**之前**先写 `attempting`。
 *    崩在中间 ⇒ 重启后看到 `attempting` ⇒ 只回"结果未知"、**不重打**（她可以人工补打）。
 */
const createLedger = (options = {}) => {
  const file = options.file;
  const maxPrinted = Number(options.maxPrinted || 1000);
  const now = options.now || (() => Date.now());
  let state = { printed: {}, attempting: {} };

  const load = () => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        printed: parsed?.printed && typeof parsed.printed === 'object' ? parsed.printed : {},
        attempting: parsed?.attempting && typeof parsed.attempting === 'object' ? parsed.attempting : {},
      };
    } catch {
      // 文件不在 / 坏了 ⇒ 空台账起步（**不是**错误：第一次运行时本来就没有）。
      state = { printed: {}, attempting: {} };
    }
    return state;
  };

  /** 原子写：先写临时文件再 rename（半截文件读不起来 = 台账丢了 = 有重打风险，绝不能省）。 */
  const save = () => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    // 条数上限：按时间保留最新的 maxPrinted 条（超出丢最老的）。
    const entries = Object.entries(state.printed);
    if (entries.length > maxPrinted) {
      entries.sort((left, right) => String(left[1]?.at || '').localeCompare(String(right[1]?.at || '')));
      state.printed = Object.fromEntries(entries.slice(entries.length - maxPrinted));
    }
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, file);
  };

  return {
    file,
    load,
    save,
    snapshot: () => state,
    isPrinted: (jobId) => Boolean(state.printed[String(jobId)]),
    isAttempting: (jobId) => Boolean(state.attempting[String(jobId)]),
    markAttempting: (jobId) => {
      state.attempting[String(jobId)] = { at: new Date(now()).toISOString() };
      save();
    },
    clearAttempting: (jobId) => {
      delete state.attempting[String(jobId)];
      save();
    },
    markPrinted: (jobId, extra = {}) => {
      state.printed[String(jobId)] = { at: new Date(now()).toISOString(), ...extra };
      delete state.attempting[String(jobId)];
      save();
    },
    markAttemptFailed: (jobId, reason) => {
      state.attempting[String(jobId)] = {
        ...(state.attempting[String(jobId)] || {}),
        at: new Date(now()).toISOString(),
        failed_reason: String(reason || ''),
      };
      save();
    },
    counts: () => ({ printed: Object.keys(state.printed).length, attempting: Object.keys(state.attempting).length }),
  };
};

// ── 测试打印页：一个最小单页 PDF（40×30mm，纯 ASCII）──────────────────────
/**
 * 「测试打印」用的那一张 —— **刻意与真打印走同一条命令路径**（否则测了等于没测）。
 * ⚠️ 只用 ASCII + PDF 内置的 Helvetica：**不碰任何字体文件**，所以不会出现"服务器上没装中文字体
 *    就印出一堆方框"那类问题（真正的中文标签由服务器出图，那边已经处理了字体）。
 */
const buildTestPdf = (text = 'TEST 40x30', when = new Date().toISOString()) => {
  const esc = (value) => String(value ?? '').replace(/[\\()]/g, (char) => `\\${char}`);
  const content = `BT /F1 10 Tf 8 55 Td (${esc(text)}) Tj ET\n`
    + `BT /F1 6 Tf 8 44 Td (${esc(when)}) Tj ET\n`
    + `BT /F1 6 Tf 8 34 Td (40x30mm label) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 113.3858 85.0394] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const part = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`);
    chunks.push(part);
    offset += part.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
    .concat(offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n `))
    .join('\n');
  chunks.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
};

// ── 主程序 ────────────────────────────────────────────────────────────────
/**
 * 建一个打印小助手。**所有副作用都可注入**（fetch / 打印 / 时钟 / 日志），
 * 所以单测能在不联网、不打印的前提下把整条链路跑一遍。
 */
const createPrintHelper = (options = {}) => {
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  config.printer = { ...DEFAULT_CONFIG.printer, ...(options.config?.printer || {}) };
  const logger = options.logger || createLogger({
    // ⚠️ 默认就把日志**同时落文件**（父母那台电脑出问题时，让他们把 helper.log 发出来）。
    fileLog: createFileLog({
      // ⚠️ 相对路径以**配置文件所在目录**为基准（`--config D:\x\config.json` 时日志落在 D:\x\）。
      file: resolvePath(config.logFile, 'helper.log', options.configDir || HERE),
      maxBytes: config.maxLogBytes,
    }),
  });
  const fetchImpl = options.fetch || globalThis.fetch;
  // ⚠️ 探"本机那个端口是不是我们自己"用的是**本机请求**，与上面那个"打服务器"的 fetch 分开
  //    （用例可以把远程 fetch 换成桩，但单实例探测必须真的去连本机端口）。
  const probeFetch = options.probeFetch || globalThis.fetch;
  const openUrl = options.openUrl || defaultOpenUrl;
  const runPowerShell = options.runPowerShell || defaultRunPowerShell;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const baseUrl = normalizeBaseUrl(config.serverBaseUrl);
  // ⚠️ 相对路径一律以**配置文件所在目录**为基准（`--config D:\x\config.json` 时
  //    `state.json` / `downloads` 都落在 D:\x\ 下，不会散到脚本目录去）。
  const configDir = options.configDir || HERE;
  const downloadDir = resolvePath(config.downloadDir, 'downloads', configDir);
  const ledger = options.ledger || createLedger({
    file: resolvePath(config.stateFile, 'state.json', configDir),
    maxPrinted: config.maxPrintedLedger,
    now,
  });

  const state = {
    startedAt: new Date(now()).toISOString(),
    sseConnected: false,
    streamFailures: 0,
    fallbackActive: false,
    lastError: '',
    lastJobAt: '',
    authError: '',
    configErrors: [],
    // ⭐ 单实例：`localPort` 上探到的是**我们自己** ⇒ 已经在跑；`portBusy` = 端口被别人占着。
    alreadyRunning: false,
    portBusy: false,
    localPort: 0,
    statusPageUrl: '',
  };

  const headers = () => ({
    'x-label-print-token': String(config.deviceToken || ''),
    'x-label-print-device': String(config.deviceId || 'store-pc'),
  });

  const api = async (method, urlPath, { body, signal } = {}) => {
    const response = await fetchImpl(`${baseUrl}${urlPath}`, {
      method,
      headers: body ? { ...headers(), 'content-type': 'application/json' } : headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (response.status === 401) {
      state.authError = '服务器说令牌不对（config.json 的 deviceToken）';
      throw new Error(state.authError);
    }
    if (response.status === 503) {
      state.authError = '服务器还没配打印小助手令牌（LABEL_PRINT_DEVICE_TOKEN）';
      throw new Error(state.authError);
    }
    if (!response.ok) throw new Error(`${method} ${urlPath} 失败：HTTP ${response.status}`);
    state.authError = '';
    return response;
  };

  /** 下载这一条任务的 PDF，并**核对 sha256**（网络截断是真实存在的，别把半张标签打进纸里）。 */
  const downloadArtifact = async (jobId) => {
    const response = await api('GET', `/api/label-print/jobs/${encodeURIComponent(jobId)}/artifact`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = String(response.headers.get('x-label-print-sha256') || '');
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (expected && expected !== actual) {
      throw new Error(`下载的打印文件校验失败（sha256 不一致：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
    }
    fs.mkdirSync(downloadDir, { recursive: true });
    const file = path.join(downloadDir, `${jobId}.pdf`);
    fs.writeFileSync(file, bytes);
    return { file, bytes: bytes.length };
  };

  /** 真正调打印命令（可注入；返回 Promise，超时会被杀掉并抛错 + 带上 stderr 尾部）。 */
  const runPrint = options.print || ((file) => new Promise((resolve, reject) => {
    const { command, args } = buildPrintCommand(config, file);
    const timeout = Number(config.printer?.printTimeoutMs || 60000);
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(new Error(`启动打印程序失败：${error.message}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退出了。
      }
      finish(new Error(`打印命令超过 ${timeout}ms 还没结束（可能打印机没就绪）`));
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-500); });
    child.on('error', (error) => finish(new Error(`打印程序启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`打印程序退出码 ${code}${stderr ? `：${stderr.trim()}` : ''}`));
    });
  }));

  /**
   * 处理**一条已经认领的任务** —— 幂等的全部逻辑就在这个函数的顺序里（别改顺序）。
   */
  const handleJob = async (job, context = {}) => {
    const jobId = String(job?.job_id || '');
    const configErrors = context.configErrors || state.configErrors;
    // ① 配置就不对 ⇒ **大声失败**（每一条都回执失败 + 原因），绝不当成"打过了"。
    if (configErrors.length) {
      const reason = configErrorText(configErrors);
      logger.error('print_helper.job.config_invalid', { job_id: jobId, reason });
      await ack(jobId, 'failed', reason);
      return { job_id: jobId, result: 'failed', reason };
    }
    // ② 台账里已经打过 ⇒ **只补回执，绝不重打**（回执丢了 / 服务端重投都会走到这里）。
    if (ledger.isPrinted(jobId)) {
      logger.info('print_helper.job.skipped_already_printed', { job_id: jobId });
      await ack(jobId, 'done');
      return { job_id: jobId, result: 'already_printed' };
    }
    // ③ 上次打印中途崩了（台账里是 attempting）⇒ **绝不自动重打**，让她人工决定。
    if (ledger.isAttempting(jobId)) {
      const reason = '上次打印结果未知（可能已经打出来了），确认后可在本地页面点「补打」';
      logger.warn('print_helper.job.unknown_outcome', { job_id: jobId, reason });
      ledger.clearAttempting(jobId);
      await ack(jobId, 'failed', reason);
      return { job_id: jobId, result: 'unknown_outcome', reason };
    }

    // ④ 先落盘 attempting（**必须在调打印命令之前**）—— 崩在打印中间时靠它挡住重打。
    ledger.markAttempting(jobId);
    let file = '';
    try {
      logger.info('print_helper.job.printing', { job_id: jobId, total_labels: job.total_labels });
      const downloaded = await downloadArtifact(jobId);
      file = downloaded.file;
      await runPrint(file);
    } catch (error) {
      const reason = String(error?.message || error);
      state.lastError = reason;
      logger.error('print_helper.job.failed', { job_id: jobId, reason });
      ledger.markAttemptFailed(jobId, reason);
      await ack(jobId, 'failed', reason);
      return { job_id: jobId, result: 'failed', reason };
    }
    // ⑤ 打印命令成功返回**之后**才写 printed。
    ledger.markPrinted(jobId, { labels: job.total_labels ?? null });
    state.lastJobAt = new Date(now()).toISOString();
    logger.info('print_helper.job.printed', { job_id: jobId, bytes: fs.existsSync(file) ? fs.statSync(file).size : null });
    await ack(jobId, 'done');
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 临时文件删不掉不是业务问题（下同名的会被覆盖）。
    }
    return { job_id: jobId, result: 'printed' };
  };

  const ack = async (jobId, status, reason) => {
    try {
      await api('POST', `/api/label-print/jobs/${encodeURIComponent(jobId)}/ack`, {
        body: reason === undefined ? { status } : { status, reason },
      });
      return true;
    } catch (error) {
      // ⚠️ 回执发不出去**不是**"没打印"：台账已经记了，重投时会补回执（不重打）。
      logger.warn('print_helper.ack.failed', { job_id: jobId, status, reason: error.message });
      return false;
    }
  };

  /** 一条一条认领并处理，直到服务器说"没有待打的了"。**串行**（打印机只有一台）。 */
  const drain = async (context = {}) => {
    if (draining) return draining;
    // ⭐ 长轮询：`waitMs > 0` 时服务器会**hold 住**这个请求，任务一到**立刻**返回
    //    （⇒ 断连期间延迟≈0、而且请求更少）。默认 0 = 立刻返回（SSE 正常时的路）。
    const waitMs = Math.max(0, Number(context.waitMs) || 0);
    draining = (async () => {
      const results = [];
      for (;;) {
        const response = await api('POST', '/api/label-print/jobs/next', {
          body: waitMs > 0 ? { waitMs } : {},
        });
        const body = await response.json().catch(() => null);
        const job = body?.job || null;
        if (!job) break;
        results.push(await handleJob(job, context));
      }
      return results;
    })().catch((error) => {
      logger.warn('print_helper.drain.failed', { reason: error.message });
      return [];
    }).finally(() => {
      draining = null;
    });
    return draining;
  };
  let draining = null;

  /** ⭐⭐ **启动补拉**：进程一起来先问一次"现在有多少排队的"，再连长连接。 */
  const startupCatchUp = async () => {
    try {
      const response = await api('GET', '/api/label-print/pending');
      const body = await response.json().catch(() => null);
      const jobs = body?.jobs || [];
      logger.info('print_helper.pending.fetched', { pending: jobs.length, online: body?.online });
    } catch (error) {
      logger.warn('print_helper.pending.failed', { reason: error.message });
    }
    return drain();
  };

  /** 心跳（长连接断了的时候，靠它让手机仍然看得到"在线"）。 */
  const heartbeat = async () => {
    try {
      await api('GET', '/api/label-print/heartbeat');
    } catch (error) {
      logger.warn('print_helper.heartbeat.failed', { reason: error.message });
    }
  };

  // ── SSE 长连接 ──────────────────────────────────────────────────────────
  let streamAbort = null;
  let stopped = false;
  const timers = new Set();

  const setTimer = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
    return timer;
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const backoff = config.reconnectBackoffMs || [1000, 2000, 5000, 10000, 30000];
    const index = Math.min(state.streamFailures, backoff.length - 1);
    const waitMs = Number(backoff[index]) || 1000;
    setTimer(() => { void connectStream(); }, waitMs);
  };

  const startFallback = () => {
    if (state.fallbackActive || stopped) return;
    state.fallbackActive = true;
    const intervalMs = Math.max(500, Number(config.pollFallbackMs) || 3000);
    const longPollMs = Math.max(1000, Number(config.longPollWaitMs) || 25000);
    logger.warn('print_helper.fallback.long_poll', {
      long_poll_ms: longPollMs,
      interval_ms: intervalMs,
      hint: '长连接断了 ⇒ **先用长轮询**（服务器 hold 住，任务一到立刻返回、延迟≈0）；'
        + '只有连长轮询都失败时才退到定时兜底轮询（默认 3 秒）。长连接一恢复就自动停。',
    });
    const tick = async () => {
      if (stopped || !state.fallbackActive) return;
      await heartbeat();
      if (!state.sseConnected) {
        const startedAt = now();
        await drain({ waitMs: longPollMs });
        const elapsed = now() - startedAt;
        // ⚠️ 长轮询"挂满过"（服务器 hold 住了）⇒ **立刻再来一轮**：任务一入队就能马上拿到（延迟≈0）。
        //    只有"秒回"（说明服务器没 hold，通常是长轮询这条路也失败了）才退到**最后兜底**：
        //    定时轮询（默认 3 秒）。这条判据把"事件驱动"这条底线守住了。
        const heldLongEnough = elapsed >= Math.min(1000, longPollMs / 2);
        if (state.fallbackActive && !stopped) {
          setTimer(() => { void tick(); }, heldLongEnough ? 0 : intervalMs);
        }
        return;
      }
      if (state.fallbackActive && !stopped) setTimer(() => { void tick(); }, intervalMs);
    };
    void tick();
  };

  const stopFallback = () => {
    state.fallbackActive = false;
  };

  const connectStream = async () => {
    if (stopped) return;
    streamAbort = new AbortController();
    try {
      const response = await fetchImpl(`${baseUrl}/api/label-print/stream`, {
        headers: headers(),
        signal: streamAbort.signal,
      });
      if (!response.ok) throw new Error(`stream HTTP ${response.status}`);
      state.sseConnected = true;
      state.streamFailures = 0;
      stopFallback();
      logger.info('print_helper.sse.connected', {});
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.event === 'ping') continue;
          // `hello` / `backlog` / `job` 都只意味着一件事：**可能有要打的**。
          // ⚠️ 连上就先 drain 一次 —— 这是"启动补拉"的第二道保险（断线期间入队的不会漏）。
          if (frame.event === 'hello' || frame.event === 'backlog' || frame.event === 'job') {
            void drain();
          }
        }
      }
      throw new Error('长连接被服务器/网络关掉了');
    } catch (error) {
      if (stopped) return;
      state.sseConnected = false;
      state.streamFailures += 1;
      logger.warn('print_helper.sse.disconnected', { failures: state.streamFailures, reason: String(error?.message || error) });
      if (state.streamFailures >= Number(config.streamFailuresBeforeFallback || 3)) startFallback();
      scheduleReconnect();
    }
  };

  // ── 本地小页面（**只监听 127.0.0.1**，只放功能名与状态，不写说明书）──────
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[<>&"]/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[char]));

  const localPageHtml = async (pageOptions = {}) => {
    const errors = state.configErrors;
    let jobs = [];
    let serverOnline = null;
    try {
      const response = await api('GET', '/api/label-print/status');
      const body = await response.json();
      jobs = body?.jobs || [];
      serverOnline = Boolean(body?.online);
    } catch (error) {
      serverOnline = null;
      state.lastError = String(error?.message || error);
    }
    const counts = ledger.counts();
    const row = (label, value, ok) => `<tr><th>${escapeHtml(label)}</th><td class="${ok === false ? 'bad' : ''}">${escapeHtml(value)}</td></tr>`;
    const jobRow = (job) => `<tr>
<td>${escapeHtml(String(job.numbers?.[0] || job.job_id).slice(0, 40))}</td>
<td>${escapeHtml(String(job.total_labels ?? ''))}</td>
<td>${escapeHtml(String(job.status_label || job.status))}</td>
<td>${escapeHtml(job.failure_reason || '')}</td>
<td><form method="post" action="/reprint"><input type="hidden" name="jobId" value="${escapeHtml(job.job_id)}"><button type="submit" class="mini">补打</button></form></td>
</tr>`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>打印小助手</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#1f2329}
h1{font-size:18px;margin:0 0 12px}.card{background:#fff;border-radius:10px;padding:14px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #eef0f3;vertical-align:top}
th{width:34%;color:#646a73;font-weight:500}.bad{color:#c0392b;font-weight:700}
form{display:inline}button{min-height:40px;padding:8px 14px;margin:4px 6px 4px 0;border:0;border-radius:8px;background:#3370ff;color:#fff;font-size:14px;cursor:pointer}
button.mini{min-height:32px;padding:4px 10px;font-size:13px;background:#eef1f5;color:#1f2329}
.notice{background:#fff4e5;border-left:4px solid #ff8800;padding:10px;border-radius:6px;margin-bottom:12px;font-size:13px}
.ok{background:#e4f5ec;border-left:4px solid #157f4a;padding:10px;border-radius:6px;margin-bottom:12px;font-size:14px;font-weight:600}
</style></head><body>
<h1>打印小助手</h1>
${pageOptions.already ? '<div class="ok">✅ 打印小助手已经在运行了 —— 这个窗口可以关掉</div>' : ''}
${errors.length ? `<div class="notice"><strong>打印程序还没配好：</strong><br>${errors.map((error) => `${escapeHtml(error.field)}：${escapeHtml(error.message)}`).join('<br>')}</div>` : ''}
${state.authError ? `<div class="notice"><strong>连不上服务器：</strong>${escapeHtml(state.authError)}</div>` : ''}
<div class="card"><table>
${row('服务器', `${baseUrl}`, serverOnline === null ? false : true)}
${row('手机看到的状态', serverOnline ? '打印电脑在线' : '未连接（任务已排队）', serverOnline === true)}
${row('长连接（SSE）', state.sseConnected ? '已连接' : (state.fallbackActive ? '断开了，正在用兜底轮询' : '未连接'), state.sseConnected)}
${row('打印程序', errors.length ? '未配好' : `${String(config.printer.mode)} 可用`, errors.length === 0)}
${row('打印参数', (Array.isArray(config.printer.printSettings) && config.printer.printSettings.length)
    ? `-print-settings ${config.printer.printSettings.join(',')}`
    : '（没设 —— 用 SumatraPDF 自己的默认行为，宽页面会被自动转 90°）', null)}
${row('本地台账', `已打印 ${counts.printed} 条 / 待确认 ${counts.attempting} 条`)}
${row('最近一次出纸', state.lastJobAt || '还没打过')}
${row('最近一次错误', state.lastError || '没有')}
</table></div>
<div class="card">
<form method="post" action="/test-print"><button type="submit">测试打印</button></form>
<form method="post" action="/reconnect"><button type="submit">重新连接</button></form>
</div>
<div class="card"><table><tr><th>编号</th><th>张数</th><th>状态</th><th>失败原因</th><th></th></tr>
${jobs.length ? jobs.map(jobRow).join('') : '<tr><td colspan="5">还没有打印任务</td></tr>'}
</table></div>
</body></html>`;
  };

  const startLocalPage = () => new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const readBody = () => new Promise((done) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => done(new URLSearchParams(raw)));
      });
      // ⭐ **单实例判据**：双击第二次时，新进程会来问一句"这个端口上是不是你自己"。
      if (url.pathname === '/__helper') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          app: HELPER_APP_ID,
          pid: process.pid,
          started_at: state.startedAt,
          sse_connected: state.sseConnected,
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/test-print') {
        await readBody();
        try {
          fs.mkdirSync(downloadDir, { recursive: true });
          const file = path.join(downloadDir, 'test-print.pdf');
          fs.writeFileSync(file, buildTestPdf('TEST PRINT 40x30', new Date().toISOString()));
          await runPrint(file);
          state.lastJobAt = new Date(now()).toISOString();
          state.lastError = '';
          logger.info('print_helper.test_print.ok', {});
        } catch (error) {
          state.lastError = String(error?.message || error);
          logger.error('print_helper.test_print.failed', { reason: state.lastError });
        }
        res.writeHead(303, { location: '/' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/reconnect') {
        await readBody();
        state.streamFailures = 0;
        stopFallback();
        if (streamAbort) {
          try {
            streamAbort.abort();
          } catch {
            // 已经断了。
          }
        }
        void connectStream();
        res.writeHead(303, { location: '/' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/reprint') {
        const params = await readBody();
        const jobId = String(params.get('jobId') || '').trim();
        try {
          await api('POST', `/api/label-print/jobs/${encodeURIComponent(jobId)}/reprint`, { body: {} });
          logger.info('print_helper.reprint.requested', { job_id: jobId });
        } catch (error) {
          state.lastError = String(error?.message || error);
          logger.error('print_helper.reprint.failed', { job_id: jobId, reason: state.lastError });
        }
        await drain();
        res.writeHead(303, { location: '/' });
        return res.end();
      }
      try {
        // ⭐ 第二次双击时带 `?already=1`（窗口是最小化的、他们看不到控制台，
        //   所以"已经在运行了"这句必须出现在**他们会看的那个页面**上）。
        return send(res, 200, 'text/html; charset=utf-8', await localPageHtml({ already: url.searchParams.has('already') }));
      } catch (error) {
        return send(res, 500, 'text/plain; charset=utf-8', String(error?.message || error));
      }
    });
    server.once('error', async (error) => {
      // ⭐⭐ **单实例**：端口被占 ⇒ 先问一句"是不是我们自己"。
      if (error.code === 'EADDRINUSE') {
        const ours = await probeHelperMarker({
          port: Number(config.localPort),
          fetchImpl: probeFetch,
          timeoutMs: 2000,
        });
        if (ours) {
          resolve({ alreadyRunning: true });
          return;
        }
        // ⚠️ 端口被**别的程序**占着 ⇒ **不许误判成"已在运行"**：大声报错，但打印照常
        //    （本地页面只是给人看的诊断页，不该因为它起不来就不干活）。
        logger.error('print_helper.local_page.port_busy', {
          port: Number(config.localPort),
          reason: '端口被别的程序占用（探到的不是打印小助手）',
          hint: '把 config.json 里的 "localPort" 改成别的没被占用的端口（例如 8801），再重启',
        });
        resolve({ portBusy: true, error });
        return;
      }
      state.lastError = `本地页面起不来（端口 ${config.localPort}）：${error.message}`;
      logger.error('print_helper.local_page.failed', { reason: state.lastError });
      resolve({ portBusy: true, error });
    });
    server.listen(Number(config.localPort), '127.0.0.1', () => {
      localServer = server;
      state.localPort = server.address().port;
      state.statusPageUrl = `http://127.0.0.1:${state.localPort}/`;
      logger.info('print_helper.local_page.ready', { url: state.statusPageUrl });
      resolve({ server });
    });
  });
  let localServer = null;

  /** ⭐ 把状态页弹给父母（`openStatusPageOnStart: false` 可关）。 */
  const openStatusPage = ({ alreadyRunning = false } = {}) => {
    if (config.openStatusPageOnStart === false) return null;
    if (!state.localPort) return null;
    const url = `http://127.0.0.1:${state.localPort}/${alreadyRunning ? '?already=1' : ''}`;
    state.statusPageUrl = url;
    try {
      openUrl(url);
      logger.info('print_helper.status_page.opened', { url });
    } catch (error) {
      logger.warn('print_helper.status_page.open_failed', { url, reason: String(error?.message || error) });
    }
    return url;
  };

  /**
   * 启动：校验配置 → **先抢本地端口（单实例）** → 打开状态页 → 启动补拉 → 连长连接。
   *
   * ⭐⭐ **顺序是硬要求**：**先**把本地端口拿到手，**再**碰队列。
   *    否则父母连点两下 ⇒ 两个进程都去连长连接/认领任务（虽然"同一条任务只能被认领一次"
   *    这道保险仍在，但两个小助手抢任务是**他们一定会踩**的坑，必须在入口挡住）。
   */
  const start = async (startOptions = {}) => {
    stopped = false;
    ledger.load();
    const wantLocalPage = startOptions.startLocalPage !== undefined
      ? startOptions.startLocalPage !== false
      : options.startLocalPage !== false;
    const wantStream = startOptions.connectStream !== undefined
      ? startOptions.connectStream !== false
      : options.connectStream !== false;
    const checked = validateConfig(config, options.validateOptions || {});
    state.configErrors = checked.errors;
    if (!checked.ok) {
      // ⚠️ **大声报错**：日志 + 本地页面顶部红条 + 每一条任务都会被回执失败（不静默）。
      logger.error('print_helper.config.invalid', { errors: checked.errors, reason: configErrorText(checked.errors) });
    } else {
      logger.info('print_helper.started', { server: baseUrl, device_id: config.deviceId, mode: config.printer.mode });
    }
    if (wantLocalPage) {
      const acquired = await startLocalPage();
      if (acquired?.alreadyRunning) {
        state.alreadyRunning = true;
        // 她那个已经在跑的实例就挂在配置的这个端口上（我们没抢到）——状态页地址就是它。
        state.localPort = Number(config.localPort);
        // ⚠️ 一句人话 + **直接把她带到已经在跑的那个状态页**（不新开进程、不碰队列）。
        logger.info('print_helper.already_running', {
          port: Number(config.localPort),
          reason: '打印小助手已经在运行了（这个窗口可以关掉）',
        });
        openStatusPage({ alreadyRunning: true });
        return { baseUrl, configErrors: checked.errors, alreadyRunning: true };
      }
      if (acquired?.portBusy) state.portBusy = true;
    }
    // ⭐ 状态页：父母双击图标就**直接看到**「打印电脑在线 / 未连接」。
    openStatusPage();
    // ⭐⭐ 启动补拉**先于**长连接（两道保险里的第一道）。
    await startupCatchUp();
    if (wantStream) void connectStream();
    // 心跳：长连接断掉时让手机仍然看得到"在线"。
    const beat = () => {
      if (stopped) return;
      if (!state.sseConnected) void heartbeat();
      setTimer(beat, Number(config.heartbeatMs) || 30000);
    };
    setTimer(beat, Number(config.heartbeatMs) || 30000);
    return { baseUrl, configErrors: checked.errors };
  };

  /** ⭐ 装/卸快捷方式（桌面 / 开机自启）。**纯拼脚本 + 交给 PowerShell**，用例可注入。 */
  const shortcutOptions = () => ({
    here: options.shortcutHere || HERE,
    ...(options.shortcutOptions || {}),
  });
  const installShortcut = async (kind = 'desktop') => {
    const spec = shortcutSpec(kind, shortcutOptions());
    const result = await runPowerShell(shortcutScript(spec));
    const created = (() => {
      try {
        return fs.existsSync(spec.linkPath);
      } catch {
        return false;
      }
    })();
    const ok = result?.code === 0;
    logger[ok ? 'info' : 'error'](ok ? 'print_helper.shortcut.installed' : 'print_helper.shortcut.failed', {
      kind: spec.kind,
      link: spec.linkPath,
      target: spec.targetPath,
      created,
      code: result?.code,
      stderr: result?.stderr || undefined,
    });
    return { ok, kind: spec.kind, spec, created, code: result?.code ?? null, stderr: result?.stderr || '' };
  };
  const uninstallShortcut = async (kind = 'desktop') => {
    const spec = shortcutSpec(kind, shortcutOptions());
    const result = await runPowerShell(shortcutRemoveScript(spec));
    const ok = result?.code === 0;
    logger[ok ? 'info' : 'error'](ok ? 'print_helper.shortcut.removed' : 'print_helper.shortcut.remove_failed', {
      kind: spec.kind, link: spec.linkPath, code: result?.code, stderr: result?.stderr || undefined,
    });
    return { ok, kind: spec.kind, spec, code: result?.code ?? null, stderr: result?.stderr || '' };
  };

  const stop = async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (streamAbort) {
      try {
        streamAbort.abort();
      } catch {
        // 已经断了。
      }
    }
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
    localServer = null;
  };

  return {
    config,
    baseUrl,
    state,
    ledger,
    start,
    stop,
    drain,
    handleJob,
    startupCatchUp,
    heartbeat,
    connectStream,
    localPageHtml,
    buildTestPdf,
    downloadArtifact,
    // ⭐ 快捷方式（桌面 / 开机自启）与状态页 —— 父母那条"一键启动"的路。
    installShortcut,
    uninstallShortcut,
    openStatusPage,
  };
};

// ── CLI ───────────────────────────────────────────────────────────────────
const readConfigFile = (file) => {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
};

/**
 * 命令行里的那些"装/卸快捷方式"子命令。
 * ⚠️ **中文文案一律在这里（Node，UTF-8）** —— `.bat` 里**一个中文字都不许有**
 *    （上一轮真踩过：换行/编码不对，她那边报了一屏乱命令）。
 */
const runShortcutCommand = async ({ action, kind, logger }) => {
  const helper = createPrintHelper({ config: {} , logger });
  const result = action === 'install'
    ? await helper.installShortcut(kind)
    : await helper.uninstallShortcut(kind);
  const label = kind === 'autostart' ? '开机自启' : '桌面快捷方式';
  if (result.ok) {
    logger.info('print_helper.shortcut.done', { action, kind, link: result.spec.linkPath });
    console.log(`✅ ${action === 'install' ? '已设置' : '已取消'}${label}`);
    console.log(`   快捷方式位置：${result.spec.linkPath}`);
    if (action === 'install') console.log('   桌面上会出现「打印小助手」，双击它就能启动。');
  } else {
    logger.error('print_helper.shortcut.command_failed', {
      action, kind, code: result.code, stderr: result.stderr,
    });
    console.log(`❌ 没能${action === 'install' ? '创建' : '取消'}${label}（退出码 ${result.code}）`);
    if (result.stderr) console.log(`   原因：${result.stderr.trim().split('\n').slice(-3).join(' / ')}`);
    console.log('   请把上面这几行拍下来发给技术同事。');
  }
  process.exitCode = result.ok ? 0 : 1;
};

const main = async () => {
  const argIndex = process.argv.indexOf('--config');
  const configFile = argIndex >= 0 ? process.argv[argIndex + 1] : DEFAULT_CONFIG_FILE;
  // ⚠️ 先把配置读出来（失败也**不急着退出**）：日志文件位置要**跟着 config** 走，
  //    否则 `--config D:\x\config.json` 的日志会跑到脚本目录去（排障时找不到）。
  let fileConfig = {};
  let configError = null;
  if (fs.existsSync(configFile)) {
    try {
      fileConfig = readConfigFile(configFile);
    } catch (error) {
      configError = error;
    }
  }
  const logger = createLogger({
    fileLog: createFileLog({
      file: resolvePath(fileConfig.logFile ?? DEFAULT_CONFIG.logFile, 'helper.log', path.dirname(configFile)),
      maxBytes: fileConfig.maxLogBytes ?? DEFAULT_CONFIG.maxLogBytes,
    }),
  });
  // ⭐ 窗口标题（中文）**由 Node 设**：`.bat` 必须是纯 ASCII，所以标题不能写在 bat 里。
  if (process.platform === 'win32') {
    try {
      process.title = `${SHORTCUT_NAME}（这个窗口别关）`;
    } catch {
      // 设不上就算了（bat 里还有一句 ASCII 的兜底标题）。
    }
  }
  const argv = process.argv.slice(2);
  // ── 子命令：装/卸快捷方式（由那几个 .bat 调用，bat 本身保持纯 ASCII）──────────
  if (argv.includes('--install-shortcut')) {
    await runShortcutCommand({ action: 'install', kind: 'desktop', logger });
    return;
  }
  if (argv.includes('--uninstall-shortcut')) {
    await runShortcutCommand({ action: 'uninstall', kind: 'desktop', logger });
    return;
  }
  if (argv.includes('--install-autostart')) {
    await runShortcutCommand({ action: 'install', kind: 'autostart', logger });
    return;
  }
  if (argv.includes('--uninstall-autostart')) {
    await runShortcutCommand({ action: 'uninstall', kind: 'autostart', logger });
    return;
  }

  if (!fs.existsSync(configFile)) {
    logger.error('print_helper.config.missing', {
      file: configFile,
      hint: '把 config.example.json 复制成 config.json，填上 deviceToken 与打印机路径，再运行',
    });
    console.log('');
    console.log('❌ 还没配置好：找不到 config.json');
    console.log('   1) 把 config.example.json 复制一份，改名成 config.json');
    console.log('   2) 用记事本打开它，填上 deviceToken 与 SumatraPDF 的路径');
    console.log('   3) 保存后再双击一次 start.bat');
    process.exitCode = 2;
    return;
  }
  if (configError) {
    logger.error('print_helper.config.unreadable', { file: configFile, reason: configError.message });
    console.log('');
    console.log(`❌ config.json 读不出来（${configError.message}）—— 把上面这一行拍下来发给技术同事。`);
    process.exitCode = 2;
    return;
  }
  const helper = createPrintHelper({ config: fileConfig, logger, configDir: path.dirname(configFile) });
  const started = await helper.start();
  if (started.alreadyRunning) {
    // ⭐ 单实例：已经在跑 ⇒ 已经把她带到状态页了，这个窗口直接收工（不占第二个位置）。
    console.log('');
    console.log('✅ 打印小助手已经在运行了（刚刚打开的页面就是它）。');
    console.log('   这个窗口可以关掉了。');
    return;
  }
  const shutdown = async (signal) => {
    logger.info('print_helper.stopping', { signal });
    await helper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
};

if (require.main === module) {
  void main();
}

module.exports = {
  DEFAULT_CONFIG,
  HELPER_APP_ID,
  SHORTCUT_NAME,
  createLogger,
  createFileLog,
  winJoin,
  shortcutSpec,
  shortcutScript,
  shortcutRemoveScript,
  probeHelperMarker,
  defaultOpenUrl,
  normalizeBaseUrl,
  resolvePath,
  parseSseFrames,
  validateConfig,
  configErrorText,
  buildPrintCommand,
  createLedger,
  buildTestPdf,
  createPrintHelper,
};
