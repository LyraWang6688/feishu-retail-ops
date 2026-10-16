'use strict';

/**
 * ⭐⭐ **不再有开关**（业务负责人 2026-10-16 22:5x 逐字）：
 *   「**不用。以后你不用有"开关"的这个思维，我们换了新功能，就直接用新功能就可以了呀。
 *     把新功能都上了，不需要开关。**」
 * ⇒ 落档 `docs/no-switch-rule-2026-10-16.md` ✓（PR #786 ✓）
 *
 * ⭐⭐ **两条独立的小哨兵（Lead 2026-10-16 拆法 ✓）** ——
 *   ⚠️ 根因：一个哨兵同时扫"**两类完全不同的东西**"⇒ 想用一套正则吃两类 ⇒ 必然假红或漏判 ✗
 *     · **AC-NS1（名字型）**：只扫 `SCAN_*` 这类**环境变量名** ⇒ 命中形态 = **读取形态** ✓
 *       ⚠️ 仍会被"**成对迁移注释逐字抄形态**"命中（实测踩过 ✗）⇒ 配 **逐行跳注释行** ✓
 *     · **AC-NS2（符号型）**：只扫**导入/定义/导出**出来的符号 ⇒ 命中形态 = `module.exports` 条目 /
 *       `const { X } = require(…)` / `exports.X` / 定义 ✓ —— ⭐ **注释里天然不会有这些形态** ✓
 *       ⇒ ⭐ **这条不用去注释** ✓（⭐ 迁移注释是整行 `//` ✓ 不会写 `module.exports` ✓）
 *
 * ⭐ **先在 `/tmp` 写成独立脚本跑通 ＋ 正负自证，才落进本文件**（Lead 要求 ✓ 我照做 ✓）：
 *   · **负向**：现在这样（只有迁移注释引用旧名）⇒ **0 命中** ✓
 *   · **正向 A**：把 `SELLABLE_STATES` 塞回**代码行**（`module.exports` 里）⇒ **AC-NS2 命中** ✓
 *   · **正向 B**：塞回真读取（`readFlag(env, 'SCAN_STOCK_POLICY_ENABLED', …)`）⇒ **AC-NS1 命中** ✓
 *   · 各自**还原逐字节** ✓
 *
 * **AC-NS3** ⭐ **行为还在**：⭐ "删开关 = 永远开" ✓ **不是把功能删了** ✗（正向钉 ✓）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const SRC = path.join(SERVER, 'src');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.js') ? [full] : [];
});
const allSrc = () => walk(SRC).map((file) => ({
  file: path.relative(SERVER, file), lines: fs.readFileSync(file, 'utf8').split('\n'),
}));

/** ⭐ 逐行跳注释行（本仓成对迁移注释**全是整行 `//`** ✓ 够用 ✓ 不做词法分析 ✗）。 */
const isCommentLine = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
};

/** ⭐ AC-NS1 命中形态 = **读取形态**（名字型 ✓）。 */
const readHit = (line, name) => [
  new RegExp(`read(Flag|String|Int)\\(env,\\s*'${name}'`),
  new RegExp(`getEnv\\(env,\\s*'${name}'`),
  new RegExp(`process\\.env\\.${name}\\b`),
  new RegExp(`process\\.env\\['${name}'\\]`),
].some((re) => re.test(line));

/** ⭐ AC-NS2 命中形态 = **导入 / 定义 / 导出**（符号型 ✓ 注释天然不匹配 ✓）。 */
const symbolHit = (line, symbol) => [
  new RegExp(`^\\s*${symbol}\\s*,?\\s*$`).test(line),                                  // exports/参数里的裸条目
  new RegExp(`^\\s*${symbol}\\s*:`).test(line),                                        // 对象属性条目
  new RegExp(`const\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*=\\s*require\\(`).test(line), // 解构 import
  new RegExp(`^\\s*(const|let|var)\\s+${symbol}\\s*=`).test(line),                      // 定义
  new RegExp(`^\\s*(module\\.)?exports\\.${symbol}\\b`).test(line),                     // exports.X =
  new RegExp(`function\\s+${symbol}\\b`).test(line),                                    // 函数定义
].some(Boolean);

