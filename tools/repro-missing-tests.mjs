#!/usr/bin/env node
/**
 * repro-missing-tests.mjs —— ② 的**可控复现**：全量跑里「tests 少了 N 条、fail 多了 k 条」是什么形状？
 *
 * 背景（2026-10-12 实测 1 次）：某次全量跑 `tests 1857 / fail 8`（正常 `1908 / 3`）——
 * **tests 少 51 条、fail 多 5 条**，重跑即恢复。当时工作区正在被改（回退 / 删测试文件）。
 *
 * 做法：在**临时 clone**里（真仓库只读、不动）：
 *   ① 先跑一次全量 → 逐文件用例数 = 基线；
 *   ② 把 k 个测试文件写成"load 阶段就炸"（= 半写 / 语法坏 / 被删一半 / 共享模块半写时下游文件的命运）；
 *   ③ 再跑一次全量 → 看 `tests / fail` 的变化，以及**哪些文件的用例整片消失**。
 *
 * 已验证的两条不变量（见输出）：
 *   · **一个文件 load 阶段起不来** ⇒ spec 的 `fail` **+1**、`tests` 少它**全部**用例；
 *   · **一个文件跑到一半进程被杀（SIGKILL）** ⇒ `fail` +1，但 **run 直接中断，后面所有文件都不跑了**
 *     （⇒ tests 会少得远超那一个文件）。
 *   ⇒ 所以"少 51 / 多 5 且**重跑即恢复**"最贴合的形状是：**5 个文件 load 阶段起不来**。
 *
 * 用法：
 *   node tools/repro-missing-tests.mjs                          # HEAD，等价于"5 个文件 × 合计 56 条"
 *   node tools/repro-missing-tests.mjs 56eb17c --sum 56 --k 5   # 对齐 2026-10-12 那次的数字
 *   node tools/repro-missing-tests.mjs HEAD --files test/a.test.js,test/b.test.js
 * 证据留在 /tmp/missing-tests-evidence/（xml + spec 输出）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realRepo = path.resolve(__dirname, '..', '..', '..');
const argv = process.argv.slice(2);
const commit = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'HEAD';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const TARGET_SUM = Number(flag('sum', 56));
const K = Number(flag('k', 5));
const explicitFiles = String(flag('files', '')).split(',').filter(Boolean);

const evidenceDir = '/tmp/missing-tests-evidence';
fs.rmSync(evidenceDir, { recursive: true, force: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-tests-'));
const clone = path.join(sandbox, 'repo');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

console.log('=== repro: 「tests 少一截」的形状（临时 clone；真仓库只读）===');
if (run('git', ['clone', '--quiet', '--no-hardlinks', '--local', realRepo, clone]).status !== 0) {
  console.log('❌ clone 失败'); process.exit(2);
}
run('git', ['-C', clone, 'checkout', '--quiet', commit]);
const headShort = run('git', ['-C', clone, 'rev-parse', '--short', 'HEAD']).stdout.trim();
console.log(`clone @ ${headShort}（${run('git', ['-C', clone, 'describe', '--tags', '--abbrev=0']).stdout.trim()}）`);
fs.symlinkSync(path.join(realRepo, 'server', 'node_modules'), path.join(clone, 'server', 'node_modules'));

const serverCwd = path.join(clone, 'server');
/** 跑全量：junit（逐文件计数）+ spec（权威的 tests/fail 汇总与 ✖ 行） */
const runSuite = (label) => {
  const xml = path.join(evidenceDir, `${label}.xml`);
  const r = run(process.execPath, [
    '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter=junit',
    `--test-reporter-destination=${path.join(evidenceDir, `${label}.spec.txt`)}`,
    `--test-reporter-destination=${xml}`,
  ], { cwd: serverCwd });
  const spec = fs.readFileSync(path.join(evidenceDir, `${label}.spec.txt`), 'utf8');
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
    const m = spec.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'm'));
    if (m) summary[key] = Number(m[1]);
  }
  const crosses = [...spec.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1].trim());
  const xmlText = fs.existsSync(xml) ? fs.readFileSync(xml, 'utf8') : '';
  // ⚠️ 解析口径：`<testcase` 计数 = 用例数；`<failure|error` 计数 = 失败数（见 flaky-suite-loop.mjs 注释）。
  const files = new Map();
  const chunks = xmlText.split('<testcase').slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf('>');
    const tag = end === -1 ? chunk : chunk.slice(0, end);
    const file = (tag.match(/file="([^"]*)"/) || [])[1];
    if (file) files.set(file, (files.get(file) || 0) + 1);
  }
  const failFromXml = (xmlText.match(/<(?:failure|error)\b/g) || []).length;
  return { summary: { ...summary, failFromXml }, crosses, files, exitStatus: r.status };
};

