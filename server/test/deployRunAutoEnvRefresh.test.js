// 部署脚本 `deploy_run.sh` 里「部署后自检失败 → 自动刷一次 env → 再自检一次」这段行为。
//
// 为什么要有它：这条坑 2026-10-07 出现、2026-10-08 同一天又复现两次
// （`pm2 startOrReload ecosystem.config.js --update-env` 回 ✓ 但进程里的 `APP_*` 没换新，
//  `/health` 于是报旧 commit）。业务负责人 2026-10-08 拍板把它做进脚本：
// 「自检失败时自动带上正确的版本号再刷一次 env，然后重新自检（只重试一次，仍失败就照旧报红、不循环不静默）」。
//
// 这是**部署关键脚本**，所以不靠"读一遍觉得对"，而是用**假的 pm2 / 假的 curl** 真跑一遍：
//   ① 一开始就对上 → 退出码 0，且**不**重启（不白刷 env）；
//   ② 第一次对不上、刷完 env 后对上 → 退出码 0，restart 恰好一次，且用的是 ecosystem 里的应用名；
//   ③ 刷完仍对不上 → 退出码 1，restart **仍然只有一次**（绝不循环重启线上）；
//   ④ `--check-only` 的语义是"只自检、不重启" ⇒ 既不起服务也不自动刷 env。
//
// ⚠️ 只用 stub，不碰真实 pm2、不碰线上：PATH 前面插一个临时 bin 目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const { apps } = require('../ecosystem.config.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'deploy_run.sh');
const REPO = path.join(__dirname, '..', '..');
const APP_NAME = apps[0].name;

/**
 * ⭐ 2026-10-12 稳定性修复：哨兵**不再读"当下 git 状态"两次**（那次全量跑偶发红的真机制）。
 *
 * 老写法（跑全量偶发红，2026-10-12 实测 1 次）：
 *   测试文件**模块加载时**读一次 `git describe --tags` / `rev-parse --short HEAD`，
 *   而脚本**运行时**自己再读一次；两次之间仓库状态只要动一下
 *   （别人 commit / 发版打 tag / 同一 worktree 里 `git pull`），断言里的版本号就对不上 ⇒ 红。
 *   实测窗口 ≈ **6.5s**（哨兵是第 6 条用例，前面 5 条先跑完）。
 *   ⚠️ 与「跨分钟 / 当下时间」**无关**：`deploy_run.sh` 里 `date` 只被读 **1 次**，
 *     而且是拿它跟它自己（脚本 export → 假 curl 抄回来）比。
 *     证伪实验：把 `date` 换成"每次调用都返回不同时间"的假实现，哨兵照样绿。
 *     真正能把它弄红的是"T0→T1 之间仓库状态动一下"（加 tag / commit），已确定性复现。
 *
 * 现在：**注入固定的 git 状态** —— 造一个临时 git 仓库（固定 tag + 固定 commit），
 * 把**真实的** `deploy_run.sh` 软链进去；`$0` 的目录决定脚本的 `REPO_DIR`，
 * 于是它算的是**这个临时仓库**的版本号，跑的过程中绝不会变 ⇒ 与环境无关
 * （CI 浅克隆、无 tag 也不受影响，因为 tag 是这里自己建的）。
 */
const PINNED_VERSION = 'v9.9.9-pinned';

const makePinnedRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-run-repo-'));
  fs.mkdirSync(path.join(dir, 'server', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'server', 'ecosystem.config.js'),
    path.join(dir, 'server', 'ecosystem.config.js'));
  // ⚠️ 软链**真实脚本**（不复制）：测的永远是仓库里那一份，不会漂。
  fs.symlinkSync(SCRIPT, path.join(dir, 'server', 'scripts', 'deploy_run.sh'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'pinned@local');
  git('config', 'user.name', 'pinned');
  git('commit', '-q', '--allow-empty', '-m', 'pinned');
  git('tag', PINNED_VERSION);
  return {
    dir,
    script: path.join(dir, 'server', 'scripts', 'deploy_run.sh'),
    version: PINNED_VERSION,
    commit: git('rev-parse', '--short', 'HEAD'),
  };
};
const OLD_COMMIT = 'deadbee';

/**
 * 造一个临时 harness：bin/ 里放假的 pm2 与假的 curl。
 *   mode = 'always-new'              → /health 一直回报"新版本"（不需要重启）
 *          'after-restart'           → 只有在 pm2 restart 之后才回报"新版本"（自动刷 env 能救）
 *          'always-old'              → 永远回报"旧版本"（自动刷 env 也救不了）
 */
const makeHarness = (mode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-run-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'pm2.calls');
  const restarted = path.join(dir, 'restarted');
  fs.writeFileSync(calls, '');

  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/bash
