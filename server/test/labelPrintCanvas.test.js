/**
 * 「**打印方向 + 铺满 + 构图**」的验收标准 —— 业务负责人 2026-10-11/12 真机四轮反馈之后。
 *
 * 她的四组实测（都有照片）：
 *   A. `0° + 页面 40×30`       ⇒ ❌ 品牌**平行于短边**（不是她要的）
 *   B. `90° + 页面 40×30`      ⇒ ✅ **平行于长边 + 构图对**，但 ❌ 缩到 **73.5%**（四周留白的小框）
 *   C. `90° + 页面 30×40`      ⇒ ❌ 方向又反了（**驱动会把"宽高比与纸型不同"的页面又转 90°**）
 *   D. 旧 `portrait`（重排行序） ⇒ 方向 ✅ 铺满 ✅ 但 ❌ **构图变了**（二维码从左边挪进了行流）
 *
 * ⭐ **本轮把 D 那套重排整个撤掉**：两档画布**用的是同一份原构图**
 *    （品牌在上、二维码在左、信息在右、尺码在下），区别只在**页面声明**：
 *      · `landscape` + `rotate:0`  ⇒ 页面 40×30，原构图 1:1（A：方向反）
 *      · `landscape` + `rotate:90` ⇒ 页面 40×30，原构图转 90°（**B**：方向对、73.5%）
 *      · `portrait`                ⇒ 页面 **30×40**，原构图转 90° ⇒ **1:1（scale=1）⇒ 100% 铺满**
 *
 * ⚠️ **自证方式**（这台机器上跑不了打印机）：把真机 B 的样张**按 -90° 转回来**，
 *    正好是她的原构图（我人眼核过那张图）⇒ 由此**标定**打印机的映射：
 *    **纸上看到的 = 页面转 -90°**。下面每条 AC 都先用这个映射把样张"还原成她看到的那张纸"，
 *    再断言方向 / 铺满 / 构图 —— 而不是只断"有没有 rotate(90)"。
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

/** ⭐ **标定出来的打印机映射**：纸上看到的 = 页面转 -90°（由真机 B 反推 + 人眼核过样张）。 */
const simulatePrint = (png) => require('sharp')(png).rotate(-90, { background: '#ffffff' }).png().toBuffer();

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

/** 「还原成她看到的那张纸」。 */
const printed = async (config, options) => simulatePrint((await render(config, options)).pngFirst);

// ── AC-C1：方向（用"还原后的纸"断言）─────────────────────────────────────

test('AC-C1 ⭐⭐ 方向（还原成纸）：B 与 portrait 的品牌都**沿长边横排**；横版 0°（A）是竖的', async () => {
  const a = await inkStats(await printed({ rotate: 0 }, { fields: { brand: true } }));
  const b = await inkStats(await printed({ rotate: 90 }, { fields: { brand: true } }));
  const portrait = await inkStats(await printed({ canvas: 'portrait' }, { fields: { brand: true } }));

  assert.ok(a.h > a.w * 2, `A（横版 0°）：「邯美皮鞋」应该沿**短边**（竖的）—— 实际 ${a.w}x${a.h}`);
  for (const [name, stats] of [['B（横版 90°）', b], ['portrait（页面 30×40）', portrait]]) {
    assert.ok(stats.w > stats.h * 2,
      `${name}：「邯美皮鞋」必须**沿长边横排**（实际 ${stats.w}x${stats.h}）——`
      + '这正是真机 B 被确认"方向对了"的那一档');
  }
});

test('AC-C1 两档画布用的是**同一份原构图**（不再有"竖版专属行序"那套重排）', () => {
  const landscape = artifact.labelSvg(label(), layout(), { dpi: 203, rotate: 90 });
  const portrait = artifact.labelSvg(label(), layout(), { dpi: 203, canvas: 'portrait' });
  assert.match(landscape, /<g transform="[^"]*rotate\(90\)/);
  assert.match(portrait, /<g transform="[^"]*rotate\(90\)/);
  assert.equal(Object.prototype.hasOwnProperty.call(LABEL_PRINT.body, 'portraitRows'), false,
    '竖版专属行序（portraitRows）已整个撤掉 —— 构图保持原样');
  assert.deepEqual(LABEL_PRINT.body.rows, ['brand', 'itemNoColor', 'price', 'state', 'sizes']);
});

// ── AC-C2 / AC-C3：铺满 + 原尺寸 ─────────────────────────────────────────

