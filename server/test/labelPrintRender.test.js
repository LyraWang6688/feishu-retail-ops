/**
 * 鞋盒标签打印**页面侧**的护栏（业务负责人 2026-10-08 **定案**的 40×30mm 版式）。
 *
 * 做两件事：
 *   ① 把 `public/workbench/features/labels/render.js` 真的当模块跑起来（复制成 `.mjs`，
 *      **只改 import 的文件名、逻辑一个字不改** —— 与 `workbenchHomeEntries.test.js` 同一套做法），
 *      断言 **尺寸 / 字号 / 每行几个尺码 / 字段开关全部来自服务端传下来的 layout**
 *      （页面自己一个 mm 都不写死），以及**数量角标是真的 `<span>`、不是 Unicode 下标字符**；
 *   ② 静态钉住接线：`label-print.html` 存在且 `data-view="label-print"`、在 `standalone.js`
 *      的独立页注册表里、"信息录入"首页有那张卡（说明里写的是 40×30mm）、
 *      CSS 走 `@media print` + mm + CSS 变量。
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
  label: { widthMm: 40, heightMm: 30, paddingMm: 1.5, ...(patch.label || {}) },
  page: {
    name: 'A4', widthMm: 210, heightMm: 297,
    marginMm: { top: 6, right: 6, bottom: 6, left: 6 }, ...(patch.page || {}),
  },
  grid: { columns: 4, rows: 9, perPage: 36, usableWidthMm: 198, gapXMm: 0, gapYMm: 0, ...(patch.grid || {}) },
  typography: {
    itemNoMm: 3.6, brandMm: 2.4, fieldMm: 2.8, sizeMm: 2.8, priceMm: 3.2, footerMm: 1.7, qrSizeMm: 15,
    ...(patch.typography || {}),
  },
  sizes: {
    perLine: 3, maxLines: 2, itemGapMm: 1, qtyFontRatio: 0.64, qtyBaselineShiftEm: 0.2,
    ...(patch.sizes || {}),
  },
  fields: {
    qr: true, brand: true, itemNo: true, color: true, category: true,
    size: true, price: true, state: false, footer: false, ...(patch.fields || {}),
  },
  texts: { missingValue: '—', overflowMark: '…', stateSeparator: '/', ...(patch.texts || {}) },
});

const label = (patch = {}) => ({
  key: 'YD6693-2|黑色|A',
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category: '休闲鞋',
  category_code: 'A',
  sizes: [{ size: 38, qty: 1 }, { size: 39, qty: 2 }, { size: 40, qty: 1 }],
  size_lines: [[{ size: 38, qty: 1 }, { size: 39, qty: 2 }, { size: 40, qty: 1 }]],
  size_overflow: false,
  total_qty: 4,
  states: ['门盒'],
  state_text: '门盒',
  price: 399,
  price_text: '¥399',
  brand_text: '邯美皮鞋',
  record_ids: ['r1'],
  record_count: 1,
  scan_url: 'https://hm.bamamei.online/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33 33"><path d="M0 0h33v33H0z"/></svg>',
  footer_text: 'YD6693-2|黑色|A',
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

test('标签纸 CSS 变量：尺寸 / 行列 / 字号 / 角标比例全部来自 layout', async () => {
  const render = await loadRenderModule();
  const vars = render.sheetStyleVars(layout());
  for (const expected of [
    '--label-w: 40mm', '--label-h: 30mm', '--label-pad: 1.5mm',
    '--cols: 4', '--gap-x: 0mm', '--gap-y: 0mm', '--sheet-w: 198mm',
    '--qr-size: 15mm', '--item-no-size: 3.6mm', '--brand-size: 2.4mm', '--field-size: 2.8mm',
    '--size-size: 2.8mm', '--size-qty-size: 1.792mm', '--size-qty-shift: -0.2em',
    '--size-gap: 1mm', '--price-size: 3.2mm', '--footer-size: 1.7mm',
  ]) {
    assert.ok(vars.includes(expected), `CSS 变量里必须有 ${expected}（来自服务端 config）`);
  }
  const custom = render.sheetStyleVars(layout({
    label: { widthMm: 50, heightMm: 40, paddingMm: 1 },
    grid: { columns: 4, rows: 7, usableWidthMm: 200, gapXMm: 0, gapYMm: 0 },
    typography: { itemNoMm: 5, brandMm: 3, fieldMm: 2.6, sizeMm: 3, priceMm: 4, footerMm: 1.5, qrSizeMm: 18 },
    sizes: { qtyFontRatio: 0.5, itemGapMm: 1.5 },
  }));
  assert.ok(custom.includes('--label-w: 50mm'));
  assert.ok(custom.includes('--cols: 4'));
  assert.ok(custom.includes('--item-no-size: 5mm'), '字号也跟着 config 走');
  assert.ok(custom.includes('--size-qty-size: 1.5mm'), '角标字号 = 尺码字号 × config 里的比例');
  assert.ok(custom.includes('--size-gap: 1.5mm'));
});

test('一张标签：二维码 + 品牌（小灰字）+ 货号（最大字号那格）+ 颜色·品类 + 尺码角标 + 单价', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout());
  assert.ok(html.includes('<svg xmlns="http://www.w3.org/2000/svg"'), '二维码 SVG 原样内联（服务端生成的）');
  assert.equal(html.match(/<div class="label-qr"/g).length, 1);
  assert.match(html, /<div class="label-brand">邯美皮鞋<\/div>/, '品牌那行（小灰字）');
  assert.match(html, /<div class="label-item-no">YD6693-2<\/div>/, '货号用最大字号那一格');
  assert.ok(html.includes('黑色 · 休闲鞋'), '颜色 · 品类一行');
  assert.ok(html.includes('¥399'), '单价那一行');
  assert.ok(!html.includes('label-footer'), 'footer 关着的时候不许出现底部小字');
  assert.ok(!html.includes('门盒'), '所属状态默认不印');
});

test('数量角标：是真的 <span>（小号字 + 下沉），**不是 Unicode 下标字符**', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout());
  assert.match(html, /<div class="label-sizes"><span class="label-size">38<span class="label-size-qty">1<\/span><\/span>/,
    '尺码 + 角标：每双数量是 <span class="label-size-qty">');
  assert.ok(html.includes('<span class="label-size">39<span class="label-size-qty">2</span></span>'));
  assert.ok(!/[\u2080-\u2089]/.test(html), '画出来的 HTML 里不许有 Unicode 下标字符（会显示成方框）');
  // 代码里也不许**输出**下标字符（注释里说明"别用下标"的那几处先剥掉再查）。
  const code = read('features/labels/render.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/[\u2080-\u2089]/.test(code), '渲染层代码里不许有下标字符');
});

test('换行：两行各画一行；还有尺码没排上时**最后一行尾上加 …**（省略看得见）', async () => {
  const render = await loadRenderModule();
  const twoLines = label({
    sizes: [38, 39, 40, 41, 42, 43, 44].map((size) => ({ size, qty: 1 })),
    size_lines: [
      [{ size: 38, qty: 1 }, { size: 39, qty: 1 }, { size: 40, qty: 1 }],
      [{ size: 41, qty: 1 }, { size: 42, qty: 1 }, { size: 43, qty: 1 }],
    ],
    size_overflow: true,
  });
  const html = render.labelHtml(twoLines, layout());
  assert.equal(html.match(/<div class="label-sizes">/g).length, 2, '两行尺码 = 两个 label-sizes');
  assert.match(html, /<span class="label-size-more">…<\/span>/, '有省略时补 …');
  assert.ok(html.indexOf('label-size-more') > html.indexOf('43'), '… 在最后一行尾上');

  const noOverflow = render.labelHtml(label({ size_overflow: false }), layout());
  assert.ok(!noOverflow.includes('label-size-more'), '没省略时不许画 …');
});

test('字段开关：关掉哪个就不印哪个（含二维码、品牌、价格、底部小字）', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout({
    fields: { qr: false, brand: false, price: false, footer: false, color: false, category: false },
  }));
  assert.ok(!html.includes('<svg'), 'fields.qr = false → 不出二维码');
  assert.ok(!html.includes('邯美皮鞋'), 'fields.brand = false → 不印品牌');
  assert.ok(!html.includes('¥399'), 'fields.price = false → 不印价格');
  assert.ok(!html.includes('黑色 · 休闲鞋') && !html.includes('label-field'),
    '颜色/品类关掉后不印（编号里还带着"黑色"是 data-record-id，不是印出来的字）');
  assert.ok(html.includes('YD6693-2'), '货号仍然印');
  assert.ok(html.includes('label-size-qty'), '尺码仍然印');
});

test('字段开关：打开所属状态与底部小字就印（与打样图那版只差开关）', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout({ fields: { state: true, footer: true } }));
  assert.ok(html.includes('门盒'), 'fields.state = true → 印状态');
  assert.match(html, /<div class="label-footer">YD6693-2\|黑色\|A<\/div>/);
});

test('取不到的值用 config 的占位顶（不留空），文字一律转义（货号里的 < > & 不许当 HTML）', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label({ color: '', item_no: '<script>alert(1)</script>', footer_text: 'a&b' }),
    layout({ fields: { footer: true } }));
  assert.ok(html.includes('— · 休闲鞋'), '颜色为空时用 layout.texts.missingValue');
  assert.ok(!html.includes('<script>'), '货号里的尖括号必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a&amp;b'));
});

test('单价缺失的标签照画（只是没有价格那一行）—— 页面不许整张丢掉', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label({ price: null, price_text: '' }), layout());
  assert.ok(html.includes('YD6693-2'), '货号还在');
  assert.ok(html.includes('label-size-qty'), '尺码还在');
  assert.ok(!html.includes('label-price'), '没有单价就不画价格那一行');
});

test('空结果不炸：给一块明确的空白提示（不是空白页，也不是异常）', async () => {
  const render = await loadRenderModule();
  const html = render.sheetHtml([], layout());
  assert.ok(html.includes('label-empty'));
  assert.ok(html.includes('没有匹配的库存'));
  assert.ok(!html.includes('<article'), '没有标签时一张都不画');
});

test('结果概要：匹配几个编号 / 一共几双 / 每页张数 + 截断 + 跳过 + 缺单价都要让她看见（不静默）', async () => {
  const render = await loadRenderModule();
  const summary = render.summaryHtml({
    total_matched: 400,
    total_returned: 300,
    total_pairs: 812,
    truncated: true,
    max_labels: 300,
    skipped_records: { total: 2 },
    missing_created_at: 3,
    missing_price: 5,
    filters: { recent_days: 7 },
    layout: layout(),
  });
  assert.ok(summary.includes('匹配 <strong>400</strong> 张标签（一张 = 一个编号）'));
  assert.ok(summary.includes('一共 <strong>812</strong> 双库存'));
  assert.ok(summary.includes('本次显示 <strong>300</strong> 张'));
  assert.ok(summary.includes('每页 36 张'));
  assert.ok(summary.includes('40×30mm'));
  assert.ok(summary.includes('一次最多印 300 张'), '截断必须明说');
  assert.ok(summary.includes('已跳过'), '跳过的库存记录必须明说');
  assert.ok(summary.includes('没有「创建时间」'), '「最近新增」漏掉的要明说');
  assert.ok(summary.includes('读不到「单价」'), '缺单价必须明说（标签照发）');
});

// ── 接线（静态）────────────────────────────────────────────────────────────

test('页面接线：label-print.html 存在、注册进 standalone.js、首页有那张卡（40×30mm）、CSS 是 mm + 打印规则', () => {
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
  assert.match(home, /desc: '.*40×30mm.*'/, '首页卡片的说明要跟着新标签纸走（不许还写 50×30mm）');

  const page = read('features/labels/index.js');
  assert.equal((page.match(/api\.get\(/g) || []).length, 1,
    '整页只发一次只读请求（品类候选来自同一次响应，不另查库存）');
  assert.ok(!page.includes('inventory/categories'), '页面不许再查一次品类接口');
  // 首次失败时兜底那份 layout 也得是 40×30（它是服务端 config 的镜子）。
  assert.match(page, /widthMm: 40, heightMm: 30/);
  assert.match(page, /qrSizeMm: 15/);

  const css = read('features/labels/labels.css');
  assert.match(css, /@media print/, '必须有打印规则（只印标签纸）');
  assert.match(css, /break-inside: avoid/, '一张标签不许被拆到两页上');
  assert.match(css, /var\(--label-w\)/, '标签宽度必须走 CSS 变量（值来自服务端 config）');
  assert.match(css, /var\(--size-qty-size\)/, '数量角标的字号必须走 CSS 变量（来自服务端 config）');
  assert.match(css, /vertical-align: var\(--size-qty-shift\)/, '角标下沉量必须走 CSS 变量');
  assert.match(css, /mm/, '排版用 mm（不是 px）');
  // 页面上不许自己写死 40×30 / 15 —— 尺寸的唯一来源是服务端 config。
  assert.ok(!/width:\s*(40|50)mm/.test(css), 'CSS 里不许写死标签宽度');
  assert.ok(!/height:\s*(30|20)mm/.test(css), 'CSS 里不许写死标签高度');
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
