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

test('AC-C8 ⭐⭐ `fitting`（"那一格"）：算法如实实现，且**逐像素等于** `landscape + rotate:0` —— 等价于不旋转', async () => {
  // 业务负责人 2026-10-12 点名的那一格：
  //   ① 逻辑画布 30 宽 × 40 高（读向沿 40mm 边：品牌沿 40mm 排在顶部、二维码在阅读坐标系左侧、
  //      信息在右、尺码在下）；② 页面 40×30 不变；③ 把 30×40 的成果**整体转 90°** 放进页面
  //   ⇒ 形状上 30×40 转 90° = 40×30 ⇒ `scale = 1` 铺满。
  const fitting = await render({ canvas: 'fitting' });
  // ③ 的"形状/铺满"部分成立：页面 40×30、scale 1、320×240
  assert.equal(fitting.meta.width_mm, 40);
  assert.equal(fitting.meta.height_mm, 30);
  assert.equal(fitting.meta.scale, 1);
  assert.equal(fitting.meta.width_pt, 113.3858);
  const meta = await require('sharp')(fitting.pngFirst).metadata();
  assert.equal(`${meta.width}x${meta.height}`, '320x240');
  // ⚠️ 但**页面内容 = 原构图本身**：①的 −90° 与 ③ 的 +90° **互相抵消**（恒等变换）
  const landscape0 = await render({ canvas: 'landscape', rotate: 0 });
  assert.deepEqual(fitting.pngFirst, landscape0.pngFirst,
    '`fitting` 与 `landscape+rotate:0` 必须逐像素相同 —— 这就是"框内 −90° + 页面 +90° = 恒等"的硬证据');
  assert.deepEqual(fitting.pdf, landscape0.pdf);
  // ⇒ 还原成纸（驱动 -90°）之后，品牌是**竖的**：与真机 A 完全一致（不是"方向 ✓"）
  const brand = await inkStats(await simulateCurrentDriver((await render({ canvas: 'fitting' }, { fields: { brand: true } })).pngFirst));
  assert.ok(brand.h > brand.w * 2,
    `fitting 的还原图里品牌必须是**竖的**（实际 ${brand.w}x${brand.h}）—— 也就是说它在纸上 = 真机 A（方向反）`);
});

test('AC-C8 ⭐ 几何证明（写死在断言里）：页面内容必须先转 ∓90° 才能印正 ⇒ 必然塞不进 40×30', async () => {
  // 证明链：① 打印机对整页做的是**等距变换**（文字没被镜像 ⇒ 是旋转）；
  //        ② 真机 A（页面=原构图）品牌 ⟂ 长边、B（页面=原构图转 90°）品牌 ∥ 长边
  //           ⇒ 标定出这个旋转 = **±90°**；
  //        ③ 要让**纸上是原构图**，页面内容就必须 = 原构图先转 **∓90°**；
  //        ④ 而"原构图转 ∓90°"在页面坐标系里是 **30 宽 × 40 高**（等距变换不改变矩形的宽高比，
  //           只是把它转了个方向）⇒ **塞不进 40 宽 × 30 高的页面**（只能等比缩到 73.5%）。
  const rotated = artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape', rotate: 90 });
  assert.equal(rotated.scale < 0.76, true, '横版转 90° 必须缩（这就是 73.5% 的来源）');
  // 换页面那档虽然 scale=1，但驱动对"形状与纸型不一致的页面"会**再转 90°**（真机 C 实测）
  const swapped = artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape', rotate: 90, rotatePageWithContent: true });
  assert.equal(swapped.scale, 1, '换页面那档确实 1:1');
  assert.equal(swapped.pageW, 30, '但它把页面换成了 30×40 —— 真机 C 实测：方向又反');
  // ⇒ 没有任何一档能同时做到"页面 40×30 + scale 1 + 纸上方向/构图正确"
  const combos = [
    artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape', rotate: 0 }),
    artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape', rotate: 90 }),
    artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape', rotate: 90, rotatePageWithContent: true }),
    artifact.canvasGeometry(LABEL_PRINT, { canvas: 'portrait' }),
    artifact.canvasGeometry(LABEL_PRINT, { canvas: 'fitting' }),
  ];
  const triple = combos.filter((geo) => geo.pageW === 40 && geo.pageH === 30 && geo.scale === 1 && geo.rotate === 90);
  assert.deepEqual(triple, [],
    '不存在"页面 40×30 + scale 1 + 内容已转 90°"的组合 —— 这就是几何上做不到的证明');
});

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

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 真机第三轮】她：「方向对了，但**沿长边没有居中**」
//   先量产物（横版 40×30、关裁切线）：**左右对称**（左 1.50 / 右 1.63mm，差 −0.13mm），
//   但**上下不对称**（上 1.63 / 下 5.88mm，差 −4.25mm）⇒ 给了内容平移旋钮（±5mm、0.5 步进）。
// ═══════════════════════════════════════════════════════════════════════════

