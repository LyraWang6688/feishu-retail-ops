/**
 * ⭐⭐ 2026-10-15（业务负责人逐字：「**可以，给隐藏掉吧**」）：
 *   `?scan=1`「只扫码」聚焦页上，**导航胶囊只留「返回完整工作台」**（那是"回家的路"，别让她出不去 ✗），
 *   其余两颗（库存手工调整 / 鞋盒标签打印 —— 后者就是这一页自己）隐藏。
 *
 * 口径（Lead 定的）：
 *   · **只在 `?scan=1` 这条入口上隐藏** ✓
 *   · **不带 `?scan` 的批量打印页一个字都不改** ✓（别的独立页照旧）
 *
 * 做法：HTML 给两颗"可隐藏"的胶囊标 `data-nav-scan-only-hide` ＋ `<html>` 上加一个
 *   **只有 `?scan=1` 会标**的属性（`markScanOnlyPage`）＋ `labels.css` 里一条**被作用域圈住**的规则
 *   ⇒ 不删 DOM、不改 `style`、也不可能波及批量页 ✓
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-D1 ⭐ `?scan=1` ⇒ 只剩「返回完整工作台」（隐藏的两颗一颗不多、一颗不少；"回家的路"**不许**被藏）
 *   AC-D2 ⭐ 批量页照旧**三颗全在**（作用域只认 `html[data-scan-only="1"]`；HTML 里**静态没有**这个属性）
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
  fs.writeFileSync(path.join(dir, 'scan-print.mjs'),
    read('features/labels/scan-print.js').split("from '../../core/ui.js'").join("from './ui.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'scan-print.mjs')).href);
};

const LABEL_PRINT_HTML = () => read('label-print.html');
/** 导航条里三颗胶囊（顺序 = DOM 顺序）。 */
const navLinks = (html) => {
  const nav = html.slice(html.indexOf('class="standalone-nav"'), html.indexOf('</nav>'));
  return [...nav.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((match) => ({
    attrs: match[1], text: match[2].trim(),
  }));
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-D1 `?scan=1` ⇒ 只剩「返回完整工作台」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D1 ⭐⭐ `?scan=1` ⇒ 导航只留「返回完整工作台」（两颗可隐藏的都藏了；"回家的路"没被藏）', async () => {
  const module = await loadScanPrintModule();

  // ① 行为：**`?scan=1` 这条唯一的编排点**（`mountScanOnlyPage`）给 `<html>` 标上属性 —— CSS 据此隐藏
  const attrs = {};
  const fakeDoc = { documentElement: { setAttribute: (name, value) => { attrs[name] = String(value); } } };
  const container = { innerHTML: '', querySelector: () => ({ querySelector: () => null }) };
  const action = { mount: () => ({}), runWithFeedback: async () => null };
  module.mountScanOnlyPage(container, action, { doc: fakeDoc, autoOpen: false });
  assert.equal(attrs[module.SCAN_ONLY_ATTR], '1',
    '`?scan=1` 必须给 <html> 打上标记（不打 ⇒ 两颗胶囊还在 ⇒ 她要的"隐藏掉"没做到 ✗）');
  assert.equal(module.markScanOnlyPage(fakeDoc), true, '幂等可重复标 ✓');
  // 没有 document 的环境（Node / 老用例）⇒ **老实返回 false，不炸** ✓
  assert.equal(module.markScanOnlyPage(null), false);

  // ② HTML：恰好**两颗**被标记（库存手工调整 / 鞋盒标签打印），而且**「返回完整工作台」没被标记**
  const links = navLinks(LABEL_PRINT_HTML());
  assert.deepEqual(links.map((link) => link.text),
    ['返回完整工作台', '库存手工调整', '鞋盒标签打印'], '导航三颗逐字还在（只是有标记，不是删掉 ✓）');
  const marked = links.filter((link) => link.attrs.includes('data-nav-scan-only-hide'));
  assert.deepEqual(marked.map((link) => link.text), ['库存手工调整', '鞋盒标签打印'],
    '🔴 被隐藏的**恰好**是这两颗（多藏 / 少藏都会红）');
  assert.equal(links[0].attrs.includes('data-nav-scan-only-hide'), false,
    '🔴「返回完整工作台」**不许**被隐藏（那是她回家的路，藏了就出不去 ✗）');

  // ③ CSS：规则**被作用域圈住**（只在 `html[data-scan-only="1"]` 下生效）
  const css = read('features/labels/labels.css');
  assert.ok(css.includes('html[data-scan-only="1"] .standalone-nav [data-nav-scan-only-hide]'),
    '隐藏规则必须挂在那个属性下（无条件隐藏 ⇒ 批量页也会被藏 ✗）');
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
    '🔴 `<html>` 上不许静态带这个属性（带了 ⇒ 批量页一进来也只剩一颗 ✗）');
  // ② 别处不许标它：全仓只有 `scan-print.js` 的 `markScanOnlyPage` 会标
  const markers = ['features/labels/index.js', 'standalone.js', 'main.js']
    .filter((file) => read(file).includes('data-scan-only'));
  assert.deepEqual(markers, [], `只有"只扫码"那条入口能标这个属性；这些文件也不行：${markers.join(' / ')}`);
  // ③ 批量页自己**从来不走** `mountScanOnlyPage`（`?scan=1` 才走；批量那一路在 index.js 里是另一支）
  const index = read('features/labels/index.js');
  assert.match(index, /if \(wantsScanFromSearch\([\s\S]{0,80}?\)\) \{\s*mountScanOnlyPage\(container, scanPrint\);\s*return;/,
    '`?scan=1` 才走聚焦页那一支（批量那一路照旧渲染完整页 ✓）');
  // ④ ⭐ **每一条**提到那两颗胶囊的 CSS 规则都必须被作用域圈住（剥掉注释再判 ——
  //    注释里会解释这条规则，不算实现）⇒ 谁要是顺手加一条无条件 `[data-nav-scan-only-hide] { display:none }`，
  //    批量页就会被一起藏 ⇒ 这里红 ✓
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hidingRules = [...cssCode.matchAll(/([^{}]*\[data-nav-scan-only-hide\][^{}]*)\{([^}]*)\}/g)];
  assert.ok(hidingRules.length >= 1, '至少有一条"隐藏那两颗胶囊"的规则（只有标记没有规则 ⇒ 她要的隐藏没生效 ✗）');
  for (const [, selector, body] of hidingRules) {
    assert.ok(selector.includes('data-scan-only'),
      `隐藏规则必须被 \`html[data-scan-only="1"]\` 圈住（批量页才会照旧全在）：${selector.trim()}`);
    assert.match(body, /display:\s*none/, '隐藏 = display: none');
  }
  // ⑤ 别的独立页的导航**没被标记**（一个字不动）
  const inventory = read('inventory-adjustment.html');
  assert.equal(inventory.includes('data-nav-scan-only-hide'), false, '库存手工调整页的导航不动 ✓');
  assert.ok(css.includes('.standalone-nav'), '导航条的公共样式照旧在（只是多了一条被圈住的规则）');
});
