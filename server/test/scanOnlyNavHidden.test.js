/**
 * ⭐⭐ 2026-11-09（业务负责人截图口径，逐字）：「**需要删除返回完整工作台按钮**」
 *   ⇒ `?scan=1`「只扫码」聚焦页上，**整条导航胶囊都不显示**（含原来那颗「返回完整工作台」）。
 *
 * 口径（Lead 定的）：
 *   · **只在 `?scan=1` 这条入口上隐藏** ✓
 *   · **不带 `?scan` 的批量打印页一个字都不改** ✓（三颗胶囊照旧全在；别的独立页照旧）
 *   · ⚠️ 2026-10-15 那版「只留返回完整工作台、藏另外两颗」**已作废** ✗
 *     （那时"回家的路不许藏"是判据；她 2026-11-09 明确连那颗也不要 ⇒ 判据翻转）
 *
 * 做法：`<html>` 上加一个**只有 `?scan=1` 会标**的属性（`markScanOnlyPage`）
 *   ＋ `labels.css` 里一条**被作用域圈住**的规则（整条 `.standalone-nav` 隐藏）——
 *   **不删 DOM**（批量页要用那三颗）、不改 `style` ⇒ 也不可能波及批量页 ✓
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-D1 ⭐ `?scan=1` ⇒ **整条导航不显示**（含「返回完整工作台」）；隐藏规则被作用域圈住
 *   AC-D2 ⭐ 批量页（不带 `?scan`）照旧**三颗全在**（作用域只认 `html[data-scan-only="1"]`；HTML 里**静态没有**这个属性）
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把前端模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）再当模块跑。 */
const loadScanPrintModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-only-nav-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/ui.js'), path.join(dir, 'ui.mjs'));
  // ⚠️ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`read('features/labels/scan-print.js').split("from '../../core/ui.js'").join("from './ui.mjs'")`
  //   改后逐字：**多复制一份 `config/scanEntries.js`** ＋ 把新 import 指向副本
  //             （业务负责人 2026-10-16 21:2x 五处口径 ⇒ 参数/文案收敛到登记表 ✓）。
  //   ⚠️ 只改**加载器**（不复制 ⇒ 模块不存在 ⇒ 假红 ✗）；**判据一个字没放宽** ✓。
  fs.copyFileSync(path.join(WORKBENCH, 'config/scanEntries.js'), path.join(dir, 'scanEntries.mjs'));
  // 🔴 2026-11-09：扫码聚焦页的「去批量打印」链接改指**飞书表单** ⇒ `scan-print.js` 多了两条 import
  //   （`core/formatters.js` 的 escapeHtml ＋ `config/links.js` 的表单 URL）——
  //   加载器成对复制（只改加载器，判据不放宽）。
  fs.copyFileSync(path.join(WORKBENCH, 'core/formatters.js'), path.join(dir, 'formatters.mjs'));
  fs.copyFileSync(path.join(WORKBENCH, 'config/links.js'), path.join(dir, 'links.mjs'));
  fs.writeFileSync(path.join(dir, 'scan-print.mjs'),
    read('features/labels/scan-print.js')
      .split("from '../../core/ui.js'").join("from './ui.mjs'")
      .split("from '../../config/scanEntries.js'").join("from './scanEntries.mjs'")
      .split("from '../../core/formatters.js'").join("from './formatters.mjs'")
      .split("from '../../config/links.js'").join("from './links.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'scan-print.mjs')).href);
};

const LABEL_PRINT_HTML = () => read('label-print.html');

/**
 * 剔掉 `@media print { … }` 整块（按大括号配对，**不是**正则猜）——
 * 打印样式里的「屏幕外壳都不进纸」与本文件要判的"屏幕上藏不藏导航"是两件事。
 */
const stripPrintMedia = (css) => {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf('@media print', index);
    if (start === -1) { out += css.slice(index); break; }
    out += css.slice(index, start);
    // 从 `@media print` 后的第一个 `{` 开始配对大括号
    const open = css.indexOf('{', start);
    if (open === -1) { out += css.slice(start); break; }
    let depth = 0;
    let end = open;
    for (let cursor = open; cursor < css.length; cursor += 1) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    index = end + 1;
  }
  return out;
};
/** 导航条里三颗胶囊（顺序 = DOM 顺序）。 */
const navLinks = (html) => {
  const nav = html.slice(html.indexOf('class="standalone-nav"'), html.indexOf('</nav>'));
  return [...nav.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((match) => ({
    attrs: match[1], text: match[2].trim(),
  }));
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-D1 `?scan=1` ⇒ 整条导航都不显示（含「返回完整工作台」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D1 ⭐⭐ `?scan=1` ⇒ 整条导航都不显示（含「返回完整工作台」；规则被作用域圈住）', async () => {
  const module = await loadScanPrintModule();

  // ① 行为：**`?scan=1` 这条唯一的编排点**（`mountScanOnlyPage`）给 `<html>` 标上属性 —— CSS 据此隐藏
  const attrs = {};
  const fakeDoc = { documentElement: { setAttribute: (name, value) => { attrs[name] = String(value); } } };
  const container = { innerHTML: '', querySelector: () => ({ querySelector: () => null }) };
  const action = { mount: () => ({}), runWithFeedback: async () => null };
  module.mountScanOnlyPage(container, action, { doc: fakeDoc, autoOpen: false });
  assert.equal(attrs[module.SCAN_ONLY_ATTR], '1',
    '`?scan=1` 必须给 <html> 打上标记（不打 ⇒ 导航还在 ⇒ 她要的"删除返回完整工作台"没做到 ✗）');
  assert.equal(module.markScanOnlyPage(fakeDoc), true, '幂等可重复标 ✓');
  // 没有 document 的环境（Node / 老用例）⇒ **老实返回 false，不炸** ✓
  assert.equal(module.markScanOnlyPage(null), false);

  // ② HTML：三颗胶囊**照旧都在**（批量页要用；这一屏只是整条藏起来），
  //    而且**不再有** `data-nav-scan-only-hide` 那种"逐颗标记"（2026-10-15 旧口径已作废）
  const links = navLinks(LABEL_PRINT_HTML());
  assert.deepEqual(links.map((link) => link.text),
    ['返回完整工作台', '库存手工调整', '鞋盒标签打印'], '导航三颗在 HTML 里逐字还在（批量页要用 ✓）');
  assert.equal(links.some((link) => link.attrs.includes('data-nav-scan-only-hide')), false,
    '🔴 旧的"只藏两颗"标记必须收干净（现在整条藏 ⇒ 留着它说明有人把旧口径塞回来了）');

  // ③ CSS：**整条导航**的隐藏规则存在，且被 `html[data-scan-only="1"]` 圈住
  const css = read('features/labels/labels.css');
  assert.ok(css.includes('html[data-scan-only="1"] .standalone-nav { display: none; }'),
    '🔴 必须有"扫码聚焦页整条导航不显示"这条规则（没有 ⇒ 返回按钮还在 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2 批量页（不带 `?scan`）照旧三颗全在
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D2 ⭐⭐ 批量打印页（不带 `?scan`）⇒ 三颗胶囊**照旧全在**（标记不是静态的，是只在扫码入口才标）', async () => {
  const module = await loadScanPrintModule();
  const html = LABEL_PRINT_HTML();
  const css = read('features/labels/labels.css');

  // ① HTML 里**静态没有**那个属性 ⇒ 首次渲染（批量页）时一条隐藏规则都不生效 ✓
  assert.equal(/<html[^>]*\bdata-scan-only/.test(html), false,
    '🔴 `<html>` 上不许静态带这个属性（带了 ⇒ 批量页一进来也把导航藏了 ✗）');
  // ② 别处不许标它：全仓只有 `scan-print.js` 的 `markScanOnlyPage` 会标
  const markers = ['features/labels/index.js', 'standalone.js', 'main.js']
    .filter((file) => read(file).includes('data-scan-only'));
  assert.deepEqual(markers, [], `只有"只扫码"那条入口能标这个属性；这些文件也不行：${markers.join(' / ')}`);
  // ③ 批量页自己**从来不走** `mountScanOnlyPage`（`?scan=1` 才走；批量那一路在 index.js 里是另一支）
  const index = read('features/labels/index.js');
  assert.match(index, /if \(wantsScanFromSearch\([\s\S]{0,80}?\)\) \{\s*mountScanOnlyPage\(container, scanPrint\);\s*return;/,
    '`?scan=1` 才走聚焦页那一支（批量那一路照旧渲染完整页 ✓）');
  // ④ ⭐ **每一条**"藏导航"的 CSS 规则都必须被作用域圈住（剥掉注释再判 ——
  //    注释里会解释这条规则，不算实现）⇒ 谁要是顺手加一条无条件 `.standalone-nav { display:none }`，
  //    批量页就会被一起藏 ⇒ 这里红 ✓
  //    ⚠️ **先剔掉 `@media print` 整块**：打印样式里本来就有「屏幕外壳都不进纸」
  //      （`.no-print, .compact-header, .standalone-nav, #page-error { display:none !important }`）——
  //      那是"打印时"，不是屏幕上，与本条口径无关（不剔 ⇒ 假红 ✓）。
  const cssCode = stripPrintMedia(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const hidingRules = [...cssCode.matchAll(/([^{}]*\.standalone-nav[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /display:\s*none/.test(body));
  assert.ok(hidingRules.length >= 1, '至少有一条"藏导航"的规则（只有标记没有规则 ⇒ 她要的删除没生效 ✗）');
  for (const [, selector] of hidingRules) {
    assert.ok(selector.includes('data-scan-only'),
      `藏导航的规则必须被 \`html[data-scan-only="1"]\` 圈住（批量页才会照旧全在）：${selector.trim()}`);
  }
  // ⑤ 旧的逐颗隐藏规则**收干净**（留着 ⇒ 扫码页会露出返回按钮，与 AC-D1 的新口径自相矛盾）
  const legacy = [...cssCode.matchAll(/([^{}]*\[data-nav-scan-only-hide\][^{}]*)\{([^}]*)\}/g)];
  assert.deepEqual(legacy.map(([, selector]) => selector.trim()), [],
    '🔴 `[data-nav-scan-only-hide]` 的逐颗隐藏规则必须删掉（2026-11-09 改为整条藏）');
  // ⑥ 别的独立页的导航**没被标记**（一个字不动）
  const inventory = read('inventory-adjustment.html');
  assert.equal(inventory.includes('data-nav-scan-only-hide'), false, '库存手工调整页的导航不动 ✓');
  assert.ok(css.includes('.standalone-nav'), '导航条的公共样式照旧在（只是多了一条被圈住的规则）');
});
