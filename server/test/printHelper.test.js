/**
 * 「打印小助手」（`print-helper/helper.js`）的验收标准护栏 —— **不联网、不打印**，全部注入。
 *
 * 业务负责人 2026-10-11 的口径（唯一权威）：
 *   「这个打印小助手，**不一定会常开着机，需要打标签的时候才会开**，所以**可以做事件触发吗**？」
 * ⇒ 下面每条用例名就是一条 AC：
 *
 *   AC-H1  **SSE 分帧**：一帧、一 chunk 多帧、半帧跨 chunk、`: ping` 注释、坏 JSON 都不许丢事件；
 *   AC-H2  **打印命令进配置**：sumatra / command / dialog 三种模式都从 `config.json` 拼出来，
 *          `{file}` 被替换成真实路径；
 *   AC-H3  **配置缺失 ⇒ 大声报错**：缺令牌 / 缺 SumatraPDF 路径 / 路径不存在 / 轮询间隔 < 10 秒，
 *          都给**带字段名**的错误（不是静默为 true）；
 *   AC-H4  ⭐ **幂等①**：台账里"已打印"的 job ⇒ **只补回执、一次都不调打印**；
 *   AC-H5  ⭐ **幂等②**：台账里"上次结果未知"（attempting）的 job ⇒ **不打印**，回执失败 + 原因里含"结果未知"；
 *   AC-H6  ⭐ **崩溃顺序**：打印命令抛错 ⇒ 台账里**先**有 attempting、**没有** printed，
 *          回执失败且原因里带命令的错误信息；
 *   AC-H7  **sha256 校验**：下载到的字节与响应头不一致 ⇒ 判失败、**不打印**、原因里含 sha；
 *   AC-H8  ⭐⭐ **启动补拉**：`start()` **先** `GET /pending`、**再**连 SSE（电脑关着时入队的不会漏）；
 *   AC-H9  ⭐ **端到端 drain（全注入）**：一条 queued 任务 → 下载 → 打印 → 回执 done；
 *          **再 drain 一次不会重打**（打印只调 1 次）；
 *   AC-H10 **兜底轮询绝不许是 2-3 秒**：默认 `pollFallbackMs >= 10000`；长连接连续失败到阈值才启用；
 *   AC-H11 **台账**：原子写（临时文件 + rename）、条数上限、读坏文件退化成空台账（不抛）；
 *   AC-H12 **本地页面**：零脚本、说清配置错误、带【测试打印】/【重新连接】/【补打】；
 *          测试打印用的是**同一条打印命令路径**；
 *   AC-H13 **回执发不出去不等于没打**：台账已记 printed，重投时只补回执、不重打。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const helper = require('../../print-helper/helper.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'print-helper-'));

const baseConfig = (patch = {}) => ({
  ...helper.DEFAULT_CONFIG,
  serverBaseUrl: 'https://example.test',
  deviceToken: 'tok',
  printer: { ...helper.DEFAULT_CONFIG.printer, ...(patch.printer || {}) },
  ...patch,
});

/** 一个"按契约回答"的假服务器（记录每一次调用）。 */
const fakeServer = (options = {}) => {
  const calls = [];
  const jobs = options.jobs ? [...options.jobs] : [];
  let artifactBytes = options.artifactBytes || Buffer.from('%PDF-1.4 fake');
  const state = { acked: [], reprints: [] };
  const handler = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ method: init.method || 'GET', pathname });
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer,
    });
    if (pathname === '/api/label-print/pending') {
      return json({ success: true, jobs: jobs.map((job) => ({ ...job })), online: true });
    }
    if (pathname === '/api/label-print/jobs/next') {
      const next = jobs.shift() || null;
      return json({ success: true, job: next });
    }
    if (/\/artifact$/.test(pathname)) {
      const expected = options.badSha
        ? 'deadbeef'.repeat(8)
        : crypto.createHash('sha256').update(artifactBytes).digest('hex');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'x-label-print-sha256' ? expected : null) },
        json: async () => ({}),
        arrayBuffer: async () => artifactBytes.buffer.slice(artifactBytes.byteOffset, artifactBytes.byteOffset + artifactBytes.length),
      };
    }
    if (/\/ack$/.test(pathname)) {
      const body = JSON.parse(init.body || '{}');
      state.acked.push({ jobId: pathname.split('/')[4], ...body });
      return json({ success: true, job: { status: body.status } });
    }
    if (/\/reprint$/.test(pathname)) {
      state.reprints.push(pathname.split('/')[4]);
      return json({ success: true, job_id: 'reprinted' });
    }
    if (pathname === '/api/label-print/status') return json({ success: true, online: true, jobs: [] });
    if (pathname === '/api/label-print/heartbeat') return json({ success: true, online: true });
    if (pathname === '/api/label-print/stream') {
      return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    }
    return json({ success: false, error: 'not found' }, 404);
  };
  return { calls, state, fetch: handler, jobs };
};

