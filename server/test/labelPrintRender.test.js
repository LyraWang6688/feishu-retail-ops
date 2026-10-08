/**
 * 鞋盒标签打印**页面侧**的护栏。
 *
 * 做两件事：
 *   ① 把 `public/workbench/features/labels/render.js` 真的当模块跑起来（复制成 `.mjs`，
 *      **只改 import 的文件名、逻辑一个字不改** —— 与 `workbenchHomeEntries.test.js` 同一套做法），
 *      断言 **尺寸 / 字号 / 字段开关全部来自服务端传下来的 layout**（页面自己一个 mm 都不写死）；
 *   ② 静态钉住接线：`label-print.html` 存在且 `data-view="label-print"`、在 `standalone.js`
 *      的独立页注册表里、"信息录入"首页有那张卡、CSS 走 `@media print` + mm。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 服务端默认配置的形状（与 `src/config/labelPrint.js` 的默认值一致；测试里当"服务端传下来的 layout"）。 */
const layout = (patch = {}) => ({
  label: { widthMm: 50, heightMm: 30, paddingMm: 1.5, ...(patch.label || {}) },
  page: {
    name: 'A4', widthMm: 210, heightMm: 297,
    marginMm: { top: 6, right: 6, bottom: 6, left: 6 }, ...(patch.page || {}),
  },
  grid: { columns: 3, rows: 9, perPage: 27, usableWidthMm: 198, gapXMm: 0, gapYMm: 0, ...(patch.grid || {}) },
  typography: { itemNoMm: 5, fieldMm: 2.6, footerMm: 1.7, qrSizeMm: 18, ...(patch.typography || {}) },
  fields: { qr: true, itemNo: true, color: true, category: true, size: true, state: true, footer: true, ...(patch.fields || {}) },
  texts: { sizeSuffix: '码', missingValue: '—', ...(patch.texts || {}) },
});

const label = (patch = {}) => ({
  key: 'r1',
  record_id: 'r1',
  item_no: 'XHB8095',
  color: '黑色',
  category: '休闲鞋',
  size: 42,
  size_text: '42码',
  state: '门盒',
  stock_key: 'XHB8095|黑色|休闲鞋|42',
  scan_url: 'https://workbench.bamamei.online/scan?no=XHB8095&size=42&color=%E9%BB%91%E8%89%B2',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33 33"><path d="M0 0h33v33H0z"/></svg>',
  footer_text: 'XHB8095|黑色|休闲鞋|42',
  ...patch,
});

/** 把 render.js + formatters.js 复制成 `.mjs`（只改 import 文件名）并当模块加载。 */
async function loadRenderModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-print-render-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/formatters.js'), path.join(dir, 'formatters.mjs'));
  fs.writeFileSync(path.join(dir, 'render.mjs'),
    read('features/labels/render.js').split("from '../../core/formatters.js'").join("from './formatters.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'render.mjs')).href);
}

test('@page：纸张尺寸与打印机边距逐字来自 layout（页面不写死 A4 / 6mm）', async () => {
  const render = await loadRenderModule();
  assert.equal(render.pageStyleText(layout()),
    '@page { size: 210mm 297mm; margin: 6mm 6mm 6mm 6mm; }');
  // 换一份 config（A5 + 不同边距）→ @page 跟着变，页面代码不用动。
  assert.equal(render.pageStyleText(layout({
    page: { name: 'A5', widthMm: 148, heightMm: 210, marginMm: { top: 4, right: 3, bottom: 4, left: 3 } },
  })), '@page { size: 148mm 210mm; margin: 4mm 3mm 4mm 3mm; }');
});

test('标签纸 CSS 变量：尺寸 / 间距 / 行列 / 字号全部来自 layout', async () => {
  const render = await loadRenderModule();
  const vars = render.sheetStyleVars(layout());
  for (const expected of [
    '--label-w: 50mm', '--label-h: 30mm', '--label-pad: 1.5mm',
    '--cols: 3', '--gap-x: 0mm', '--gap-y: 0mm', '--sheet-w: 198mm',
    '--qr-size: 18mm', '--item-no-size: 5mm', '--field-size: 2.6mm', '--footer-size: 1.7mm',
  ]) {
    assert.ok(vars.includes(expected), `CSS 变量里必须有 ${expected}（来自服务端 config）`);
  }
  const custom = render.sheetStyleVars(layout({
    label: { widthMm: 40, heightMm: 20, paddingMm: 1 },
    grid: { columns: 5, rows: 14, usableWidthMm: 200, gapXMm: 0, gapYMm: 0 },
    typography: { itemNoMm: 4.2, fieldMm: 2.2, footerMm: 1.5, qrSizeMm: 15 },
  }));
  assert.ok(custom.includes('--label-w: 40mm'));
  assert.ok(custom.includes('--cols: 5'));
  assert.ok(custom.includes('--item-no-size: 4.2mm'), '字号也跟着 config 走');
});

test('一张标签：二维码 + 货号（最大字号那个 class）+ 颜色/类别/尺码/状态 + 底部小字', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout());
  assert.ok(html.includes('<svg xmlns="http://www.w3.org/2000/svg"'), '二维码 SVG 原样内联（服务端生成的）');
  assert.match(html, /<div class="label-item-no">XHB8095<\/div>/, '货号用最大字号那一格');
  assert.ok(html.includes('黑色 · 休闲鞋'), '颜色与类别一行');
  assert.ok(html.includes('42码'), '尺码一行');
  assert.ok(html.includes('门盒'), '所属状态一行');
  assert.equal(html.match(/<div class="label-qr"/g).length, 1);
  assert.match(html, /<div class="label-footer">XHB8095\|黑色\|休闲鞋\|42<\/div>/);
});