printf '%s\\n' "$*" >> ${calls}
if [ "$1" = "restart" ]; then : > ${restarted}; fi
exit 0
`, { mode: 0o755 });

  // 假 /health：`APP_*` 是脚本 export 出来的，stub 直接抄（这样"新版本"一定与脚本期望值相等）
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
new_health() {
  printf '{"status":"ok","version":"%s","commit":"%s","deployed_at":"%s"}' "$APP_VERSION" "$APP_COMMIT" "$APP_DEPLOYED_AT"
}
old_health() {
  printf '{"status":"ok","version":"v0.0.1","commit":"${OLD_COMMIT}","deployed_at":"2026-01-01T00:00:00+08:00"}'
}
case "${mode}" in
  always-new) new_health ;;
  after-restart) if [ -f ${restarted} ]; then new_health; else old_health; fi ;;
  *) old_health ;;
esac
`, { mode: 0o755 });

  return { dir, bin, calls };
};

const runScript = (harness, args = [], extraEnv = {}, scriptPath = SCRIPT) => spawnSync('bash', [scriptPath, ...args], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${harness.bin}:${process.env.PATH}`,
    DEPLOY_HEALTH_RETRIES: '1',
    DEPLOY_HEALTH_INTERVAL: '1',
    DEPLOY_HEALTH_AUTO_REFRESH_WAIT: '0',
    ...extraEnv,
  },
});

const callsOf = (harness) => fs.readFileSync(harness.calls, 'utf8').trim().split('\n').filter(Boolean);

test('① 一开始就对上：退出码 0，而且**不**去重启（不白刷 env）', () => {
  const harness = makeHarness('always-new');
  const result = runScript(harness);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /✅ 部署后自检通过/);
  const calls = callsOf(harness);
  assert.deepEqual(calls, ['startOrReload ecosystem.config.js --update-env'],
    '只应该有 startOrReload，不许有 restart');
});

test('② 第一次对不上 → 自动刷一次 env 后对上：退出码 0，restart 恰好一次、用 ecosystem 里的应用名', () => {
  const harness = makeHarness('after-restart');
  const result = runScript(harness);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /自动带上正确的版本号刷一次 env/,
    '自动刷 env 的提示走 stderr（是警告，不是成功输出）');
  assert.match(result.stdout, /✅ 部署后自检通过（自动刷 env 之后）/);
  const calls = callsOf(harness);
  assert.deepEqual(calls, [
    'startOrReload ecosystem.config.js --update-env',
    `restart ${APP_NAME} --update-env`,
  ], `restart 必须用 ecosystem.config.js 里的应用名（现在是 ${APP_NAME}）`);
});

test('③ 刷完仍然对不上：退出码 1，restart **仍然只有一次**（绝不循环重启线上）', () => {
  const harness = makeHarness('always-old');
  const result = runScript(harness);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /自动刷 env 之后【仍然】对不上/);
  assert.match(result.stderr, /本次已自动执行过一次/);
  const restartCalls = callsOf(harness).filter((line) => line.startsWith('restart '));
  assert.equal(restartCalls.length, 1, '自动刷 env 只允许一次');
});

test('④ --check-only：只自检、不重启 ⇒ 既不起服务、也不自动刷 env', () => {
  const harness = makeHarness('always-old');
  const result = runScript(harness, ['--check-only']);
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(callsOf(harness), [], '--check-only 模式下一次 pm2 都不该被调用');
  assert.match(result.stderr, /刻意\*\*不重启\*\*/);
});

test('⑤ 显式关掉自动刷 env（DEPLOY_HEALTH_AUTO_ENV_REFRESH=0）：照旧报红，不做重启', () => {
  const harness = makeHarness('after-restart');
  const result = runScript(harness, [], { DEPLOY_HEALTH_AUTO_ENV_REFRESH: '0' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /已显式关掉自动刷 env/);
  assert.deepEqual(callsOf(harness), ['startOrReload ecosystem.config.js --update-env']);
});

test('哨兵：脚本里的"正确版本号"是 deploy_run.sh 自己算的（tag 名 + commit），不是写死的', () => {
  // ⭐ 跑在**固定的临时仓库**上：tag/commit 由这里现造 ⇒ 与"外面有没有人在 commit / 打 tag"无关。
  const pinned = makePinnedRepo();
  try {
    const harness = makeHarness('always-new');
    const result = runScript(harness, [], {}, pinned.script);
    // 版本号必须是**这个仓库现算的**（tag + commit）——写死任何一个都会红。
    assert.match(result.stdout,
      new RegExp(`Deploying version ${pinned.version} \\(commit ${pinned.commit}\\)`),
      '部署时印出来的版本号必须来自 git（tag + commit），不是写死的');
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    fs.rmSync(pinned.dir, { recursive: true, force: true });
  }
});