/** 墨迹四边留白（mm）—— 关裁切线量"内容"本身。 */
const marginsOf = async (png) => {
  const sharp = require('sharp');
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width; let maxX = -1; let minY = info.height; let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] < 128) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const mm = 25.4 / 203;
  return {
    left: +(minX * mm).toFixed(2), right: +((info.width - 1 - maxX) * mm).toFixed(2),
    top: +(minY * mm).toFixed(2), bottom: +((info.height - 1 - maxY) * mm).toFixed(2),
    widthPx: info.width,
  };
};

const noBorderLayout = () => layout({ label: { borderMm: 0 } });
const renderNoBorder = (config) => artifact.renderLabels({
  labels: [label()], layout: noBorderLayout(), config: { dpi: 203, ...config },
});

test('AC-C9-1 ⭐⭐ 默认产物：内容盒**有意不对称**（左 3.5 / 右 1.5，她拍板方案①）—— 几何断言，与字体无关', () => {
  // 🔴🔴 **为什么不能断言"墨迹 bbox 左右对称"**（2026-10-12 PR #346 CI 红教的）：
  //   墨迹**右边缘**由"最宽的那一行"决定，而那是**文字** ⇒ 宽度随**环境字体**变：
  //     · 我本地（macOS）：左 1.50mm ／ 右 **1.63mm**；CI（Linux）：左 1.50mm ／ 右 **3.25mm** ❌
  //     · 机制自证：只把颜色「棕色」→「浅棕色」，右边距就从 1.63 → **3.13mm**（≈ CI 的 3.25）
  //   ⇒ 所以这里断言**布局几何**（渲染器算出来的设计值，**不经过任何字体度量/光栅化**）。
  //   ⚠️ 2026-10-12 她拍板方案①：**左留白 3.5 / 右留白 1.5 是有意的不对称**（要让二维码那边有空档），
  //      所以本用例**不再**断言"左右相等"——那条会和设计打架。恒等式才是真正的不变量。
  const geo = artifact.canvasGeometry(LABEL_PRINT, { canvas: 'landscape' });
  const left = artifact.resolveLeftPaddingMm(layout(), { leftPaddingMm: LABEL_PRINT_QUEUE.artifact.leftPaddingMm });
  const right = LABEL_PRINT.label.paddingMm;
  const cut = artifact.resolveCutLineMm(layout(), { cutLineMm: LABEL_PRINT_QUEUE.artifact.cutLineMm });
  const qrCol = artifact.resolveQrSizeMm(layout(), { qrSizeMm: LABEL_PRINT_QUEUE.artifact.qrSizeMm })
    + LABEL_PRINT.body.qrGapMm;
  const infoCol = artifact.availableWidthMm(layout(), {
    designWidthMm: geo.designW,
    leftPaddingMm: LABEL_PRINT_QUEUE.artifact.leftPaddingMm,
    qrSizeMm: LABEL_PRINT_QUEUE.artifact.qrSizeMm,
    cutLineMm: LABEL_PRINT_QUEUE.artifact.cutLineMm,
  });
  assert.equal(left, 3.5, '方案①：左留白 3.5mm（她拍板）');
  assert.equal(right, 1.5, '右留白仍是 paddingMm 1.5mm ⇒ **有意不对称**（不是 bug）');
  assert.equal(cut, 0, '裁切线默认 0（不画 —— 她说"上下有横杠"）');
  assert.equal(Number((left + cut + qrCol + infoCol + right + cut).toFixed(6)), geo.designW,
    `恒等式：左${left} + 线${cut} + 二维码列${qrCol} + 信息栏${infoCol} + 右${right} + 线${cut} = 页宽${geo.designW}`);
  assert.equal(infoCol, 20.5, '方案① 的信息栏 20.5mm（比现状 20.1mm 还宽 0.4mm —— 因为不画线又多让出 0.4）');
  // 品牌行：居中锚在**内容盒**中点（内容盒现在左边更宽 ⇒ 中点相对页面右移）
  const svg = artifact.labelSvg(label(), layout(), {
    dpi: 203,
    leftPaddingMm: LABEL_PRINT_QUEUE.artifact.leftPaddingMm,
    qrSizeMm: LABEL_PRINT_QUEUE.artifact.qrSizeMm,
    cutLineMm: LABEL_PRINT_QUEUE.artifact.cutLineMm,
  });
  const brand = /<text x="([\d.]+)" y="[\d.]+" font-family="[^"]*" font-size="[\d.]+" text-anchor="middle">邯美皮鞋</.exec(svg);
  assert.ok(brand, '品牌行要居中锚定');
  assert.equal(Number(brand[1]), Number((left + cut + (geo.designW - left - right - cut * 2) / 2).toFixed(2)),
    '品牌锚点 = 内容盒中点（内容盒左 3.7 / 右 1.5 ⇒ 中点 22.15，比页宽中点 20 右移 2.15mm）');
});

