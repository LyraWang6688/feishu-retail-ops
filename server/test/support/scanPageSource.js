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
 * ⭐⭐ **口径（Lead 批 ✓）**：
 *   聚合 = **`index.js` 全文** ＋ **各子文件的"标记切片"**（按 `SOURCE_ORDER` 固定顺序 ✓ 不存在的文件跳过 ✓）
 *
 * 🔴🔴 **但聚合文本必须"是合法的 JS"** ✗ —— 因为**有一批用例会把读到的源码拿去 require/eval**
 *   （不只是做字符串匹配 ✗）。2026-10-16 实测教训：第一版聚合把 `index.js` 已 `require` 的声明
 *   又贴了一遍 ⇒ **`SyntaxError: Identifier 'asList' has already been declared`** ✗
 *   ⇒ 全量 **31 红、用例数 2899 → 2579**（有文件整片崩 ✗）。
 *
 *   处置（Lead 裁定 **(a)** ✓，落在下面两个函数里）：
 *     ① **把 `index.js` 里那些"名字已被切片定义"的 `const {…} = require(…)` 行注释掉** ✗
 *        （**自动**抽"切片定义了哪些名字"来判 ✗ 不许手写清单 ✓ —— **不删** ✗ 原文照旧在文本里 ✓；
 *         定义仍留在切片里 ✓ ⇒ 文本判据照旧找得到 `const asList = …` ✓；而聚合里只剩**一份定义** ⇒ 能解析 ✓）
 *     ② **去掉切片里的 `module.exports` 行** ✓（那是子文件的出口 ✓ 不在 index 的语义里 ✓）
 *   ⇒ 由 **AC-SP-R5**（`new vm.Script(聚合文本)` 只解析、不执行 ✓）钉住 ✓ **秒级**拦住这类崩 ✗。
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

/** 切片里**定义**的名字（`const NAME = …` ✓ 不含 require 行 ✗ —— 那些是"取用"不是"定义" ✓）。 */
const definedNamesOf = (slice) => {
  const names = new Set();
  for (const line of slice.split('\n')) {
    const m = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !/=\s*require\(/.test(line)) names.add(m[1]);
  }
  return names;
};

/** 从一行里抽出它声明的名字（`const { a, b } = require(…)` / `const x = require(…)` ✓）。 */
const declaredNamesInLine = (line) => {
  const curly = line.match(/^\s*const\s*\{([^}]+)\}\s*=\s*require\(/);
  if (curly) {
    return curly[1].split(',').map((x) => x.trim().split(':').pop().trim()).filter(Boolean);
  }
  const plain = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/);
  return plain ? [plain[1]] : [];
};

/**
 * ⭐ (a)：把 `index.js` 里**名字已被切片定义**的 `const … = require(…)` 行**注释掉** ✗（不删 ✗）。
 * ⚠️ 为什么不是"删切片的定义" ✗：那会让搬走的助手在聚合里**消失** ⇒ 文本判据会瞎 ✗（Lead 已否 (b) ✓）。
 */
