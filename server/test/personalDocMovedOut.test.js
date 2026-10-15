'use strict';

/**
 * personalDocMovedOut.test.js —— 那份**个人需求文档**已移出本仓的哨兵（0 悬空引用）。
 *
 * ## 来历（业务负责人 2026-10-15 深夜决定 · 逐字）
 * > 「「手机里…需求说明」这份文档**移动到 workplace 里的临时仓库**吧」
 * ＋她给的路径：`/Users/wangying/Documents/workplace/temp repo`（**不是 git 仓库** ⇒ 复制即可）。
 * 删除前核过：目标那份与本仓那份 **md5 逐字节一致** ✓（`768314b4…`）。
 *
 * ⇒ **本仓已删掉那份**；它在本仓**只有一处历史引用**（架构审计报告 §3.3 第 4 项），
 *   那处按"**原结论留痕 + 🔁 后续状态**"成对更正 ⇒ **0 悬空引用** ✓
 *
 * ## 钉住三条（都能真红）
 * - **AC-DOC1** 仓库根目录**不再有**那份文档（变异：重建文件 ⇒ 红）
 * - **AC-DOC2** 全仓（README / AGENTS.md / docs / 脚本 / CI / package.json …）**除架构审计报告外 0 处提及**
 *   （变异：往 README.md 塞一句 ⇒ 红）；且**审计报告里必须留「已移出本仓」这句更正**（成对出现）
 * - **AC-DOC3** 审计报告那处是**成对更正**：原结论**逐字保留**（"不许我替她处理文档归属"仍在）
 *   ＋ 新增「后续状态」＋「已移出本仓」
 *
 * ⚠️ **本文件自己不许出现那两个关键词的字面量**（否则会把自己扫成"引用"✗）——
 *   ⇒ 关键词一律**拼**出来（`['…', '…'].join('')`），只作"要抓的目标"用 ✓
 * ⚠️ 扫描**排除** `.git` / `node_modules` / `.local`（后者是并行代理的 worktree，不在版本库里）/
 *   `server/data` / 二进制与图片；只扫文本文件（`git ls-files` 更准，但这里**不依赖 git**，便于离线跑）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

// 关键词**拼**出来（本文件里不出现字面量）
// ⚠️ 标题里 `跟` 与 `AI` 之间**有一个连字符** —— 第一版漏了它 ⇒ 只能靠"日期后缀"命中，
//    「只写标题、不写日期」的引用会漏 ✗（本轮真踩到，已修）
const DOC_TITLE = ['手机里跟', 'AI-助手聊天'].join('-');
const DOC_NAME_SUFFIX = ['需求说明', '2026-10-08'].join('-');
const DOC_FILE_NAME = `${DOC_TITLE}-${DOC_NAME_SUFFIX}.md`;
/** 唯一允许**历史留痕**提到它的文件（架构审计报告 §3.3 第 4 项 ＋ 它的 🔁 后续状态）。 */
const HISTORY_RECORD_FILE = path.join('docs', 'architecture-audit-2026-10-15.md');
/** 留痕必须与更正**成对**出现（改前逐字保留 + 改后逐字说明已移出）。 */
const MOVED_OUT_MARKER = '已移出本仓';
const KEPT_RECORD_MARKER = '不许我替她处理文档归属';

const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.local', 'data', 'uploads']);
const TEXT_EXTENSIONS = new Set(['.md', '.js', '.cjs', '.mjs', '.json', '.yml', '.yaml', '.sh', '.txt', '.sql', '.html', '.css', '.example', '']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 递归列出**文本文件**（跳过跳过名单与二进制/超大文件）。 */
const listTextFiles = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(item.name)) continue;
        walk(path.join(dir, item.name));
        continue;
      }
      if (!item.isFile()) continue;
      const full = path.join(dir, item.name);
      const ext = path.extname(item.name);
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
};