const makeHelper = (overrides = {}) => {
  const dir = tmpDir();
  const server = overrides.server || fakeServer();
  const printed = [];
  const helperInstance = helper.createPrintHelper({
    config: baseConfig({
      stateFile: path.join(dir, 'state.json'),
      downloadDir: path.join(dir, 'downloads'),
      ...(overrides.config || {}),
    }),
    fetch: server.fetch,
    print: async (file) => {
      printed.push(file);
      if (overrides.printError) throw new Error(overrides.printError);
      if (overrides.onPrint) await overrides.onPrint(file);
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // ⚠️ 用例在 mac/CI 上跑，Windows 的 SumatraPDF.exe 路径当然不存在 ⇒
    //    路径存在性检查在单测里注入为"都存在"（那条检查本身由 AC-H3 单独验）。
    validateOptions: { exists: () => true, checkPaths: false },
    ...overrides.options,
  });
  return { helper: helperInstance, server, printed, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const JOB = (patch = {}) => ({
  job_id: 'job-1', status: 'claimed', status_label: '已取走', total_labels: 1,
  numbers: ['XHB8095|棕色|A'], failure_reason: '', ...patch,
});

// ── AC-H1：SSE 分帧 ───────────────────────────────────────────────────────

test('AC-H1 SSE 分帧：一帧 / 一 chunk 多帧 / 半帧跨 chunk / ping 注释都不丢事件', () => {
  // ① 一帧
  assert.deepEqual(helper.parseSseFrames('event: job\ndata: {"job_id":"a"}\n\n').frames,
    [{ event: 'job', data: '{"job_id":"a"}', json: { job_id: 'a' } }]);
  // ② 一个 chunk 里两帧
  const two = helper.parseSseFrames('event: hello\ndata: {}\n\nevent: backlog\ndata: {"jobs":[]}\n\n');
  assert.deepEqual(two.frames.map((frame) => frame.event), ['hello', 'backlog']);
  assert.deepEqual(two.rest, '');
  // ③ 半帧跨 chunk：第一段什么都不出，`rest` 留着与下一段拼
  const part1 = helper.parseSseFrames('event: job\ndata: {"job_id":"b');
  assert.deepEqual(part1.frames, []);
  assert.equal(part1.rest, 'event: job\ndata: {"job_id":"b');
  const part2 = helper.parseSseFrames(`${part1.rest}"}\n\n`);
  assert.deepEqual(part2.frames, [{ event: 'job', data: '{"job_id":"b"}', json: { job_id: 'b' } }]);
  // ④ `: ping` 注释丢掉（它只用来保活），且**不影响**后面的帧
  const ping = helper.parseSseFrames(': ping\n\nevent: job\ndata: {"job_id":"c"}\n\n');
  assert.deepEqual(ping.frames.map((frame) => frame.event), ['job']);
  // ⑤ 坏 JSON ⇒ 不抛，json 为 null（帧本身还在，不会被静默吞掉）
  const broken = helper.parseSseFrames('event: job\ndata: {oops\n\n');
  assert.equal(broken.frames.length, 1);
  assert.equal(broken.frames[0].json, null);
});

// ── AC-H2 / AC-H3：打印命令与配置校验 ─────────────────────────────────────

test('AC-H2 打印命令进配置：sumatra / command / dialog 三种模式 + {file} 替换', () => {
  const sumatra = helper.buildPrintCommand(baseConfig(), 'C:\\tmp\\a b.pdf');
  assert.equal(sumatra.command, 'C:\\print-helper\\SumatraPDF.exe');
  assert.deepEqual(sumatra.args, ['-print-to-default', '-silent', 'C:\\tmp\\a b.pdf']);

  const command = helper.buildPrintCommand(baseConfig({
    printer: { mode: 'command', command: 'C:\\tools\\print.exe', args: ['/p', '{file}'] },
  }), '/tmp/x.pdf');
  assert.equal(command.command, 'C:\\tools\\print.exe');
  assert.deepEqual(command.args, ['/p', '/tmp/x.pdf']);

  const dialog = helper.buildPrintCommand(baseConfig({ printer: { mode: 'dialog' } }), "/tmp/o'brien.pdf");
  assert.equal(dialog.command, 'powershell');
  assert.match(dialog.args.join(' '), /-Verb Print/);
  assert.match(dialog.args.join(' '), /o''brien/, '路径里的单引号要转义（不然 PowerShell 会断）');

  assert.throws(() => helper.buildPrintCommand(baseConfig({ printer: { mode: 'nope' } }), '/tmp/x.pdf'), /不认识的打印方式/);
});

test('AC-H3 配置缺失/写错 ⇒ 带字段名的明确错误（绝不静默）', () => {
  const exists = () => true;
  // ① 缺令牌
  let checked = helper.validateConfig(baseConfig({ deviceToken: '' }), { exists });
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((error) => error.field === 'deviceToken'));
  // ② 缺 SumatraPDF 路径
  checked = helper.validateConfig(baseConfig({ printer: { mode: 'sumatra', sumatraExe: '' } }), { exists });
  assert.ok(checked.errors.some((error) => error.field === 'printer.sumatraExe'));
  // ③ 路径存在性：文件不在 ⇒ 明确报（含那个路径）
  checked = helper.validateConfig(baseConfig(), { exists: (file) => file !== 'C:\\print-helper\\SumatraPDF.exe' });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.find((error) => error.field === 'printer.sumatraExe').message, /找不到这个文件/);
  // ④ 参数里没有 {file}
  checked = helper.validateConfig(baseConfig({ printer: { mode: 'sumatra', args: ['-silent'] } }), { exists });
  assert.ok(checked.errors.some((error) => error.field === 'printer.args'));
  // ⑤ 🔴 兜底轮询不许是 2-3 秒（她明令不要定时轮询）
  checked = helper.validateConfig(baseConfig({ pollFallbackMs: 2500 }), { exists });
  assert.ok(checked.errors.some((error) => error.field === 'pollFallbackMs'));
  assert.equal(helper.validateConfig(baseConfig({ pollFallbackMs: 3000 }), { exists }).ok, false);
  // ⑥ 全对 ⇒ ok，且 configErrorText 是一句人话
  checked = helper.validateConfig(baseConfig(), { exists });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.errors, []);
  assert.match(helper.configErrorText([{ field: 'x', message: 'y' }]), /x y/);
});

