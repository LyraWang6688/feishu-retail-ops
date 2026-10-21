#!/usr/bin/env node
/**
 * check-file-size.mjs —— 文件大小棘轮门禁（size ratchet）
 *
 * 规则（业务负责人 2026-10-18 批准）：
 *   1) 源码 `server/src/**\/*.js` 单文件 ≤ 800 行；测试 `server/test/**\/*.js` 单文件 ≤ 1200 行；
 *   2) `size-baseline.json` 是「存量超限文件」白名单：登记当前行数；
 *      **只有「当前 > 基线」才红**（防膨胀）；**文件变小但没降基线 ⇒ 只警告，不失败**
 *      （方案 C，2026-10-20 业务负责人拍板：棘轮是为了防膨胀，不惩罚瘦身）；
 *      新增文件超限 ⇒ 红；
 *   3) 既有文件（base 里存在）净增 > `maxNetIncrease`（默认 100）行 ⇒ 红；
 *   4) 新增文件不受「净增」约束（新文件只受 1) 的硬上限约束 —— 鼓励拆成小模块，
 *      而不是逼人把新模块塞进老文件。
 *
 * 「净增」的基线从哪里来：优先 `--base <ref>`，其次环境变量 `SIZE_BASE_REF`，
 * 最后自动探测 `origin/main` / `main`。都拿不到时**只跳过净增检查**（打印提示，不判红），
 * 棘轮（1、2 两条）始终生效。CI 会显式传 PR 的 base 提交。
 *
 * 用法（在 `server/` 目录下）：
 *   node scripts/check-file-size.mjs                 # 门禁
 *   node scripts/check-file-size.mjs --base HEAD~1   # 指定比较基线
 *   node scripts/check-file-size.mjs --update-baseline   # 生成 / 下调基线（只许变小；变小不更新也只警告）
 *
 * 退出码：0 = 绿；1 = 红（超限 / 基线变大 / 净增超阈值 / 配置错误）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'size-baseline.json');

/** 扫描范围：路径相对仓库根；type 决定上限，也决定 baseline 里怎么解释。 */
const SCAN_ROOTS = [
  { dir: 'server/src', type: 'source', label: '源码' },
  { dir: 'server/test', type: 'test', label: '测试' },
];

const DEFAULT_LIMITS = { source: 800, test: 1200 };
const DEFAULT_MAX_NET_INCREASE = 100;

// ── 参数 ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const hasFlag = (name) => argv.includes(name);

/** 取 `--name value` 或 `--name=value`；没有则返回 undefined。 */
const optionValue = (name) => {
  const withEq = argv.find((item) => item.startsWith(`${name}=`));
  if (withEq) return withEq.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return undefined;
};

const wantsHelp = hasFlag('--help') || hasFlag('-h');
const updateBaseline = hasFlag('--update-baseline');
const skipNetCheck = hasFlag('--no-net-check');
const baseRefArg = optionValue('--base');
const baseRef = (baseRefArg ?? process.env.SIZE_BASE_REF ?? '').trim();

if (wantsHelp) {
  console.log(
    [
      '文件大小棘轮门禁（check-file-size.mjs）',
      '',
      '  node scripts/check-file-size.mjs                      检查（0 绿 / 1 红）',
      '  node scripts/check-file-size.mjs --base <ref>         指定「净增」比较基线',
      '  node scripts/check-file-size.mjs --update-baseline    生成或下调 size-baseline.json（只许变小）',
      '',
      '规则 C：文件比基线**大** ⇒ 失败；文件比基线**小**但没降基线 ⇒ 只警告，不失败。',
      '  node scripts/check-file-size.mjs --no-net-check       跳过「净增 > N 行」检查',
      '',
      '环境变量：SIZE_BASE_REF（等价 --base）',
    ].join('\n'),
  );
  process.exit(0);
}

// ── 基础工具 ─────────────────────────────────────────────────────────────────

const rel = (absPath) => path.relative(REPO_ROOT, absPath).split(path.sep).join('/');

/** 物理行数：`a\nb\n` 算 2 行；末尾换行不额外算一行。 */
const countLines = (absPath) => {
  const content = fs.readFileSync(absPath, 'utf8');
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
};

