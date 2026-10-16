'use strict';

/**
 * ⭐⭐ 第 2 轮的**新 parity 口径**（Lead 批 ✓）：**搬走的函数体**必须
 *   ① **逐字没被改过** —— 其 sha256 == 从**基线提交**切出来的那一份 ✓
 *   ② **恰好出现一次**（在某个子文件里 ✓）
 *   ③ **`index.js` 里不再出现** ✗（留在原地 ⇒ 红 ✓）
 *
 * 为什么换口径：第 1 轮的"聚合 == 原文"只在**整块拼接**下成立 ✓；
 *   第 2 轮把闭包里的函数/分支搬进子文件（`index.js` 里留下**调用行** ✗）⇒ 聚合**不可能**再等于原文 ✗
 *   ⇒ 改成"**按函数体逐个钉 sha**" ✓（Lead 加的那条 ✓ 比"看起来还在"强 ✓）。
 *
 * 🔴 **函数体的边界规则（与基线同一规则 ✓ 两边不许不一样 ✗）**：
 *   从 `const NAME = ` 那一行起，到**下一个顶层**行（以 `const ` / `/**` / `//` / `module.exports` 开头）
 *   **之前**为止 ✓（去掉尾部空行 ✓）。
 *   ⚠️ **第一版我把"下一个函数的注释块"也算进体里** ✗ ⇒ 7 条里 2 条**假红**
 *     （`parseReturnEntries` 875 vs 实际 379 · `asList` 354 vs 211 —— 差异**全是下一个函数的注释** ✓
 *      **函数体本身一直是逐字的** ✓）⇒ **规则已修正** ✓ 谁再按"含下一段注释"重算 ⇒ 又会假红 ✗。
 *
 * ⚠️ 只给测试用 ✓；`baseline` 一栏逐字写明**从哪个 commit 切出来的** ✗ 不许含糊 ✓。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_DIR = path.join(__dirname, '..', '..');
const SCAN_PAGE_DIR = path.join(SERVER_DIR, 'src', 'routes', 'scanPage');
const INDEX = path.join(SCAN_PAGE_DIR, 'index.js');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** 体（规则见文件头 ✓ 与基线同一规则 ✓）。 */
const bodyOf = (text, name) => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`const ${name} = `));
  if (at < 0) return null;
  let end = at + 1;
  const stop = (line) => line.startsWith('const ')
    || line.startsWith('/**') || line.startsWith('//') || line.startsWith('module.exports');
  while (end < lines.length && !stop(lines[end])) end += 1;
  return lines.slice(at, end).join('\n').replace(/\n+$/, '');
};

/** ⭐ 登记表：**已搬走**的函数体 → 应在哪个子文件 ✓ ＋ **基线 sha**（基线提交逐字写明 ✓）。 */
const MOVED_BODIES = [
  // ── 第 1 轮搬走的 7 个（基线 = `3d97bfa:src/routes/scanPage.js` ✓ 已按修正后的规则逐字核对 ✓）──
  { name: 'parseReplenishEntries', file: 'posting.js', baseline: '3d97bfa', sha: 'd313e5985645251ee3700ddddf11fed69b1d9746720fa6b9e5bd2669186e9e88' },
  { name: 'parseReturnEntries', file: 'posting.js', baseline: '3d97bfa', sha: 'bafd4b820c1ca8d0f808da7044803c6f79f9219f50779e7fe299e1a30587c11e' },
  { name: 'parseMultiItemGroups', file: 'multiItem.js', baseline: '3d97bfa', sha: '1bae3e253e45e95a0f0d27bd33800498c6abc0afb3a38d77413eb65de5c97727' },
  { name: 'mergeFirstItemEntries', file: 'multiItem.js', baseline: '3d97bfa', sha: '26013fc6ec3c3f67c6c572fb514f5d51e3b4b474c54b460d104cbea1a68dbb56' },
  { name: 'asList', file: 'shared.js', baseline: '3d97bfa', sha: 'e7fdadfb1ce538a87175621e49f83571b60ada510eaa5aa55a0424ace09dda60' },
  { name: 'parsePaymentRows', file: 'payment.js', baseline: '3d97bfa', sha: '390bbfe465727f776e0d538083d948de01714ee6855a1f3caf488abb219aaad9' },
  { name: 'purchaseWriteDisabledError', file: 'multiItem.js', baseline: '3d97bfa', sha: '9933fa505633969da342b6a14f518d248a9275250a3aef16c3f8527651e25608' },
];

const subFiles = () => fs.readdirSync(SCAN_PAGE_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
const indexText = () => fs.readFileSync(INDEX, 'utf8');
const allTexts = () => [indexText(), ...subFiles().map((f) => fs.readFileSync(path.join(SCAN_PAGE_DIR, f), 'utf8'))];

/** 逐条核对 ✓（返回 [{name, baseline, ok, why}] 供判据逐条钉 ✓）。 */
const checkMovedBodies = () => MOVED_BODIES.map((entry) => {
  const text = fs.readFileSync(path.join(SCAN_PAGE_DIR, entry.file), 'utf8');
  const body = bodyOf(text, entry.name);
  if (!body) return { ...entry, ok: false, why: `子文件 ${entry.file} 里找不到 ${entry.name} ✗` };
  if (sha256(body) !== entry.sha) {
    return { ...entry, ok: false, why: `${entry.name} 的函数体**不是逐字**（sha 不符 ✗ 基线 ${entry.baseline} ✓）` };
  }
  const count = allTexts().reduce((n, t) => n + (t.includes(body) ? 1 : 0), 0);
  if (count !== 1) return { ...entry, ok: false, why: `${entry.name} 的函数体出现了 ${count} 次（必须**恰好 1 次** ✗）` };
  if (indexText().includes(body)) return { ...entry, ok: false, why: `${entry.name} 的函数体**还在 index.js 里** ✗` };
  return { ...entry, ok: true, why: '' };
});

module.exports = { MOVED_BODIES, checkMovedBodies, bodyOf, sha256, SCAN_PAGE_DIR, INDEX, subFiles };
