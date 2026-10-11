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
const runInspect = (env) => {
  const result = spawnSync(process.execPath, [runner, 'inspect'], {
    cwd: serverRoot,
    env: { ...process.env, ...env },
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

test('server/scripts 下不许硬编码飞书 token / app_id / open_id 等凭证（已登记例外除外）', () => {
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
  walk(scriptsDir);
  assert.deepEqual(offenders, [],
    `scripts/ 下出现了硬编码凭证（应从 .env / 环境变量读）：\n${offenders.join('\n')}`);
});

// ── ⑤ 不许用飞书 CLI ────────────────────────────────────────────────────────
test('server/scripts 下不许调用飞书 CLI（含"读表验证"）', () => {
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
  walk(scriptsDir);
  assert.deepEqual(offenders, [],
    `scripts/ 下出现了飞书 CLI 调用（业务负责人明确禁止）：${offenders.join(', ')}`);
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
