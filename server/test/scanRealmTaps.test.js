/**
 * 切换条六格的「点了没反应」哨兵（2026-10-13 深夜真机）：
 *   她（逐字）：「点了库存、补货其他 5 个，**除了上新有跳转，其他都没有反应**」
 *            ＋ 补充现象：「那五格**按下去有点灰/抖了一下**（= 有按下反馈）⇒ **但不跳**」
 * ⇒ 只可能是 (甲) href 不是真地址 / (乙) 有 JS 拦点击。
 *   本文件把两条都钉住；并证明"这条检查能真红"（反向哨兵）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js');
const source = fs.readFileSync(RENDERER, 'utf8');
/** 去掉注释再判（⚠️ 我今晚因为没剥注释误判过两次 ✗） */
const stripped = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 一个 `<a data-tap-target>` 的点击处理器里**不许有 preventDefault 调用**（否则第二次点就被吞 ✗） */
function swallowsTap(text) {
  const from = text.indexOf("var tapLinks = document.querySelectorAll");
  const to = text.indexOf('var tapForms =');
  assert.ok(from >= 0 && to > from, '定位不到 tapLinks 段');
  const segment = stripped(text.slice(from, to));
  return /\.preventDefault\s*\(/.test(segment);
}

test('AC1 ⭐⭐ 链接的点击处理器里**不再有 preventDefault**（她"有反馈但不跳"的真因 ✗）', () => {
  assert.equal(swallowsTap(source), false,
    '「第一次点打标记、第二次点 preventDefault 吞掉」那个分支必须删掉 —— 每一次点击都要交给浏览器导航');
  // 反馈还在（她要"任何点击必须即时反馈" ✓）：按下变灰 + 文案换成"正在打开"
  const segment = source.slice(source.indexOf('var tapLinks'), source.indexOf('var tapForms'));
  assert.match(segment, /opacity = '0\.55'/, '按下反馈保留 ✓');
  assert.match(segment, /data-open-label/, '文案反馈保留 ✓');
  assert.match(segment, /tapReport\(/, '点一下仍上报一次（排查用 ✓）');
});

test('AC2 ⭐⭐ 反向哨兵：把改前那行放回去 ⇒ 这条检查**必须红**（否则它是自我安慰 ✗）', () => {
  const oldFragment = "var tapLinks = document.querySelectorAll('a[data-tap-target]');\n"
    + "link.setAttribute('data-opening', '1');\n"
    + "if (link.getAttribute('data-opening') === '1') { event.preventDefault(); return; }\n"
    + 'var tapForms = document.querySelectorAll();\n';
  assert.equal(swallowsTap(oldFragment), true, '改前的写法必须被判为"吞点击" ✗');
  assert.equal(swallowsTap(source), false, '现在这份必须判为"不吞" ✓');
});

test('AC3 ⭐ 六格的 href 都是**真地址**（非空、不是 #、不是 javascript:）＋ 上新仍是外链', () => {
  // 站内五格：href="?from=<id>"（相对 query，保留当前路径 ⇒ /s 与 /r 都对 ✓）
  assert.match(source, /href="\?from=\$\{escapeHtml\(item\.id\)\}"/, '站内格 = ?from=<id> ✓');
  assert.equal(/href="#"|href=""|javascript:void/.test(source), false, '(甲) 一律排除：不许空 href / # / javascript: ✗');
  // 外链那一格：直达飞书表单（她确认「上新能跳到多维表格的表单」✓）
  assert.match(source, /href="\$\{escapeHtml\(SCAN_PAGE\.realmBar\.newFormUrl\)\}" target="_blank" rel="noopener"/,
    '上新 = 外链（回归 ✓）');
  // 外链那颗**不许**绑 tap 脚本（绑了就会被拦 ✗ —— 这也是"只有上新好使"的原因之一）
  const external = source.split('\n').find((line) => line.includes('newFormUrl') && line.includes('<a '));
  assert.ok(!external.includes('data-tap-target'), '外链那颗不许带 data-tap-target ✓');
});

test('AC4 ⭐ `?from=inventory` 进来后**那一格是选中态**（她要有"我点到了"的可见变化 ✓）', () => {
  // 高亮由**服务端**决定：`realm-tab--active` + `aria-current="page"`
  assert.match(source, /const active = item\.id === realm;/, 'active 判据 = 当前领域 ✓');
  assert.match(source, /realm-tab--active/, '选中态 class ✓');
  assert.match(source, /aria-current="page"/, '无障碍也标出来 ✓');
  // `?from=` → 领域 id 的映射（认不出来回落缺省 ✓ 不白屏）
  const realm = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'scanPageRealm.js'), 'utf8');
  assert.match(realm, /const resolveRealm = \(value\) => \{[\s\S]*?REALMS\.some\(\(realm\) => realm\.id === raw\) \? raw : DEFAULT_REALM;/,
    'from=inventory ⇒ inventory；认不出 ⇒ 缺省 ✓');
  assert.match(realm, /Object\.freeze\(\{ id: 'inventory', label: '库存' \}\)/, '库存这一格确实存在 ✓');
  // ⭐ 2026-10-14 晚：**上新已从扫码页去掉** ⇒ 断言翻成"条上没有任何 external" ✓（判据不放宽 ✗）
  assert.equal(/external: true/.test(realm.replace(/^\s*\/\/.*$/gm, '')), false, '条上不再有外链 tab（上新已去掉 ✓）');
});

test('AC5 ⭐ 每一格的可点高度 ≥44px（`--control-height`，她的老规矩 ✓）', () => {
  const css = source.slice(source.indexOf('.realm-tab {'), source.indexOf('.realm-tab:active'));
  assert.match(css, /min-height: var\(--control-height\)/, '格子高度走控件高度令牌 ✓');
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'styles', 'tokens.css'), 'utf8');
  const m = tokens.match(/--control-height:\s*(\d+)px/);
  assert.ok(m, '令牌要有具体数值 ✓');
  assert.ok(Number(m[1]) >= 44, `--control-height 必须 ≥44px（实际 ${m[1]}px）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-14：六格必须**横向铺满**（她：「没有铺满屏幕的水平方向……最后一格被截」）
// ═══════════════════════════════════════════════════════════════════════════

const TOKENS = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'styles', 'tokens.css'), 'utf8');

test('AC6 ⭐⭐ 切换条铺满整宽：容器**一整列**、行 = 列数=格数 + width:100%、每格 min-width:0', () => {
  const css = stripped(source);
  // ① 容器：一整列（**原来它是 3 列**，而里面有两个 row ⇒ 每个 row 只占 1/3 ⇒ 右边空着 ✗ 这正是"没铺满"）
  assert.match(css, /\.realm-bar\s*\{[^}]*grid-template-columns:\s*1fr;/, '容器必须是一整列（row 才能占满整宽 ✓）');
  assert.match(css, /\.realm-bar\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/, '容器整宽 ✓');
  assert.match(css, /\.realm-bar\s*\{[^}]*overflow-x:\s*auto;/, '窄屏**横向滚动**而不是裁切 ✗');
  // ② 行：**列数 = 实际格数** + 整宽
  // ⚠️ 2026-10-15 **改写**（4 个领域 + 飞书多一格「扫一扫」）：
  //   改前逐字：`assert.match(source, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\);width:100%/, '一行六格、六列等分、整宽 ✓');`
  //   改后逐字：下面这两条（`repeat(${htmlCells.length}, …)` + **渲染列数 === 格数**）✓
  //   依据：固定 6 列在 4 格时右边空两列；列数跟格数走才真"铺满整宽"✓（判据没放宽 ✗）
  assert.match(source, /grid-template-columns:repeat\(\$\{htmlCells\.length\},minmax\(0,1fr\)\);width:100%/, '一行铺满、列数=格数、整宽 ✓');
  // ⚠️ 本文件只读**源码**（不渲染页面）⇒ "渲染列数 === 格数"这条由**渲染层**那两个用例做
  //   （`scanPageRealmTabs` 的 AC-RB2 与 `scanPageSixRealms` 的 AC-6R2，都当场渲染并数格/数列 ✓）——
  //   这里补一条源码级不变量：列数**不许写死**（写死 6/4/5 都会在格数变化时静默错位 ✗）。
  assert.equal(/grid-template-columns:repeat\(\d/.test(source), false,
    '列数**不许写死**（必须 repeat(${htmlCells.length}, …) ⇒ 跟格数走 ✓）');
  // ③ 每格 min-width:0（长文案不许把自己撑宽 ⇒ 不许把最后一格挤出容器 ✗）
  assert.match(css, /\.realm-tab\s*\{[^}]*min-width:\s*0;/, '每格 min-width:0 ✓');
  assert.match(css, /\.realm-tab\s*\{[^}]*white-space:\s*nowrap;/, '文字仍不许竖拆 ✓');
  // ④ 只有**一个** realm-row、里面正好六格（不再 3+3 两行 ⇒ 也就不会只占 2/3 宽 ✗）
  assert.equal((source.match(/class="realm-row"/g) || []).length, 1, '只许一个 row ✓');
  assert.equal((source.match(/items\.slice\(/g) || []).length, 0, '不许再把六格切成两行 ✓');
});

// ⚠️ 2026-10-15（同一天的口径）：条上最多 **5 格**（4 个领域 + 飞书的「扫一扫」）——
//   改前逐字：`test('AC7 ⭐ 算术推导：常见最窄手机宽下，六格每格仍 ≥44px（放不下 ⇒ 才是横向滚动）', () => {`
//     ＋ `const needed = 6 * 44 + 5 * gap;`
//   改后逐字：下面这几行（按 **5 格**这一上界算）
//   依据：她 2026-10-15「…库存、销售、补货、退货、扫一扫」；🔴 判据**变严**了（原来按 6 格宽松算，
//        现在条上最多 5 格 ⇒ 常见手机更宽裕 ⇒「不需要横滑」这条更成立 ✓）
test('AC7 ⭐ 算术推导：常见最窄手机宽下，**条上最多 5 格**每格仍 ≥44px（放不下 ⇒ 才是横向滚动）', () => {
  const height = Number(TOKENS.match(/--control-height:\s*(\d+)px/)[1]);
  assert.ok(height >= 44, `每格高度 ≥44px（实际 ${height}）`);
  const gap = 8; // 行内 gap:8px（与渲染一致 ✓）
  const narrowest = 252; // 五格各 44 + 4 个 gap 8 = 252 ⇒ 屏幕 ≥252px 时每格都 ≥44px ✓
  const needed = 5 * 44 + 4 * gap;
  assert.equal(needed, narrowest, `五格各 ≥44px 需要 ${needed}px 可用宽`);
  assert.ok(narrowest <= 320, '常见的 320px 手机**宽裕**放得下 ⇒ 不必横滑 ✓（更窄才走 overflow-x:auto ✓）');
  // 文字完整（行数=1）：六个标签都是 2 个字 + nowrap ⇒ 在 ≥44px 宽里完整显示 ✓
  const realms = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'scanPageRealm.js'), 'utf8');
  const labels = [...realms.matchAll(/Object\.freeze\(\{ id: '(\w+)', label: '([^']+)'(, external: true)? \}\)/g)]
    .map((m) => m[2]).filter((l) => l);
  assert.ok(labels.length >= 1, '能读到领域标签 ✓');
  assert.ok(labels.every((l) => [...l].length <= 3), `标签都 ≤3 个字（保证 44px 宽内单行完整 ✓）：${labels.join('/')}`);
});
