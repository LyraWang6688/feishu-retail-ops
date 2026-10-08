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
 * 宽容地取 git 信息 —— ⚠️ **CI 是浅克隆且不带 tag**（actions/checkout 默认 fetch-depth: 1），
 * `git describe --tags` 在那里会**直接抛**（本地有 tag，所以本地是绿的）。
 * 脚本自己就是 `|| echo untagged` 兜底的，测试必须同样兜底，
 * 否则会出现「本地绿、CI 红」的假失败 —— 2026-10-08 真踩过一次。
 */
const gitOut = (args, fallback = '') => {
  const result = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : fallback;
};

/** 与脚本算 APP_VERSION 的同一条口径（没有 tag 时 = `untagged`）。 */
const DESCRIBED_VERSION = gitOut(['describe', '--tags', '--abbrev=0'], 'untagged');
const HEAD_SHORT = gitOut(['rev-parse', '--short', 'HEAD'], '');
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

const runScript = (harness, args = [], extraEnv = {}) => spawnSync('bash', [SCRIPT, ...args], {
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

test('哨兵：脚本里的"正确版本号"是 deploy_run.sh 自己算的（tag 名 + commit + 当下时间）', () => {
  const harness = makeHarness('always-new');
  const result = runScript(harness);
  // ⚠️ 版本号用**脚本同一条口径**算（CI 浅克隆没有 tag ⇒ `untagged`），不能用 execFileSync 硬取
  assert.match(result.stdout, new RegExp(`Deploying version ${DESCRIBED_VERSION} \\(commit ${HEAD_SHORT}\\)`),
    '部署时印出来的版本号必须来自 git（tag + commit），不是写死的');
  if (HEAD_SHORT) {
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});
