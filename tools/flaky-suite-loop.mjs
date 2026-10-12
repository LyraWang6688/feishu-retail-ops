#!/usr/bin/env node
/**
 * flaky-suite-loop.mjs —— 全量测试「单次运行异常退出（少一截用例）」的**复现驱动**（只读，不改任何产品/测试代码）。
 *
 * 为什么这么写：
 *   · 症状是"某次全量跑的 tests 总数比正常少几十条 + 若干 fail"，重跑即恢复 ⇒ 必须**跑很多次**才撞得上；
 *   · 判据不能只看总数（总数会被任何新增用例影响）⇒ 用 **per-file 用例计数**与**同一环境下的基线**逐个对比，
 *     才能回答"**少的那几十条属于哪个/哪几个文件**"。
 *   · junit reporter 把 `file=` 写在每个 testcase 上 ⇒ 天然支持按文件计数。
 *
 * 用法：node tools/flaky-suite-loop.mjs <轮数> <输出目录>
 * 产物：<输出目录>/run-<i>.json  （每轮：总数/fail/每文件计数/退出码）
 *       <输出目录>/summary.txt   （人读：异常轮 + 少的文件）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..', 'server');
const RUNS = Number(process.argv[2] || 20);
const outDir = process.argv[3] || '/tmp/flaky-suite';
fs.mkdirSync(outDir, { recursive: true });

/**
 * 解析 junit XML → { files: Map<file, count>, total, fail, failures }
 *
 * ⚠️ 解析口径踩过的坑（2026-10-12，把"坏文件"误报成"整片文件消失"）：
 *   一开始用「带 body 的非贪婪正则」同时抓 testcase 与 failure，结果**漏掉大量条目**、
 *   还漏掉 load 阶段就炸的文件。改成**最笨但可靠**的两步：
 *     ① `<testcase` 出现次数 = 用例总数（file= 取该元素开标签里的第一个，用于按文件计数）；
 *     ② `<failure` / `<error` 的**出现次数** = 失败数（**不**依赖它嵌在哪个 testcase 里）。
 */
const parseJunit = (xml) => {
  const files = new Map();
  let total = 0;
  const failures = [];
  // ① 用例：把 XML 按 `<testcase` 切块，每块取开标签（到第一个 `>` 为止）里的 file=
  const chunks = String(xml || '').split('<testcase').slice(1);
  for (const chunk of chunks) {
    const tag = chunk.slice(0, chunk.indexOf('>') === -1 ? chunk.length : chunk.indexOf('>'));
    total += 1;
    const file = (tag.match(/file="([^"]*)"/) || [])[1];
    if (file) files.set(file, (files.get(file) || 0) + 1);
    if (/<(?:failure|error)\b/.test(chunk.slice(0, chunk.indexOf('</testcase>') === -1 ? chunk.length : chunk.indexOf('</testcase>')))) {
      failures.push({ file: file || '(no-file-attr)', name: (tag.match(/name="([^"]*)"/) || [])[1] || '' });
    }
  }
  // ② 失败数：直接数标记（load 阶段炸掉的"文件级失败"也带这个标记）
  const fail = (String(xml || '').match(/<(?:failure|error)\b/g) || []).length;
  return { files, total, fail, failures };
};

const runs = [];
for (let i = 1; i <= RUNS; i += 1) {
  const xmlPath = path.join(outDir, `run-${i}.xml`);
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1',
    '--test-reporter=junit', `--test-reporter-destination=${xmlPath}`,
  ], { cwd: serverRoot, encoding: 'utf8' });
  const xml = fs.existsSync(xmlPath) ? fs.readFileSync(xmlPath, 'utf8') : '';
  const parsed = parseJunit(xml);
  const record = {
    run: i,
    started_at: startedAt,
    exit_status: r.status,
    duration_guess: null,
    total: parsed.total,
    fail: parsed.fail,
    files: Object.fromEntries([...parsed.files.entries()].sort()),
    failures: parsed.failures,
  };
  fs.writeFileSync(path.join(outDir, `run-${i}.json`), JSON.stringify(record, null, 2));
  runs.push(record);
  process.stdout.write(`run ${i}/${RUNS}: tests=${parsed.total} fail=${parsed.fail} exit=${r.status}\n`);
}

// 基线 = 出现次数最多的 total（众数）；逐轮对比 per-file 计数
const totals = runs.map((r) => r.total);
const modeTotal = [...new Set(totals)].sort((a, b) => totals.filter((t) => t === b).length - totals.filter((t) => t === a).length)[0];
const baseline = runs.find((r) => r.total === modeTotal) || runs[0];
const lines = [];
lines.push(`轮数 ${RUNS} · 基线 total=${modeTotal}（出现 ${totals.filter((t) => t === modeTotal).length} 次）`);
lines.push(`各轮 total：${runs.map((r) => `${r.run}:${r.total}${r.fail ? `/f${r.fail}` : ''}`).join('  ')}`);
let anomalies = 0;
for (const run of runs) {
  const missing = [];
  for (const [file, count] of Object.entries(baseline.files)) {
    const got = run.files[file] || 0;
    if (got < count) missing.push(`${file} 少 ${count - got}（基线 ${count} → 本轮 ${got || '未出现'}）`);
  }
  const extra = Object.keys(run.files).filter((file) => !(file in baseline.files));
  if (missing.length || run.fail > baseline.fail || run.exit_status !== baseline.exit_status) {
    anomalies += 1;
    lines.push('');
    lines.push(`⚠️ 第 ${run.run} 轮异常：tests=${run.total}（基线 ${baseline.total} / 差 ${baseline.total - run.total}）`
      + ` fail=${run.fail} exit=${run.exit_status}`);
    for (const item of missing) lines.push(`   · 少：${item}`);
    for (const file of extra) lines.push(`   · 多出文件：${file}`);
    for (const f of run.failures.slice(0, 20)) lines.push(`   · fail：${path.basename(f.file)} :: ${f.name} :: ${f.msg.slice(0, 120)}`);
  }
}
lines.push('');
lines.push(anomalies ? `共 ${anomalies} 轮异常` : `✅ ${RUNS} 轮无异常（每轮 tests=${modeTotal}）`);
fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n'));
process.stdout.write(`\n${lines.join('\n')}\n`);