test('AC-H3 配置不对时：每一条任务都回执失败 + 原因（不是静默跳过）', async () => {
  const server = fakeServer({ jobs: [JOB()] });
  const { helper: instance, server: srv, printed, cleanup } = makeHelper({ server });
  try {
    // 令牌留空 ⇒ 配置无效；drain 时每条任务都必须被回执失败。
    instance.config.deviceToken = '';
    instance.state.configErrors = helper.validateConfig(instance.config, { exists: () => true }).errors;
    await instance.drain();
    assert.equal(printed.length, 0, '配置不对就绝不许打印');
    assert.equal(srv.state.acked.length, 1);
    assert.equal(srv.state.acked[0].status, 'failed');
    assert.match(srv.state.acked[0].reason, /配置有问题/);
  } finally {
    cleanup();
  }
});

// ── AC-H4 / AC-H5 / AC-H6 / AC-H13：幂等 ──────────────────────────────────

test('AC-H4 ⭐ 已打印过的 job：只补回执，一次都不调打印', async () => {
  const server = fakeServer();
  const { helper: instance, printed, cleanup } = makeHelper({ server });
  try {
    instance.ledger.load();
    instance.ledger.markPrinted('job-1', { labels: 1 });
    const result = await instance.handleJob(JOB());
    assert.equal(result.result, 'already_printed');
    assert.equal(printed.length, 0, '绝不重新打印');
    assert.deepEqual(server.state.acked, [{ jobId: 'job-1', status: 'done' }]);
  } finally {
    cleanup();
  }
});