test('AC-C9-2 ⭐ `contentOffsetXMm=+1` ⇒ 内容整体右移 1mm（左留白 +1、右留白 −1）', async () => {
  const before = await marginsOf((await renderNoBorder({})).pngFirst);
  const after = await marginsOf((await renderNoBorder({ contentOffsetXMm: 1 })).pngFirst);
  assert.ok(Math.abs((after.left - before.left) - 1) <= 0.2,
    `左留白要 +1mm（${before.left} → ${after.left}）`);
  assert.ok(Math.abs((before.right - after.right) - 1) <= 0.2,
    `右留白要 −1mm（${before.right} → ${after.right}）`);
  // 竖向不许动
  assert.ok(Math.abs(after.top - before.top) <= 0.2 && Math.abs(after.bottom - before.bottom) <= 0.2,
    'X 平移不许影响上下留白');
  // Y 平移同理（把"上下不对称"调正的那一档）
  const yMoved = await marginsOf((await renderNoBorder({ contentOffsetYMm: 2 })).pngFirst);
  assert.ok(Math.abs((yMoved.top - before.top) - 2) <= 0.2, `上留白要 +2mm（${before.top} → ${yMoved.top}）`);
  assert.ok(Math.abs((yMoved.bottom - before.bottom) + 2) <= 0.3, `下留白要 −2mm（${before.bottom} → ${yMoved.bottom}）`);
});

test('AC-C9-3 ⭐ 非法/越界当场拒（指字段名）；env 解析同一套口径', () => {
  for (const value of [6, -5.5, 0.3, 'x']) {
    assert.throws(() => artifact.normalizeOffsetMm(value, 'contentOffsetXMm'), /contentOffsetXMm/,
      `${value} 必须被拒并指出字段名`);
  }
  assert.equal(artifact.normalizeOffsetMm(undefined), 0, '没设 = 0（默认不动）');
  assert.equal(artifact.normalizeOffsetMm(''), 0);
  assert.equal(artifact.normalizeOffsetMm(-5), -5);
  assert.equal(artifact.normalizeOffsetMm(1.5), 1.5);
  const { resolveLabelPrintQueueConfig } = require('../src/config/labelPrintQueue');
  assert.equal(resolveLabelPrintQueueConfig({}).artifact.contentOffsetXMm, 0);
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_CONTENT_OFFSET_Y_MM: '2' }).artifact.contentOffsetYMm, 2);
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_CONTENT_OFFSET_X_MM: '9' }),
    /LABEL_PRINT_CONTENT_OFFSET_X_MM/);
});