/** 递归收集 .js 文件（跳过 node_modules / 隐藏目录）。 */
const walkJs = (absDir, out = []) => {
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkJs(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
};

const scanned = [];
for (const root of SCAN_ROOTS) {
  for (const abs of walkJs(path.join(REPO_ROOT, root.dir))) {
    scanned.push({ abs, rel: rel(abs), type: root.type, lines: countLines(abs) });
  }
}

// ── baseline ─────────────────────────────────────────────────────────────────

const emptyBaseline = () => ({ files: {} });

const readBaseline = () => {
  if (!fs.existsSync(BASELINE_PATH)) return emptyBaseline();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    console.error(`[红] size-baseline.json 不是合法 JSON：${error.message}`);
    process.exit(1);
  }
  const files = parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {};
  const cleaned = {};
  for (const [file, value] of Object.entries(files)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      console.error(`[红] size-baseline.json 中 ${file} 的行数必须是正整数（当前：${JSON.stringify(value)}）`);
      process.exit(1);
    }
    cleaned[file] = value;
  }
  return { files: cleaned };
};

const baseline = readBaseline();

/** 上限只允许比内置值更严，不允许借 baseline 放宽（否则门禁可被 JSON 绕过）。 */
const clampLimit = (configured, fallback) => (
  Number.isInteger(configured) && configured > 0 && configured <= fallback ? configured : fallback
);

const limits = {
  source: clampLimit(baselineRawLimits().source, DEFAULT_LIMITS.source),
  test: clampLimit(baselineRawLimits().test, DEFAULT_LIMITS.test),
};

/** 仅用于读取可选的 limits / maxNetIncrease（缺省用脚本内置值）。 */
function baselineRawLimits() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return {
      source: parsed?.limits?.source,
      test: parsed?.limits?.test,
    };
  } catch {
    return {};
  }
}