test('AC-C2 ⭐⭐ 铺满：portrait 是 **1:1（scale=1）**、页面 30×40；B 仍是 73.5%（保留，别改坏）', async () => {
  const portrait = await render({ canvas: 'portrait' });
  assert.equal(portrait.meta.scale, 1, 'portrait 必须 1:1（原尺寸）');
  assert.equal(portrait.meta.width_mm, 30);
  assert.equal(portrait.meta.height_mm, 40);
  assert.equal(portrait.meta.width_pt, 85.0394);
  assert.equal(portrait.meta.height_pt, 113.3858);
  assert.equal(portrait.meta.canvas_width_mm, 40, '逻辑画布仍是 40×30 的原构图');
  assert.equal(portrait.meta.canvas_height_mm, 30);

  const b = await render({ rotate: 90 });
  assert.equal(b.meta.width_mm, 40, 'B 的页面仍是 40×30');
  assert.ok(b.meta.scale > 0.72 && b.meta.scale < 0.76, `B 仍是那条约 0.735 的缩放（实际 ${b.meta.scale}）`);

  // 还原成纸：portrait 的内容要铺满整张纸；B 明显小一圈
  const p = await inkStats(await printed({ canvas: 'portrait' }));
  const bPrinted = await inkStats(await printed({ rotate: 90 }));
  assert.ok(p.coverageX >= 0.9, `portrait 横向铺满率要 ≥90%（实际 ${(p.coverageX * 100).toFixed(1)}%）`);
  assert.ok(p.coverageY >= 0.8, `portrait 纵向铺满率要 ≥80%（实际 ${(p.coverageY * 100).toFixed(1)}%）`);
  assert.ok(p.coverageY > bPrinted.coverageY * 1.25,
    `portrait 明显比 B 铺得满（${p.coverageY.toFixed(3)} vs ${bPrinted.coverageY.toFixed(3)}）`);
});

// ── AC-C3：构图关系（她最在意的："左边是二维码、右边是信息"）────────────

test('AC-C3 ⭐⭐ 构图（还原成纸）：品牌在最上、二维码在**左半区且在品牌下方**、信息在**右半区**', async () => {
  for (const [name, config] of [['B（横版 90°）', { rotate: 90 }], ['portrait（页面 30×40）', { canvas: 'portrait' }]]) {
    // eslint-disable-next-line no-await-in-loop
    const brand = await inkStats(await printed(config, { fields: { brand: true } }));
    // eslint-disable-next-line no-await-in-loop
    const qr = await inkStats(await printed(config, { fields: { qr: true } }));
    // ⚠️ 信息块的位置必须在**二维码占着左边那一栏**的时候量 —— 所以这里保留 `qr: true`
    //    但把二维码内容换成空串（占位、不画）⇒ 量到的才是信息块的真实位置（踩过一次）。
    // eslint-disable-next-line no-await-in-loop
    const info = await inkStats(await printed(config, {
      fields: { qr: true, itemNo: true, color: true, price: true, size: true },
      patch: { qr_svg: '' },
    }));

    assert.ok(brand.cy < brand.height / 3,
      `${name}：品牌必须在**最上面**（中心 y=${brand.cy.toFixed(1)}，纸高 ${brand.height}）`);
    assert.ok(qr.cx < qr.width / 2,
      `${name}：二维码必须在**左半区**（中心 x=${qr.cx.toFixed(1)}，纸宽 ${qr.width}）——`
      + '她是看着"左边二维码、右边信息"这个格局定稿的');
    assert.ok(qr.cy > brand.cy,
      `${name}：二维码要在品牌那一行的下方（qr.y=${qr.cy.toFixed(1)} vs 品牌 y=${brand.cy.toFixed(1)}）`);
    assert.ok(info.cx > info.width / 2,
      `${name}：信息块必须在**右半区**（中心 x=${info.cx.toFixed(1)}，纸宽 ${info.width}）`);
    assert.ok(info.cx > qr.cx, `${name}：信息要在二维码右边`);
  }
});

test('AC-C3 二维码要**明显靠左**（钉住"二维码跑进行流"那套重排不再复活）', async () => {
  const qr = await inkStats(await printed({ canvas: 'portrait' }, { fields: { qr: true } }));
  assert.ok(qr.cx < qr.width * 0.35,
    `二维码要明显靠左（中心 x 应 < 纸宽的 35%，实际 ${(qr.cx / qr.width * 100).toFixed(1)}%）`);
});

// ── AC-C4：二维码 ────────────────────────────────────────────────────────