test('AC-C9-4 ⭐ 回归：默认偏移 0 ⇒ 产物与之前**逐字节一致**（不套多余的 <g>）', async () => {
  const svg = artifact.labelSvg(label(), layout(), { dpi: 203 });
  assert.equal(svg.includes('translate(0 0)'), false, '偏移 0 时不许出现多余的平移组');
  const base = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203 } });
  const alsoBase = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, contentOffsetXMm: 0, contentOffsetYMm: 0 },
  });
  assert.deepEqual(base.pdf, alsoBase.pdf, '显式写 0 与不写必须完全一样');
  // 横版转 90°（B 档）与换页面（C 档）的老行为不受影响
  const b = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203, rotate: 90 } });
  assert.ok(b.meta.scale > 0.72 && b.meta.scale < 0.76);
  const c = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, rotate: 90, rotatePageWithContent: true },
  });
  assert.equal(c.meta.width_pt, 85.0394);
  // 裁切线**不跟着内容走**（它是标签边界）
  // ⚠️ 2026-10-12 改：这里原来用 `contentOffsetXMm: 2`，现在 +2 已超过"不裁边的安全上限"
  //    （右移余量 = 右留白 1.5mm，见 AC-C12-1）⇒ 换成安全上限 1.5，意图（线不跟着走）不变。
  const moved = artifact.labelSvg(label(), layout(), { dpi: 203, contentOffsetXMm: 1.5 });
  assert.match(moved, /<rect x="0\.1" y="0\.1"/, '裁切线仍在纸边');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 她「再挪 2mm」】纯平移会裁到最宽那行 ⇒ 加"左留白可配"（左右独立）
//   恒等式（有 AC 钉着）：`左留白 + 二维码列 + 信息栏 + 右留白 = 页宽`（信息栏吃剩下的）
//   ⭐ 方案①：左留白 1.5→3.5 + 二维码 15→13 ⇒ **信息栏仍是 20.1mm、货号字号一点没变** ✓
// ═══════════════════════════════════════════════════════════════════════════

const infoColOf = (leftPaddingMm, qrSizeMm) => artifact.availableWidthMm(
  layout({ label: { ...LABEL_PRINT.label, leftPaddingMm }, typography: { ...LABEL_PRINT.typography, qrSizeMm } }),
  { designWidthMm: LABEL_PRINT.label.widthMm, leftPaddingMm },
);
const identityOf = (leftPaddingMm, qrSizeMm) => {
  const info = infoColOf(leftPaddingMm, qrSizeMm);
  const border = LABEL_PRINT.label.borderMm;
  return Number((leftPaddingMm + border + qrSizeMm + LABEL_PRINT.body.qrGapMm + info
    + LABEL_PRINT.label.paddingMm + border).toFixed(6));
};

test('AC-C10-1 ⭐⭐ 恒等式：`左留白 + 二维码列 + 信息栏 + 右留白 = 页宽`（精确，任何组合都成立）', () => {
  const pageW = LABEL_PRINT.label.widthMm;
  for (const [left, qr] of [[1.5, 15], [3.5, 13], [3.5, 15], [3.5, 12], [0, 15], [4, 14]]) {
    assert.equal(identityOf(left, qr), pageW, `左${left}/二维码${qr} 时恒等式必须精确成立`);
  }
});

