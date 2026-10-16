/**
 * ⭐⭐ 测试用的**渲染层源码聚合**（2026-10-16 · `scanPageRenderer.js` 按块拆分之后）。
 *
 * 为什么需要它：`views/scanPageRenderer.js` 被拆进了 `views/scanPage/*.js`，
 *   而**几十条判据是按"源码文本"钉行为的**（例：数 `multiItemBlockHtml(write, view…)` 出现几次、
 *   从 `indexOf('const multiItemBlockHtml')` 切到 `indexOf('const replenishFormHtml')`、
 *   正则找某条 CSS 规则、`includes("require('./scanPageRealm')")`…）。
 *
 * 🔴 那些判据**一条都不许放宽**（拆分是**纯搬运** ⇒ 它们本来就该照旧成立 ✓）。
 *   ⇒ 做法：把拆开的块按**原文顺序**拼回一份"渲染层源码"，并**把拆分时唯一改过的东西
 *     （`require` 相对路径前缀）反向换回去** —— 这样拼出来的文本与"拆之前那一份"**逐字相同**
 *     （`test/scanPageSplitParity.test.js` 会拿 sha256 把这件事钉住 ✓）。
 *
 * ⚠️ 只给测试用（`test/support/` 不在生产依赖里 ✓）；顺序 = 原文里的出现顺序 ✓（切片语义才成立）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCAN_PAGE_DIR = path.join(__dirname, '..', '..', 'src', 'views', 'scanPage');

/** 原文里的出现顺序（**不是**文件名字典序 ✗ —— `indexOf` / `slice` 这类判据靠它 ✓）。 */
const ORDER = [
  'fields.js',
  'styles.js',
  'layout.js',
  'draftBlock.js',
  'stockBlock.js',
  'productBlock.js',
  'script.js',
  'paymentBlock.js',
  'multiItemBlock.js',
  'replenishBlock.js',
  'returnBlock.js',
  'realmBlock.js',
  'index.js',
];

/**
 * 拆分时**唯一**的文本改动（`scanPageRenderer.js` ⇒ `scanPage/*.js`：文件下了一层目录）。
 *   ⚠️ 这里按**逆序**换回去 —— 让聚合出来的文本与"拆之前那一份"逐字一致 ✓。
 *   （与 `docs/scan-page-renderer-split-2026-10-16.md` 里那张"改前逐字 → 改后逐字"表一一对应 ✓）
 */
const REVERSE_REWRITES = [
  ["require('../../config/scanPage')", "require('../config/scanPage')"],
  ["require('../../config/scanWrite')", "require('../config/scanWrite')"],
  ["require('../../config/multiItemOrder')", "require('../config/multiItemOrder')"],
  ["require('../scanPageRealm')", "require('./scanPageRealm')"],
  ["require('../scanRealmScan')", "require('./scanRealmScan')"],
];

/** 拆开后各块的源码（原文顺序拼接 + 路径反向 ⇒ 与"拆之前那一份"逐字相同 ✓）。 */
const rendererSource = () => ORDER
  .map((file) => fs.readFileSync(path.join(SCAN_PAGE_DIR, file), 'utf8'))
  .join('\n')
  .replace(/require\('\.\.\/\.\.\/config\/([A-Za-z]+)'\)/g, "require('../config/$1')")
  .replace(/require\('\.\.\/scanPageRealm'\)/g, "require('./scanPageRealm')")
  .replace(/require\('\.\.\/scanRealmScan'\)/g, "require('./scanRealmScan')");

module.exports = { rendererSource, SCAN_PAGE_DIR, ORDER, REVERSE_REWRITES };
