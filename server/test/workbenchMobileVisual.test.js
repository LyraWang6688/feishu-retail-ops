/**
 * ⭐⭐ 工作台**移动端视觉**的验收标准（业务负责人 2026-10-09）：
 *   「我们现在的工作台**一定要对移动端友好**，而且我觉得现在这个**不太美观**」
 *   ＋ 本任务的口径：「她授权：按你自己觉得如何对移动端友好美观先做一版」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 **一个主色 + 浅灰底 + 白卡片 + 12~16px 圆角 + 很轻的阴影**：
 *      颜色 / 圆角 / 阴影**只在 `styles/tokens.css`**（其余 CSS 零十六进制颜色，既有哨兵）。
 *  AC2 **字号层级**：页面标题 18~20 · 正文 15~16 · 次要 13 · 行高 1.5；次要文字是**中性灰**。
 *  AC3 **手指友好**：按钮 / 输入框 ≥44px（`--control-height`）· 主按钮占满一行 ·
 *      卡片整块可点 · 次要操作收进 `<details>`（summary 也是 ≥44px 命中区）。
 *  AC4 **列表卡片化 + 大数字 + 彩色小标签**：一单一张卡（无表格）·
 *      金额 / 数量用大字号令牌 · 状态有彩色小标签（待补充 / 待交割 / 已两清 · 现货 / 预订 · 待建设）。
 *  AC5 **一屏一件事**：手机默认单列、桌面（≥761px）才自适应多列；留白走 `--space-*`。
 *  AC6 **不白屏 / 不外链资源 / 不引新依赖**：CSS 里没有 `@import url(...)`、
 *      页面里没有外链字体 / 图片 / 脚本，`package.json` 不新增任何依赖。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const walk = (dir, extensions) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full, extensions);
  return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
});

const tokens = read('styles/tokens.css');
const base = read('styles/base.css');
const orders = read('features/orders/orders.css');
const domains = read('features/domains/domains.css');

const CSS_FILES = walk(WORKBENCH, ['.css']).filter((file) => file !== path.join(WORKBENCH, 'styles', 'tokens.css'));
const ALL_CSS = CSS_FILES.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// AC1 一个主色 + 浅灰底 + 白卡片 + 圆角 + 很轻的阴影
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 一个主色 · 浅灰底 · 白卡片 · 12~16px 圆角 · 很轻的阴影（只在 tokens.css）', () => {
  // ① 主色只有一个（深蓝），且**没有第二个品牌色**令牌
  assert.match(tokens, /--primary:\s*#185abd;/, '主色 = 深蓝（既有那一个）');
  assert.equal(/--(accent|brand-2|primary-2|secondary-color)\s*:/i.test(tokens), false,
    '不许有第二个品牌色 —— 一个主色就够');

  // ② 浅灰底 + 白卡片
  const background = tokens.match(/--background:\s*(#[0-9a-f]{6})/i)[1];
  assert.match(background, /^#f/i, `背景要是浅灰（现在 ${background}）`);
  assert.match(tokens, /--surface:\s*#ffffff;/i, '内容 = 白卡片');

  // ③ 圆角 12~16px（卡片用 --radius-md=12 / --radius-lg=16）
  assert.match(tokens, /--radius-md:\s*12px;/, '卡片圆角 12px');
  assert.match(tokens, /--radius-lg:\s*16px;/, '大卡片圆角 16px');
  assert.match(ALL_CSS, /border-radius:\s*var\(--radius-(md|lg)\)/, '卡片圆角走令牌（不写死）');

  // ④ 很轻的阴影：alpha ≤ 0.12
  const shadow = tokens.match(/--shadow-card:\s*([^;]+);/)[1];
  const alpha = Number((shadow.match(/rgba\([^)]*?,\s*(0?\.\d+|1(?:\.0)?)\)/) || [])[1]);
  assert.ok(Number.isFinite(alpha) && alpha <= 0.12, `卡片阴影要很轻（--shadow-card: ${shadow}）`);
  assert.match(ALL_CSS + base, /box-shadow:\s*var\(--shadow-card\)/, '卡片阴影走令牌');

  // ⑤ 颜色只在主题文件里（既有哨兵，这里再钉一次）
  for (const file of CSS_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.deepEqual(source.match(/#[0-9a-fA-F]{3,8}\b/g) || [],
      [], `${path.relative(WORKBENCH, file)} 里还有写死的颜色`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 字号层级 + 行高 + 次要文字中性灰
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 字号层级：标题 18~20 · 正文 15~16 · 次要 13 · 行高 1.5 · 次要文字中性灰', () => {
  const px = (name) => Number(tokens.match(new RegExp(`--${name}:\\s*(\\d+)px;`))[1]);
  const title = px('font-size-xl');
  assert.ok(title >= 18 && title <= 20, `页面标题要在 18~20（现在 ${title}）`);
  const bodySize = px('font-size-base');
  assert.ok(bodySize >= 15 && bodySize <= 16, `正文要在 15~16（现在 ${bodySize}）`);
  assert.ok(px('font-size-md') >= 15 && px('font-size-md') <= 16, '正文小一号也在 15~16');
  assert.equal(px('font-size-sm'), 13, '次要文字 = 13px');
  assert.match(tokens, /--line-height:\s*1\.5;/, '行高 1.5');

  // 次要文字是**中性灰**（r≈g≈b，不是纯黑也不是彩色）
  const secondary = tokens.match(/--text-secondary:\s*#([0-9a-f]{6})/i)[1];
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(secondary.slice(index, index + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 24, `次要文字要中性灰（现在 #${secondary}）`);
  assert.ok(Math.max(r, g, b) < 200, '次要文字要比卡片底色深（能看清）');

  // 页面标题 / 正文 / 次要都走令牌（没有一处写死 px 字号）
  assert.match(base, /\.subtitle[^{]*\{[^}]*font-size:\s*var\(--font-size-sm\)/, '次要文字走令牌');
  assert.match(base, /body\s*\{[^}]*font-size:\s*var\(--font-size-base\)/s, '正文走令牌');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 手指友好：≥44px · 主按钮占满一行 · 卡片整块可点 · <details> 收次要操作
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 按钮 / 输入框 ≥44px · 主按钮占满一行 · 卡片整块可点 · 次要操作进 <details>', () => {
  assert.match(tokens, /--control-height:\s*44px;/, '命中区下限 = 44px（令牌）');
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/,
    '按钮 / 输入框 ≥44px');
  assert.match(ALL_CSS, /summary\s*\{[^}]*min-height:\s*(var\(--control-height\)|44px)/s,
    '次要操作收进 <details>：summary 也必须是 ≥44px 命中区');
  assert.match(ALL_CSS, /details/i, '次要操作要用 <details> 折叠（一屏一件事）');
  assert.match(base, /\.btn-primary\s*\{[^}]*width:\s*100%/, '主按钮占满一行');
  assert.match(domains, /\.card-button/, '「跳到另一个子页」的卡片 = 整块可点的按钮');
  assert.match(base, /\.entry-card\s*\{[^}]*display:\s*flex/s, '入口卡片整块可点（<a> 铺满卡片）');
  assert.match(ALL_CSS, /-webkit-tap-highlight-color|:hover/, '有触屏反馈（hover / tap 高亮）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 列表卡片化 + 大数字 + 彩色小标签
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 列表卡片化（一单一张卡，无表格）· 金额 / 数量大字号 · 状态彩色小标签', () => {
  // ① 一单一张卡：白卡片 + 圆角 + 很轻的边框，没有表格版式
  assert.match(orders, /\.order-card\s*\{[^}]*border-radius:\s*var\(--radius-md\)/s, '一单一张卡');
  assert.match(orders, /\.order-card\s*\{[^}]*background:\s*var\(--surface/, '卡片是白底');
  for (const [name, css] of [['orders.css', orders], ['domains.css', domains]]) {
    assert.equal(/<table|table\s*\{/.test(css), false, `${name} 不许有表格版式`);
  }

  // ② 金额 / 数量用**大字号令牌**
  assert.match(tokens, /--font-size-amount:\s*(2[0-9]|1[89])px;/, '要有一个"大数字"字号令牌');
  assert.match(ALL_CSS, /font-size:\s*var\(--font-size-amount\)/, '金额 / 数量用大字号令牌');

  // ③ 状态彩色小标签：既有语义色 + 三组用例（待补充 / 待交割 / 已两清 · 现货 / 预订 · 待建设）
  for (const family of ['tag-success', 'tag-warning', 'tag-info']) {
    assert.match(base, new RegExp(`\\.${family}\\s*\\{[^}]*var\\(--`), `${family} 要用语义色令牌`);
  }
  assert.match(ALL_CSS, /\.tag\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/s, '标签是小圆角胶囊');
  assert.match(read('config/orders.js'), /tag: '待补充'/, '补充信息单 = 待补充标签');
  assert.match(read('config/orders.js'), /tag: '待交割'/, '待交割单 = 待交割标签');
  assert.match(read('config/orders.js'), /tag: '已两清'/, '售后列表 = 已两清标签');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 一屏一件事：手机单列 / 桌面自适应 / 留白走令牌
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 手机默认单列、桌面（≥761px）才多列；留白充足且走 --space-*', () => {
  assert.match(base, /\.quick-entries,\s*\.domain-cards\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    '手机默认单列');
  assert.match(base, /@media\s*\(min-width:\s*761px\)/, '桌面才有自适应那一层');
  assert.match(base, /html,\s*body\s*\{\s*max-width:\s*100%;\s*overflow-x:\s*hidden;\s*\}/, '不横向滚动');
  // 留白：卡片 / 页面内边距走 --space-*（不是写死的 px）
  const paddings = ALL_CSS.match(/padding:\s*[^;]+;/g) || [];
  assert.ok(paddings.filter((item) => /var\(--space-/.test(item)).length >= 10, '留白要走 --space-* 令牌');
  assert.ok(!/padding:\s*\d{3,}px/.test(ALL_CSS), '留白不许写死很大的 px');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 不白屏 / 不外链资源 / 不引新依赖
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 不依赖外链资源、不引新依赖、页面不白屏', () => {
  // ① 页面里没有任何外链资源（字体 / 图片 / 脚本 / 样式）
  for (const page of ['index.html', 'others.html', 'common.html', 'label-print.html']) {
    const html = read(page);
    for (const match of html.matchAll(/<(link|script|img)\b[^>]*>/gi)) {
      assert.equal(/https?:\/\/|\/\/[a-z0-9-]+\./i.test(match[0]), false,
        `${page} 里有外链资源：${match[0].slice(0, 80)}`);
    }
  }
  // ② CSS 里没有 @import url(...)（会多一次网络请求）
  assert.equal(/@import\s+url\(/i.test(ALL_CSS), false, 'CSS 不许 @import 外链');

  // ③ 不引新依赖（工作台是纯静态资源，package.json 里没有 css / 构建类依赖）
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  for (const banned of ['tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less', 'bootstrap', 'normalize.css', 'vite', 'esbuild']) {
    assert.equal(deps.includes(banned), false, `不许为改样式引入 ${banned}`);
  }

  // ④ 不白屏：主题文件与基础样式都能被解析出令牌（扫码页内联的就是它）
  const { readThemeTokens, STYLE } = require('../src/views/scanPageRenderer');
  assert.ok(readThemeTokens().length >= 30, 'tokens.css 仍然是扫码页内联的那一份主题');
  assert.match(STYLE, /\.card\s*\{[^}]*background:\s*var\(--surface\)/s, '扫码页的卡片也是白卡片');
  assert.match(STYLE, /@media|max-width:\s*var\(--page-max\)/, '扫码页仍然是移动端优先（单列 / 限宽）');
});