test('AC-C10-2 ⭐⭐ 方案①（左留白 3.5 + 二维码 13）：**信息栏不变、货号字号不变**——"再挪 2mm"零代价', () => {
  const beforeInfo = infoColOf(1.5, 15);
  const afterInfo = infoColOf(3.5, 13);
  assert.equal(beforeInfo, 20.1, '现状信息栏 20.1mm');
  assert.equal(afterInfo, beforeInfo, '⭐ 方案① 的信息栏必须**与现状完全相同**（20.1mm）');
  // 货号那行（现在是"货号+颜色同行"）的规划字号也必须一样 ⇒ 她看到的字号不变
  const planOf = (left, qr) => artifact.planItemNoColor(label(), layout({
    label: { ...LABEL_PRINT.label, leftPaddingMm: left },
    typography: { ...LABEL_PRINT.typography, qrSizeMm: qr },
  }), { designWidthMm: LABEL_PRINT.label.widthMm, leftPaddingMm: left });
  const before = planOf(1.5, 15);
  const after = planOf(3.5, 13);
  assert.equal(after.itemNoSizeMm, before.itemNoSizeMm, '货号字号必须一点不变（不是"放宽"，是"没变"）');
  assert.equal(after.itemNoTruncated, false, '不许截断');
  assert.equal(after.soloItemNoSizeMm, before.soloItemNoSizeMm, '货号单独一行时的字号也不变');
});

test('AC-C10-3 ⭐ 方案②（左留白 3.5 + 二维码仍 15）的**代价如实**：信息栏窄 2mm ⇒ 同行字号变小', () => {
  const before = infoColOf(1.5, 15);
  const after = infoColOf(3.5, 15);
  assert.equal(Number((before - after).toFixed(6)), 2, '方案② 的信息栏正好窄 2mm');
  const planOf = (left, qr) => artifact.planItemNoColor(label(), layout({
    label: { ...LABEL_PRINT.label, leftPaddingMm: left },
    typography: { ...LABEL_PRINT.typography, qrSizeMm: qr },
  }), { designWidthMm: LABEL_PRINT.label.widthMm, leftPaddingMm: left });
  const a = planOf(1.5, 15);
  const b = planOf(3.5, 15);
  assert.ok(b.itemNoSizeMm < a.itemNoSizeMm,
    `方案② 的"货号+颜色同行"字号必须变小（${a.itemNoSizeMm} → ${b.itemNoSizeMm}）`);
  assert.equal(b.itemNoTruncated, false, '变小但不许截断');
  // 方案③（二维码缩到 12）：信息栏反而更宽 ⇒ 同行字号更大
  assert.ok(infoColOf(3.5, 12) > before);
});

test('AC-C10-4 ⭐ 左留白：默认 = 方案① 的 3.5（可显式设回 1.5 对称）；越界/非法当场拒；env 同口径', async () => {
  const base = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203 } });
  const same = await artifact.renderLabels({
    labels: [label()], layout: layout({ label: { ...LABEL_PRINT.label, leftPaddingMm: LABEL_PRINT.label.paddingMm } }),
    config: { dpi: 203 },
  });
  // ⚠️ 2026-10-12 改断言（**默认值从"对称"改成方案①的 3.5**）：
  //   改前：默认左留白 = paddingMm（左右相等）
  //   改后：默认左留白 = 3.5（她拍板方案①）；**显式**写 `leftPaddingMm: paddingMm` 时仍能与
  //         "对称"那条老口径逐字节对齐 —— 所以这里改成拿"显式 1.5"当基准来比。
  const symmetric = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, leftPaddingMm: LABEL_PRINT.label.paddingMm },
  });
  assert.deepEqual(symmetric.pdf, same.pdf, '显式 1.5 与"layout 里写 1.5"必须逐字节一致');
  assert.equal(symmetric.meta.left_padding_mm, LABEL_PRINT.label.paddingMm, '显式 1.5 ⇒ 左右相等（老口径仍可用）');
  const wider = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, leftPaddingMm: 3.5 },
  });
  assert.equal(wider.meta.left_padding_mm, 3.5);
  for (const value of [11, -1, 'x', 0.3]) {
    assert.throws(() => artifact.resolveLeftPaddingMm(layout(), { leftPaddingMm: value }), /左留白/,
      `${value} 必须被拒并指字段名`);
  }
  const { resolveLabelPrintQueueConfig } = require('../src/config/labelPrintQueue');
  // ⚠️ 2026-10-12 改：默认值从 `null`（对称）改成 **3.5**（她拍板方案①）
  assert.equal(resolveLabelPrintQueueConfig({}).artifact.leftPaddingMm, 3.5, '默认 3.5（方案①）');
  assert.equal(LABEL_PRINT_QUEUE.artifact.qrSizeMm, 13, '方案①：二维码默认 13mm（腾 2mm 给左留白）');
  assert.equal(LABEL_PRINT_QUEUE.artifact.cutLineMm, 0, '裁切线默认 0（不画）');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_LEFT_PADDING_MM: '3.5' }).artifact.leftPaddingMm, 3.5);
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_LEFT_PADDING_MM: '11' }), /LEFT_PADDING/);
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_LEFT_PADDING_MM: '0.3' }), /LEFT_PADDING/);
});