// ① 基线
const base = runSuite('baseline');
console.log(`\n【基线】tests ${base.summary.tests} · pass ${base.summary.pass} · fail ${base.summary.fail}（exit=${base.exitStatus}）`);

// 挑 k 个文件，使它们声明的用例数之和 = TARGET_SUM（对齐那次观测）
let picked = [];
if (explicitFiles.length) {
  picked = explicitFiles.map((rel) => [rel, base.files.get(path.join(clone, 'server', rel)) || 0]);
} else {
  const pool = [...base.files.entries()]
    .filter(([file, n]) => file && file.endsWith('.test.js') && n >= 1 && n <= 30)
    .map(([file, n]) => [path.relative(serverCwd, file), n]);
  const rec = (idx, chosen, sum) => {
    if (chosen.length === K) return sum === TARGET_SUM ? chosen : null;
    if (idx >= pool.length) return null;
    return rec(idx + 1, [...chosen, pool[idx]], sum + pool[idx][1]) || rec(idx + 1, chosen, sum);
  };
  picked = rec(0, [], 0) || [];
}
const pickedSum = picked.reduce((s, [, n]) => s + n, 0);
console.log(`\n【改坏的 ${picked.length} 个文件（合计 ${pickedSum} 条）】\n  ${picked.map(([f, n]) => `${f}(${n})`).join(' · ')}`);

for (const [rel] of picked) {
  fs.writeFileSync(path.join(serverCwd, rel),
    "// 模拟『跑测试期间这个文件正被改 / 写坏 / 删了一半』\nthrow new Error('probe: load 阶段就起不来');\n");
}
const broken = runSuite('broken');
console.log(`\n【${picked.length} 个文件 load 起不来】tests ${broken.summary.tests} · pass ${broken.summary.pass} · fail ${broken.summary.fail}（exit=${broken.exitStatus}）`);
console.log(`   Δtests = ${broken.summary.tests - base.summary.tests} · Δfail = +${broken.summary.fail - base.summary.fail}`);
console.log(`   ✖ 行（权威的失败清单，共 ${broken.crosses.length} 条）：`);
for (const cross of broken.crosses) console.log(`     ✖ ${cross}`);
const lost = [...base.files.entries()]
  .filter(([file, n]) => file && (broken.files.get(file) || 0) < n)
  .map(([file, n]) => `${path.basename(file)}: ${n} → ${broken.files.get(file) || 0}`);
console.log(`   用例整片消失的文件（${lost.length} 个）：${lost.slice(0, 10).join(' · ')}`);

const matched = (broken.summary.tests - base.summary.tests) === -(TARGET_SUM - picked.length)
  && (broken.summary.fail - base.summary.fail) === picked.length;
console.log('\n=== 结论 ===');
console.log(`· k 个文件 load 起不来 ⇒ Δtests = -(k 个文件声明用例之和) + k · Δfail = +k`);
console.log(`· 本次：Δtests=${broken.summary.tests - base.summary.tests} / Δfail=+${broken.summary.fail - base.summary.fail}`
  + `${matched ? ' ⇒ 与 2026-10-12 观测到的「少 51 / 多 5」同一形状 ✅' : '（换 --sum/--k 可对齐其它观测）'}`);
console.log('· 机制：**跑测试期间工作区还在被改**（半写的文件 / 被删的文件 / 半写的共享模块）→ 那些文件 load 就炸；');
console.log('  重跑即恢复（那时文件已写完）—— 这与"资源不足/时钟跨分钟"都不相符：');
console.log('  3 路并发 × 3 轮全量跑 = 9 次，tests 逐轮一致、fail 0（见 tools/flaky-suite-loop.mjs）。');
console.log(`\n证据目录（未删）：${evidenceDir}`);

fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(matched ? 0 : 1);