/** 已退场的 env 名字（**逐批加** ✗ 不新建文件 ✓）。 */
const REMOVED_NAMES = [
  'SCAN_MULTI_ITEM_ASYNC_ENABLED',   // ① 一单多货异步（已删净 ✓）
  'SCAN_STOCK_POLICY_ENABLED',       // ② 四页库存口径（已删净 ✓）
];

/** 已退场的符号（**逐批加** ✓ —— 删一个符号必须同时搜「定义 / 导出 / import / 消费者」四处 ✗）。 */
const REMOVED_SYMBOLS = [
  'asyncEnabled',            // ① 一单多货异步的配置键 ✓
  'SELLABLE_STATES',         // ② 老口径名单（视图层转发 ✓）
  'LEGACY_SELLABLE_STATES',  // ② 老口径名单本体 ✓
  'legacySellableCountOf',   // ② 老口径计数 ✓
  'legacyStates',            // ② 挂在配置对象上的老口径 ✓
];

test('AC-NS1 ⭐ **名字型**：那些开关名**只许出现在注释里**（读取形态 0 处 ⇒ 名字回来即红 ✓）', () => {
  const hits = [];
  for (const { file, lines } of allSrc()) {
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;   // ⭐ 逐行跳注释行 ✓（迁移注释会逐字抄"改前形态" ✗）
      if (REMOVED_NAMES.some((name) => readHit(line, name))) hits.push(`${file}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, [],
    '⭐ 这些开关名**不许再被读取** ✗（她 22:5x：不需要开关 ⇒ 永远用新功能 ✓）—— 名字回来 ⇒ 红 ✓');
});

test('AC-NS2 🔴 **符号型**：退场时删掉的那些符号**不许再被 导出 / 定义 / import**（塞回即红 ✓）', () => {
  const hits = [];
  for (const { file, lines } of allSrc()) {
    lines.forEach((line, i) => {
      if (REMOVED_SYMBOLS.some((symbol) => symbolHit(line, symbol))) {
        hits.push(`${file}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    '⭐ 这些符号必须**删净** ✗（⭐ 删一个符号必须同时搜【定义 / 导出 / import / 消费者】四处 ✗ '
    + '—— 只删定义 ⇒ 模块**加载即 ReferenceError** ✓ 今晚踩过 ✓）—— 塞回即红 ✓');
});

test('AC-NS3 ⭐ **行为还在**：删开关 = 永远开 ✓ **不是把功能删了** ✗（正向钉 ✓）', () => {
  // ① 一单多货：⭐ "提交即回、后台那一跑"必须照旧在 ✓
  const routes = fs.readFileSync(path.join(SRC, 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.ok(/schedulePurchaseRest|schedulePurchaseWrite/.test(routes),
    '⭐ "提交即回、后台那一跑"必须**照旧在** ✗（删开关 = 永远开 ✓ 不是把功能删了 ✗）');
  // ② 四页库存口径：⭐ "有货"判据必须**只剩新口径**（实时库存里有记录 = 有货 ✓）
  // ⚠️ 同 AC-NS1：⭐ **按行跳注释** ✓（成对迁移注释里逐字抄了 `policy.enabled ? … : legacySellableCountOf(…)` ✗）
  const policy = fs.readFileSync(path.join(SRC, 'config', 'scanStockPolicy.js'), 'utf8')
    .split('\n').filter((line) => !isCommentLine(line)).join('\n');
  assert.ok(/const countInStockOf = \(row\) => liveInventoryCountOf\(row\);/.test(policy),
    '⭐ 「有货」判据必须**只剩新口径** ✓（`liveInventoryCountOf` ⇒ 实时库存里有记录就有货 ✓）');
  assert.equal(/legacySellableCountOf|policy\.enabled/.test(policy), false,
    '🔴 老口径（按门盒/样品那两格数）**不许留下任何一行** ✗');
});