function baselineRawMaxNetIncrease() {
  if (!fs.existsSync(BASELINE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return parsed?.maxNetIncrease;
  } catch {
    return undefined;
  }
}

const configuredMaxNetIncrease = baselineRawMaxNetIncrease();
const maxNetIncrease = Number.isInteger(configuredMaxNetIncrease) && configuredMaxNetIncrease > 0
  ? configuredMaxNetIncrease
  : DEFAULT_MAX_NET_INCREASE;

// ── 净增检查（git diff）──────────────────────────────────────────────────────

const gitRefExists = (ref) => {
  if (!ref) return false;
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0;
};

const resolveGitBase = (requested) => {
  // 显式传入的 ref 必须先验证：写错 ref 时不能静默当成「没有基线」，
  // 但也不能因为 CI 拿不到 base sha 就把整个门禁判红（棘轮本身仍然有效）。
  if (requested && gitRefExists(requested)) return requested;
  for (const candidate of ['origin/main', 'main']) {
    if (gitRefExists(candidate)) return candidate;
  }
  return '';
};

/** 返回 Map<相对路径, {added, deleted, net}>；拿不到 git 基线时返回 null。 */
const readNetChanges = (ref) => {
  const result = spawnSync(
    'git',
    ['diff', '--numstat', '--diff-filter=M', ref, '--', 'server/src', 'server/test'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) return null;
  const changes = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    if (addedRaw === '-' || deletedRaw === '-') continue; // 二进制文件
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    // 重命名时 numstat 的最后一列形如 `old => new`；取新路径，且纯重命名净增为 0。
    const rawPath = pathParts.join('\t');
    const targetPath = rawPath.includes(' => ') ? rawPath.split(' => ').pop() : rawPath;
    if (!targetPath.endsWith('.js')) continue;
    changes.set(targetPath, { added, deleted, net: added - deleted });
  }
  return changes;
};

// ── 检查 ─────────────────────────────────────────────────────────────────────

const violations = [];
const warnings = [];
const scannedRel = new Set(scanned.map((file) => file.rel));

for (const file of scanned) {
  const limit = limits[file.type];
  const baselineLines = baseline.files[file.rel];

  if (baselineLines !== undefined) {
    if (file.lines > baselineLines) {
      violations.push({
        kind: 'baseline-growth',
        file: file.rel,
        message: `当前 ${file.lines} 行 > 基线 ${baselineLines} 行（基线只允许变小；请拆出模块，或先与维护者确认）`,
      });
    } else if (file.lines < baselineLines) {
      warnings.push(
        `${file.rel} 已缩小 ${baselineLines - file.lines} 行（${baselineLines} → ${file.lines}）：建议跑 --update-baseline 降基线（只提示，不算失败）`,
      );
    }
    if (file.lines <= limit) {
      warnings.push(`${file.rel} 已低于上限 ${limit} 行，可以从 baseline 移除（--update-baseline 会自动清掉）`);
    }
    continue;
  }

  if (file.lines > limit) {
    violations.push({
      kind: 'new-over-limit',
      file: file.rel,
      message: `当前 ${file.lines} 行 > 上限 ${limit} 行，且不在 baseline（新文件/新超限不允许；请按模块拆分）`,
    });
  }
}

for (const file of Object.keys(baseline.files)) {
  if (!scannedRel.has(file)) {
    warnings.push(`baseline 里的 ${file} 已不在扫描范围（删除/改名？）：请跑 --update-baseline 清掉`);
  }
}

let netRef = '';
let netChanges = null;
if (!skipNetCheck) {
  netRef = resolveGitBase(baseRef);
  if (netRef) {
    netChanges = readNetChanges(netRef);
  }
  if (netChanges) {
    for (const [file, change] of netChanges) {
      if (change.net > maxNetIncrease) {
        const existingViolation = violations.find((item) => item.file === file);
        if (existingViolation) continue; // 已经因基线变大判红，不重复报
        violations.push({
          kind: 'net-increase',
          file,
          message: `相对 ${netRef} 净增 ${change.net} 行（+${change.added} / -${change.deleted}）> ${maxNetIncrease} 行；请拆成小模块`,
        });
      }
    }
  } else if (netRef) {
    warnings.push(`git diff 相对 ${netRef} 读取失败：本次跳过「净增 > ${maxNetIncrease} 行」检查`);
  } else {
    const hint = baseRef ? `（显式指定的 base「${baseRef}」不可用，已忽略）` : '';
    warnings.push(
      `未找到可比 git 基线（origin/main / main 均不可用）${hint}：本次跳过「净增 > ${maxNetIncrease} 行」检查；可用 --base <ref> 指定`,
    );
  }
}

// ── --update-baseline ───────────────────────────────────────────────────────

if (updateBaseline) {
  const nextFiles = {};
  const shrinkable = [];
  const refused = [];
  for (const file of scanned) {
    if (file.lines <= limits[file.type]) continue;
    const previous = baseline.files[file.rel];
    if (previous !== undefined && file.lines > previous) {
      refused.push(`${file.rel}：当前 ${file.lines} 行 > 已登记基线 ${previous} 行（基线只允许变小，拒绝上调）`);
      continue;
    }
    nextFiles[file.rel] = file.lines;
    if (previous !== undefined && file.lines < previous) {
      shrinkable.push(`${file.rel}：${previous} → ${file.lines}`);
    }
  }

  if (refused.length > 0) {
    console.error('[红] 拒绝写入基线：存在文件比已登记基线更大。');
    for (const line of refused) console.error(`  - ${line}`);
    console.error('处理办法：把这些文件拆小（这是门禁的目的），不要上调基线。');
    process.exit(1);
  }

  const sortedFiles = Object.fromEntries(
    Object.entries(nextFiles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const payload = {
    $comment:
      '存量超限文件白名单。只允许变小：文件变大或新文件超限 ⇒ CI 红。用 `node scripts/check-file-size.mjs --update-baseline` 生成/下调，禁止手改上调。',
    limits,
    maxNetIncrease,
    updatedAt: new Date().toISOString().slice(0, 10),
    files: sortedFiles,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const removed = Object.keys(baseline.files).filter((file) => !(file in sortedFiles));
  console.log(`[基线] 已写入 ${path.relative(process.cwd(), BASELINE_PATH)}：${Object.keys(sortedFiles).length} 个超限文件在册`);
  for (const line of shrinkable) console.log(`  ↓ 下调：${line}`);
  for (const file of removed) console.log(`  - 移出：${file}（已不超限或已删除）`);
  process.exit(0);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

const sourceCount = scanned.filter((file) => file.type === 'source').length;
const testCount = scanned.filter((file) => file.type === 'test').length;
console.log(
  `[文件大小棘轮] 扫描 ${scanned.length} 个文件：源码 ${sourceCount}（上限 ${limits.source}）/ 测试 ${testCount}（上限 ${limits.test}）`,
);
console.log(`[基线] ${Object.keys(baseline.files).length} 个存量超限文件在册（只允许变小）`);
if (!skipNetCheck) {
  console.log(
    netChanges
      ? `[净增] 对比 ${netRef}：既有文件净增 > ${maxNetIncrease} 行 ⇒ 红（新文件不计）`
      : `[净增] 跳过（无可用 git 基线）`,
  );
}

const kindLabel = {
  'baseline-growth': '基线变大',
  'new-over-limit': '新超限',
  'net-increase': '净增超阈值',
};
for (const violation of violations) {
  console.error(`[红] ${violation.file}：${violation.message}（${kindLabel[violation.kind]}）`);
}
for (const warning of warnings) {
  console.log(`[提示] ${warning}`);
}

if (violations.length > 0) {
  console.error(`[结果] 红 ${violations.length} 条 ⇒ exit 1。规则见 docs/engineering-layering-and-file-size-2026-10-18.md`);
  process.exitCode = 1;
} else {
  console.log('[结果] 绿：0 条违规（超限文件均 ≤ 已登记基线）');
  process.exitCode = 0;
}
