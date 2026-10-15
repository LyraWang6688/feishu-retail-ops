'use strict';

/**
 * deployBuildForbiddenTokensGate.test.js —— **部署闸门**里那条「非测试环境必须配禁止写入清单」的判据。
 *
 * ## 为什么有这条闸门（缺口）
 * Lead 只读核过**线上** `/opt/box2bitable/.env`：`FEISHU_V1_FORBIDDEN_APP_TOKENS` /
 * `FEISHU_V1_PROD_APP_TOKEN` **都没配** ⇒ `e2e-run.mjs` / `ws-poke-event.cjs` /
 * `ws-subscribe.cjs` 的「生产 Base」闸门**在服务器上也是空转的** ✗ ——
 * 而**服务器才是真正够得着生产 Base 的地方** ✗。
 * 这是**配置缺口、不是代码缺陷** ⇒ 固化成 `server/scripts/deploy_build.sh` 里的**只读闸门**：
 * **它自己会拦住下一次部署** ✓（与既有 `v1:schema-check:*` 同一形状：`echo` 说明 → 失败即中止 → 只读）。
 *
 * ## 钉住六条（每条都能真红）
 * - **AC-G1** 非测试环境 + 清单**未配** ⇒ **闸门红 + 人话修法**（点名两个键 + "与 … 同值"）
 * - **AC-G2** 非测试环境 + 清单**已配**（复数键 / 单数键，两种都认）⇒ **绿**（不误杀）
 * - **AC-G3** **测试环境** ⇒ **不因这条报红**（判据用仓库既有口径：`FEISHU_TARGET_ENV=test`
 *   **且** 目标 Base **逐字等于** 授权测试 Base；⚠️ 只满足一半 ⇒ **按非测试处理**〔保守〕）
 * - **AC-G4** **只读零写入**：跑这条检查前后**整个工作区（除 node_modules/.git/data）逐文件 md5 不变**
 *   ＋ 源码哨兵：这段里没有写类动作（`curl` / `git` / `pm2` / 改 `.env` 的重定向…）
 * - **AC-G5** **其余行为逐字不变**：原来的 5 行（install / schema 注释 / schema 命令 / 收尾）**逐字仍在、
 *   顺序不变**；新检查就在 schema 检查**正上方**（同一形状与位置）；`deploy_run.sh` **一行没碰**
 * - **AC-G6** 两遍全量 EXIT=0 ×2 ＋ CI 四件全绿（在交付流程里做，不在这条用例里）
 *
 * ⚠️ 全程**离线**：只跑 `--check-only`（不装依赖、不校验 schema、**不碰任何 Base**），
 *   环境变量**全部显式给**（含空串）⇒ 不受本机 `.env` / CI 碰巧有的值影响 ✓
 * ⚠️ 🔴 **绝不在服务器上跑这个闸门**（= 严禁部署）；本文件只在本地 worktree 里跑 `--check-only`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const buildGate = path.join(serverRoot, 'scripts', 'deploy_build.sh');
const runGate = path.join(serverRoot, 'scripts', 'deploy_run.sh');
const buildGateSource = fs.readFileSync(buildGate, 'utf8');

const FAKE_PROD = 'prod_base_token_for_gate_test';
const FAKE_AUTHORIZED = 'authorized_test_base_token_for_gate_test';

/**
 * 跑一次**只读**闸门（`--check-only`：不装依赖、不校验 schema、不发任何远端调用）。
 * ⚠️ 五个相关变量**全部显式给**（含空串）⇒ 被测判据只由本用例输入决定 ✓
 */
