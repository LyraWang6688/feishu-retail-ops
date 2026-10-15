'use strict';

/**
 * e2eHygiene.test.js —— **自测脚本的离线闸门**（不联网、不写任何表）。
 *
 * 来历：原先这份闸门挂在 `server/scripts/e2e-group-thread.mjs`（群聊/话题六场景 E2E）上；
 * 2026-10-12 **群聊入口整体退场**，那个脚本与它的场景一起删除 ——
 * 但脚本身上的几条**业务负责人定的硬纪律**必须继续被钉住（它们与"跑哪条链路"无关，
 * 讲的是"**怎么跑才安全**"）⇒ 按她的决定**迁到现行入口的自测脚本**上：
 * `server/scripts/e2e-run.mjs`（扫码/销售链路的本地端到端自测）。
 *
 * 钉住的五条（一旦被改坏，后果全是"静默地用错的方式测出一个假通过"）：
 *   ① 写入目标 ≠ 授权测试 Base → **拒绝运行**（生产 Base 只读）；
 *   ② 命中**禁止写入清单**（生产 app_token）→ **拒绝运行**；
 *   ③ `FEISHU_TARGET_ENV` 不是 test → **拒绝运行**；
 *   ④ **不许硬编码任何 token/secret**（`server/scripts/` 全目录静态扫）；
 *   ⑤ **不许用飞书 CLI**（脚本里不许出现 `lark-cli` / `lark` CLI 调用）。
 *   ⑥ 走的是**项目代码**：必须 require 项目自己的模块（不是自己拼 SDK 直连）。
 *
 * ⚠️ 这里**只做只读的静态检查 + 子进程闸门**：不读飞书、不写飞书、不需要真凭证
 *    （闸门在**任何远端调用之前**就退出）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const scriptsDir = path.join(serverRoot, 'scripts');
// ⭐ 2026-10-12（e2e-author 收口）：真写 E2E 也住 `server/e2e/**`（新套件 `e2e/real-paths.mjs`）——
//    只扫 `server/scripts/` 的话，它**整份逃出**「禁硬编码凭证 / 禁 CLI」两条静态闸门。
//    ⇒ 两个 walk 一起扫这两个根目录。
const e2eDir = path.join(serverRoot, 'e2e');
const SCAN_ROOTS = [scriptsDir, e2eDir].filter((dir) => fs.existsSync(dir));
const runner = path.join(scriptsDir, 'e2e-run.mjs');
const runnerSource = fs.readFileSync(runner, 'utf8');

// token 用**假值**：闸门只做字符串比对，不需要真凭证。
const FAKE_AUTHORIZED = 'test_base_token_for_gate_test';
const FAKE_OTHER = 'some_other_base_token';

/**
 * 跑一次闸门。⚠️ 用**只读子命令 `inspect`**（`e2e-run.mjs` 的只读出口），
 * 且**故意让闸门失败** ⇒ 它在任何远端调用之前就退出。
 * ⚠️ 判据看 **输出**（"拒绝运行"），不看 exit code：`e2e-run.mjs` 的收尾
 * `process.exitCode` 在 `then` 链里设置，闸门抛错时命令行仍可能是 0。
 */
/**
 * ⚠️ 必须补上**假的应用凭证**（`LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET`）。
 *
 * 为什么：`e2e-run.mjs inspect` 的第一行是 `createClient()`，它**在 `guardEnvironment`
 * 之前**就要求凭证齐全 —— 缺了会先抛「新飞书应用必须同时配置 LARK_AGENT_APP_ID 和
 * LARK_AGENT_APP_SECRET」，**根本走不到我们要验的那道闸门**。
 * ⚠️ 本机有 `.env`（CI 没有）⇒ 这一条在**本机是"假绿"**、在 CI 是红的
 *   （2026-10-12 真实踩到：#331 CI 3 条红，本地 1862 全绿）。
 * ⇒ 修法：**在子进程环境里显式给一对假凭证**，把"与被测闸门无关的前置条件"补齐；
 *   **断言一个字没放宽**（仍然要求输出里出现那道闸门的原话）。
 */
