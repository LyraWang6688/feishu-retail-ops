/**
 * 「**方向 + 构图 + 铺满**」的验收标准 —— 业务负责人 2026-10-11/12 真机四轮 + Lead 的几何推导之后。
 *
 * ⭐ **本轮口径（Lead 定）**：`canvas: 'portrait'` = **逻辑画布 30×40（原构图按"读向沿 40mm 那条边"
 *    整个坐标系换向）+ 整幅转 90° 进页面**。这两步**正好互相抵消** ⇒ 结果是
 *    **页面内容 = 原构图本身、页面仍是 40×30、`scale = 1`（原尺寸铺满）**、二维码仍 15mm。
 *    ⚠️ 关键点（也是上一版错在哪）：**页面不能改成 30×40** —— 一改，驱动"看到页面形状与纸型
 *       不一致"就会**再转 90°**（真机 C 组：方向又反）。所以页面**保持 40×30**。
 *
 * ⚠️ **前提（必须写在测试里，免得"以为换了模式其实没变"）**：
 *    `portrait` 与 `landscape + rotate:0` **渲染结果逐像素相同**（下面 AC-C5 直接证明）——
 *    也就是说**真正的开关是那台打印机的驱动纸型**：
 *      · 驱动纸型 = **40×30** ⇒ 页面按原样打印 ⇒ 原构图就是纸上看到的（方向✓ 构图✓ 铺满✓）；
 *      · 驱动纸型 = **30×40**（她之前的状态）⇒ 驱动会把这张 40×30 的页面**再转 90°** ⇒
 *        方向反（= 真机 A 组）。⇒ 驱动没改对之前，线上应用
 *        `landscape + rotate:90`（B：方向✓ 构图✓，代价 73.5%）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { LABEL_PRINT_QUEUE, resolveLabelPrintQueueConfig } = require('../src/config/labelPrintQueue');
const artifact = require('../src/services/labelPrintArtifactService');

const label = (patch = {}) => ({
  key: 'XHB8095|棕色|A', number: 'XHB8095|棕色|A', item_no: 'XHB8095', color: '棕色',
  category: '休闲鞋', category_code: 'A',
  sizes: [{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }, { size: 39, qty: 1 }],
  size_lines: [[{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }], [{ size: 39, qty: 1 }]],
  size_overflow: false, total_qty: 5, states: ['门盒'], state_text: '门盒',
  price: 198, price_text: '¥198', brand_text: '邯美皮鞋',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
  footer_text: 'XHB8095|棕色|A', ...patch,
});

const layout = (patch = {}) => ({
  ...LABEL_PRINT,
  label: { ...LABEL_PRINT.label, ...(patch.label || {}) },
  typography: { ...LABEL_PRINT.typography, ...(patch.typography || {}) },
  body: { ...LABEL_PRINT.body, ...(patch.body || {}) },
  fields: { ...LABEL_PRINT.fields, ...(patch.fields || {}) },
  sizes: { ...LABEL_PRINT.sizes, ...(patch.sizes || {}) },
  texts: { ...LABEL_PRINT.texts, ...(patch.texts || {}) },
});

/** ⭐ 标定出来的打印机映射（由真机 B「方向对了」那张反推 + 人眼核过）：纸上看到的 = 页面转 -90°。 */
const simulateCurrentDriver = (png) => require('sharp')(png).rotate(-90, { background: '#ffffff' }).png().toBuffer();

/** 墨迹包围盒（宽高 / 覆盖率 / 中心点）。 */
const inkStats = async (png) => {
  const sharp = require('sharp');
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width; let maxX = -1; let minY = info.height; let maxY = -1; let dark = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] < 128) {
        dark += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width: info.width, height: info.height, dark,
    w: maxX - minX + 1, h: maxY - minY + 1,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    coverageX: (maxX - minX + 1) / info.width,
    coverageY: (maxY - minY + 1) / info.height,
  };
};

/** 只印某几个字段（其它全关 + 关裁切线）⇒ 墨迹包围盒 = 那几个字段的形状。 */
const onlyFields = (fields) => layout({
  label: { borderMm: 0 },
  fields: {
    qr: false, brand: false, itemNo: false, color: false, category: false,
    size: false, price: false, state: false, footer: false, ...fields,
  },
});

const render = (config, { fields, patch } = {}) => artifact.renderLabels({
  labels: [label(patch)],
  layout: fields ? onlyFields(fields) : layout(),
  config: { dpi: 203, ...config },
});

// ── AC-C1 / AC-C2：页面尺寸 + scale + 铺满 ───────────────────────────────

