/**
 * ⭐⭐ 工作台**页面主标题退场**的验收标准（业务负责人 2026-10-12 定，**先写后做**）。
 *
 * 她的原话（逐字）：
 *   「把 title『**邯美皮鞋数字经营工作台经营管理中心**』去掉。移动端屏幕本来就小，
 *     **去掉后能省出不少空间**」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 事实核对（改前，`index.html`）：
 *   · 可见标题 = `<div class="eyebrow">邯美数智经营工作台</div>` ＋ `<h1>经营管理中心</h1>`
 *     （她逐字念的是这两行**连起来**的那一串；她在手机上看到的就是这一块）；
 *   · 浏览器 `<title>` = 「邯美数智经营工作台」⇒ 顺带缩成「邯美工作台」。
 *   · ⚠️ `inventory-adjustment.html` / `label-print.html` 两个**独立子页**的 eyebrow / h1
 *     **不在本次范围**（它们是各自页面的功能标题：库存手工调整 / 鞋盒标签打印）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准
 *   AC1 index.html 里**不再出现**那串可见标题（`邯美数智经营工作台` / `经营管理中心` 两个逐字片段都不许有）。
 *   AC2 `<title>` 缩短为「邯美工作台」（不再是那串）。
 *   AC3 登录行**逐字保留**：`auth-status` 那行 + 「退出登录」按钮。
 *   AC4 四个大 tab（销售 · 库存 · 采购 · 货品）与其子 tab 清单**逐字不变**；
 *       index.html 的 `<nav id="main-tabs">` 仍留空（文案唯一来源 = `config/tabs.js`）。
 *   AC5 移动端可点区域仍 ≥44px（值仍来自 `--control-height`；登录那颗 `.btn-ghost` 也在内）。
 *   AC6 标题区没有"为标题预留"的 `padding-top` / 固定 `height`（省下的空间是自然上移）。
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

/** 去掉注释再判"代码里有没有某件事"（注释里留沿革说明不算实现）。 */
const stripComments = (source) => source
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到临时目录（**只改 import 的文件名，逻辑一个字不改**）——
 * 与 `workbenchFourTabs.test.js` 同一套做法。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-main-title-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/tabs.js', 'tabs.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('core/tabs.js', 'core-tabs.mjs', [["from '../config/tabs.js'", "from './tabs.mjs'"]]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { tabs: load('tabs'), domains: load('domains'), coreTabs: load('core-tabs') };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 / AC2 可见标题退场 + 浏览器标题缩短
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 index.html 里不再有那串可见标题（「邯美数智经营工作台」＋「经营管理中心」两个片段都不许有）', () => {
  const html = read('index.html');
  // 逐字断言（含注释也一并判 —— 这一块是被删掉的，没理由留沿革说明）
  assert.ok(!html.includes('经营管理中心'), 'index.html 里不许再出现「经营管理中心」（她点名的那个标题）');
  assert.ok(!html.includes('邯美数智经营工作台'), 'index.html 里不许再出现「邯美数智经营工作台」（标题块的上一行）');
  // 标题块的两个容器也一并退场（不是只把字清空、留个空壳占位）
  assert.ok(!/class="eyebrow"/.test(html), 'index.html 里不许再留 .eyebrow（那是标题块的上半行）');
  assert.ok(!/<h1[\s>]/.test(html), 'index.html 里不许再留 <h1>（那是标题块的下半行）');
});