const FAKE_APP_ID = 'cli_fake_for_gate_test';
const FAKE_APP_SECRET = 'fake_app_secret_for_gate_test';

const runInspect = (env) => {
  const result = spawnSync(process.execPath, [runner, 'inspect'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      LARK_AGENT_APP_ID: FAKE_APP_ID,
      LARK_AGENT_APP_SECRET: FAKE_APP_SECRET,
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
};

// ── ① 写入目标 ≠ 授权测试 Base → 拒绝运行 ────────────────────────────────────
test('e2e-run：写入目标不是授权测试 Base → 拒绝运行（生产只读）', () => {
  const output = runInspect({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_OTHER,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_TARGET_ENV: 'test',
    FEISHU_V1_FORBIDDEN_APP_TOKENS: '',
  });
  assert.match(output, /拒绝运行/, 'app_token 不等于授权测试 Base 时必须拒绝运行');
  assert.match(output, /不等于授权的测试 Base/, '要把"为什么拒绝"说清楚');
});

// ── ② 命中禁止写入清单 → 拒绝运行（早于任何远端调用）────────────────────────
test('e2e-run：app_token 命中禁止写入清单 → 拒绝运行', () => {
  const output = runInspect({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_OTHER,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_OTHER,
    FEISHU_V1_FORBIDDEN_APP_TOKENS: FAKE_OTHER,
    FEISHU_TARGET_ENV: 'test',
  });
  assert.match(output, /禁止写入清单/, '命中禁止清单必须拒绝');
  assert.match(output, /拒绝运行/, '必须是"拒绝运行"，不是"警告后照跑"');
});

// ── ③ FEISHU_TARGET_ENV 不是 test → 拒绝运行 ────────────────────────────────
test('e2e-run：FEISHU_TARGET_ENV 不是 test → 拒绝运行', () => {
  const output = runInspect({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_V1_FORBIDDEN_APP_TOKENS: '',
    FEISHU_TARGET_ENV: 'prod',
  });
  assert.match(output, /FEISHU_TARGET_ENV 不是 test/, '环境标记不是 test 必须拒绝');
});

// ── ④ `server/scripts/` 全目录：不许硬编码凭证 ──────────────────────────────
// ⚠️ 唯一的**已登记例外**（AGENTS.md 第 7 条"已知违规 · 待改"）：
//    `ws-selftest.mjs` 里 `ALLOWED_CHAT_ID = 'oc_…'`（它是长连接自测的白名单群 id）。
//    它与本次"清群聊入口"无关、也不该由本次顺手改（改它=动另一个方向的脚本），
//    ⇒ 这里**显式登记为例外并写明原因**，而不是把规则放宽成"不检查 chat_id"
//      （那样将来新写的硬编码就漏了）。
const KNOWN_CREDENTIAL_EXCEPTIONS = Object.freeze({
  'ws-selftest.mjs': 'AGENTS.md 第 7 条已登记的"已知违规·待改"：长连接自测的 ALLOWED_CHAT_ID 白名单群 id',
});

test('server/scripts 与 server/e2e 下不许硬编码飞书 token / app_id / open_id 等凭证（已登记例外除外）', () => {
  const offenders = [];
  const patterns = [
    { re: /cli_[a-z0-9]{12,}/i, what: '飞书应用 app_id（cli_…）' },
    { re: /ou_[a-z0-9]{12,}/i, what: 'open_id（ou_…）' },
    { re: /oc_[a-z0-9]{12,}/i, what: 'chat_id（oc_…）' },
    { re: /(?:app_token|appToken)\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/, what: '硬编码的 app_token 字面量' },
  ];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      if (KNOWN_CREDENTIAL_EXCEPTIONS[entry.name]) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const { re, what } of patterns) {
        if (re.test(source)) offenders.push(`${path.relative(serverRoot, full)} → ${what}`);
      }
    }
  };
  for (const dir of SCAN_ROOTS) walk(dir);
  assert.deepEqual(offenders, [],
    `scripts/ 与 e2e/ 下出现了硬编码凭证（应从 .env / 环境变量读）：\n${offenders.join('\n')}`);
});