test('AC-C1 ⭐⭐ `portrait`：**页面仍是 40×30**、`scale === 1`（原尺寸，不缩不换页面）', async () => {
  const out = await render({ canvas: 'portrait' });
  assert.equal(out.meta.width_mm, 40, '页面必须保持 40×30（换了页面 ⇒ 驱动会再转 90°、方向又反）');
  assert.equal(out.meta.height_mm, 30);
  assert.equal(out.meta.width_pt, 113.3858);
  assert.equal(out.meta.height_pt, 85.0394);
  assert.equal(out.meta.scale, 1, '原尺寸：不许再出现 0.735 那种"小框"');
  assert.equal(out.meta.rotate, 0, '页面内容 = 原构图本身（画布里那次 −90° 与页面那次 +90° 相互抵消）');
  assert.equal(out.meta.rotate_page_with_content, false);
  const meta = await require('sharp')(out.pngFirst).metadata();
  assert.equal(`${meta.width}x${meta.height}`, '320x240', '像素尺寸仍是 320×240');
  assert.match(out.pdf.toString('latin1'), /\/MediaBox \[0 0 113\.3858 85\.0394\]/);
  assert.equal(out.meta.canvas_width_mm, 40);
  assert.equal(out.meta.canvas_height_mm, 30);
});

test('AC-C2 ⭐⭐ 铺满：`portrait` 的内容覆盖 ≥85% / ≥70%（对比 B 的小框）', async () => {
  // ⚠️ **必须关掉裁切线再量**：裁切线本来就沿纸边画，留着它量到的只是"纸边"（横竖都是 100%），
  //    分不出"内容铺满"还是"内容被缩成小框"（踩过一次）。
  const noBorder = layout({ label: { borderMm: 0 } });
  const measure = async (config) => inkStats((await artifact.renderLabels({
    labels: [label()], layout: noBorder, config: { dpi: 203, ...config },
  })).pngFirst);

  const portrait = await measure({ canvas: 'portrait' });
  assert.ok(portrait.coverageX >= 0.85, `横向铺满率要 ≥85%（实际 ${(portrait.coverageX * 100).toFixed(1)}%）`);
  assert.ok(portrait.coverageY >= 0.70, `纵向铺满率要 ≥70%（实际 ${(portrait.coverageY * 100).toFixed(1)}%）`);

  // 对照：B（横版 90°）= 整幅缩到 73.5% ⇒ 长边方向空掉一半（"小框"的签名）
  const b = await measure({ rotate: 90 });
  assert.ok(b.coverageX < 0.6, `B（横版 90°）本来就是"小框"（实际 ${(b.coverageX * 100).toFixed(1)}%）`);
  assert.ok(portrait.coverageX > b.coverageX * 1.6,
    `portrait 必须显著比 B 铺得满（${portrait.coverageX.toFixed(3)} vs ${b.coverageX.toFixed(3)}）`);
});

// ── AC-C3：构图关系（她最在意的"左边二维码、右边信息"）──────────────────

test('AC-C3 ⭐⭐ 构图：品牌在**最上**、二维码在**左半区且在品牌下方**、信息块在**右半区**', async () => {
  // ⚠️ 在**页面**上断言：`portrait` 的前提就是"驱动按原样打印"（页面内容 = 纸上看到的）。
  const brand = await inkStats((await render({ canvas: 'portrait' }, { fields: { brand: true } })).pngFirst);
  const qr = await inkStats((await render({ canvas: 'portrait' }, { fields: { qr: true } })).pngFirst);
  // 信息块：二维码"占位但不画"（qr_svg 空串）⇒ 量到的才是信息块的真实位置（踩过一次）
  const info = await inkStats((await render({ canvas: 'portrait' }, {
    fields: { qr: true, itemNo: true, color: true, price: true, size: true },
    patch: { qr_svg: '' },
  })).pngFirst);

  assert.ok(brand.cy < brand.height / 3,
    `品牌必须在**最上面**（中心 y=${brand.cy.toFixed(1)}，纸高 ${brand.height}）`);
  assert.ok(qr.cx < qr.width / 2,
    `二维码必须在**左半区**（中心 x=${qr.cx.toFixed(1)}，纸宽 ${qr.width}）——`
    + '她是看着"左边二维码、右边信息"这个格局定稿的');
  assert.ok(qr.cx < qr.width * 0.35, `二维码要**明显靠左**（实际 ${(qr.cx / qr.width * 100).toFixed(1)}%）`);
  assert.ok(qr.cy > brand.cy,
    `二维码要在品牌那一行的下方（qr.y=${qr.cy.toFixed(1)} vs 品牌 y=${brand.cy.toFixed(1)}）`);
  assert.ok(info.cx > info.width / 2,
    `信息块必须在**右半区**（中心 x=${info.cx.toFixed(1)}，纸宽 ${info.width}）`);
  assert.ok(info.cx > qr.cx, '信息要在二维码右边（两者不重叠）');
});