test('AC-C10-5 ⭐ 左留白 + 内容平移**同时用**也成立：几何恒等式 + 裁切线仍在纸边 + B/C 档回归', async () => {
  const out = await artifact.renderLabels({
    labels: [label()], layout: layout({ label: { ...LABEL_PRINT.label, leftPaddingMm: 3.5 } }),
    config: { dpi: 203, qrSizeMm: 13, leftPaddingMm: 3.5, contentOffsetXMm: 0.5 },
  });
  assert.equal(out.meta.left_padding_mm, 3.5);
  assert.equal(identityOf(3.5, 13), LABEL_PRINT.label.widthMm, '左留白 + 平移同时用，恒等式照样成立');
  const svg = artifact.labelSvg(label(), layout({ label: { ...LABEL_PRINT.label, leftPaddingMm: 3.5 } }),
    { dpi: 203, contentOffsetXMm: 0.5 });
  assert.match(svg, /<rect x="0\.1" y="0\.1"/, '裁切线仍在纸边（不跟着内容走）');
  const b = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203, rotate: 90 } });
  assert.ok(b.meta.scale > 0.72 && b.meta.scale < 0.76, 'B 档缩放不变');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 她："打印时上下会有横杠"】= 我们画的那圈裁切线（成卷标签上像横杠）
//   ⇒ 默认 `cutLineMm: 0`（不画）；能力保留（设成正数画回来）
//   ⚠️ 断言用**像素扫描**（页边 1mm 带里有没有"横贯整页的实线"），不是只看配置值 ✓
// ═══════════════════════════════════════════════════════════════════════════

/** 页边 1mm 带里"横贯整页的实线"统计（行 = 横杠，列 = 竖杠）。 */
const edgeLineScan = async (png) => {
  const sharp = require('sharp');
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const band = Math.max(1, Math.round(info.width / 40)); // 1mm ≈ 8px
  const rowDark = (y) => { let n = 0; for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x] < 128) n += 1; return n; };
  const colDark = (x) => { let n = 0; for (let y = 0; y < info.height; y += 1) if (data[y * info.width + x] < 128) n += 1; return n; };
  const horizontalLines = [];
  for (let y = 0; y < band; y += 1) if (rowDark(y) >= info.width * 0.8) horizontalLines.push({ y, side: 'top' });
  for (let y = info.height - band; y < info.height; y += 1) if (rowDark(y) >= info.width * 0.8) horizontalLines.push({ y, side: 'bottom' });
  const verticalLines = [];
  for (let x = 0; x < band; x += 1) if (colDark(x) >= info.height * 0.8) verticalLines.push({ x, side: 'left' });
  for (let x = info.width - band; x < info.width; x += 1) if (colDark(x) >= info.height * 0.8) verticalLines.push({ x, side: 'right' });
  return { horizontalLines, verticalLines, widthPx: info.width, heightPx: info.height };
};

