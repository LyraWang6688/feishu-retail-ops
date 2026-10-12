#!/usr/bin/env node
/**
 * probe-clock-dependence.mjs —— ① 的**证伪实验**：`deployRunAutoEnvRefresh.test.js` 的哨兵
 * 到底有没有"拿当下时间当不变量"？
 *
 * 做法（只读；不改仓库里任何文件）：
 *   造一个临时 harness（假 pm2 / 假 curl / **假 date**），把它放在 PATH 最前面，然后跑真的
 *   `server/scripts/deploy_run.sh`：
 *     · 假 `date` 每次被调用都返回**不一样**的时间（且记下被调了几次）——如果脚本存在
 *       "读两次时钟然后互相比"的形状，哨兵就会红；
 *     · 假 `curl` 照原样回 `$APP_*`（= 脚本自己 export 的值）。
 *   再按哨兵那条断言（stdout 里有 `Deploying version <describe> (commit <short>)` + exit 0）判定。
 *
 * 结论怎么看：
 *   · `date` 只被调用 **1 次** + 哨兵仍绿 ⇒ **"跨分钟边界"假设证伪**（值只有一处来源，
 *     拿它跟自己比，永远相等）；
 *   · 若红 ⇒ 复盘输出，说明确实存在时钟依赖。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..', 'server');
const repoRoot = path.resolve(serverRoot, '..');
const SCRIPT = path.join(serverRoot, 'scripts', 'deploy_run.sh');

const gitOut = (args, fallback = '') => {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : fallback;
};
const DESCRIBED = gitOut(['describe', '--tags', '--abbrev=0'], 'untagged');
const HEAD = gitOut(['rev-parse', '--short', 'HEAD'], '');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-probe-'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
const dateCalls = path.join(dir, 'date.calls');
fs.writeFileSync(dateCalls, '');

// 假 date：每次调用都返回"不一样"的时间（秒随调用次数递增），并记录调用次数
fs.writeFileSync(path.join(bin, 'date'), `#!/bin/bash
n=$(wc -l < ${dateCalls} | tr -d ' ')
printf '%s\\n' "$*" >> ${dateCalls}
printf '2026-10-12T19:%02d:%02d+08:00\\n' "$((n % 60))" "$(((n * 7) % 60))"
`, { mode: 0o755 });

fs.writeFileSync(path.join(bin, 'pm2'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
printf '{"status":"ok","version":"%s","commit":"%s","deployed_at":"%s"}' "$APP_VERSION" "$APP_COMMIT" "$APP_DEPLOYED_AT"
`, { mode: 0o755 });

const result = spawnSync('bash', [SCRIPT], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DEPLOY_HEALTH_RETRIES: '1',
    DEPLOY_HEALTH_INTERVAL: '1',
    DEPLOY_HEALTH_AUTO_REFRESH_WAIT: '0',
  },
});

const calls = fs.readFileSync(dateCalls, 'utf8').trim().split('\n').filter(Boolean);
const sentinelRe = new RegExp(`Deploying version ${DESCRIBED} \\(commit ${HEAD}\\)`);
const printed = (result.stdout.match(/Deploying version .*/) || ['(没有这行)'])[0];
const sentinelOk = sentinelRe.test(result.stdout) && result.status === 0;

console.log('=== probe: 时钟依赖 ===');
console.log(`假 date 被调用 ${calls.length} 次：${JSON.stringify(calls)}`);
console.log(`脚本打印：${printed}`);
console.log(`哨兵断言（stdout 匹配 + exit 0）：${sentinelOk ? '绿 ✅' : '红 ❌'}（exit=${result.status}）`);
console.log(`期望 describe=${DESCRIBED} / short=${HEAD}`);
if (!sentinelOk) {
  console.log('--- stdout ---'); console.log(result.stdout);
  console.log('--- stderr ---'); console.log(result.stderr);
}
console.log(calls.length <= 1
  ? '⇒ 时钟只被读 1 次：脚本拿它跟自己比，**跨分钟边界不可能让它红**（假设证伪）'
  : '⇒ 时钟被读多次：存在"读两次时钟互比"的可能，需要细看');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(sentinelOk ? 0 : 1);