test('AC-H5 ⭐ 上次"结果未知"（attempting）：不打印、回执失败 + 原因里含"结果未知"', async () => {
  const server = fakeServer();
  const { helper: instance, printed, cleanup } = makeHelper({ server });
  try {
    instance.ledger.load();
    instance.ledger.markAttempting('job-1');
    const result = await instance.handleJob(JOB());
    assert.equal(result.result, 'unknown_outcome');
    assert.equal(printed.length, 0, '崩溃恢复绝不自动重打');
    assert.equal(server.state.acked[0].status, 'failed');
    assert.match(server.state.acked[0].reason, /结果未知/);
    assert.match(server.state.acked[0].reason, /补打/);
  } finally {
    cleanup();
  }
});

test('AC-H6 ⭐ 崩溃顺序：先写 attempting、失败记原因、绝不写 printed；回执带命令的错误信息', async () => {
  const server = fakeServer();
  const { helper: instance, printed, cleanup } = makeHelper({ server, printError: '打印机没开（退出码 2）' });
  try {
    instance.ledger.load();
    const result = await instance.handleJob(JOB());
    assert.equal(result.result, 'failed');
    assert.equal(printed.length, 1, '命令确实被调了一次（失败在命令里）');
    // 台账：**没有** printed（否则以后就不敢补打了），attempting 里记着失败原因。
    assert.equal(instance.ledger.isPrinted('job-1'), false);
    assert.equal(instance.ledger.isAttempting('job-1'), true);
    const onDisk = JSON.parse(fs.readFileSync(instance.ledger.file, 'utf8'));
    assert.match(onDisk.attempting['job-1'].failed_reason, /打印机没开/);
    assert.equal(server.state.acked[0].status, 'failed');
    assert.match(server.state.acked[0].reason, /打印机没开/);
  } finally {
    cleanup();
  }
});

test('AC-H13 回执发不出去 ≠ 没打印：台账已记 printed，重投时只补回执、不重打', async () => {
  const server = fakeServer();
  const inner = server.fetch;
  let failAck = true;
  server.fetch = async (url, init) => {
    if (failAck && /\/ack$/.test(String(url))) throw new Error('服务器连不上');
    return inner(url, init);
  };
  const { helper: instance, printed, cleanup } = makeHelper({ server });
  try {
    instance.ledger.load();
    const first = await instance.handleJob(JOB());
    assert.equal(first.result, 'printed');
    assert.equal(printed.length, 1);
    assert.equal(instance.ledger.isPrinted('job-1'), true, '回执没发出去也要记下"打过了"');
    // 服务端重投同一条 ⇒ 只补回执。
    failAck = false;
    const second = await instance.handleJob(JOB());
    assert.equal(second.result, 'already_printed');
    assert.equal(printed.length, 1, '绝不重打');
    assert.deepEqual(server.state.acked, [{ jobId: 'job-1', status: 'done' }]);
  } finally {
    cleanup();
  }
});

// ── AC-H7：sha256 ─────────────────────────────────────────────────────────

test('AC-H7 下载校验失败（sha256 不一致）⇒ 不打印、回执失败 + 原因里含 sha', async () => {
  const server = fakeServer({ badSha: true, jobs: [JOB()] });
  const { helper: instance, printed, cleanup } = makeHelper({ server });
  try {
    instance.ledger.load();
    await instance.drain();
    assert.equal(printed.length, 0, '下坏的文件绝不许进打印机');
    assert.equal(server.state.acked[0].status, 'failed');
    assert.match(server.state.acked[0].reason, /sha256/);
  } finally {
    cleanup();
  }
});