const runCheckOnly = (env) => {
  const result = spawnSync('bash', [buildGate, '--check-only'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      FEISHU_TARGET_ENV: '',
      FEISHU_V1_BITABLE_APP_TOKEN: '',
      FEISHU_V1_E2E_TEST_APP_TOKEN: '',
      FEISHU_V1_FORBIDDEN_APP_TOKENS: '',
      FEISHU_V1_PROD_APP_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
};

// ── AC-G1 非测试环境 + 未配 ⇒ 红 ─────────────────────────────────────────────
test('AC-G1 🔴 非测试环境 + 禁止写入清单未配 ⇒ 闸门红 + 人话修法', () => {
  const { status, output } = runCheckOnly({ FEISHU_V1_BITABLE_APP_TOKEN: FAKE_PROD });
  assert.notEqual(status, 0, '非测试环境没配清单必须非零退出（闸门红）');
  assert.match(output, /非测试环境/, '要说清是哪条判据红了');
  assert.match(output, /禁止写入清单/, '要点名"禁止写入清单"');
  assert.match(output, /FEISHU_V1_FORBIDDEN_APP_TOKENS/, '修法里必须点名要配哪个键');
  assert.match(output, /同值/, '修法要说清值是"与 FEISHU_V1_BITABLE_APP_TOKEN 同值"');
});

// ── AC-G2 非测试环境 + 已配 ⇒ 绿（两种键名都认）──────────────────────────────
test('AC-G2 ✅ 非测试环境 + 清单已配（复数键 / 单数键）⇒ 闸门绿（不误杀）', () => {
  const plural = runCheckOnly({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_PROD,
    FEISHU_V1_FORBIDDEN_APP_TOKENS: FAKE_PROD,
  });
  assert.equal(plural.status, 0, `复数键配了应当放行：\n${plural.output}`);
  assert.match(plural.output, /已配置/, '要如实报"已配置"');
  assert.doesNotMatch(plural.output, /prod_base_token_for_gate_test/, '🔴 不许把 token 值打印出来');

  const singular = runCheckOnly({
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_PROD,
    FEISHU_V1_PROD_APP_TOKEN: `${FAKE_PROD},another_prod_token_for_gate_test`,
  });
  assert.equal(singular.status, 0, `单数键（兼容读法）配了也应当放行：\n${singular.output}`);
  assert.match(singular.output, /2 条/, '应当如实报"配了几条"');
});

// ── AC-G3 测试环境 ⇒ 不误杀；只满足一半 ⇒ 保守 ──────────────────────────────
test('AC-G3 ✅ 测试环境（TARGET_ENV=test 且目标=授权测试 Base）⇒ 不因这条报红', () => {
  const { status, output } = runCheckOnly({
    FEISHU_TARGET_ENV: 'test',
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_AUTHORIZED,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
    // ⚠️ **故意不配**清单：测试环境本来就不该被这条拦 ✓
  });
  assert.equal(status, 0, `测试环境不该被这条拦：\n${output}`);
  assert.match(output, /不适用/, '要说清"这条闸门不适用"');
});

test('AC-G3b 🔴 只满足一半（TARGET_ENV=test 但目标 ≠ 授权测试 Base）⇒ 仍按非测试（保守，不许放行）', () => {
  const { status, output } = runCheckOnly({
    FEISHU_TARGET_ENV: 'test',
    FEISHU_V1_BITABLE_APP_TOKEN: FAKE_PROD,
    FEISHU_V1_E2E_TEST_APP_TOKEN: FAKE_AUTHORIZED,
  });
  assert.notEqual(status, 0, '判不出"这是测试环境"时必须选更保守的一边（拒绝）');
  assert.match(output, /禁止写入清单/, '应当给出同一条修法');
});

// ── AC-G4 只读零写入 ────────────────────────────────────────────────────────
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', 'data']);
/**
 * 工作区指纹：路径 → `md5 + mtimeMs`。
 * ⚠️ **必须带 mtime**：不然"把已有文件**重写一遍**"（内容一样）会被判成没变 ⇒ 漏掉一次写 ✗
 *   （**本轮真踩到**：那条变异写过一次之后，第二次跑前后 md5 相同 ⇒ AC-G4 假绿）。
 */
const snapshotTree = (root) => {
  const entries = new Map();
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SNAPSHOT_SKIP.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.isFile()) continue;
      const stat = fs.statSync(full);
      const digest = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
      entries.set(path.relative(root, full), `${digest}@${stat.mtimeMs}`);
    }
  };
  walk(root);
  return entries;
};

test('AC-G4 🔴 这条检查是只读的：跑完整个工作区逐文件 md5 不变（零写入）', () => {
  const before = snapshotTree(repoRoot);
  const { status } = runCheckOnly({ FEISHU_V1_BITABLE_APP_TOKEN: FAKE_PROD });
  const after = snapshotTree(repoRoot);
  assert.notEqual(status, 0, '（前置）这次跑的是"红"的那条分支');
  const changed = [...after.keys()].filter((key) => before.get(key) !== after.get(key));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  assert.deepEqual({ changed, added, removed }, { changed: [], added: [], removed: [] },
    `🔴 只读检查不许写任何文件（改=${changed.length} 增=${added.length} 删=${removed.length}）`);
  assert.ok(before.size > 100, `（前置）快照应当扫到整个仓库文件树（实得 ${before.size}）`);
});

