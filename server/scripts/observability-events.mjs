#!/usr/bin/env node
/**
 * 观测事件目录生成器（第一刀）：
 *   ① 扫 src 下所有 .js 里的 `logInfo/logWarn/logError('事件名', …)` 字面量；
 *   ② 生成唯一真源 `src/config/events.js`（运行时校验用）；
 *   ③ 生成 `docs/observability-events.md`（给人看的清单）。
 *
 * 用法：
 *   node scripts/observability-events.mjs          # 重新生成两个产物
 *   node scripts/observability-events.mjs --check  # 只校验是否过期（CI/测试用；过期 exit 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(HERE, '..');
export const EVENT_FILE = path.join(SERVER_ROOT, 'src/config/events.js');
export const DOC_FILE = path.resolve(SERVER_ROOT, '..', 'docs/observability-events.md');

const EVENT_RE = /\blog(?:Info|Warn|Error)\(\s*['"]([a-z0-9][a-z0-9._-]*)['"]/g;

// 只把真正的块注释当注释：`/*` 后必须是空白、`*` 或 `!`。
// 日志文案/字符串里的 `/*）` 不能开启注释，否则会把后面的事件整段吞掉。
const BLOCK_COMMENT_RE = /\/\*(?=\s|\*|!)[\s\S]*?\*\//g;
const stripComments = (text) => text
  .replace(BLOCK_COMMENT_RE, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

/** 动态事件的收集器：前缀 × 后缀（scheduler / card 反馈那两族都用 `eventPrefix`）。 */
const prefixes = new Map();
const suffixes = new Set();
const PREFIX_RE = /eventPrefix\s*[:=]\s*'([a-z0-9][a-z0-9._-]*)'/g;
/** 缓存工厂的 `event: '前缀'`（日志里是 `${event}.cache_hit/.cache_miss`）。 */
const EVENT_OPTION_RE = /\bevent:\s*'([a-z0-9][a-z0-9._-]*)'/g;
const CACHE_EVENT_SUFFIXES = new Set(['cache_hit', 'cache_miss']);
const cachePrefixes = new Map();
const addCachePrefix = (prefix, add) => {
  const entry = cachePrefixes.get(prefix) || new Set();
  entry.add(add);
  cachePrefixes.set(prefix, entry);
};
const SUFFIX_RE = /\$\{eventPrefix\}\.([a-z][a-z0-9_]*)/g;
/** 配置里的 `a.b.c` 事件名（只扫 config/ 目录）。 */
const CONFIG_EVENT_RE = /'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_-]*){2,})'/g;
const addPrefix = (prefix, add) => {
  const entry = prefixes.get(prefix) || new Set();
  entry.add(add);
  prefixes.set(prefix, entry);
};