test('AC-C11-1 ⭐⭐ 默认产物在**页边 1mm 带里没有横杠/竖杠**（像素扫描，不是看配置）', async () => {
  // ⚠️ 必须带上**队列 artifact 的默认值**（生产就是这条路：`queueService` 拿 `LABEL_PRINT_QUEUE.artifact` 渲染）
  const out = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, ...LABEL_PRINT_QUEUE.artifact },
  });
  const scan = await edgeLineScan(out.pngFirst);
  assert.deepEqual(scan.horizontalLines, [], `上下 1mm 带里不许有横贯整页的实线（扫到 ${JSON.stringify(scan.horizontalLines)}）`);
  assert.deepEqual(scan.verticalLines, [], `左右 1mm 带里也不许有竖线（扫到 ${JSON.stringify(scan.verticalLines)}）`);
  // A4 表那两条老路（转 90 / 换页面）也扫一遍
  for (const cfg of [{ rotate: 90 }, { rotate: 90, rotatePageWithContent: true }]) {
    const b = await artifact.renderLabels({
      labels: [label()], layout: layout(), config: { dpi: 203, ...LABEL_PRINT_QUEUE.artifact, ...cfg },
    });
    const s2 = await edgeLineScan(b.pngFirst);
    assert.deepEqual(s2.horizontalLines, [], `${JSON.stringify(cfg)} 也不许有横杠`);
  }
});

test('AC-C11-2 ⭐ 能力保留：显式 `cutLineMm: 0.2` ⇒ 那条线**回来了**（有人要用它做裁切定位）', async () => {
  const on = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, ...LABEL_PRINT_QUEUE.artifact, cutLineMm: 0.2 },
  });
  const scan = await edgeLineScan(on.pngFirst);
  assert.ok(scan.horizontalLines.length >= 1, '显式开线时要扫得到横线（否则这个开关就是假的）');
  assert.ok(scan.verticalLines.length >= 1, '竖线同理');
  assert.equal(on.meta.cut_line_mm, 0.2);
  // 非法/越界 ⇒ 拒
  assert.throws(() => artifact.resolveCutLineMm(layout(), { cutLineMm: 2 }), /裁切线/);
  assert.throws(() => artifact.resolveCutLineMm(layout(), { cutLineMm: 'x' }), /裁切线/);
  assert.equal(artifact.resolveCutLineMm(layout(), { cutLineMm: 0 }), 0, '0 = 明确不画');
  assert.equal(artifact.resolveCutLineMm(layout(), {}), LABEL_PRINT.label.borderMm, '不传 = 用 layout 的老值（兼容）');
});