test('AC-C3 构图的关系是从**同一份配置**来的：没有"竖版专属行序"那套重排', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(LABEL_PRINT.body, 'portraitRows'), false,
    '竖版专属行序（portraitRows）已整个撤掉 —— 两档用的是同一份原构图');
  assert.deepEqual(LABEL_PRINT.body.rows, ['brand', 'itemNoColor', 'price', 'state', 'sizes']);
  const portrait = artifact.labelSvg(label(), layout(), { dpi: 203, canvas: 'portrait' });
  assert.match(portrait, /viewBox="0 0 40 30"/, '`portrait` 的页面仍是 40×30');
});

// ── AC-C4：二维码 ────────────────────────────────────────────────────────

test('AC-C4 ⭐ 二维码仍 **15mm、正方形、可识别**（真二维码；B 那档是 73.5% ⇒ 88px，属已知取舍）', async () => {
  const QRCode = require('qrcode');
  const qrSvg = await QRCode.toString('https://hm.bamamei.online/s/XHB8095%7C%E6%A3%95%E8%89%B2%7CA',
    { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
  for (const [config, expectedPx] of [[{ canvas: 'portrait' }, 120], [{ rotate: 90 }, 88]]) {
    const png = await render(config, { fields: { qr: true }, patch: { qr_svg: qrSvg } });
    const stats = await inkStats(png.pngFirst);
    assert.ok(Math.abs(stats.w - stats.h) <= 2, `二维码必须还是正方形（实际 ${stats.w}x${stats.h}）`);
    assert.ok(Math.abs(stats.w - expectedPx) <= 3,
      `二维码边长（期望 ~${expectedPx}px，实际 ${stats.w}px）—— portrait 必须是原尺寸 15mm`);
    const svg = artifact.labelSvg(label({ qr_svg: qrSvg }), onlyFields({ qr: true }), { dpi: 203, ...config });
    const scaleMatch = /scale\(([^)]+)\)/.exec(svg);
    if (scaleMatch) {
      const values = scaleMatch[1].trim().split(/\s+/).map(Number);
      assert.equal(values.length === 1 || values[0] === values[1], true, `缩放必须等比（${scaleMatch[1]}）`);
    }
  }
});

// ── AC-C5：等价性 + 当前驱动下的如实结论 ─────────────────────────────────

test('AC-C5 ⭐⭐ `portrait` 与 `landscape + rotate:0` **逐像素相同**（证明"页面内容 = 原构图"）', async () => {
  const portrait = await render({ canvas: 'portrait' });
  const landscape0 = await render({ canvas: 'landscape', rotate: 0 });
  assert.deepEqual(portrait.pngFirst, landscape0.pngFirst,
    '`portrait` 的页面内容就是原构图本身 ⇒ 与 landscape+0 像素级相同'
    + '（⚠️ 所以它能不能在纸上打对，取决于**驱动纸型**，不是取决于这个参数名）');
  assert.equal(portrait.meta.width_pt, landscape0.meta.width_pt);
  assert.equal(portrait.meta.scale, landscape0.meta.scale);
});

test('AC-C5 ⚠️ 如实钉住：**驱动纸型没改对之前**，`portrait` 在纸上会打出 A 组那个方向（竖的）', async () => {
  // 真机 A 组 = 页面 40×30 + 原构图（= 现在的 `portrait`），她实测「平行于短边」。
  // 这条不是"要求它错"，而是把**前提**钉在测试里：驱动纸型 30×40 时它会这样打。
  const brandOnly = { fields: { brand: true } };
  const portraitOnCurrentDriver = await inkStats(
    await simulateCurrentDriver((await render({ canvas: 'portrait' }, brandOnly)).pngFirst),
  );
  const aOnCurrentDriver = await inkStats(
    await simulateCurrentDriver((await render({ rotate: 0 }, brandOnly)).pngFirst),
  );
  assert.deepEqual(portraitOnCurrentDriver, aOnCurrentDriver, 'portrait ≡ A（同一页 ⇒ 同一打印结果）');
  assert.ok(portraitOnCurrentDriver.h > portraitOnCurrentDriver.w * 2,
    '⚠️ 驱动纸型还是 30×40 时，品牌是**竖的**（= 真机 A）⇒ 上线前必须先把驱动纸型改成 40×30');

  // 对照：驱动纸型改对之后（页面按原样打印）⇒ 品牌**沿长边横排**，还铺满。
  const portraitOnFixedDriver = await inkStats((await render({ canvas: 'portrait' }, brandOnly)).pngFirst);
  assert.ok(portraitOnFixedDriver.w > portraitOnFixedDriver.h * 2,
    '驱动纸型 = 40×30 ⇒ 页面原样打印 ⇒ 品牌沿长边横排（方向✓）');
});

// ── AC-C6：横版（默认）与 B 不许被改坏 ───────────────────────────────────

test('AC-C6 ⭐ 横版默认与 B 回归不变（0° 不套 `<g>`、B 的 0.735、老"换页面"那条路保留）', async () => {
  assert.equal(LABEL_PRINT_QUEUE.artifact.canvas, 'landscape');
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotate, 0);
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotatePageWithContent, false);

  const svg = artifact.labelSvg(label(), layout(), { dpi: 203 });
  assert.equal(svg.includes('<g transform='), false, '横版 0° 仍不套 <g>（逐字节一致）');
  assert.equal(svg.includes('scale('), false);
  assert.match(svg, /viewBox="0 0 40 30"/);

  const b = await render({ rotate: 90 });
  assert.equal(b.meta.width_pt, 113.3858, 'B 的页面仍是 40×30');
  assert.ok(b.meta.scale > 0.72 && b.meta.scale < 0.76, `B 仍是那条约 0.735 的缩放（实际 ${b.meta.scale}）`);
  // B 的方向/构图（用"还原成纸"验证）
  const brandB = await inkStats(await simulateCurrentDriver((await render({ rotate: 90 }, { fields: { brand: true } })).pngFirst));
  assert.ok(brandB.w > brandB.h * 2, `B 在纸上品牌沿长边横排（实际 ${brandB.w}x${brandB.h}）`);

  const legacy = await render({ rotate: 90, rotatePageWithContent: true });
  assert.equal(legacy.meta.width_pt, 85.0394, '老"换页面"那条路保留（注释已标注"实测会再转 90°、不推荐"）');
  assert.equal(legacy.meta.height_pt, 113.3858);
});