// ── ⑤ 不许用飞书 CLI ────────────────────────────────────────────────────────
test('server/scripts 与 server/e2e 下不许调用飞书 CLI（含"读表验证"）', () => {
  const offenders = [];
  const patterns = [
    /\blark-cli\b/, /\blark_cli\b/, /['"`]lark['"`]\s+(?:base|im|doc|sheet)\b/,
  ];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (patterns.some((re) => re.test(source))) offenders.push(path.relative(serverRoot, full));
    }
  };
  for (const dir of SCAN_ROOTS) walk(dir);
  assert.deepEqual(offenders, [],
    `scripts/ 与 e2e/ 下出现了飞书 CLI 调用（业务负责人明确禁止）：${offenders.join(', ')}`);
});

// ── ⑥ 走项目代码：require 项目自己的模块，不自己拼 SDK ─────────────────────
test('e2e-run 走的是项目代码（require 项目自己的服务 / 网关）', () => {
  // 现行入口 = 扫码页 + 销售/库存/采购共享层：脚本必须直接用它们。
  // ⚠️ `e2e-run.mjs` 是 `.mjs`，用 `createRequire` 之后的 **CJS `require`** 加载项目代码
  //    （见它第 89-96 行），所以这里匹配 `require('…/src/…')` 而不是 ESM `from`。
  for (const expected of [
    /require\(\s*['"][^'"]*\/src\/services\//,
    /require\(\s*['"][^'"]*\/src\/config\//,
  ]) {
    assert.match(runnerSource, expected, `e2e-run.mjs 必须 require 项目代码：${expected}`);
  }
  // 闸门本体必须在（不是只有注释）：三处拒绝运行都要有实现。
  for (const gate of [
    /未配置 FEISHU_V1_BITABLE_APP_TOKEN，拒绝运行/,
    /禁止写入清单/,
    /FEISHU_TARGET_ENV 不是 test，拒绝运行/,
  ]) {
    assert.match(runnerSource, gate, `e2e-run.mjs 缺闸门实现：${gate}`);
  }
  // ⚠️ 群聊入口已退场：那个脚本与它的场景不该再回来。
  assert.equal(fs.existsSync(path.join(scriptsDir, 'e2e-group-thread.mjs')), false,
    'e2e-group-thread.mjs 应已删除（群聊入口 2026-10-12 退场）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-12（独立复核 agent 挑出的 F-1 / F-2 / F-3 / F-5 / F-6 / F-9）
//    这一批钉的是"**别假绿、别误伤生产、别误发真群**"。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-H1（F-1/F-2）报告与退出码集中在纯函数里：失败 ⇒ 非零；跳过必须落报告', async () => {
  const report = await import(path.join(serverRoot, 'scripts', 'lib', 'e2e-report.mjs'));
  const scenarios = [
    { name: 'ok', checks: [{ pass: true }] },
    { name: 'bad', checks: [{ pass: true }, { pass: false }] },
  ];
  const skipped = [{ name: 'no-data', reason: '测试 Base 里缺少可用数据' }];
  const summary = report.summarize({ scenarios, skipped });
  assert.deepEqual(summary, { ran: 2, failed: 1, passed: 1, skipped: 1, total: 3 },
    '汇总要分别给出 跑过/通过/未达标/跳过（原来只数跑了的 ⇒ 像全覆盖）');
  assert.equal(report.exitCodeFor({ failed: summary.failed }), 1, '有未达标 ⇒ **非零退出**（F-1）');
  assert.equal(report.exitCodeFor({ failed: 0 }), 0);
  assert.equal(report.exitCodeFor({ failed: 0, error: true }), 2, '脚本自身报错 ⇒ 2');
  const payload = report.buildReport({ base: 'base_x', scenarios, skipped });
  assert.deepEqual(payload.skipped, [{ name: 'no-data', reason: '测试 Base 里缺少可用数据' }],
    '报告里必须有 skipped（带原因）——F-2');
  assert.match(report.summaryLine(summary), /跑过 2 个.*未达标 1.*跳过 1 个/,
    '汇总那一行要**分别**说清跑过/跳过/失败');
});

test('AC-H2（F-1/F-2）群场景脚本：用了那个纯函数（不能自己算一套、退出码不能丢）', async () => {
  // 🔴 2026-10-16（「与 AI 分析有关的都停掉」）：这个脚本**已整体删除** ——
  //    ① 它驱动的是 **2026-10-12 已退场的群聊销售入口**；
  //    ② 它 import 的 `config/afterSalesFlow`（本次已删）里那两个符号
  //       （`AFTER_SALES_CARD_ACTIONS` / `AFTER_SALES_TASK_STATUS`）**本来就不在那份配置的导出里**
  //       ⇒ 这个脚本**在改动前就已经跑不起来了**（import 之后一用就是 undefined）。
  //    ⇒ 与 AC-H3 同一条既成口径（"已归档/删除 ⇒ 也算处置过"）：**文件不在就跳过** ✓
  //    依据=业务负责人 2026-10-16 逐字「**连代码一起删**」。
  const file = path.join(scriptsDir, 'e2e-sales-group-scenarios.mjs');
  if (!fs.existsSync(file)) return;                           // 已归档/删除 ⇒ 也算处置过
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes("scripts/lib/e2e-report.mjs") || source.includes('./lib/e2e-report.mjs'),
    '群场景脚本要 import 那个报告/退出码模块（唯一判定处）');
  assert.ok(/process\.exitCode\s*=\s*exitCodeFor\(/.test(source),
    '退出码必须走 `exitCodeFor(...)`（F-1：原来算了 failedCount 却 exit 0）');
  assert.ok(/buildReport\(/.test(source) && /skipped/.test(source),
    '报告体要走 `buildReport(...)`（含 skipped）（F-2）');
});

test('AC-H3（F-3）驱动"已退场的群入口"的两个老脚本：必须**当场说清原因**，不许超时+误导', async () => {
  for (const name of ['e2e-sales-status.mjs', 'e2e-sales-group-scenarios.mjs']) {
    const file = path.join(scriptsDir, name);
    if (!fs.existsSync(file)) continue;                       // 已归档/删除 ⇒ 也算处置过
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(/群(聊)?入口.*(已)?退场|ARCHIVED_GROUP_SCRIPTS|群入口已退场/.test(source),
      `${name}：必须在文件顶部写清"群入口已退场"这件事`);
    assert.ok(/FEISHU_E2E_ARCHIVED_GROUP_SCRIPTS/.test(source),
      `${name}：要有显式开关才能继续跑（默认**当场退出**，不许跑到超时才报"解析超时"那种误导原因）`);
  }
});

test('AC-H4（F-5）e2e-run 打印 Base 时**只打指纹**，绝不打印 app_token 明文', () => {
  assert.equal(/say\(`\s*Base app_token：\$\{appToken\}/.test(runnerSource), false,
    'F-5：不许 `say(`Base app_token：${appToken}`)` —— 日志/截图会漏 token');
  assert.ok(/tokenFingerprint\(/.test(runnerSource), '要用既有的 `tokenFingerprint()`');
});

test('AC-H5（F-6）闸门必须在创建客户端**之前**（缺凭证也要先被闸门挡住）', () => {
  const order = [...runnerSource.matchAll(/guardEnvironment\([^)]*\)|createClient\(\{[^}]*\}\)/g)]
    .map((match) => (match[0].startsWith('guardEnvironment') ? 'guard' : 'client'));
  assert.ok(order.length >= 4, `至少三处子命令 + 定义，实际匹配到 ${order.length} 处`);
  // 每一处 `createClient` 之前**必须**已经出现过一次 `guard`（同一个子命令里的顺序）
  let guards = 0;
  for (const step of order) {
    if (step === 'guard') { guards += 1; continue; }
    assert.ok(guards > 0, 'F-6：`createClient()` 出现在任何 `guardEnvironment()` 之前 ⇒ 缺凭证时走不到闸门');
  }
});

test('AC-H6（F-9）`--real-im` 必须显式开闸才生效（默认**禁止**发真群）', () => {
  // 🔴 2026-10-16：脚本已整体删除 ⇒ **文件不在就跳过**（口径同 AC-H2 / AC-H3）✓
  const file = path.join(scriptsDir, 'e2e-sales-group-scenarios.mjs');
  if (!fs.existsSync(file)) return;                           // 已归档/删除 ⇒ 也算处置过
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(/FEISHU_E2E_ALLOW_REAL_IM/.test(source),
    'F-9：本机 .env 里有**真实**的群/机器人 id ⇒ `--real-im` 要再用一个显式环境变量开闸');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-12（e2e-author 收口）：**新套件** `server/e2e/real-paths.mjs` 的防假绿闸门。
//    为什么单列一条：它住在 `server/e2e/`（不在上面两条静态扫描的旧范围里，现已并入），
//    而且是**唯一一条真写真飞书的销售/售后/采购 E2E** ⇒ 它假绿 = 发版证据假绿。
// ═══════════════════════════════════════════════════════════════════════════
test('AC-H7（F-1/F-2）新套件：退出码走 exitCodeFor、跳过落报告、不许 t.todo', () => {
  const realPaths = path.join(e2eDir, 'real-paths.mjs');
  assert.ok(fs.existsSync(realPaths), 'server/e2e/real-paths.mjs 应存在（真写 E2E 套件）');
  const source = fs.readFileSync(realPaths, 'utf8');
  // ① 报告体与汇总走**共用纯函数**（与 `e2e-sales-group-scenarios.mjs` 同一处判定）
  assert.ok(/from '\.\.\/scripts\/lib\/e2e-report\.mjs'/.test(source),
    'AC-H7①：要 import `scripts/lib/e2e-report.mjs`（唯一判定处），别自己再算一套');
  assert.ok(/buildReport\(/.test(source) && /summaryLine\(/.test(source),
    'AC-H7①：报告体与汇总行要走 `buildReport` / `summaryLine`');
  // ② 退出码必须由 `exitCodeFor` 决定（F-1：算了未达标数却 exit 0 是最典型的假绿）
  assert.ok(/process\.exitCode\s*=\s*[^;]*exitCodeFor\(/.test(source),
    'AC-H7②：退出码必须走 `exitCodeFor(...)`（未达标 ⇒ 非 0）');
  // ③ 跳过必须进 `skipped`（`report.json` 里有 skipped:[{name,reason}]）——只打控制台不算
  assert.ok(/skipped\.push\(\s*\{\s*name/.test(source),
    'AC-H7③：跳过项要 `skipped.push({ name, reason })`（只打一句控制台 ⚠️ 不算证据）');
  assert.ok(/buildReport\(\{[^}]*skipped/s.test(source) && /summarize\(\{[^}]*skipped/s.test(source),
    'AC-H7③：`skipped` 必须真的传进 `buildReport` / `summarize`（否则报告里没有它）');
  // ④ 🔴 **不许 `t.todo`**：本轮口径是"未覆盖就诚实跳过 + 落报告"，`todo` 既不计失败也不进报告
  assert.equal(/\.todo\(/.test(source), false,
    'AC-H7④：`node:test` 的 `t.todo` 不影响退出码、也不进报告 ⇒ 一律用 `t.skip` + `skipped.push`');
  // ⑤ 报告里不许出现明文 token：base 只放指纹
  assert.ok(/base:\s*fingerprint\(/.test(source),
    'AC-H7⑤：报告的 `base` 只放指纹（报告会被当证据存档，明文 token 不许进文件）');
});
