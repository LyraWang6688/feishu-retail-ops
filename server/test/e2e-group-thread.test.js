'use strict';

/**
 * e2e-group-thread.test.js —— 群聊/话题六场景 E2E 脚本的**离线闸门**（不联网、不写任何表）。
 *
 * 为什么要有它：`server/scripts/e2e-group-thread.mjs` 是**真写测试 Base** 的端到端脚本，
 * 不能放进 `node --test` 里跑（它会真写表、要跑十几分钟）。但它身上有几条
 * **业务负责人定的硬纪律**是可以离线钉住的 —— 这几条一旦被改坏，后果全是"静默地
 * 用错的方式测出一个假通过"，所以值得有回归闸门：
 *
 *   ① 写入目标**不等于**授权测试 Base → 必须**拒绝运行**（生产 Base 只读）；
 *   ② 命中**禁止写入清单**（生产 app_token）→ 必须拒绝运行；
 *   ③ `FEISHU_TARGET_ENV` 不是 test → 必须拒绝运行；
 *   ④ **不许硬编码任何 token/secret**（`server/scripts/` 全目录静态扫）；
 *   ⑤ **不许用飞书 CLI**（脚本里不许出现 `lark-cli` / `lark` CLI 调用）；
 *   ⑥ 走的是**项目代码**：必须 require 项目自己的入口
 *      （`LarkMvpService.acceptMessage` / `handleCardAction` / `V1BitableGateway`），
 *      而不是自己拼 SDK 调用；
 *      ⛔ 2026-10-09：原先还要求 `PurchaseWebhookService.accept('supplier-report', …)` ——
 *        那条「信息填写」表变更入口已随整表删除退场，脚本里那两个采购场景（s4/s5）也删了。
 *   ⑦ 场景（s1/s2/s3/s6 ＋ 销售侧补充）与它们各自的验收标准都在脚本里声明了。
 *
 * ⚠️ 这里**只做只读的静态检查 + 子进程闸门**：不读飞书、不写飞书、不需要任何凭证。
 *    （闸门那一组子进程会在"任何远端调用之前"就退出。）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const scriptsDir = path.join(serverRoot, 'scripts');
const runner = path.join(scriptsDir, 'e2e-group-thread.mjs');
const runnerSource = fs.readFileSync(runner, 'utf8');

// 测试 Base 的 token 用**假值**：闸门只做字符串比对，不需要真凭证。
const FAKE_AUTHORIZED = 'test_base_token_for_gate_test';
const FAKE_FORBIDDEN = 'prod_base_token_for_gate_test';

/** 跑一次脚本，返回 { status, output }（合并 stdout+stderr）。 */
const runRunner = (env) => {
  const result = spawnSync(process.execPath, [runner, 'run'], {
    cwd: serverRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
};

// ── ① 写入目标 ≠ 授权测试 Base → 拒绝运行 ────────────────────────────────────
test('e2e-group-thread：写入目标不是授权测试 Base → 拒绝运行（生产只读）', () => {
  const { status, output } = runRunner({
    FEISHU_V1_BITABLE_APP_TOKEN: 'some_other_base_token',
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_TARGET_ENV: 'test',
  });
  assert.notStrictEqual(status, 0, '必须非零退出');
  assert.match(output, /写入目标与【授权测试 Base】不一致/, `实际输出：${output.slice(-500)}`);
  // 拒绝运行时**不许打印 token 本身**，只允许指纹
  assert.ok(!output.includes('some_other_base_token'), '拒绝信息里不能回显 token 原文');
});

// ── ② 命中禁止写入清单（生产）→ 拒绝运行 ─────────────────────────────────────
test('e2e-group-thread：app_token 命中禁止写入清单 → 拒绝运行', () => {
  const { status, output } = runRunner({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_FORBIDDEN,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_FORBIDDEN,
    FEISHU_V1_FORBIDDEN_APP_TOKENS: FAKE_FORBIDDEN,
    FEISHU_TARGET_ENV: 'test',
  });
  assert.notStrictEqual(status, 0, '必须非零退出');
  assert.match(output, /禁止写入清单/, `实际输出：${output.slice(-500)}`);
});

// ── ③ FEISHU_TARGET_ENV 不是 test → 拒绝运行 ─────────────────────────────────
test('e2e-group-thread：FEISHU_TARGET_ENV 不是 test → 拒绝运行', () => {
  const { status, output } = runRunner({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_TARGET_ENV: 'production',
    FEISHU_V1_FORBIDDEN_APP_TOKENS: '',
  });
  assert.notStrictEqual(status, 0, '必须非零退出');
  assert.match(output, /FEISHU_TARGET_ENV 必须是 test/, `实际输出：${output.slice(-500)}`);
});

// ── ④ 不许硬编码任何 token / secret（server/scripts 全目录）──────────────────
test('server/scripts 下不许硬编码飞书 token / app_id / open_id 等凭证', () => {
  const offenders = [];
  // 飞书 app_token（27 位）、app_id（cli_ 开头）、open_id（ou_ 开头）、chat_id（oc_ 开头）
  const patterns = [
    /\b(?:GqMMbh|QrXlbw)[A-Za-z0-9]{6,}/,
    /\bcli_[a-z0-9]{16,}\b/,
    /\bou_[a-f0-9]{24,}\b/,
    /\boc_[a-f0-9]{24,}\b/,
  ];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(?:mjs|cjs|js)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of patterns) {
        const hit = text.match(pattern);
        if (hit) offenders.push(`${path.relative(serverRoot, full)}: ${hit[0].slice(0, 6)}…`);
      }
    }
  };
  walk(scriptsDir);
  // ⚠️ 例外白名单：`ws-selftest.mjs` 里那个 `oc_…` 是**测试群**的 chat_id
  //（脚本自己注释写明了"这是测试群，运行期还会再判一次"），不是凭证；
  // 它也不属于"token/secret"这条红线。留在这里是为了让遗留项可见、不静默。
  const allowed = offenders.filter((line) => line.startsWith('scripts/ws-selftest.mjs: oc_'));
  const real = offenders.filter((line) => !allowed.includes(line));
  assert.deepStrictEqual(real, [], `硬编码凭证：${real.join(' / ')}`);
});