test('AC-G4b 🔴 源码哨兵：这段里只有"读环境变量 / 读 .env"，没有任何写动作', () => {
  const start = buildGateSource.indexOf('check_forbidden_tokens ()');
  assert.notEqual(start, -1, '必须能定位到新检查（函数定义）');
  // ⚠️ 用**函数收尾那行**定位结尾（`' "$PROJECT_DIR/../.env"` + 顶格 `}`）——
  //    不能拿第一个 `\n}\n` 当结尾：内层 `if (...) { ... }` 的收尾也是顶格 `}` ✗
  const endMarker = "' \"$PROJECT_DIR/../.env\"\n}";
  const end = buildGateSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, '必须能定位到新检查的结尾（传 .env 路径那一行）');
  const block = buildGateSource.slice(start, end + endMarker.length);
  // ① 必须读到这几个键（判据的两个方向）
  for (const key of ['FEISHU_TARGET_ENV', 'FEISHU_V1_E2E_TEST_APP_TOKEN', 'FEISHU_V1_BITABLE_APP_TOKEN',
    'FEISHU_V1_FORBIDDEN_APP_TOKENS', 'FEISHU_V1_PROD_APP_TOKEN']) {
    assert.ok(block.includes(key), `检查里必须读 ${key}`);
  }
  assert.match(block, /process\.env/, '值必须运行期从 process.env 取');
  // ② 不许有写类动作（写 Base / 改 .env / 重启 / 联网）
  for (const forbidden of ['curl', 'wget', 'pm2', 'git ', 'rm ', 'mv ', 'tee ', 'lark-cli', '>>']) {
    assert.ok(!block.includes(forbidden), `只读检查里不许出现写/联网动作：${forbidden}`);
  }
  assert.ok(!/writeFile|appendFile|unlink|mkdir/.test(block), '不许有任何文件写 API');
});

// ── AC-G5 其余行为逐字不变 ─────────────────────────────────────────────────
test('AC-G5 ⭐ 部署脚本其余行为逐字不变（原有 5 行仍在、顺序不变；新检查就在 schema 检查正上方）', () => {
  const markers = [
    'echo "Installing dependencies..."',
    'pnpm install --frozen-lockfile',
    'echo "Validating V1 schema against the live Base..."',
    'pnpm run v1:schema-check:all',
    'echo "Build completed."',
  ];
  let cursor = -1;
  for (const marker of markers) {
    const at = buildGateSource.indexOf(marker);
    assert.notEqual(at, -1, `原有那行必须逐字还在：${marker}`);
    assert.ok(at > cursor, `原有各行的顺序不许变：${marker}`);
    cursor = at;
  }
  // 新检查紧贴在 schema 检查正上方（"同一形状与位置"）+ **在 install 之后**（要用到 dotenv）
  const checkCall = buildGateSource.indexOf('\ncheck_forbidden_tokens\n');
  const schemaLine = buildGateSource.indexOf('echo "Validating V1 schema against the live Base..."');
  const installLine = buildGateSource.indexOf('pnpm install --frozen-lockfile');
  assert.ok(checkCall > installLine && checkCall < schemaLine,
    '新检查应当在 install 之后、schema 检查正上方');
  // 原样保留的那段"部署门槛"注释也在（逐字）
  assert.ok(buildGateSource.includes('# 部署门槛：先拿即将上线的代码去核对线上多维表格的真实结构。'));
  assert.ok(buildGateSource.includes('# 校验只读，不改任何飞书数据；需要 .env 里的目标 Base 与机器人凭证。'));
});

test('AC-G5b ⭐ `deploy_run.sh` 一行没碰（既有标记仍在，且没被塞进这条新检查）', () => {
  const runSource = fs.readFileSync(runGate, 'utf8');
  for (const marker of ['--check-only', 'pm2 startOrReload ecosystem.config.js --update-env', '版本自检']) {
    assert.ok(runSource.includes(marker), `deploy_run.sh 的既有内容不许动：${marker}`);
  }
  assert.ok(!runSource.includes('check_forbidden_tokens'), '新检查只属于 deploy_build.sh，不许塞进 deploy_run.sh');
});

test('AC-G5c 未知参数 ⇒ 立刻退出 2（不静默忽略，也不误跑闸门）', () => {
  const result = spawnSync('bash', [buildGate, '--oops'], { cwd: serverRoot, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 2, '未知参数必须非零退出');
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /--oops/, '要把未知参数原样回显');
});
