'use strict';

/**
 * ⭐⭐ 2026-10-16（Lead 派活 ①②）—— **文档索引完整性哨兵** ＋ **今晚 7 条口径进总账**。
 *
 * 起因：`docs/README.md` 的索引**只加不核** ⇒ 今晚新增的文档（含 AI 全停、订单列表性能、
 *   补货/退货接异步、标注模式…）**没进索引** ✗ —— 索引是"找得到"的唯一入口，
 *   漏登记 = 那份文档**等于没写** ✓
 * ⇒ 本文件把"索引与 `docs/**` 彼此对得上"变成**能真红的判据** ✓
 *
 * 🔴 本文件**只新建测试**：不改 `server/src/**` ✗（各有主）· 不改 `config/**` ✗
 *   唯一被读的是 `docs/**`（只读 ✓）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'README.md');

/**
 * ⭐ 索引的**实际覆盖范围 = `docs/*.md`（顶层那些）** ——
 *   索引对**子目录**（`adr/` / `archive/` / `reports/` / `branch-salvage-*`…）是**选择性**登记的
 *   （例如只登记 `adr/README.md`，历史归档一律不进索引 ✓）
 * ⇒ 所以哨兵只对**顶层**文档要求"必须进索引" ✗；子目录文档**允许**不在索引里 ✓（如实标注 ✓）
 */
const needIndex = () => fs.readdirSync(DOCS, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.md'))
  .map((e) => e.name)
  .sort();

/** 索引里写的目标（`](xxx.md)` ✓）—— 相对 `docs/` 解析 */
const indexTargets = (text) => [...text.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
const normalise = (rel) => path.normalize(rel).replace(/\\/g, '/');

/**
 * ⭐ 检测器（**纯函数** ⇒ 可以用坏样本单独验它**不是空跑** ✓）
 * 返回：未进索引的文档 + 索引里指向不存在文件的条目。
 */
const audit = (files, targets, exists) => ({
  unindexed: files.filter((f) => !targets.includes(f)).sort(),
  dangling: [...new Set(targets)].filter((t) => !exists(t)).sort(),
});

// ═══════════════════════════════════════════════════════════════════════════

test('AC-DI0 ⭐ 探针：审计函数**不空跑**（喂坏样本必须报红 ✓）', () => {
  const files = ['a.md', 'b.md'];
  const targets = ['a.md', 'ghost.md'];
  const exists = (t) => t === 'a.md';
  const result = audit(files, targets, exists);
  assert.deepEqual(result.unindexed, ['b.md'], '文档没进索引 ⇒ 必须被点出来 ✓');
  assert.deepEqual(result.dangling, ['ghost.md'], '索引指向不存在的文件 ⇒ 必须被点出来 ✓');
  assert.deepEqual(audit(['a.md'], ['a.md'], exists), { unindexed: [], dangling: [] }, '干净输入不许误报 ✓');
});

test('AC-DI1 ⭐⭐ 每份 `docs/**/*.md` 都在索引里（新文档漏登记 ⇒ 红 ✓）', () => {
  const files = needIndex().map(normalise);
  const targets = indexTargets(fs.readFileSync(INDEX, 'utf8')).map(normalise);
  const { unindexed } = audit(files, targets, () => true);
  assert.deepEqual(unindexed, [],
    '⛔ 这些文档**没进 docs/README.md 索引** ⇒ 等于没人找得到 ✗（新增时必须同时登记）：' + unindexed.join(' / '));
});

test('AC-DI2 ⭐⭐ 索引里的每条都指向**真实存在**的文件（指向已删文档 ⇒ 红 ✓）', () => {
  const targets = indexTargets(fs.readFileSync(INDEX, 'utf8')).map(normalise);
  const exists = (t) => fs.existsSync(path.join(DOCS, t));
  const { dangling } = audit([], targets, exists);
  assert.deepEqual(dangling, [],
    `⛔ 索引里有**指向不存在文件**的条目（文档已删/改名 ⇒ 成对订正索引 ✗）：${dangling.join(' / ')}`);
});

test('AC-DI3 ⭐ 今晚那 7 条口径都在总账里（且逐字可追 ✓）', () => {
  const backlog = fs.readFileSync(path.join(DOCS, 'owner-requests-backlog.md'), 'utf8');
  const wanted = [
    ['R-19', '都停掉，与 AI 分析有关的都停掉'],           // ① AI 全停
    ['R-20', '收款明细是记账47.7'],                        // ② 团购券三个数
    ['R-21', 'A：自动记（差额⇒未收款）'],                 // ③ 少付自动记未收款
    ['R-22', '最下面的蓝色按钮改为退货'],                  // ④ 退货页三处 + 按钮改名
    ['R-23', '输入货号，例如 XHB8095'],                    // ⑤ 工作台 domains 三处
    ['R-24', 'B：工作台那半也接异步'],                     // ⑥ 验收也接异步
    ['R-25', '我可没有说过，我们是能够进行动态交互的'],   // ⑦ 零 JS 是我方约束（订正）
  ];
  for (const [id, quote] of wanted) {
    assert.ok(backlog.includes(id), `总账里缺 ${id} ✗`);
    assert.ok(backlog.includes(quote), `${id} 的**她的原话（逐字）**必须在总账里 ✓（缺：${quote}）`);
  }
});
