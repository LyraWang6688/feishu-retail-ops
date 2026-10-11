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
  // 跑数据放哪（留空 = 与本文件同目录）。
  stateFile: '',
  downloadDir: '',
  // ⚠️ 兜底轮询间隔：**只在 SSE 长连接断了**的时候才用。
  //    她明令"不要每 2-3 秒定时轮询" ⇒ 默认 15 秒，且**校验时会拒绝小于 10 秒的值**。
  pollFallbackMs: 15000,
  heartbeatMs: 30000,
  // 长连接连续失败几次 ⇒ 启用兜底轮询。
  streamFailuresBeforeFallback: 3,
  // 重连退避（毫秒）；用完最后一档就一直按最后一档重试。
  reconnectBackoffMs: [1000, 2000, 5000, 10000, 30000],
  // 本地台账最多记多少条"已打印"（超出丢最老的）。
  maxPrintedLedger: 1000,
  printer: {
    // sumatra = SumatraPDF 便携版（默认，推荐）；command = 任意命令行打印器；dialog = 系统默认程序。
    mode: 'sumatra',
    sumatraExe: 'C:\\print-helper\\SumatraPDF.exe',
    // `{file}` = 下载下来的 PDF 的路径（会被替换）。
    args: ['-print-to-default', '-silent', '{file}'],
    // mode=command 时用这个（args 同样支持 {file}）。
    command: '',
    printTimeoutMs: 60000,
  },
});

// ── 日志：一行一个 JSON（与服务器日志同一风格，排障时好 grep）────────────────
const createLogger = (sink = console) => {
  const write = (level, event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
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
const resolvePath = (value, fallbackName) => {
  const raw = String(value || '').trim();
  if (!raw) return path.join(HERE, fallbackName);
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? expanded : path.join(HERE, expanded);
};

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
  const poll = Number(config?.pollFallbackMs);
  if (!Number.isFinite(poll) || poll < 10000) {
    // 🔴 她明令："不要每 2-3 秒定时轮询" ⇒ 这一条是硬约束，不是建议。
    push('pollFallbackMs', `兜底轮询间隔不能小于 10000 毫秒（现在 ${config?.pollFallbackMs}）—— 实时性靠长连接，不靠轮询`);
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
    return { command: String(printer.sumatraExe || ''), args: (printer.args || []).map(fill) };
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
  const logger = options.logger || createLogger();
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const baseUrl = normalizeBaseUrl(config.serverBaseUrl);
  const downloadDir = resolvePath(config.downloadDir, 'downloads');
  const ledger = options.ledger || createLedger({
    file: resolvePath(config.stateFile, 'state.json'),
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
    draining = (async () => {
      const results = [];
      for (;;) {
        const response = await api('POST', '/api/label-print/jobs/next', { body: {} });
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
    logger.warn('print_helper.fallback.polling', {
      interval_ms: config.pollFallbackMs,
      hint: '长连接连不上，先用兜底轮询（默认 15 秒一次）+ 心跳顶着；长连接一恢复就自动停',
    });
    const tick = async () => {
      if (stopped || !state.fallbackActive) return;
      await heartbeat();
      if (!state.sseConnected) await drain();
      if (state.fallbackActive && !stopped) setTimer(() => { void tick(); }, Number(config.pollFallbackMs) || 15000);
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

  const localPageHtml = async () => {
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
</style></head><body>
<h1>打印小助手</h1>
${errors.length ? `<div class="notice"><strong>打印程序还没配好：</strong><br>${errors.map((error) => `${escapeHtml(error.field)}：${escapeHtml(error.message)}`).join('<br>')}</div>` : ''}
${state.authError ? `<div class="notice"><strong>连不上服务器：</strong>${escapeHtml(state.authError)}</div>` : ''}
<div class="card"><table>
${row('服务器', `${baseUrl}`, serverOnline === null ? false : true)}
${row('手机看到的状态', serverOnline ? '打印电脑在线' : '未连接（任务已排队）', serverOnline === true)}
${row('长连接（SSE）', state.sseConnected ? '已连接' : (state.fallbackActive ? '断开了，正在用兜底轮询' : '未连接'), state.sseConnected)}
${row('打印程序', errors.length ? '未配好' : `${String(config.printer.mode)} 可用`, errors.length === 0)}
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
        return send(res, 200, 'text/html; charset=utf-8', await localPageHtml());
      } catch (error) {
        return send(res, 500, 'text/plain; charset=utf-8', String(error?.message || error));
      }
    });
    server.on('error', (error) => {
      state.lastError = `本地页面起不来（端口 ${config.localPort}）：${error.message}`;
      logger.error('print_helper.local_page.failed', { reason: state.lastError });
      resolve(null);
    });
    server.listen(Number(config.localPort), '127.0.0.1', () => {
      logger.info('print_helper.local_page.ready', { url: `http://127.0.0.1:${config.localPort}/` });
      resolve(server);
    });
  });
  let localServer = null;

  /** 启动：校验配置 → 启动补拉 → 连长连接 → 起本地页面。 */
  const start = async () => {
    stopped = false;
    ledger.load();
    const checked = validateConfig(config, options.validateOptions || {});
    state.configErrors = checked.errors;
    if (!checked.ok) {
      // ⚠️ **大声报错**：日志 + 本地页面顶部红条 + 每一条任务都会被回执失败（不静默）。
      logger.error('print_helper.config.invalid', { errors: checked.errors, reason: configErrorText(checked.errors) });
    } else {
      logger.info('print_helper.started', { server: baseUrl, device_id: config.deviceId, mode: config.printer.mode });
    }
    if (options.startLocalPage !== false) localServer = await startLocalPage();
    // ⭐⭐ 启动补拉**先于**长连接（两道保险里的第一道）。
    await startupCatchUp();
    if (options.connectStream !== false) void connectStream();
    // 心跳：长连接断掉时让手机仍然看得到"在线"。
    const beat = () => {
      if (stopped) return;
      if (!state.sseConnected) void heartbeat();
      setTimer(beat, Number(config.heartbeatMs) || 30000);
    };
    setTimer(beat, Number(config.heartbeatMs) || 30000);
    return { baseUrl, configErrors: checked.errors };
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
  };
};

// ── CLI ───────────────────────────────────────────────────────────────────
const readConfigFile = (file) => {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
};

const main = async () => {
  const logger = createLogger();
  const argIndex = process.argv.indexOf('--config');
  const configFile = argIndex >= 0 ? process.argv[argIndex + 1] : DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(configFile)) {
    logger.error('print_helper.config.missing', {
      file: configFile,
      hint: '把 config.example.json 复制成 config.json，填上 deviceToken 与打印机路径，再运行',
    });
    process.exitCode = 2;
    return;
  }
  let fileConfig;
  try {
    fileConfig = readConfigFile(configFile);
  } catch (error) {
    logger.error('print_helper.config.unreadable', { file: configFile, reason: error.message });
    process.exitCode = 2;
    return;
  }
  const helper = createPrintHelper({ config: fileConfig, logger });
  await helper.start();
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
  createLogger,
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