/** 扫一遍：返回"提到它"的文件相对路径列表（含命中行号，便于排查）。 */
const findMentions = (root) => {
  const hits = [];
  for (const full of listTextFiles(root)) {
    let source;
    try { source = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!source.includes(DOC_TITLE) && !source.includes(DOC_NAME_SUFFIX)) continue;
    const relative = path.relative(root, full);
    source.split('\n').forEach((line, index) => {
      if (line.includes(DOC_TITLE) || line.includes(DOC_NAME_SUFFIX)) hits.push(`${relative}:${index + 1}`);
    });
  }
  return hits;
};

// ── AC-DOC1 文件已删 ────────────────────────────────────────────────────────
test('AC-DOC1 🔴 仓库根目录**不再有**那份个人需求文档（塞回来就红）', () => {
  const target = path.join(repoRoot, DOC_FILE_NAME);
  assert.equal(fs.existsSync(target), false,
    `本仓不该再有这份文档（她已决定移到 workplace/temp repo）：${DOC_FILE_NAME}`);
});

// ── AC-DOC2 0 悬空引用 ─────────────────────────────────────────────────────
test('AC-DOC2 🔴 全仓 **0 悬空引用**：只有架构审计报告那一处历史留痕，别的文件一处都不许有', (t) => {
  const hits = findMentions(repoRoot);
  assert.ok(hits.length > 0,
    '审计报告里必须**留着**那处历史留痕（原结论不改写）——一处都没有说明留痕被误删了');
  const outside = hits.filter((hit) => !hit.startsWith(HISTORY_RECORD_FILE));
  assert.deepEqual(outside, [],
    `🔴 这些文件还在提那份**已移出本仓**的文档（悬空引用）：\n${outside.join('\n')}`);
  const inHistory = hits.filter((hit) => hit.startsWith(HISTORY_RECORD_FILE));
  assert.ok(inHistory.length > 0, '历史留痕必须在架构审计报告里（§3.3 第 4 项）');
  t.diagnostic(`历史留痕命中：${inHistory.join(' / ')}`);
});

test('AC-DOC2b ⭐ 扫描器**真抓得到**引用（造一个临时文件 ⇒ 必被扫出来；防止哨兵烂成空转）', () => {
  const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-sentinel-'));
  try {
    fs.writeFileSync(path.join(sandbox, 'README.md'), `见根目录 ${DOC_FILE_NAME} 那份说明\n`, 'utf8');
    const hits = findMentions(sandbox);
    assert.equal(hits.length, 1, `扫描器必须抓得到这份引用，实得 ${JSON.stringify(hits)}`);
    assert.match(hits[0], /^README\.md:1$/);
    // 反向：**不提**它的文件不该被误抓
    fs.writeFileSync(path.join(sandbox, 'other.md'), '这份文档跟它无关\n', 'utf8');
    assert.equal(findMentions(sandbox).length, 1, '不许把无关文件误判成引用');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ── AC-DOC3 审计报告成对更正 ───────────────────────────────────────────────
test('AC-DOC3 ⭐ 审计报告那处是**成对更正**：原结论逐字留痕 ＋ 🔁 后续状态写明已移出本仓', () => {
  const audit = fs.readFileSync(path.join(repoRoot, HISTORY_RECORD_FILE), 'utf8');
  assert.ok(audit.includes(KEPT_RECORD_MARKER),
    '原结论必须**逐字保留**（"不许我替她处理文档归属"那句还在 ⇒ 留痕 ✓）');
  assert.ok(audit.includes(MOVED_OUT_MARKER),
    `必须写明「${MOVED_OUT_MARKER}」（改后现状 ⇒ 与留痕成对）`);
  const movedOutAt = audit.indexOf(MOVED_OUT_MARKER);
  const markerAt = audit.lastIndexOf(KEPT_RECORD_MARKER);
  assert.ok(movedOutAt > markerAt,
    '「后续状态」必须写在原结论**之后**（先留痕、再更正 ⇒ 顺序也是对的一部分）');
});
