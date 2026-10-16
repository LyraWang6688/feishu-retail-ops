'use strict';

/**
 * ⭐⭐ 测试用的**扫码页路由源码聚合**（2026-10-16 · `routes/scanPage.js` 拆分之后）。
 *
 * 为什么需要它：`routes/scanPage.js` 被拆进 `routes/scanPage/*.js`，而**几十条判据是按"源码文本"
 *   钉行为的**（例：`fs.readFileSync(path.join(__dirname,'..','src','routes','scanPage.js'))`
 *   之后再 `includes(...)` / `indexOf(...)` 切片 / 数出现次数）。
 *
 * 🔴 那些判据**一条都不许放宽**（拆分是**纯搬运** ⇒ 它们本来就该照旧成立 ✓）。
 *   ⇒ 做法：把拆开的块按**原文顺序**拼回一份"拆之前那一份源码"，并把拆分时唯一改过的
 *     `require` 相对路径前缀**反向**换回去 ⇒ 拼出来的文本与 `3d97bfa:server/src/routes/scanPage.js`
 *     **逐字节相同**（sha256 = `74cc86d900ab93831723c29c5e195c5e8324804305240504dcf60d367281c285` ✓
 *     由 `test/scanPageSplitParity.test.js` 的 **AC-SP-2** 钉住 ✓）。
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

/** 拆分时**新增**的那几行（聚合时必须去掉 ✓）—— 与 `index.js` 里那段注释逐字对应 ✓。 */
const ADDED_REQUIRE_BLOCK = [
  '',
  '// ⭐⭐ 2026-10-16 拆分（阶段二·纯搬运）：下面这几件已搬到同目录各文件 ✓ 形状/语义一字未改 ✓',
  "const { asList } = require('./shared');",
  "const { parsePaymentRows } = require('./payment');",
  "const { parseReplenishEntries, parseReturnEntries } = require('./posting');",
  "const { parseMultiItemGroups, mergeFirstItemEntries } = require('./multiItem');",
].join('\n');

/** 原文里**被搬走**的块的顺序（按**原文出现顺序** ✓ 顺序错 ⇒ sha 对不上 ⇒ 红 ✓）。 */
const MOVED = [
  { file: 'posting.js', name: 'parseReplenishEntries' },
  { file: 'posting.js', name: 'parseReturnEntries' },
  { file: 'multiItem.js', name: 'parseMultiItemGroups' },
  { file: 'multiItem.js', name: 'mergeFirstItemEntries' },
  { file: 'shared.js', name: 'asList' },
  { file: 'payment.js', name: 'parsePaymentRows' },
];

/** 取某个子文件里"原文逐字切片"那一段（标记之后、`module.exports` 之前 ✓ = 与原文逐字相同 ✓）。 */
const sliceOf = (file) => {
  const text = fs.readFileSync(path.join(SCAN_PAGE_DIR, file), 'utf8');
  const at = text.indexOf(MARK);
  if (at < 0) throw new Error(`聚合失败：${file} 里没有切片标记 ✗`);
  const body = text.slice(at + MARK.length + 1);
  const end = body.lastIndexOf('\nmodule.exports');
  if (end < 0) throw new Error(`聚合失败：${file} 里找不到 module.exports ✗`);
  return body.slice(0, end);
};

/** ⭐ 拆之前那一份源码（壳不算 ✗ —— 壳是拆分新增的 ✓）。 */
const scanPageSource = () => {
  const index = fs.readFileSync(path.join(SCAN_PAGE_DIR, 'index.js'), 'utf8');
  let out = index.replace(ADDED_REQUIRE_BLOCK, '');
  out = out.replace(/require\('\.\.\/\.\.\//g, "require('../");
  out = out.replace(/require\('\.\.\/(workbench|feishuWebAuth)'\)/g, "require('./$1')");
  // ⚠️ 被搬走的块在原文里位于**工厂结束之后、`module.exports` 之前** ✓（顺序错 ⇒ sha 对不上 ⇒ 红 ✓）
  const cut = out.indexOf('\nmodule.exports');
  if (cut < 0) throw new Error('聚合失败：index.js 里找不到 module.exports ✗');
  const files = [...new Set(MOVED.map((m) => m.file))];
  const blocks = files.map((file) => sliceOf(file)).join('\n');
  return out.slice(0, cut) + blocks + out.slice(cut);
};

/** 壳必须**只**转发（薄壳口径 ✓）：行数上限 ✓。 */
const SHELL_MAX_LINES = 20;

module.exports = { scanPageSource, SCAN_PAGE_DIR, SHELL, MOVED, ADDED_REQUIRE_BLOCK, MARK, SHELL_MAX_LINES };