// ── ⑤ 不许用飞书 CLI ─────────────────────────────────────────────────────────
test('e2e-group-thread 脚本不许调用飞书 CLI（含"读表验证"）', () => {
  assert.ok(!/lark-cli|\blark\s+base\b|execSync\([^)]*\blark\b/.test(runnerSource),
    '脚本里出现了飞书 CLI 的痕迹（业务负责人明确禁止，包括读表验证）');
});

// ── ⑥ 必须走项目代码：项目自己的入口 ─────────────────────────────────────────
test('e2e-group-thread 走的是项目代码（项目自己的入口函数）', () => {
  const required = [
    "require('../src/services/larkMvpService')",
    'service.acceptMessage(',
    'handleCardAction(',
    'new V1BitableGateway(',
  ];
  for (const needle of required) {
    assert.ok(runnerSource.includes(needle), `缺少项目入口调用：${needle}`);
  }
});

// ── ⑦ 场景与验收标准都在脚本里声明 ──────────────────────────────────────────
test('e2e-group-thread 声明了销售侧场景 + 跑之前先打印验收标准', () => {
  // ⛔ 2026-10-09：原先还有 s4（采购报单）/ s5（采购退货）两个场景 ——
  //   它们走的入口（「信息填写」表变更）已随整表删除退场，脚本里也删了。
  for (const key of ['s1', 's2', 's3', 's6']) {
    // 场景在 ACCEPTANCE_CRITERIA 里声明（跑之前打印），并且在 cmdRun 里被真正登记
    assert.ok(new RegExp(`^  '${key} `, 'm').test(runnerSource), `缺少验收标准声明 ${key}`);
    assert.ok(runnerSource.includes(`wanted('${key}')`), `缺少场景执行分支 ${key}`);
  }
  // s1 / s6 是各自独立的 runner（s2 / s3 复用售后那条，key 由调用方传）
  for (const key of ['s1', 's6']) {
    assert.ok(runnerSource.includes(`makeScenario('${key}'`), `缺少场景 runner ${key}`);
  }
  assert.match(runnerSource, /ACCEPTANCE_CRITERIA/);
  assert.match(runnerSource, /【验收标准（跑之前写下来的/);
});
