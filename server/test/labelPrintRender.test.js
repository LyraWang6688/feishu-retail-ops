/**
 * 鞋盒标签打印**页面侧**的护栏（业务负责人 2026-10-08 **看了实物标签之后**定案的 40×30mm 版式）。
 *
 * 做两件事：
 *   ① 把 `public/workbench/features/labels/render.js` 真的当模块跑起来（复制成 `.mjs`，
 *      **只改 import 的文件名、逻辑一个字不改** —— 与 `workbenchHomeEntries.test.js` 同一套做法），
 *      断言 **尺寸 / 字号 / 品牌位置 / 右栏行序 / 每行几个尺码 / 字段开关全部来自服务端传下来的
 *      layout**（页面自己一个 mm、一个行序都不写死），**数量角标是真的 `<span>`、不是 Unicode
 *      下标字符**，以及**超长货号缩字号 / 截断、估算宽度永不越界（不许压到二维码）**；
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
const layout = (patch = {}) => {
  const bodyPatch = patch.body || {};
  return {
    label: { widthMm: 40, heightMm: 30, paddingMm: 1.5, borderMm: 0.2, ...(patch.label || {}) },
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
      order: 'asc', compare: 'numeric', ...(patch.sizes || {}),
    },
    // 标签内部版式（品牌置顶居中 / 右栏行序 / 货号+颜色同行的超宽规则）—— 服务端 config 的镜子。
    body: {
      rows: ['brand', 'itemNoColor', 'price', 'state', 'sizes'],
      brandRow: 'top',
      brandAlign: 'center',
      brandGapMm: 0.6,
      qrGapMm: 1.5,
      ...bodyPatch,
      itemNoColor: {
        gapMm: 1.2,
        categorySeparator: ' · ',
        preferColorOverCategory: true,
        minItemNoMm: 2.4,
        truncateMark: '…',
        widthEm: {
          narrow: 0.25, ascii: 0.66, wide: 0.72, cjk: 1,
          narrowChars: [' '], wideChars: ['·', '-', '—', '/'],
        },
        ...(bodyPatch.itemNoColor || {}),
      },
    },
    fields: {
      qr: true, brand: true, itemNo: true, color: true, category: true,
      size: true, price: true, state: false, footer: false, ...(patch.fields || {}),
    },
    texts: { missingValue: '—', overflowMark: '…', stateSeparator: '/', ...(patch.texts || {}) },
  };
};

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

test('防漂移：页面侧镜像的版式参数与 `config/labelPrint.js` 的默认值逐字一致', async () => {
  // 这条用例专门拦"改了服务端 config、忘了同步页面侧的镜子"（历史坑：50×30 → 40×30 时漏改过）。
  const { LABEL_PRINT } = require('../src/config/labelPrint');
  const mirrored = layout();
  assert.deepEqual(mirrored.label, LABEL_PRINT.label, 'label（含裁切线 borderMm）');
  assert.deepEqual(mirrored.typography, LABEL_PRINT.typography, 'typography');
  assert.deepEqual(mirrored.sizes, LABEL_PRINT.sizes, 'sizes（含 order / compare）');
  assert.deepEqual(mirrored.body, LABEL_PRINT.body, 'body（品牌位置 / 右栏行序 / 超长货号规则）');
  assert.deepEqual(mirrored.fields, LABEL_PRINT.fields, 'fields');
  assert.deepEqual(mirrored.texts, LABEL_PRINT.texts, 'texts');
});

test('@page：纸张尺寸与打印机边距逐字来自 layout（页面不写死 A4 / 6mm）', async () => {
  const render = await loadRenderModule();
  assert.equal(render.pageStyleText(layout()),
    '@page { size: 210mm 297mm; margin: 6mm 6mm 6mm 6mm; }');
  // 换一份 config（A5 + 不同边距）→ @page 跟着变，页面代码不用动。
  assert.equal(render.pageStyleText(layout({
    page: { name: 'A5', widthMm: 148, heightMm: 210, marginMm: { top: 4, right: 3, bottom: 4, left: 3 } },
  })), '@page { size: 148mm 210mm; margin: 4mm 3mm 4mm 3mm; }');
});

test('标签纸 CSS 变量：尺寸 / 行列 / 字号 / 角标比例 / 品牌与二维码间距全部来自 layout', async () => {
  const render = await loadRenderModule();
  const vars = render.sheetStyleVars(layout());
  for (const expected of [
    '--label-w: 40mm', '--label-h: 30mm', '--label-pad: 1.5mm', '--label-border: 0.2mm',
    '--cols: 4', '--gap-x: 0mm', '--gap-y: 0mm', '--sheet-w: 198mm',
    '--qr-size: 15mm', '--qr-gap: 1.5mm', '--brand-gap: 0.6mm', '--item-no-gap: 1.2mm',
    '--item-no-size: 3.6mm', '--brand-size: 2.4mm', '--field-size: 2.8mm',
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
    body: { qrGapMm: 2, brandGapMm: 1.4, itemNoColor: { gapMm: 2 } },
  }));
  assert.ok(custom.includes('--label-w: 50mm'));
  assert.ok(custom.includes('--cols: 4'));
  assert.ok(custom.includes('--item-no-size: 5mm'), '字号也跟着 config 走');
  assert.ok(custom.includes('--size-qty-size: 1.5mm'), '角标字号 = 尺码字号 × config 里的比例');
  assert.ok(custom.includes('--size-gap: 1.5mm'));
  assert.ok(custom.includes('--qr-gap: 2mm') && custom.includes('--brand-gap: 1.4mm')
    && custom.includes('--item-no-gap: 2mm'), '品牌 / 二维码 / 货号与颜色的间距也来自 config');
});

test('她定案的版式：品牌**顶部居中** → 右栏第一行「货号 + 颜色」→ 第二行「单价」→ 下面尺码区', async () => {
  const render = await loadRenderModule();
  const html = render.labelHtml(label(), layout());
  assert.ok(html.includes('<svg xmlns="http://www.w3.org/2000/svg"'), '二维码 SVG 原样内联（服务端生成的）');
  assert.equal(html.match(/<div class="label-qr"/g).length, 1);

  // ① 品牌：顶部**居中**，且**跨整张标签**（在 .label-main 之前、不在右栏里）。
  assert.match(html, /<div class="label-brand label-brand-top" style="text-align: center">邯美皮鞋<\/div>/,
    '品牌是顶部那一行、居中（对齐方式来自 config 的 body.brandAlign）');
  assert.ok(html.indexOf('label-brand') < html.indexOf('label-main'),
    '品牌在二维码/右栏**上面**（不是挤在右栏第一条）');
  assert.equal((html.match(/class="label-brand/g) || []).length, 1, '品牌只印一处（顶部那行）');

  // ② 右栏第一行：货号 + 颜色**同一行**（一个 label-item-line 里两个 span，货号在前）。
  assert.equal(html.match(/<div class="label-item-line"/g).length, 1, '货号与颜色在同一行 = 只有一个 item-line');
  assert.match(html, /<div class="label-item-line"[^>]*><span class="label-item-no">YD6693-2<\/span><span class="label-color">/,
    '货号（大字）在前、颜色在后，同一行');
  assert.ok(html.indexOf('label-item-no') < html.indexOf('label-color'), '货号在颜色左边');
  // 二维码在左、右栏在右。
  assert.ok(html.indexOf('label-qr') < html.indexOf('label-item-line'), '二维码在右栏左边');

  // ③ 单价在**第二行**（颜色那一行之后、尺码区之前）。
  assert.ok(html.includes('¥399'));
  assert.ok(html.indexOf('label-item-line') < html.indexOf('label-price'), '单价在"货号+颜色"那一行下面');
  // ④ 下面是尺码区。
  assert.ok(html.indexOf('label-price') < html.indexOf('label-sizes'), '尺码区在单价下面');
  assert.ok(html.includes('label-size-qty'), '尺码带数量角标');

  assert.ok(!html.includes('label-footer'), 'footer 关着的时候不许出现底部小字');
  assert.ok(!html.includes('门盒'), '所属状态默认不印');
});

test('右栏行序来自 config：改 `body.rows` 的顺序，画出来的 HTML 顺序跟着变（渲染层不写死）', async () => {
  const render = await loadRenderModule();
  const defaultHtml = render.labelHtml(label(), layout());
  assert.ok(defaultHtml.indexOf('label-item-line') < defaultHtml.indexOf('label-price')
    && defaultHtml.indexOf('label-price') < defaultHtml.indexOf('label-sizes'),
    '默认行序：货号+颜色 → 单价 → 尺码');

  const flipped = render.labelHtml(label(), layout({ body: { rows: ['sizes', 'price', 'itemNoColor'] } }));
  assert.ok(flipped.indexOf('label-sizes') < flipped.indexOf('label-price')
    && flipped.indexOf('label-price') < flipped.indexOf('label-item-line'),
    '行序换了，HTML 顺序跟着换');

  const withoutPrice = render.labelHtml(label(), layout({ body: { rows: ['itemNoColor', 'sizes'] } }));
  assert.ok(!withoutPrice.includes('label-price'), '行序里没有 price 就不画价格（不靠字段开关也行）');
});

test('品牌位置与对齐都来自 config：brandRow 改 inline 就回到右栏，brandAlign 改 left 就不居中', async () => {
  const render = await loadRenderModule();
  const inline = render.labelHtml(label(), layout({ body: { brandRow: 'inline' } }));
  assert.ok(!inline.includes('label-brand-top'), 'brandRow = inline ⇒ 不再是顶部那一行');
  assert.ok(inline.indexOf('label-brand') > inline.indexOf('label-body'), '品牌回到右栏里（老版式）');
  assert.match(inline, /<div class="label-brand">邯美皮鞋<\/div>/);

  const aligned = render.labelHtml(label(), layout({ body: { brandAlign: 'left' } }));
  assert.match(aligned, /<div class="label-brand label-brand-top" style="text-align: left">邯美皮鞋<\/div>/,
    '对齐方式也走 config（这里配的是 left）');
});

test('货号 + 颜色同行：她给的例子「0225 棕色 · B」缩一点点也保品类；要牺牲货号才塞得下就丢品类保颜色', async () => {
  const render = await loadRenderModule();
  // 她给的例子：4 位货号 + 2 字颜色 + 1 字品类 ⇒ 货号**缩一点点**就让得开，品类照印。
  const shortLabel = label({ item_no: '0225', color: '棕色', category: 'B' });
  const short = render.labelHtml(shortLabel, layout());
  assert.ok(short.includes('<span class="label-item-no">0225</span>'));
  assert.ok(short.includes('<span class="label-color">棕色 · B</span>'), '颜色 · 品类跟在货号后面同一行');
  const shortPlan = render.planItemNoColor(shortLabel, layout());
  assert.equal(shortPlan.categoryIncluded, true);
  assert.ok(shortPlan.itemNoSizeMm >= 2.4 && shortPlan.itemNoSizeMm <= 3.6, '为保住品类，货号缩了一点点');
  assert.ok(shortPlan.estimatedWidthMm <= shortPlan.availableWidthMm + 1e-9);

  // 货号长 / 品类长 ⇒ 保品类就得把货号缩到下限（甚至截断）⇒ 丢品类、保颜色，颜色一个字不少。
  const plan = render.planItemNoColor(label(), layout());
  assert.equal(plan.colorText, '黑色', '放不下时优先保颜色：品类被丢掉、颜色保住');
  assert.equal(plan.categoryIncluded, false);
  assert.ok(!render.labelHtml(label(), layout()).includes('休闲鞋'), '被丢掉的品类不出现在 HTML 里');

  // 关掉"优先保颜色"⇒ 品类优先：货号缩到最小也要把品类印上。
  const keepCategory = render.planItemNoColor(label(), layout({
    body: { itemNoColor: { preferColorOverCategory: false } },
  }));
  assert.equal(keepCategory.categoryIncluded, true);
  assert.ok(keepCategory.colorText.includes('休闲鞋'), 'preferColorOverCategory = false ⇒ 品类保住');
  assert.ok(keepCategory.itemNoSizeMm <= 2.4 + 1e-9, '代价是货号缩到配置里的下限');

  // 整个品类关掉（fields.category = false）⇒ 只剩货号 + 颜色。
  const noCategory = render.labelHtml(label(), layout({ fields: { category: false } }));
  assert.ok(noCategory.includes('黑色') && !noCategory.includes('休闲鞋'));
});

test('超长货号**不许压到二维码**：先缩字号、缩到底再截断补 …；估算宽度永远 ≤ 右栏可用宽度', async () => {
  const render = await loadRenderModule();
  const base = layout();
  assert.equal(render.availableWidthMm(base), 20.1, '右栏可用宽度 = 40 − 2×1.5 − 0.4(裁切线) − 15(二维码) − 1.5(间距)');
  assert.equal(render.availableWidthMm(layout({ fields: { qr: false } })), 36.6, '二维码关掉 ⇒ 右栏拿走整张宽');

  const long = label({ item_no: 'XHB8095-2-BLACK-EXTRA-LONG-99' });
  const plan = render.planItemNoColor(long, base);
  assert.ok(plan.itemNoTruncated, '长到缩到底也放不下 ⇒ 截断');
  assert.equal(plan.itemNoSizeMm, 2.4, '缩字号的下限来自 config（minItemNoMm）');
  assert.ok(plan.itemNoText.endsWith('…'), '截断要看得见（补 …）');
  assert.ok(plan.itemNoText.length < long.item_no.length);
  assert.ok(plan.estimatedWidthMm <= plan.availableWidthMm + 1e-9, '估算宽度不许越过右栏边界');
  assert.equal(plan.colorText, '黑色', '货号再长也不丢颜色');

  const html = render.labelHtml(long, base);
  assert.ok(html.includes('data-truncated="true"'), '截断了要标出来（页面/测试看得见）');
  assert.match(html, /style="--item-no-size: 2\.4mm"/, '缩小的字号以内联 CSS 变量下来');
  assert.ok(!html.includes(long.item_no), '被截掉的货号不会整串出现在 HTML 里');

  // 一整串长货号扫一遍：不论多长，"估算宽度 ≤ 可用宽度"这条不变量都不能破。
  const em = base.body.itemNoColor.widthEm;
  for (const itemNo of ['A', '0225', 'YD6693-2', 'XHB8095', 'XHB8095-2-BLACK-EXTRA-LONG-99', 'X'.repeat(60)]) {
    const one = render.planItemNoColor(label({ item_no: itemNo }), base);
    assert.ok(one.estimatedWidthMm <= one.availableWidthMm + 1e-9, `${itemNo} 不许越界`);
    assert.equal(render.textWidthMm(one.itemNoText, one.itemNoSizeMm, em)
      + one.gapMm + render.textWidthMm(one.colorText, base.typography.fieldMm, em),
    one.estimatedWidthMm, 'estimatedWidthMm 就是"货号 + 间距 + 颜色"的实际估算宽度');
  }
});

test('「货号+颜色」那一行在 CSS 里是 nowrap + overflow: hidden（估算之外的第二道保险）', () => {
  const css = read('features/labels/labels.css');
  assert.match(css, /\.label-item-line\s*\{[^}]*white-space:\s*nowrap/s, '货号+颜色那一行不许换行');
  assert.match(css, /\.label-item-line\s*\{[^}]*overflow:\s*hidden/s, '放不下只能被裁（绝不压到二维码上）');
  assert.match(css, /\.label-body\s*\{[^}]*min-width:\s*0/s, '右栏必须能收缩，否则长货号会把二维码挤走');
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
  const html = render.labelHtml(label({ color: '', item_no: 'A1', footer_text: 'a&b' }),
    layout({ fields: { footer: true } }));
  assert.ok(html.includes('— · 休闲鞋'), '颜色为空时用 layout.texts.missingValue');
  assert.ok(html.includes('a&amp;b'));

  // 长货号（带尖括号）走"缩字号 / 截断"这条路时也必须转义。
  const escaped = render.labelHtml(label({ item_no: '<script>alert(1)</script>' }), layout());
  assert.ok(!escaped.includes('<script>'), '货号里的尖括号必须被转义');
  assert.ok(escaped.includes('&lt;script'), '转义后仍是那段货号的开头');
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
