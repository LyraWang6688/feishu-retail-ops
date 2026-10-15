'use strict';

/**
 * scriptProductionGate.test.js —— 三个自测脚本的「**生产 Base 闸门**」与「**禁硬编码凭证**」哨兵。
 *
 * ## 来历（2026-10-15 晚 · Lead 核查后收窄的口径）
 * `AGENTS.md` 第 7 条 + `docs/architecture-audit-2026-10-15.md` §3.3 第 7 项**曾经**写着：
 *   > ⚠️ 已知违规：`server/scripts/e2e-run.mjs` / `ws-poke-event.cjs` / `ws-subscribe.cjs`
 *   >   里**硬编码了生产 token 当闸门** —— **待改**
 *
 * **复核结论：这条"违规"其实早已修掉** —— 三个脚本**都从 env 读**（键名逐字见下），
 * 源码里**没有任何明文 token / secret** ⇒ `AGENTS.md` 那句**已同步成事实** ✓
 * （判据迁移：改前逐字 = 上面那段"已知违规·待改"；改后逐字 = AGENTS.md 里的"**脚本已从 env 读** +
 *   本机刻意不配 ⇒ 该闸门在本机**空转**"；依据 = **AGENTS.md 第 7 条**
 *   「不许把任何 token / secret 硬编码进源码 / 应从 `.env` 或环境变量读」✓）。
 *
 * 本文件把"事实"**钉成判据**，防它以后**悄悄失效** ✗ —— 钉住四条，**每条都能真红**：
 *   ① 三个脚本 **零明文凭证**：`cli_…` / `ou_…` / `oc_…` / `app_token: '…'` / **32+ 位引号串** = 0
 *      （变异：塞回一个字面量 ⇒ 红 ✓；文件末尾那条"哨兵自检"保证这些正则本身没烂掉）
 *   ② 闸门**从 env 读**禁写清单：源码里键名**逐字**（`FEISHU_V1_FORBIDDEN_APP_TOKENS` /
 *      `FEISHU_V1_PROD_APP_TOKEN`）+ 取值经过 `process.env`
 *   ③ 行为：目标 app_token **命中禁写清单** ⇒ `ws-poke-event.cjs` / `ws-subscribe.cjs`
 *      **拒绝执行**（且**在任何远端调用之前**就退出）
 *   ④ 行为：**没配清单** ⇒ 如实打一条「**本机这道闸门是空转的**」warn（看得见；原先只写在注释里 ✗）
 *
 * ## 边界（为什么不联网、不碰 Base）
 * ③④ 两条走的都是脚本**最前面**的那道闸门（在 `lark.Client` / `V1BitableGateway` 之前）⇒
 * 拒绝与告警都发生在**任何远端调用之前** ✓。本文件**只做离线检查**：不读飞书、不写飞书、不要真凭证。
 *
 * ⚠️ `e2e-run.mjs` 的**同类行为**（目标 ≠ 授权测试 Base / 命中禁写清单 / `FEISHU_TARGET_ENV` ≠ test
 *    ⇒ 拒绝运行）已由**既有** `server/test/e2eHygiene.test.js` 的 ①②③ 逐字钉着 ——
 *    本文件**不重复、也不动那些用例** ✓，只补它没覆盖的两件事（`ws-*` 两个脚本的行为 + 32+ 位疑似串）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const scriptsDir = path.join(serverRoot, 'scripts');

/** 被审的三个脚本（= AGENTS.md 第 7 条点名的那三个）。 */
const GUARDED_SCRIPTS = ['e2e-run.mjs', 'ws-poke-event.cjs', 'ws-subscribe.cjs'];
/** 会**发远端调用**的两个（`e2e-run.mjs` 的 inspect 是只读且另有闸门 ⇒ 不在这里跑）。 */
const WRITING_SCRIPTS = ['ws-poke-event.cjs', 'ws-subscribe.cjs'];

const readScript = (name) => fs.readFileSync(path.join(scriptsDir, name), 'utf8');