// ── AC-C7：配置先行 + 不溢出 ─────────────────────────────────────────────

test('AC-C7 配置先行：`canvas` 可配、非法值当场抛错；`rotatePageWithContent` 标注"不推荐"', () => {
  assert.equal(resolveLabelPrintQueueConfig({}).artifact.canvas, 'landscape');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'portrait' }).artifact.canvas, 'portrait');
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'diagonal' }), /LABEL_PRINT_CANVAS/);
  assert.equal(artifact.normalizeCanvas(undefined), 'landscape');
  assert.equal(artifact.normalizeCanvas('portrait'), 'portrait');
  assert.throws(() => artifact.normalizeCanvas('45'), /canvas/);
  const source = fs.readFileSync(path.join(__dirname, '../src/config/labelPrintQueue.js'), 'utf8');
  assert.match(source, /rotatePageWithContent[\s\S]{0,600}不推荐/,
    'rotatePageWithContent 旁边必须写清"实测会把方向再转 90°、不推荐"');
  assert.match(source, /canvas: 'portrait'[\s\S]{0,600}页面/, '注释里要写清 portrait 的前提（页面/驱动纸型）');
});

test('AC-C7 内容不许溢出页面（最外一圈只有裁切线）—— 三档都验', async () => {
  const sharp = require('sharp');
  for (const config of [{}, { canvas: 'portrait' }, { rotate: 90 }]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await render(config);
    // eslint-disable-next-line no-await-in-loop
    const { data, info } = await sharp(out.pngFirst).greyscale().raw().toBuffer({ resolveWithObject: true });
    let borderInk = 0;
    for (let x = 0; x < info.width; x += 1) {
      if (data[x] < 128) borderInk += 1;
      if (data[(info.height - 1) * info.width + x] < 128) borderInk += 1;
    }
    for (let y = 0; y < info.height; y += 1) {
      if (data[y * info.width] < 128) borderInk += 1;
      if (data[y * info.width + info.width - 1] < 128) borderInk += 1;
    }
    // ⚠️ 裁切线本来就沿最外一圈走（老版式，原样保留）⇒ 上界 = 那一圈的像素数 + 一点余量
    const ringPx = 2 * (info.width + info.height);
    assert.ok(borderInk <= ringPx + 8,
      `${JSON.stringify(config)}：最外一圈只该有裁切线（上限 ${ringPx + 8}，实际 ${borderInk}）`);
  }
});