/** 扫描源码 → Map<event, {count, files:Set}>（按事件名排序）。 */
export function scanEvents(root = SERVER_ROOT) {
  const src = path.join(root, 'src');
  const result = new Map();
  for (const full of walk(src)) {
    if (full.endsWith(path.join('config', 'events.js'))) continue;
    const rel = path.relative(root, full).replaceAll(path.sep, '/');
    const text = stripComments(fs.readFileSync(full, 'utf8'));
    const add = (event, times = 1) => {
      const entry = result.get(event) || { count: 0, files: new Set() };
      entry.count += times;
      entry.files.add(rel);
      result.set(event, entry);
    };
    let match;
    EVENT_RE.lastIndex = 0;
    while ((match = EVENT_RE.exec(text))) add(match[1]);

    // ② 动态事件：`eventPrefix: '前缀'` × scheduler 模板 `${eventPrefix}.started` 等。
    //    （这是运行时校验里 "unregistered" 的常见来源；能静态展开的就展开进目录。）
    PREFIX_RE.lastIndex = 0;
    while ((match = PREFIX_RE.exec(text))) addPrefix(match[1], add);
    EVENT_OPTION_RE.lastIndex = 0;
    while ((match = EVENT_OPTION_RE.exec(text))) addCachePrefix(match[1], add);
    SUFFIX_RE.lastIndex = 0;
    while ((match = SUFFIX_RE.exec(text))) suffixes.add(match[1]);

    // ③ 配置里的事件名（如 `snapshotRefreshed: 'scan.snapshot.refreshed'`，调用点是
    //    `logInfo(events.snapshotRefreshed, …)` —— 静态扫描看不到）。只认 config/ 下、
    //    形如 `a.b.c` 的值，避免把普通英文短词/URL/中文当成事件。
    if (rel.startsWith('src/config/')) {
      CONFIG_EVENT_RE.lastIndex = 0;
      while ((match = CONFIG_EVENT_RE.exec(text))) add(match[1]);
    }
  }
  // 前缀 × 后缀展开（如 `product.tag_qr.sweep` × `.started` / `.tick_failed`）
  for (const [prefix, adders] of prefixes) {
    for (const suffix of suffixes) {
      const event = `${prefix}.${suffix}`;
      for (const add of adders) add(event);
    }
  }
  for (const [prefix, adders] of cachePrefixes) {
    for (const suffix of CACHE_EVENT_SUFFIXES) {
      const event = `${prefix}.${suffix}`;
      for (const add of adders) add(event);
    }
  }
  return new Map([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const header = (commentPrefix = '//') => [
  `${commentPrefix} ⚠️ AUTO-GENERATED —— 不要手改；改事件名/新增日志后跑：`,
  `${commentPrefix}    cd server && pnpm run observability:events`,
].join('\n');

export function renderCatalog(events) {
  const lines = ['\'use strict\';', '', header(), '', '/** 全仓日志事件名的唯一真源（由 scripts/observability-events.mjs 生成）。 */', 'const EVENTS = Object.freeze(['];
  for (const [event] of events) lines.push(`  '${event}',`);
  lines.push(']);', '', 'const EVENT_SET = new Set(EVENTS);', '', '/** 这个事件名是否已登记（运行时校验用；未登记只告警、不阻断）。 */', 'const isRegisteredEvent = (event) => EVENT_SET.has(String(event || \'\'));', '', 'module.exports = { EVENTS, isRegisteredEvent };', '');
  return lines.join('\n');
}

export function renderDoc(events) {
  const lines = [
    '# 观测事件目录（自动生成）',
    '',
    '> ⚠️ 本文件由 `server/scripts/observability-events.mjs` 生成，**不要手改**。',
    '> 新增/改名日志事件后跑：`cd server && pnpm run observability:events`。',
    '',
    `共 **${events.size}** 个事件。按前缀分组：`,
    '',
  ];
  const groups = new Map();
  for (const [event, info] of events) {
    const prefix = event.split('.')[0] || 'other';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push([event, info]);
  }
  for (const prefix of [...groups.keys()].sort()) {
    lines.push(`## ${prefix}`, '', '| 事件 | 次数 | 文件 |', '| --- | --- | --- |');
    for (const [event, info] of groups.get(prefix)) {
      const files = [...info.files].sort();
      const shown = files.slice(0, 3).join('<br>') + (files.length > 3 ? `<br>…等 ${files.length} 个文件` : '');
      lines.push(`| \`${event}\` | ${info.count} | ${shown} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function generate({ write = true } = {}) {
  const events = scanEvents();
  const catalog = renderCatalog(events);
  const doc = renderDoc(events);
  if (!write) return { events, catalog, doc };
  fs.writeFileSync(EVENT_FILE, catalog);
  fs.writeFileSync(DOC_FILE, doc);
  return { events, catalog, doc };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  const { events, catalog, doc } = generate({ write: !check });
  const eventCount = events.size;
  if (check) {
    const catalogNow = fs.existsSync(EVENT_FILE) ? fs.readFileSync(EVENT_FILE, 'utf8') : '';
    const docNow = fs.existsSync(DOC_FILE) ? fs.readFileSync(DOC_FILE, 'utf8') : '';
    if (catalogNow !== catalog || docNow !== doc) {
      console.error(`⛔ 事件目录/文档已过期（源码里现在有 ${eventCount} 个事件）⇒ 跑 pnpm run observability:events 重新生成`);
      process.exit(1);
    }
    console.log(`✅ 事件目录/文档是最新的（${eventCount} 个事件）`);
  } else {
    console.log(`✅ 已生成 ${eventCount} 个事件 → src/config/events.js + docs/observability-events.md`);
  }
}
