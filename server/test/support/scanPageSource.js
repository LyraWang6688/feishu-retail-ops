'use strict';

/**
 * ⭐⭐ 测试用的**扫码页路由源码聚合**（2026-10-16 · `routes/scanPage.js` 拆分之后）。
 *
 * 为什么需要它：`routes/scanPage.js` 被拆进 `routes/scanPage/*.js`，而**几十条判据是按"源码文本"
 *   钉行为的**（例：`fs.readFileSync(path.join(__dirname,'..','src','routes','scanPage.js'))`
 *   之后再 `includes(...)` / `indexOf(...)` 切片 / 数出现次数）。
 *
 * 🔴 那些判据**一条都不许放宽**（拆分是**纯搬运** ⇒ 它们本来就该照旧成立 ✓）。
 *
 * ⭐⭐ **口径（2026-10-16 · 第 2 轮 · Lead 批 ✓）**：
 *   聚合 = **`index.js` 全文** ＋ **各子文件的"标记切片"**（按 `SOURCE_ORDER` 固定顺序 ✓ 不存在的文件跳过 ✓）
 *   ⇒ 那些"读源码"的判据**照旧能看到全部代码** ✓
 *
 * ⚠️ 第 1 轮曾用"**把块按原文顺序拼回 ⇒ 与拆之前逐字节相同（sha 74cc86d…）**"——
 *   那个口径只在**整块拼接**下成立 ✓；第 2 轮把闭包函数/分支搬进子文件时 `index.js` 里会留下
 *   **调用行** ✗ ⇒ 聚合**不可能**再等于原文 ✗ ⇒ 已由 `scanPageMovedBodies.js` 的
 *   **按函数体 sha 登记表**取代 ✓（见 `test/routesScanPageSplitParity.test.js` 的 AC-SP-R2 ✓）。
 *
 * ⚠️ 只给测试用（`test/support/` 不在生产依赖里 ✓）。
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', '..');
const SCAN_PAGE_DIR = path.join(SERVER_DIR, 'src', 'routes', 'scanPage');
const SHELL = path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js');

/** 子文件里"原文逐字切片"的起始标记（聚合时**不含**这一行 ✓）。 */
const MARK = '// ===== 以下为原文逐字切片（聚合用；勿改 ✗）=====';

/** ⭐ 聚合顺序（固定 ✓）：真身在前，其余按**关注点**顺序 ✓；不存在的文件跳过 ✓。 */
const SOURCE_ORDER = ['index.js', 'shared.js', 'payment.js', 'posting.js', 'multiItem.js', 'drafts.js'];

/**
 * ⭐ 第 2 轮口径：`index.js` 全文 ＋ 各子文件的标记切片（无标记的子文件取全文 ✓）。
 */
const scanPageSource = () => SOURCE_ORDER
  .map((file) => path.join(SCAN_PAGE_DIR, file))
  .filter((full) => fs.existsSync(full))
  .map((full) => {
    const text = fs.readFileSync(full, 'utf8');
    if (path.basename(full) === 'index.js') return text;
    const at = text.indexOf(MARK);
    return at < 0 ? text : text.slice(at + MARK.length + 1);
  })
  .join('\n');

/** 壳必须**只**转发（薄壳口径 ✓）：行数上限 ✓。 */
const SHELL_MAX_LINES = 20;

module.exports = { scanPageSource, SCAN_PAGE_DIR, SHELL, SOURCE_ORDER, MARK, SHELL_MAX_LINES };
