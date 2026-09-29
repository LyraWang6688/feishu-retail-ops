#!/usr/bin/env node
/**
 * 从机器人任务文件里导出真实销售案例，按用途分三类。
 *
 *   node scripts/collect_sales_cases.js                        # 打印到屏幕
 *   node scripts/collect_sales_cases.js --out cases.md         # 同时写文件
 *   node scripts/collect_sales_cases.js --dir data/xxx_tasks   # 换目录
 *
 * 为什么要分类：
 *   good      —— 可以直接当「正确示例」给使用者看，也是回归测试的样本
 *   bad       —— 货号/颜色匹配不上等，是要提醒使用者避免的写法
 *   boundary  —— 意图不符、解析失败、缺信息等边界情况，用来测稳健性
 *
 * 数据来源是本地任务文件（`data/lark_mvp_tasks/`），比多维表格更全：
 * 表里被删掉的记录，本地文件还在。
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dir = path.resolve(process.cwd(), argOf('dir', 'data/lark_mvp_tasks'));
const outFile = argOf('out', '');

// 富文本消息里的 HTML 标签在这里去掉，导出的是人能读的原话。
const readableText = (value) => String(value || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// 「坏示例」的判定依据：失败原因指向货品本身，而不是用户少说了什么。
const BAD_REASONS = [/找不到/, /不唯一/, /无法匹配/, /多个/, /颜色/, /货号/, /编号/];

const classify = (task) => {
  const status = String(task.status || '');
  const missing = Array.isArray(task.draft?.missing_fields) ? task.draft.missing_fields : [];
  const text = readableText(task.original_text);
  if (!text) return 'skip';
  if (status === 'needs_info' && missing.some((item) => BAD_REASONS.some((re) => re.test(String(item))))) {
    return 'bad';
  }
  if (['ignored', 'failed'].includes(status) || status === 'needs_info') return 'boundary';
  if (['ready_to_confirm', 'completed', 'posted'].includes(status)) return 'good';
  return 'skip'; // 还在处理中的任务先不导出
};

const reasonOf = (task) => {
  if (task.error) return String(task.error);
  const missing = task.draft?.missing_fields;
  if (Array.isArray(missing) && missing.length) return missing.join('；');
  if (task.status === 'ignored') return '未识别为当前支持的销售';
  return '';
};

const main = () => {
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  const buckets = { good: [], bad: [], boundary: [] };
  const seen = new Set();
  let skipped = 0;

  for (const file of files) {
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (error) {
      console.error(`跳过无法解析的文件 ${file}：${error.message}`);
      continue;
    }
    const kind = classify(task);
    if (kind === 'skip') { skipped += 1; continue; }
    const text = readableText(task.original_text);
    const dedupeKey = `${kind}|${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    buckets[kind].push({ text, status: task.status, reason: reasonOf(task), at: task.sent_at || task.created_at || '' });
  }

  const lines = [];
  lines.push('# 销售案例收集');
  lines.push('');
  lines.push(`来源：${dir}`);
  lines.push(`共 ${files.length} 条任务，导出 ${buckets.good.length + buckets.bad.length + buckets.boundary.length} 条，`
    + `跳过 ${skipped} 条（处理中或缺原文）。`);
  lines.push('');

  const SECTION = [
    ['good', '一、正确示例（可以拿给使用者看）'],
    ['bad', '二、坏示例（货号或颜色对不上等，要提醒避免）'],
    ['boundary', '三、边界案例（意图不符、解析失败、信息缺失）'],
  ];
  for (const [key, title] of SECTION) {
    lines.push(`## ${title}`);
    lines.push('');
    if (!buckets[key].length) {
      lines.push('（暂无）');
      lines.push('');
      continue;
    }
    const reasons = new Map();
    for (const item of buckets[key]) {
      if (item.reason) reasons.set(item.reason, (reasons.get(item.reason) || 0) + 1);
    }
    if (reasons.size) {
      lines.push(`原因分布：${[...reasons.entries()].map(([r, n]) => `${r} ×${n}`).join('；')}`);
      lines.push('');
    }
    for (const item of buckets[key]) {
      lines.push(`- 原文：${item.text}`);
      if (item.reason) lines.push(`  - 结果：${item.status}｜${item.reason}`);
      lines.push('');
    }
  }

  const output = lines.join('\n');
  console.log(output);
  if (outFile) {
    const target = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(target, `${output}\n`, 'utf8');
    console.log(`\n已写入 ${target}`);
  }
};

main();
