#!/usr/bin/env node
/**
 * 每日观测汇总（埋点第 2 刀）：
 *   读 PM2 日志（JSON 行）→ 按东八区某一天过滤 → 汇总 level/事件 Top N/未登记事件/错误/慢事件
 *   → 写 `docs/reports/observability-YYYY-MM-DD.{md,json}`。
 *
 * 用法：
 *   node scripts/observability-daily.mjs                      # 今天（+8）
 *   node scripts/observability-daily.mjs --date 2026-10-17 --logs '~/.pm2/logs/box2bitable-server-out*.log'
 *   node scripts/observability-daily.mjs --help
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Markdown 表格单元格转义：先转义反斜杠再转义竖线（只转义 `|` 会被 CodeQL 判
// `js/incomplete-sanitization`：反斜杠没处理 ⇒ 仍可能破坏单元格）。
const mdCell = (value) => String(value == null ? '' : value)
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|');

/** 展开 `--logs`：支持逗号分隔、`~`、目录内 `*` 通配（只展开一层，够 PM2 用）。 */
export function expandLogs(spec) {
  const out = [];
  for (const raw of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const full = expandHome(raw);
    if (!full.includes('*')) { if (fs.existsSync(full)) out.push(full); continue; }
    const dir = path.dirname(full);
    const re = new RegExp(`^${path.basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (re.test(name)) out.push(path.join(dir, name));
  }
  return [...new Set(out)].sort();
}

const dayInZone = (iso, timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
  } catch { return ''; }
};

export const todayInZone = (timeZone = 'Asia/Shanghai', now = new Date()) => dayInZone(now.toISOString(), timeZone);

/** 读日志文件 → 当天（时区）的 JSON 记录数组。非 JSON 行忽略（PM2 自身输出）。 */
export function recordsOfDay(files, { date, timeZone = 'Asia/Shanghai' }) {
  const records = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const raw = line.trim();
      if (!raw.startsWith('{')) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      if (!record || typeof record !== 'object' || !record.ts) continue;
      if (dayInZone(record.ts, timeZone) !== date) continue;
      records.push(record);
    }
  }
  return records;
}

/** 纯函数：汇总当天记录（可单测；不碰磁盘）。 */
export function summarize(records, { topN = 20, slowMs = 3000 } = {}) {
  const byLevel = {};
  const byEvent = new Map();
  const unregistered = new Map();
  const errors = [];
  const slow = [];
  for (const record of records) {
    const level = String(record.level || 'info');
    byLevel[level] = (byLevel[level] || 0) + 1;
    const event = String(record.event || '(no event)');
    byEvent.set(event, (byEvent.get(event) || 0) + 1);
    if (record.unregistered === true) unregistered.set(event, (unregistered.get(event) || 0) + 1);
    if (level === 'error') {
      errors.push({
        ts: record.ts,
        event,
        error: String(record.error || record.detail || record.reason || '').slice(0, 300),
      });
    }
    const ms = Number(record.duration_ms ?? record.durationMs ?? record.ms);
    if (Number.isFinite(ms) && ms >= slowMs) slow.push({ ts: record.ts, event, duration_ms: ms });
  }
  const topEvents = [...byEvent.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([event, count]) => ({ event, count }));
  return {
    total: records.length,
    byLevel,
    topEvents,
    unregistered: [...unregistered.entries()].map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count),
    errors: errors.slice(0, 50),
    slow: slow.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 50),
  };
}

export function renderMarkdown(summary, { date, timeZone = 'Asia/Shanghai', files = [], topN = 20, slowMs = 3000 }) {
  const lines = [
    `# 观测日报 ${date}（${timeZone}）`,
    '',
    '> ⚠️ 自动生成：`cd server && node scripts/observability-daily.mjs`；日志轮转由 `scripts/setup-pm2-logrotate.sh` 管理。',
    '',
    `- 日志文件：${files.length ? files.map((f) => `\`${path.basename(f)}\``).join('、') : '（无）'}`,
    `- 总条数：**${summary.total}**`,
    `- 分级：${Object.entries(summary.byLevel).map(([k, v]) => `${k}=${v}`).join(' / ') || '（无）'}`,
    '',
    `## 事件 Top ${topN}`,
    '',
  ];
  if (summary.topEvents.length) {
    lines.push('| 事件 | 次数 |', '| --- | --- |');
    for (const { event, count } of summary.topEvents) lines.push(`| \`${event}\` | ${count} |`);
  } else lines.push('（当天没有日志）');
  lines.push('', '## 未登记事件（`unregistered: true`）', '');
  if (summary.unregistered.length) {
    lines.push('| 事件 | 次数 |', '| --- | --- |');
    for (const { event, count } of summary.unregistered) lines.push(`| \`${event}\` | ${count} |`);
    lines.push('', '> 处理：确认是动态拼接的事件名还是漏登记；能静态化的改成字面量后跑 `pnpm run observability:events`。');
  } else lines.push('✅ 无（或当天没跑到那些分支）');
  lines.push('', '## 错误', '');
  if (summary.errors.length) {
    lines.push('| 时间 | 事件 | 错误 |', '| --- | --- | --- |');
    for (const item of summary.errors) lines.push(`| ${item.ts} | \`${item.event}\` | ${mdCell(item.error)} |`);
  } else lines.push('✅ 无');
  lines.push('', `## 慢事件（≥ ${slowMs} ms）`, '');
  if (summary.slow.length) {
    lines.push('| 时间 | 事件 | 耗时(ms) |', '| --- | --- | --- |');
    for (const item of summary.slow) lines.push(`| ${item.ts} | \`${item.event}\` | ${item.duration_ms} |`);
  } else lines.push('✅ 无');
  lines.push('');
  return lines.join('\n');
}

export function buildReport({ files, date, topN, slowMs, timeZone }) {
  const records = recordsOfDay(files, { date, timeZone });
  const summary = summarize(records, { topN, slowMs });
  return { records, summary, markdown: renderMarkdown(summary, { date, timeZone, files, topN, slowMs }) };
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 12).join('\n'));
    process.exit(0);
  }
  const { OBSERVABILITY } = await import('../src/config/observability.js');
  const cfg = OBSERVABILITY.daily;
  const date = opt('--date') || todayInZone(cfg.timeZone);
  const logsSpec = opt('--logs') || cfg.logGlob || '~/.pm2/logs/box2bitable-server-*.log';
  const files = expandLogs(logsSpec);
  const outDir = path.resolve(opt('--out') || cfg.outputDir || path.join(REPO_ROOT, 'docs/reports'));
  const topN = Number(opt('--top') || cfg.topN || 20);
  const slowMs = Number(opt('--slow-ms') || cfg.slowMs || 3000);
  if (!cfg.enabled) { console.error('OBSERVABILITY_DAILY_ENABLED=false ⇒ 不生成日报'); process.exit(0); }
  const report = buildReport({ files, date, topN, slowMs, timeZone: cfg.timeZone });
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `observability-${date}`);
  fs.writeFileSync(`${base}.md`, report.markdown);
  fs.writeFileSync(`${base}.json`, JSON.stringify({
    date, time_zone: cfg.timeZone, files, ...report.summary,
  }, null, 2));
  console.log(`✅ 日报已生成：${base}.md / .json（${report.summary.total} 条，${files.length} 个日志文件）`);
}