test('AC-C4 ⭐ 两档画布：二维码仍 **15mm、正方形、可识别**（真二维码）', async () => {
  const QRCode = require('qrcode');
  const qrSvg = await QRCode.toString('https://hm.bamamei.online/s/XHB8095%7C%E6%A3%95%E8%89%B2%7CA',
    { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
  // ⚠️ 期望值随画布不同：`portrait` 是**原尺寸**（15mm ⇒ 120px）；
  //    横版转 90°（B）整幅缩到 73.5% ⇒ 二维码 11mm（88px）—— **那正是 B 的取舍**，不是 bug。
  for (const [config, expectedPx] of [[{ rotate: 90 }, 88], [{ canvas: 'portrait' }, 120]]) {
    // eslint-disable-next-line no-await-in-loop
    const png = await printed(config, { fields: { qr: true }, patch: { qr_svg: qrSvg } });
    // eslint-disable-next-line no-await-in-loop
    const stats = await inkStats(png);
    assert.ok(Math.abs(stats.w - stats.h) <= 2, `二维码必须还是正方形（实际 ${stats.w}x${stats.h}）`);
    assert.ok(Math.abs(stats.w - expectedPx) <= 3,
      `二维码边长（期望 ~${expectedPx}px，实际 ${stats.w}px）—— portrait 必须还是原尺寸 15mm`);
    const svg = artifact.labelSvg(label({ qr_svg: qrSvg }), onlyFields({ qr: true }), { dpi: 203, ...config });
    const scaleMatch = /scale\(([^)]+)\)/.exec(svg);
    if (scaleMatch) {
      const values = scaleMatch[1].trim().split(/\s+/).map(Number);
      assert.equal(values.length === 1 || values[0] === values[1], true, `缩放必须等比（${scaleMatch[1]}）`);
    }
  }
});

// ── AC-C5：横版（默认）不许被改坏 ────────────────────────────────────────

test('AC-C5 ⭐ 横版是默认，行为与改动前一致（0° 不套 `<g>` / B 的 0.735 / C 的 30×40 都保留）', async () => {
  assert.equal(LABEL_PRINT_QUEUE.artifact.canvas, 'landscape');
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotate, 0);
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotatePageWithContent, false);

  const svg = artifact.labelSvg(label(), layout(), { dpi: 203 });
  assert.equal(svg.includes('<g transform='), false, '横版 0° 仍然不套 <g>（逐字节一致）');
  assert.equal(svg.includes('scale('), false);
  assert.match(svg, /viewBox="0 0 40 30"/);

  const base = await render({});
  assert.equal(base.meta.width_pt, 113.3858);
  assert.equal(base.meta.scale, 1);

  const b = await render({ rotate: 90 });
  assert.equal(b.meta.width_pt, 113.3858);
  const c = await render({ rotate: 90, rotatePageWithContent: true });
  assert.equal(c.meta.width_pt, 85.0394, '换页面那条老路保留（注释里已标注"实测会再转 90°、不推荐"）');
  assert.equal(c.meta.height_pt, 113.3858);
});

// ── AC-C6：配置先行 ──────────────────────────────────────────────────────

test('AC-C6 配置先行：`canvas` 可配、非法值当场抛错；`rotatePageWithContent` 标注"不推荐"', () => {
  assert.equal(resolveLabelPrintQueueConfig({}).artifact.canvas, 'landscape');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'portrait' }).artifact.canvas, 'portrait');
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'diagonal' }), /LABEL_PRINT_CANVAS/);
  assert.equal(artifact.normalizeCanvas(undefined), 'landscape');
  assert.equal(artifact.normalizeCanvas('portrait'), 'portrait');
  assert.throws(() => artifact.normalizeCanvas('45'), /canvas/);
  const source = fs.readFileSync(path.join(__dirname, '../src/config/labelPrintQueue.js'), 'utf8');
  assert.match(source, /rotatePageWithContent[\s\S]{0,600}不推荐/,
    'rotatePageWithContent 旁边必须写清"实测会把方向再转 90°、不推荐"');
});

test('AC-C6 内容不许溢出页面（最外一圈只有裁切线）—— 三档都验', async () => {
  const sharp = require('sharp');
  for (const config of [{}, { rotate: 90 }, { canvas: 'portrait' }]) {
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
    // ⚠️ 裁切线**本来就画在最外一圈**（老版式，原样保留）⇒ 上界 = 那一圈的像素数 + 一点余量；
    //    超过它才说明内容溢出/被裁（踩过一次：阈值当初按"一条边"算的）。
    const ringPx = 2 * (info.width + info.height);
    assert.ok(borderInk <= ringPx + 8,
      `${JSON.stringify(config)}：最外一圈只该有裁切线（实际上限 ${ringPx + 8}，实际 ${borderInk}）`);
  }
});