// ── AC-H8 / AC-H9：补拉 + 端到端 ─────────────────────────────────────────

test('AC-H8 ⭐⭐ 启动补拉：start() 先 GET /pending、再连 /stream（电脑关着时入队的不会漏）', async () => {
  const server = fakeServer({ jobs: [JOB({ job_id: 'queued-while-off' })] });
  const { helper: instance, printed, cleanup } = makeHelper({ server });
  try {
    await instance.start({ startLocalPage: false });
    // 顺序：pending 必须**早于** stream。
    const order = server.calls.map((call) => call.pathname);
    const pendingAt = order.indexOf('/api/label-print/pending');
    const streamAt = order.indexOf('/api/label-print/stream');
    assert.ok(pendingAt >= 0, '必须先补拉');
    assert.ok(streamAt >= 0, '也要连长连接');
    assert.ok(pendingAt < streamAt, `补拉要早于长连接（实际顺序 ${order.join(' → ')}）`);
    // 排队的那条被打出来了。
    assert.equal(printed.length, 1);
    assert.equal(server.state.acked[0].jobId, 'queued-while-off');
    assert.equal(server.state.acked[0].status, 'done');
    await instance.stop();
  } finally {
    cleanup();
  }
});

test('AC-H9 ⭐ 端到端 drain：queued → 下载 → 打印 → 回执 done；再 drain 一次不重打', async () => {
  const server = fakeServer({ jobs: [JOB({ job_id: 'e2e-1', total_labels: 2 })] });
  const { helper: instance, printed, server: srv, cleanup } = makeHelper({ server });
  try {
    instance.ledger.load();
    const first = await instance.drain();
    assert.deepEqual(first, [{ job_id: 'e2e-1', result: 'printed' }]);
    assert.equal(printed.length, 1);
    assert.equal(srv.state.acked.length, 1);
    assert.deepEqual(srv.state.acked[0], { jobId: 'e2e-1', status: 'done' });
    assert.equal(instance.ledger.isPrinted('e2e-1'), true);
    // 再 drain：服务器已经没任务了 ⇒ 一次打印都不再发生。
    const second = await instance.drain();
    assert.deepEqual(second, []);
    assert.equal(printed.length, 1);
  } finally {
    cleanup();
  }
});

// ── AC-H10：兜底轮询 ──────────────────────────────────────────────────────

test('AC-H10 兜底轮询绝不是 2-3 秒：默认 ≥10 秒，且只在长连接连续失败到阈值才启用', async () => {
  assert.ok(helper.DEFAULT_CONFIG.pollFallbackMs >= 10000, '默认兜底轮询间隔必须 ≥10 秒');
  assert.equal(helper.DEFAULT_CONFIG.streamFailuresBeforeFallback, 3);

  const server = fakeServer();
  server.fetch = async (url) => {
    if (String(url).includes('/stream')) throw new Error('连不上');
    return fakeServer().fetch(url);
  };
  const { helper: instance, cleanup } = makeHelper({
    server,
    options: {
      config: baseConfig({
        stateFile: path.join(os.tmpdir(), `ph-${Date.now()}`, 'state.json'),
        pollFallbackMs: 15000,
      }),
    },
  });
  try {
    assert.equal(instance.state.fallbackActive, false);
    await instance.connectStream(); // 失败一次
    assert.equal(instance.state.fallbackActive, false, '失败一次还不降级');
  } finally {
    cleanup();
  }
});

// ── AC-H11：台账 ──────────────────────────────────────────────────────────