test('字段开关：关掉哪个就不印哪个（含二维码、底部小字、货号）', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout({
    fields: { qr: false, footer: false, color: false, category: false },
  }));
  assert.ok(!html.includes('<svg'), 'fields.qr = false → 不出二维码');
  assert.ok(!html.includes('label-footer'), 'fields.footer = false → 不出底部小字');
  assert.ok(!html.includes('黑色') && !html.includes('休闲鞋'), '颜色/类别关掉后不印');
  assert.ok(html.includes('XHB8095'), '货号仍然印');
  assert.ok(html.includes('42码') && html.includes('门盒'), '尺码与状态仍然印');
});

test('取不到的值用 config 的占位顶（不留空），文字一律转义（货号里的 < > & 不许当 HTML）', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label({ color: '', item_no: '<script>alert(1)</script>', footer_text: 'a&b' }),
    layout());
  assert.ok(html.includes('— · 休闲鞋'), '颜色为空时用 layout.texts.missingValue');
  assert.ok(!html.includes('<script>'), '货号里的尖括号必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a&amp;b'));
});

test('空结果不炸：给一块明确的空白提示（不是空白页，也不是异常）', async () => {
  const render = await loadRenderModule();
  const html = render.sheetHtml([], layout());
  assert.ok(html.includes('label-empty'));
  assert.ok(html.includes('没有匹配的库存'));
  assert.ok(!html.includes('<article'), '没有标签时一张都不画');
});

test('结果概要：匹配/显示/每页张数 + 截断 + 跳过的记录都要让她看见（不静默）', async () => {
  const render = await loadRenderModule();
  const summary = render.summaryHtml({
    total_matched: 400,
    total_returned: 300,
    truncated: true,
    max_labels: 300,
    skipped_records: { total: 2 },
    missing_created_at: 3,
    filters: { recent_days: 7 },
    layout: layout(),
  });
  assert.ok(summary.includes('匹配 <strong>400</strong> 张标签'));
  assert.ok(summary.includes('本次显示 <strong>300</strong> 张'));
  assert.ok(summary.includes('每页 27 张'));
  assert.ok(summary.includes('50×30mm'));
  assert.ok(summary.includes('一次最多印 300 张'), '截断必须明说');
  assert.ok(summary.includes('已跳过'), '跳过的库存记录必须明说');
  assert.ok(summary.includes('没有「创建时间」'), '「最近新增」漏掉的要明说');
});

// ── 接线（静态）────────────────────────────────────────────────────────────

test('页面接线：label-print.html 存在、注册进 standalone.js、首页有那张卡、CSS 是 mm + 打印规则', () => {
  assert.ok(fs.existsSync(path.join(WORKBENCH, 'label-print.html')), 'label-print.html 必须存在');
  const html = read('label-print.html');
  assert.match(html, /data-view="label-print"/);
  assert.match(html, /features\/labels\/labels\.css/);
  assert.match(html, /features\/labels\/index\.js|standalone\.js/, '页面必须走既有 standalone 启动器');

  const standalone = read('standalone.js');
  assert.match(standalone, /'label-print': \(\) => createLabelPrintModule\(\)/,
    'standalone.js 的独立页注册表里必须有 label-print（不是新开一套启动逻辑）');

  const home = read('config/home.js');
  assert.match(home, /href: '\/workbench\/label-print\.html'/);
  assert.match(home, /title: '鞋盒标签打印'/);

  const page = read('features/labels/index.js');
  assert.equal((page.match(/api\.get\(/g) || []).length, 1,
    '整页只发一次只读请求（类别候选来自同一次响应，不另查库存）');
  assert.ok(!page.includes('inventory/categories'), '页面不许再查一次类别接口');

  const css = read('features/labels/labels.css');
  assert.match(css, /@media print/, '必须有打印规则（只印标签纸）');
  assert.match(css, /break-inside: avoid/, '一张标签不许被拆到两页上');
  assert.match(css, /var\(--label-w\)/, '标签宽度必须走 CSS 变量（值来自服务端 config）');
  assert.match(css, /mm/, '排版用 mm（不是 px）');
  // 页面上不许自己写死 50×30 —— 尺寸的唯一来源是服务端 config。
  assert.ok(!/width:\s*50mm/.test(css), 'CSS 里不许写死 50mm');
  assert.ok(!/height:\s*30mm/.test(css), 'CSS 里不许写死 30mm');
});

test('接线：走的是既有工作台鉴权与既有导航（没有新开鉴权、没有重做导航）', () => {
  const html = read('label-print.html');
  assert.match(html, /class="standalone-nav"/, '沿用既有独立页导航条');
  assert.match(html, /返回信息录入/, '导航里保留回信息录入的那条');

  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.equal(routes.match(/const requireWorkbenchAccess/g).length, 1,
    '鉴权中间件只能有既有那一个（不许为标签接口再写一套）');
  assert.ok(routes.indexOf("router.get('/labels'") > routes.indexOf('router.use(requireWorkbenchAccess)'),
    '/labels 必须挂在既有身份闸门之后');
  assert.ok(!/库存键|所属状态/.test(routes),
    '路由里不许写死飞书字段名（字段映射的唯一来源是 config / service）');
});
