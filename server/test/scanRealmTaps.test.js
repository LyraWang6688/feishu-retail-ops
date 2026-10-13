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
  assert.match(realm, /Object\.freeze\(\{ id: 'new', label: '上新', external: true \}\)/, '上新 = 唯一 external ✓');
});

test('AC5 ⭐ 每一格的可点高度 ≥44px（`--control-height`，她的老规矩 ✓）', () => {
  const css = source.slice(source.indexOf('.realm-tab {'), source.indexOf('.realm-tab:active'));
  assert.match(css, /min-height: var\(--control-height\)/, '格子高度走控件高度令牌 ✓');
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'styles', 'tokens.css'), 'utf8');
  const m = tokens.match(/--control-height:\s*(\d+)px/);
  assert.ok(m, '令牌要有具体数值 ✓');
  assert.ok(Number(m[1]) >= 44, `--control-height 必须 ≥44px（实际 ${m[1]}px）`);
});