// ── ① 零明文凭证 ─────────────────────────────────────────────────────────────
/**
 * 明文凭证的**形状**（与 `e2eHygiene.test.js` ④ 同一族，外加"32+ 位引号串"这一维）：
 * ⚠️ 不检查 `chat_id`（`oc_…`）在 `ws-selftest.mjs` 里的那条**已登记例外** —— 那不在本次三个文件里 ✗。
 */
const PLAINTEXT_PATTERNS = [
  { re: /cli_[a-z0-9]{12,}/i, what: '飞书应用 app_id（cli_…）' },
  { re: /ou_[a-z0-9]{12,}/i, what: 'open_id（ou_…）' },
  { re: /oc_[a-z0-9]{12,}/i, what: 'chat_id（oc_…）' },
  { re: /(?:app_token|appToken|secret|Secret)\s*[:=]\s*['"][A-Za-z0-9_-]{10,}['"]/, what: '硬编码的 app_token / secret 字面量' },
  { re: /['"][A-Za-z0-9_-]{32,}['"]/, what: '32 位以上的疑似 token / secret 引号串' },
];

test('① 🔴 三个脚本里**零明文 token / secret**（塞回一个字面量就红）', () => {
  const offenders = [];
  for (const name of GUARDED_SCRIPTS) {
    const source = readScript(name);
    for (const { re, what } of PLAINTEXT_PATTERNS) {
      const hit = source.match(re);
      if (hit) offenders.push(`scripts/${name} → ${what}：${hit[0].slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `🔴 这三个脚本里不许出现明文凭证（应从 env 读，AGENTS.md 第 7 条）：\n${offenders.join('\n')}`);
});

test('①b ⭐ 哨兵自检：上面那几条正则**真的抓得到**硬编码（防止哨兵自己烂成空转）', () => {
  // 故意在"样例"上长成被禁的样子（**不是仓库里的真值**，只是形状）——抓不到就说明规则写废了 ✗
  const samples = [
    ['cli_abcdefghijklmnop', 0],
    ['ou_abcdefghijklmnop', 1],
    ['oc_abcdefghijklmnop', 2],
    ["const app_token = 'fakeAppTokenValue123'", 3],
    ["const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789'", 4],
  ];
  for (const [sample, index] of samples) {
    assert.equal(PLAINTEXT_PATTERNS[index].re.test(sample), true,
      `第 ${index} 条规则必须抓得到样例：${sample}`);
  }
});

// ── ② 闸门从 env 读（源码哨兵，键名逐字）─────────────────────────────────────
test('② ⭐ 闸门**从 env 读**禁写清单：两个键名逐字在三个脚本里，且取值经过 `process.env`', () => {
  for (const name of GUARDED_SCRIPTS) {
    const source = readScript(name);
    assert.ok(source.includes('FEISHU_V1_FORBIDDEN_APP_TOKENS'),
      `scripts/${name}：必须从 env 读 \`FEISHU_V1_FORBIDDEN_APP_TOKENS\`（禁写清单）`);
    assert.ok(source.includes('FEISHU_V1_PROD_APP_TOKEN'),
      `scripts/${name}：必须保留单数形式 \`FEISHU_V1_PROD_APP_TOKEN\` 这条兼容读法`);
    assert.match(source, /process\.env\.FEISHU_V1_FORBIDDEN_APP_TOKENS|process\.env\[('|")FEISHU_V1_FORBIDDEN_APP_TOKENS/,
      `scripts/${name}：禁写清单的值必须**运行期**从 \`process.env\` 取（不许是字面量）`);
  }
});

// ── ③ 行为：命中禁写清单 ⇒ 拒绝执行（且在任何远端调用之前）────────────────────
const runScript = (name, env) => spawnSync(process.execPath, [path.join(scriptsDir, name)], {
  cwd: serverRoot,
  env: {
    ...process.env,
    // ⚠️ 两个键都显式给（含空串）⇒ 不受本机 `.env` / CI 环境里碰巧有的值影响 ✓
    FEISHU_V1_FORBIDDEN_APP_TOKENS: '',
    FEISHU_V1_PROD_APP_TOKEN: '',
    LARK_TEST_APP_ID: '',
    LARK_TEST_APP_SECRET: '',
    LARK_AGENT_APP_ID: '',
    ...env,
  },
  encoding: 'utf8',
  timeout: 60_000,
});

test('③ 🔴 目标 app_token 命中禁写清单 ⇒ 两个脚本都**拒绝执行**（离线：闸门在远端调用之前）', () => {
  const forbidden = 'forbidden_base_token_for_gate_test';
  for (const name of WRITING_SCRIPTS) {
    const result = runScript(name, {
      FEISHU_V1_BITABLE_APP_TOKEN: forbidden,
      FEISHU_V1_FORBIDDEN_APP_TOKENS: forbidden,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.match(output, /拒绝执行/, `${name}：命中禁写清单必须**拒绝执行**`);
    assert.match(output, /禁止写入清单/, `${name}：要把"为什么拒绝"说清楚（禁止写入清单）`);
    assert.notEqual(result.status, 0, `${name}：拒绝时必须非零退出`);
    // 🔴 关键：**还没有走到远端**（闸门在 `lark.Client` / `V1BitableGateway` 之前）
    assert.doesNotMatch(output, /缺少测试应用凭证/, `${name}：应当在"凭证检查"之前就拒绝（说明闸门在最前面）`);
    assert.doesNotMatch(output, /订阅结果|EVENT_PROBE_CREATED/, `${name}：拒绝时**不许**已经发过远端调用`);
  }
});

// ── ④ 行为：没配清单 ⇒ "空转"看得见 ─────────────────────────────────────────
test('④ ⭐ 没配禁写清单 ⇒ 如实打一条「本机这道闸门是空转的」warn（不再是只写在注释里）', () => {
  for (const name of WRITING_SCRIPTS) {
    const result = runScript(name, { FEISHU_V1_BITABLE_APP_TOKEN: 'test_base_token_for_gate_test' });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.match(output, /闸门是空转的/, `${name}：没配清单时必须**如实提示空转**（看得见）`);
    assert.match(output, /FEISHU_V1_FORBIDDEN_APP_TOKENS/, `${name}：提示里要点名是哪个键没配`);
    // 仍然**不联网**：缺测试凭证 ⇒ 在远端调用之前退出 ✓
    assert.match(output, /缺少测试应用凭证/, `${name}：空转之后应停在"缺测试凭证"这一步（离线）`);
    assert.doesNotMatch(output, /订阅结果|EVENT_PROBE_CREATED/, `${name}：这条路径也不许真的发出去`);
  }
});

// ── ⑤ 交叉引用：另两个键（授权测试 Base）在 e2e-run 里也逐字在 ────────────────
test('⑤ ⭐ `e2e-run.mjs` 的保守闸门键逐字在（授权测试 Base）—— 行为由既有 e2eHygiene ①②③ 钉着', () => {
  const source = readScript('e2e-run.mjs');
  assert.ok(source.includes('FEISHU_V1_E2E_TEST_APP_TOKEN'),
    'e2e-run.mjs：必须保留「授权可写的测试 Base」这个键（它的保守闸门就靠它）');
  assert.ok(source.includes('FEISHU_TARGET_ENV'), 'e2e-run.mjs：必须保留 FEISHU_TARGET_ENV 那道检查');
  // 老实说清：**取不到授权测试 Base ⇒ 拒绝**这条判据的验收在**既有**用例里（本文件不重复）
  const hygiene = fs.readFileSync(path.join(__dirname, 'e2eHygiene.test.js'), 'utf8');
  assert.ok(hygiene.includes('不等于授权的测试 Base'),
    '既有 e2eHygiene.test.js 必须仍在钉「不等于授权的测试 Base ⇒ 拒绝运行」');
});