const neutralizeCollidingRequires = (index, definedInSlices) => index.split('\n').map((line) => {
  if (!/=\s*require\(/.test(line) || !/^\s*const\s/.test(line)) return line;
  const nameList = declaredNamesInLine(line);
  const collides = nameList.length > 0 && nameList.some((n) => definedInSlices.has(n));
  return collides
    ? line.replace(/^(\s*)const\s/, '$1// ⚠️ 拆分后此处不再重复声明（同名定义在下方切片里 ✓）：const ')
    : line;
}).join('\n');

/** ⭐ (a)-②：切片的尾巴（`module.exports` 及其后）去掉 ✓ —— 那是子文件的出口 ✓ 不属于 index 语义 ✓。 */
const stripExports = (slice) => {
  const at = slice.indexOf('\nmodule.exports');
  return at < 0 ? slice : slice.slice(0, at);
};

/** ⭐ 聚合：`index.js`（冲突 require 行已注释 ✓）＋ 各子文件的标记切片（去过 `module.exports` ✓）。 */
const scanPageSource = () => {
  const index = fs.readFileSync(path.join(SCAN_PAGE_DIR, 'index.js'), 'utf8');
  const slices = SOURCE_ORDER.slice(1)
    .map((file) => path.join(SCAN_PAGE_DIR, file))
    .filter((full) => fs.existsSync(full))
    .map((full) => {
      const text = fs.readFileSync(full, 'utf8');
      const at = text.indexOf(MARK);
      return stripExports(at < 0 ? text : text.slice(at + MARK.length + 1));
    });
  const definedInSlices = new Set();
  slices.forEach((slice) => definedNamesOf(slice).forEach((n) => definedInSlices.add(n)));
  // ⭐⭐ **必须把 require 深度反向换回** ✗（第 1 轮就踩过一次 ✓ A′ 重写时漏了 ⇒ 3 个文件整片崩 ✗）：
  //   有一批用例会把聚合文本**当模块编译**，而编译路径 = `src/routes/scanPage.js`
  //   （= **拆分之前**那一份所在的位置 ✓）⇒ 子文件里的 `'../../x'` 在那个位置要写成 `'../x'` ✓
  // ⭐⭐ 切片必须插在 `module.exports` **之前** ✗（= 被搬走那块在原文里的位置 ✓）
  //   ⚠️ 追加在 `module.exports` **之后** ⇒ 那里读 `parseReplenishEntries` 会 **TDZ**
  //      （`ReferenceError: Cannot access '…' before initialization` ✗ 3 个"执行类"文件整片崩 ✓ 已实测 ✓）
  const prepared = neutralizeCollidingRequires(index, definedInSlices);
  const cut = prepared.indexOf('\nmodule.exports');
  const body = cut < 0
    ? prepared + '\n' + slices.join('\n')
    : prepared.slice(0, cut) + '\n' + slices.join('\n') + prepared.slice(cut);
  // ⭐ 再把 require 深度反向换回 ✓（有一批用例会把聚合**当模块编译**，编译路径 = 拆分前那一份的位置 ✓）
  // ⭐ 2026-10-18（拆分第 2 刀）：搬进独立模块的实现（actions / renderContext）也要进聚合文本 ——
  //   否则"按源码文本钉行为"的既有判据会突然找不到实现（那是**判据失效**，不是行为变化 ✗）。
  //   ⚠️ 追加在 `module.exports` 之前（顶层作用域，与 factory 内的同名薄包装**不在同一作用域** ⇒ 不冲突 ✓）；
  //   去掉它们的 `module.exports`（子文件出口不属于旧单文件的语义 ✓）。
  const extras = ['actions.js', 'renderContext.js', 'sessionFlow.js', 'handlers/purchase.js', 'handlers/payment.js', 'handlers/salesSubmit.js', 'handlers/smallActions.js', 'responses.js']
    .map((file) => path.join(SCAN_PAGE_DIR, file))
    .filter((full) => fs.existsSync(full))
    .map((full) => fs.readFileSync(full, 'utf8')
      .replace(/\nmodule\.exports[\s\S]*$/, '')
      // 子模块顶部的 `const {…} = require(…)` 与 index 顶层的 require **同名** ⇒ 聚合里会重复声明；
      // 这些名字 index 顶层已经声明过（聚合执行时共享）⇒ 从 extras 里去掉 require 行即可（不删函数体 ✓）。
      .replace(/^\s*const\s*\{[^}]*\}\s*=\s*require\([^)]*\);\s*$/gm, ''))
    .join('\n');
  return (body + '\n' + extras)
    .replace(/require\('\.\.\/\.\.\//g, "require('../")
    .replace(/require\('\.\/actions'\)/g, "require('./scanPage/actions')")
    .replace(/require\('\.\/renderContext'\)/g, "require('./scanPage/renderContext')")
    .replace(/require\('\.\/sessionFlow'\)/g, "require('./scanPage/sessionFlow')")
    .replace(/require\('\.\/handlers\/purchase'\)/g, "require('./scanPage/handlers/purchase')")
    .replace(/require\('\.\/handlers\/payment'\)/g, "require('./scanPage/handlers/payment')")
    .replace(/require\('\.\/handlers\/salesSubmit'\)/g, "require('./scanPage/handlers/salesSubmit')")
    .replace(/require\('\.\/handlers\/smallActions'\)/g, "require('./scanPage/handlers/smallActions')")
    .replace(/require\('\.\/responses'\)/g, "require('./scanPage/responses')")
    .replace(/require\('\.\.\/(workbench|feishuWebAuth)'\)/g, "require('./$1')");
};

/** 壳必须**只**转发（薄壳口径 ✓）：行数上限 ✓。 */
const SHELL_MAX_LINES = 20;

module.exports = { scanPageSource, SCAN_PAGE_DIR, SHELL, SOURCE_ORDER, MARK, SHELL_MAX_LINES, definedNamesOf };