test('AC2 浏览器 <title> 缩短为「邯美工作台」（不再是那串长名）', () => {
  const html = read('index.html');
  const title = html.match(/<title>([\s\S]*?)<\/title>/);
  assert.ok(title, 'index.html 必须有 <title>');
  assert.equal(title[1].trim(), '邯美工作台', '浏览器标题 = 「邯美工作台」（手机上标签 / 容器标题栏更省空间）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 登录行逐字保留
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 登录状态行与「退出登录」按钮逐字保留（只删标题，不动登录）', () => {
  const html = read('index.html');
  assert.match(html, /<div class="auth">/, '仍然要有 .auth 那一块');
  assert.ok(html.includes('<span id="auth-status" class="muted">正在检查飞书登录状态…</span>'),
    '登录状态行逐字保留');
  assert.ok(html.includes('<button id="logout" class="btn btn-ghost hidden" type="button">退出登录</button>'),
    '「退出登录」按钮逐字保留');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 四个大 tab + 子 tab 结构逐字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC4a ⭐ 扫一扫（最前）+ 四个业务领域逐字不变：扫一扫 · 销售 · 库存 · 采购 · 货品（顺序 = config/tabs.js）', async () => {
  const modules = loadFrontendModules();
  const [tabs, coreTabs] = await Promise.all([modules.tabs, modules.coreTabs]);
  // ⭐ 2026-10-13 她裁定：**扫一扫**与四个业务领域同级、放最前 ⇒ 只加这一条，**其余 4 个逐字不变** ✓
  assert.deepEqual(tabs.MAIN_TABS.map((tab) => tab.label), ['扫一扫', '销售', '库存', '采购', '货品'],
    '扫一扫最前；四个大 tab 文案与顺序逐字不变');
  assert.deepEqual(tabs.MAIN_TABS.map((tab) => tab.module), ['scan', 'sales', 'inventory', 'purchase', 'product']);

  const html = coreTabs.mainTabsHtml();
  const buttons = [...html.matchAll(/<button class="([^"]*)" type="button" data-module="([^"]*)">([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 5, '⭐ 扫一扫 + 四个业务领域 = 5 个 tab 按钮（2026-10-13 新增扫一扫）');
  assert.deepEqual(buttons.map((button) => button[3]), ['扫一扫', '销售', '库存', '采购', '货品'], '渲染出来的文案与顺序逐字一致');
});

test('AC4b 每个大 tab 的子 tab 清单逐字不变（唯一来源 config/domains.js）', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  const labels = (id) => byId.get(id).pages.map((page) => page.label);

  // ⚠️ 2026-10-12 断言**同步**（她的新口径：销售无「销售建单」· 库存无「单款查询」·
  //    采购无「验收到货」，「采购订单列表」改名「订单列表」）：
  //    改前（逐字）：sales ['销售建单','订单列表','销售查询','客户往来款']
  //                 / inventory ['单款查询','全仓查询','手工调整']
  //                 / purchase ['验收到货','采购订单列表','供应商往来款']
  //    理由：本文件（batch① 删主标题）的这几条是**结构哨兵**，口径变了就要逐字跟上；
  //      "四个大 tab 与子 tab 一条不少"这条不变量由 `workbenchQueryDirectJump.test.js` 与
  //      `workbenchFourTabs.test.js` 共同保证（列出的子 tab 数没少，只是按她口径换了成员）。
  assert.deepEqual(labels('sales'), ['订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(labels('inventory'), ['全仓查询', '手工调整']);
  assert.deepEqual(labels('purchase'), ['验收', '退货', '订单列表', '供应商往来款']);
  assert.deepEqual(labels('product'), ['货品上新', '标签打印']);
});

test('AC4c index.html 的 <nav id="main-tabs"> 仍留空 + 模块宿主与页脚扫码入口还在', () => {
  const html = read('index.html');
  const nav = html.match(/<nav id="main-tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'index.html 必须仍有 <nav id="main-tabs">');
  assert.ok(!/<button/.test(nav[0]) && !/data-module=/.test(nav[0]),
    'nav 里不许硬编码 tab 按钮（文案唯一来源 = config/tabs.js）');
  assert.ok(html.includes('<section id="module-host"'), '模块宿主仍在');
  assert.ok(stripComments(html).includes('扫码入口'), '页脚扫码入口那半句仍在');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 ≥44px 命中区（沿用既有哨兵口径）
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 移动端可点区域仍 ≥44px（值来自 --control-height；登录按钮 .btn-ghost 也在内）', () => {
  const tokens = read('styles/tokens.css');
  const base = read('styles/base.css');
  assert.match(tokens, /--control-height:\s*44px;/, '44px 命中区仍来自主题变量');
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/,
    '按钮 / 输入框仍 ≥44px');
  assert.match(base, /\.btn-ghost\s*\{[^}]*min-height:\s*var\(--control-height\)[^}]*\}/,
    '登录那一颗 .btn-ghost 也仍 ≥44px');
  assert.match(base, /\.main-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/, '大 tab 仍 ≥44px');
  assert.match(base, /\.sub-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/, '子 tab 仍 ≥44px');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 没有"为标题预留"的空间
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 没有为标题预留的 padding-top / 固定 height（空间是自然上移省出来的）', () => {
  const html = read('index.html');
  const base = read('styles/base.css');
  // index.html 里没有任何内联 height / padding-top（标题块是唯一会让页面顶部"顶下来"的东西）
  assert.ok(!/style="[^"]*(height|padding-top)/.test(html), 'index.html 里没有内联 height / padding-top');
  // base.css 的 .header 用 flex gap 管间距，没有给标题预留的固定高度
  const header = base.match(/\.header\s*\{[^}]*\}/);
  assert.ok(header, 'base.css 仍有 .header 规则');
  assert.ok(!/height:/.test(header[0]), '.header 不许有固定 height（改前也没有；这一条是防回归）');
  assert.ok(!/padding-top:/.test(header[0]), '.header 不许有 padding-top（间距一律走 margin/gap）');
});
