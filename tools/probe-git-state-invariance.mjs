#!/usr/bin/env node
/**
 * probe-git-state-invariance.mjs —— ① 的**真机制复现**：哨兵把「git 状态」当不变量，
 * 而它其实在**两个不同时刻**被读了两次（测试文件模块加载时一次、脚本运行时一次）。
 *
 * 形状（照抄 `server/test/deployRunAutoEnvRefresh.test.js:41-43、147-156`）：
 *   const DESCRIBED = gitOut(['describe','--tags','--abbrev=0'])   // ← 时刻 T0
 *   const SHORT     = gitOut(['rev-parse','--short','HEAD'])       // ← 时刻 T0
 *   …（全量跑时这里要过几十秒到几分钟）…
 *   const result = runScript()                                     // ← 时刻 T1，脚本**自己再读一次**
 *   assert.match(result.stdout, `Deploying version ${DESCRIBED} (commit ${SHORT})`)
 *
 * ⇒ 只要 T0→T1 之间**仓库状态动了**（别人打 tag / 发版打 tag / git pull / 同一 worktree 里 commit），
 *   断言必红 —— 与"时钟跨分钟"无关（时钟那条已由 probe-clock-dependence 证伪）。
 *
 * ⚠️ 安全：全程在一个**临时 clone**里做（`git clone --no-hardlinks`），
 *    **绝不**在真仓库里建 tag / 建 commit。clone 完即删。
 *
 * 用法：node tools/probe-git-state-invariance.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..'); // .local/e2e-verify → 仓库根
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstate-probe-'));
const cloneDir = path.join(sandbox, 'repo');

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const gitIn = (dir, args) => {
  const r = run('git', ['-C', dir, ...args]);
  return r.status === 0 ? r.stdout.trim() : `(失败:${r.stderr.trim()})`;
};

console.log('=== probe: 哨兵的「git 状态不变量」 ===');
console.log(`把真仓库 clone 到临时目录（--no-hardlinks，不动真仓库的 tag）：${cloneDir}`);
const clone = run('git', ['clone', '--quiet', '--no-hardlinks', '--local', repoRoot, cloneDir]);
if (clone.status !== 0) {
  console.log(`❌ clone 失败：${clone.stderr}`);
  process.exit(2);
}

// worktree clone 里没有 node_modules / ecosystem 依赖：软链过去（scripts 只用 node 与 pm2 假替身）
fs.symlinkSync(path.join(repoRoot, 'server', 'node_modules'), path.join(cloneDir, 'server', 'node_modules'));

const SCRIPT = path.join(cloneDir, 'server', 'scripts', 'deploy_run.sh');
const bin = path.join(sandbox, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'pm2'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
printf '{"status":"ok","version":"%s","commit":"%s","deployed_at":"%s"}' "$APP_VERSION" "$APP_COMMIT" "$APP_DEPLOYED_AT"
`, { mode: 0o755 });

const runScript = () => spawnSync('bash', [SCRIPT], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DEPLOY_HEALTH_RETRIES: '1',
    DEPLOY_HEALTH_INTERVAL: '1',
    DEPLOY_HEALTH_AUTO_REFRESH_WAIT: '0',
  },
});

/** 复现"哨兵"那条断言，返回 {ok, expected, actualLine} */
const sentinel = (described, short, result) => {
  const expected = `Deploying version ${described} (commit ${short})`;
  const actualLine = (result.stdout.match(/Deploying version .*/) || ['(没有这行)'])[0];
  return {
    ok: result.stdout.includes(expected) && result.status === 0,
    expected,
    actualLine,
    status: result.status,
  };
};

const results = [];

// ── 场景 0（对照）：T0→T1 之间仓库不动 ──────────────────────────────────────
{
  const described = gitIn(cloneDir, ['describe', '--tags', '--abbrev=0']);
  const short = gitIn(cloneDir, ['rev-parse', '--short', 'HEAD']);
  const r = sentinel(described, short, runScript());
  results.push({ name: '对照：仓库不动', ...r });
}

// ── 场景 1：T0→T1 之间**多了一个 tag**（= 发版打 tag / tag_release.sh）──────
{
  const described = gitIn(cloneDir, ['describe', '--tags', '--abbrev=0']);
  const short = gitIn(cloneDir, ['rev-parse', '--short', 'HEAD']);
  run('git', ['-C', cloneDir, 'tag', '-a', 'v9.9.9-repro', '-m', 'repro: 模拟并发打 tag']);
  const r = sentinel(described, short, runScript());
  results.push({ name: 'T0→T1 之间多了一个 tag（HEAD 不变）', ...r, after: gitIn(cloneDir, ['describe', '--tags', '--abbrev=0']) });
}

// ── 场景 2：T0→T1 之间**HEAD 动了**（= 同一 worktree 里 commit / pull）──────
{
  const described = gitIn(cloneDir, ['describe', '--tags', '--abbrev=0']);
  const short = gitIn(cloneDir, ['rev-parse', '--short', 'HEAD']);
  run('git', ['-C', cloneDir, '-c', 'user.email=probe@local', '-c', 'user.name=probe',
    'commit', '--allow-empty', '-m', 'repro: 模拟并发 commit']);
  const r = sentinel(described, short, runScript());
  results.push({ name: 'T0→T1 之间 HEAD 动了（空 commit）', ...r, after: gitIn(cloneDir, ['rev-parse', '--short', 'HEAD']) });
}

console.log('');
for (const item of results) {
  console.log(`【${item.name}】${item.ok ? '绿 ✅' : '红 ❌'}（exit=${item.status}）`);
  console.log(`   期望子串：${item.expected}`);
  console.log(`   实际打印：${item.actualLine}${item.after ? `\n   变动后：${item.after}` : ''}`);
}
const reproduced = results.some((item, index) => index > 0 && !item.ok) && results[0].ok;
console.log('');
console.log(reproduced
  ? '⇒ 复现成功：**仓库状态在 T0→T1 之间动一下，哨兵必红**（对照不动=绿）'
    + '\n   ⇒ 这就是"拿环境相关量（git 状态）当不变量"的真实机制；与时钟无关。'
  : '⇒ 未复现（与预期不符，需要复查）');

fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(reproduced ? 0 : 1);