test('AC-C11-3 ⭐ 方案①的成品数字（她先看样张再打纸）：左 3.5 / 二维码 13 / 信息栏 20.5 / 无线', async () => {
  const out = await artifact.renderLabels({
    labels: [label()], layout: layout(), config: { dpi: 203, ...LABEL_PRINT_QUEUE.artifact },
  });
  assert.equal(out.meta.left_padding_mm, 3.5);
  assert.equal(out.meta.qr_size_mm, 13);
  assert.equal(out.meta.cut_line_mm, 0);
  assert.equal(out.meta.width_mm, 40, '页面仍是 40×30（驱动纸型不变）');
  assert.equal(out.meta.width_pt, 113.3858);
  // 二维码仍然是**正方形、13mm**（真二维码那条 AC 覆盖 15mm，这里补 13mm 的尺寸）
  const sharp = require('sharp');
  const qrOnly = await artifact.renderLabels({
    labels: [label()],
    layout: layout({ label: { borderMm: 0 },
      fields: { qr: true, brand: false, itemNo: false, color: false, category: false, size: false, price: false, state: false, footer: false } }),
    config: { dpi: 203, leftPaddingMm: 3.5, qrSizeMm: 13, cutLineMm: 0 },
  });
  assert.equal(out.meta.height_mm, 30);
  const meta = await sharp(qrOnly.pngFirst).metadata();
  assert.equal(meta.width, 320);
  const stats = await (async () => {
    const { data, info } = await sharp(qrOnly.pngFirst).greyscale().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width; let maxX = -1; let minY = info.height; let maxY = -1;
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x] < 128) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, left: +(minX * 25.4 / 203).toFixed(2) };
  })();
  assert.ok(Math.abs(stats.w - stats.h) <= 2, `二维码仍是正方形（${stats.w}x${stats.h}）`);
  assert.ok(Math.abs(stats.w - Math.round((13 / 25.4) * 203)) <= 3, `二维码 13mm ≈ 104px（实际 ${stats.w}px）`);
  assert.ok(Math.abs(stats.left - 3.5) <= 0.2, `二维码左边距 = 左留白 3.5mm（实际 ${stats.left}mm）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 她/Lead 点透的原理】缩二维码 = 腾空间；**整幅右移 = 把品牌挪到纸中间**
//   ⇒ 右移的安全余量 = **右留白**（最宽那行的右边缘 = 页宽 − 右留白）；左移 = 左留白
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C12-1 ⭐⭐ 安全上限：右移余量 = 右留白（1.5mm）、左移余量 = 左留白（3.5mm）；超过就拒', () => {
  const layout35 = layout({ label: { ...LABEL_PRINT.label, leftPaddingMm: 3.5 } });
  const opts = { leftPaddingMm: 3.5 };
  assert.deepEqual(artifact.maxSafeOffsetXMm(layout35, opts), { right: 1.5, left: 3.5 },
    '⚠️ 关键数字：右移最多 1.5mm（= 右留白）—— 所以 +2.0mm 是**不安全**的');
  for (const value of [0, 0.5, 1, 1.5, -1, -3.5]) {
    assert.doesNotThrow(() => artifact.assertSafeOffsetXMm(value, layout35, opts), `偏移 ${value} 应放行`);
  }
  assert.throws(() => artifact.assertSafeOffsetXMm(2, layout35, opts), /contentOffsetXMm.*1\.5/,
    '+2.0 必须被拒（会把最宽的货号行裁到纸外）并指出上限');
  assert.throws(() => artifact.assertSafeOffsetXMm(-4, layout35, opts), /contentOffsetXMm.*3\.5/,
    '-4.0 必须被拒（二维码会贴到纸边）');
  // 渲染入口也要拦住（不只是 helper）
  assert.throws(() => artifact.labelSvg(label(), layout35, { dpi: 203, contentOffsetXMm: 2 }), /contentOffsetXMm/);
});

test('AC-C12-2 ⭐⭐ 三档偏移下"品牌中心相对页面中心"的位移（与字体无关的几何）', () => {
  const layout35 = layout({ label: { ...LABEL_PRINT.label, leftPaddingMm: 3.5 } });
  const opts = { leftPaddingMm: 3.5 };
  const pageCenter = LABEL_PRINT.label.widthMm / 2; // 20
  const brandCenterOf = (offset) => {
    const svg = artifact.labelSvg(label(), layout35, { dpi: 203, contentOffsetXMm: offset });
    const hit = /<text x="([\d.]+)" y="[\d.]+" font-family="[^"]*" font-size="[\d.]+" text-anchor="middle">邯美皮鞋</.exec(svg);
    // 整体平移组里带着 `translate(<offset> 0)` ⇒ 品牌锚点本身不变、实际位置 = 锚点 + 偏移
    const shifted = /translate\(([-\d.]+) 0\)/.exec(svg);
    return Number(hit[1]) + (shifted ? Number(shifted[1]) : 0);
  };
  assert.equal(brandCenterOf(0), 21, '偏移 0：品牌中心 21mm（内容盒中点）= 比页面中心右 1.0mm');
  assert.equal(brandCenterOf(1), 22, '偏移 +1：品牌中心 22mm = 比页面中心右 2.0mm');
  assert.equal(brandCenterOf(1.5), 22.5, '偏移 +1.5（安全上限）：品牌中心 22.5mm = 右 2.5mm');
  for (const [offset, expected] of [[0, 1], [1, 2], [1.5, 2.5]]) {
    assert.equal(Number((brandCenterOf(offset) - pageCenter).toFixed(2)), expected,
      `偏移 ${offset} ⇒ 品牌中心相对页面中心右移 ${expected}mm`);
    // 最宽那一行的右边余量 = 右留白 − 偏移（≥0 才不裁边）
    assert.ok(Number((1.5 - offset).toFixed(2)) >= 0, `偏移 ${offset} 的右边余量必须 ≥0`);
  }
});