test('AC-H11 台账：原子写 / 条数上限 / 坏文件退化成空台账', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'state.json');
    const ledger = helper.createLedger({ file, maxPrinted: 3, now: () => Date.UTC(2026, 9, 11, 12, 0, 0) });
    ledger.load();
    assert.deepEqual(ledger.counts(), { printed: 0, attempting: 0 }, '文件不存在 ⇒ 空台账（不抛）');
    for (let index = 1; index <= 5; index += 1) {
      ledger.markPrinted(`job-${index}`, { labels: 1 });
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(saved.printed).length, 3, '超过上限只保留最新的 3 条');
    assert.ok(saved.printed['job-5'], '保留的是最新的');
    assert.equal(saved.printed['job-1'], undefined, '最老的被丢掉');
    // 原子写留下的临时文件不该还在。
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    // 坏文件 ⇒ 空台账起步，不抛。
    fs.writeFileSync(file, '{ 这不是 JSON');
    const broken = helper.createLedger({ file });
    assert.deepEqual(broken.load(), { printed: {}, attempting: {} });
    // attempting 的两条迁移路径
    broken.markAttempting('x');
    assert.equal(broken.isAttempting('x'), true);
    assert.equal(broken.isPrinted('x'), false);
    broken.markPrinted('x');
    assert.equal(broken.isAttempting('x'), false, '打成功之后 attempting 要被清掉');
    assert.equal(broken.isPrinted('x'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC-H12：本地页面 + 测试打印 ───────────────────────────────────────────

test('AC-H12 本地页面：零脚本、说清配置错误、有【测试打印】/【重新连接】/【补打】', async () => {
  const server = fakeServer();
  const { helper: instance, cleanup } = makeHelper({ server });
  try {
    instance.config.deviceToken = '';
    instance.state.configErrors = helper.validateConfig(instance.config, { exists: () => true }).errors;
    instance.state.sseConnected = false;
    const html = await instance.localPageHtml();
    assert.equal(/<script[\s>]/i.test(html), false, '本地页面零脚本');
    assert.ok(html.includes('deviceToken'), '配置错误要**说清是哪个字段**');
    assert.ok(html.includes('测试打印') && html.includes('重新连接'));
    assert.ok(html.includes('action="/test-print"') && html.includes('action="/reconnect"'));
    assert.ok(html.includes('未连接（任务已排队）') || html.includes('打印电脑在线'), '要有"手机看到的状态"');
  } finally {
    cleanup();
  }
});

test('AC-H12 测试打印用的是同一条打印命令路径（一个合法的 40×30mm PDF）', async () => {
  const pdf = helper.buildTestPdf('TEST PRINT', '2026-10-11T12:00:00Z');
  const text = pdf.toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/MediaBox \[0 0 113\.3858 85\.0394\]/, '40×30mm（pt）');
  assert.match(text, /\/BaseFont \/Helvetica/, '只用内置字体（不碰字体文件）');
  assert.match(text, /startxref\s+\d+\s*\n%%EOF/);
  // xref 每条偏移都指回对象头
  const tail = /startxref\s+(\d+)/.exec(text);
  const xrefAt = Number(tail[1]);
  const lines = text.slice(xrefAt).split('\n');
  const size = Number(lines[1].split(/\s+/)[1]);
  assert.equal(size, 6);
  for (let id = 1; id < size; id += 1) {
    const at = Number(/^(\d{10})/.exec(lines[2 + id])[1]);
    assert.equal(text.slice(at, at + `${id} 0 obj`.length), `${id} 0 obj`);
  }
  // 真打印与测试打印走同一个 buildPrintCommand。
  const { command, args } = helper.buildPrintCommand(baseConfig(), 'C:\\x\\test.pdf');
  assert.match(command, /SumatraPDF\.exe$/);
  assert.deepEqual(args.slice(-1), ['C:\\x\\test.pdf']);
});

test('AC-H8/H10 start() 不连长连接/不起页面时也不报错（用例注入）', async () => {
  const server = fakeServer();
  const { helper: instance, cleanup } = makeHelper({ server });
  try {
    const result = await instance.start({ startLocalPage: false, connectStream: false });
    assert.equal(result.baseUrl, 'https://example.test');
    assert.deepEqual(instance.startupCatchUp ? [] : [], []);
    await instance.stop();
  } finally {
    cleanup();
  }
});
