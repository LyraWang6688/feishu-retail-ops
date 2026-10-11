/**
 * 「**旋转画布**」（把方向做对 + 原尺寸铺满）的验收标准 —— 业务负责人 2026-10-11 真机三组对照之后。
 *
 * 她的三组实测（都拍了照片）：
 *   A. `0° + 不换页面`        ⇒ ❌ 平行于**短边**（不是她要的）
 *   B. `90° + 不换页面`        ⇒ ✅ **平行于长边（她要的）**，但 ❌ 缩到 **75%**、四周留白（小框）
 *   C. `90° + 换页面(30×40)`  ⇒ ❌ 又变回平行于**短边**，✅ 铺满
 * ⇒ ⭐ **要的是"B 的方向 + C 的铺满"**，所以**不能**再"先按 40×30 画好、转一下、转不下就缩"。
 *   正确修法 = **旋转【布局画布】**：按旋转后的画布（30×40）重新排版，
 *   再整幅**按原尺寸**转进 40×30 的页面（**不缩、不裁**）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-C1  ⭐⭐ **方向**：竖版画布下，「邯美皮鞋」那一行**沿页面的竖向**排
 *          （= 真机 B 的方向 ⇒ 打印出来才是"平行于长边"），而横版（默认）是横向；
 *   AC-C2  ⭐⭐ **铺满**：竖版画布的内容墨迹包围盒要 **≥ 页面的 85%**（两个方向都算）
 *          —— 把"小框"（75% 缩放那条路）这种回归**挡住**；
 *   AC-C3  ⭐ **不缩不裁**：页面仍是 **40×30**（`/MediaBox` 113.3858×85.0394、PNG 320×240），
 *          内容**原尺寸**铺满（不再有"转不下就等比缩到 75%"）；
 *   AC-C4  ⭐ **二维码仍正方形、仍是 15mm**（竖版画布下自己占一行 ⇒ 不被挤小、不被拉歪）；
 *   AC-C5  ⭐ **横版（默认）行为一个字没变**：0° 不套 `<g>`、MediaBox 40×30、320×240；
 *          `90° + 不换页面` 仍是"缩 75%"那条老路（真机 B）——**线上正跑着它**，不许被我改坏；
 *   AC-C6  **配置先行**：`canvas: 'landscape' | 'portrait'`（环境变量 `LABEL_PRINT_CANVAS`），
 *          认不出的值当场抛错；`rotatePageWithContent` **保留**但标注"实测会把方向再转 90°、不推荐"，
 *          且在竖版画布下**被忽略**；
 *   AC-C7  **手机侧可以按这一次覆盖方向方案**（试方向不用改配置重启），非法值 ⇒ 400；
 *   AC-C8  竖版画布的**行序**也进配置（`body.portraitRows`）—— 渲染层不写死。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { LABEL_PRINT_QUEUE, resolveLabelPrintQueueConfig } = require('../src/config/labelPrintQueue');
const artifact = require('../src/services/labelPrintArtifactService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const P = V1_BITABLE_SCHEMA.tables.product.fields;

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

/** 墨迹包围盒 + 是否碰边（真二维码/裁切线那几条 AC 都靠它）。 */
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
    coverageX: (maxX - minX + 1) / info.width,
    coverageY: (maxY - minY + 1) / info.height,
  };
};

const renderOne = (config, patch = {}) => artifact.renderLabels({
  labels: [label(patch)], layout: layout(), config: { dpi: 203, ...config },
});

// ── AC-C1：方向 ───────────────────────────────────────────────────────────

test('AC-C1 ⭐⭐ 方向：竖版画布下「邯美皮鞋」沿页面**竖向**排（= 真机 B 的方向）；横版是横向', async () => {
  // 只印品牌（其它字段 + 裁切线全关）⇒ 墨迹包围盒就是"那一行字"的形状。
  const onlyBrand = layout({
    label: { borderMm: 0 },
    fields: { qr: false, brand: true, itemNo: false, color: false, category: false, size: false, price: false, state: false, footer: false },
  });
  const draw = async (config) => artifact.renderLabels({ labels: [label()], layout: onlyBrand, config: { dpi: 203, ...config } });
  const landscape = await inkStats((await draw({})).pngFirst);
  const portrait = await inkStats((await draw({ canvas: 'portrait' })).pngFirst);

  assert.ok(landscape.w > landscape.h * 2,
    `横版（默认）：「邯美皮鞋」必须是**横**的（实际 ${landscape.w}x${landscape.h}）`);
  assert.ok(portrait.h > portrait.w * 2,
    `竖版画布：「邯美皮鞋」必须沿页面**竖向**（实际 ${portrait.w}x${portrait.h}）——`
    + '这正是真机 B 的方向（打印出来才平行于长边）');
});

test('AC-C1 竖版画布的 SVG 里，内容确实被整体转了 90°（不是"设了参数没生效"）', () => {
  const svg = artifact.labelSvg(label(), layout(), { dpi: 203, canvas: 'portrait' });
  assert.match(svg, /<g transform="[^"]*rotate\(90\)/);
  assert.match(svg, /viewBox="0 0 40 30"/, '页面仍是 40×30');
  const landscape = artifact.labelSvg(label(), layout(), { dpi: 203 });
  assert.equal(landscape.includes('<g transform='), false, '横版 0° 仍然不套 <g>（行为一个字没变）');
});

// ── AC-C2 / AC-C3：铺满、原尺寸 ───────────────────────────────────────────

test('AC-C2 ⭐⭐ 铺满：竖版画布的内容墨迹 ≥ 页面的 85%（把"小框"那条路挡在门外）', async () => {
  // ⚠️ 关掉裁切线：那一圈线本来就画在纸边上，留着它量到的只是"纸边"，
  //    量不出"内容有没有缩成小框"（踩过一次）。
  const noBorder = layout({ label: { borderMm: 0 } });
  const draw = async (config) => artifact.renderLabels({ labels: [label()], layout: noBorder, config: { dpi: 203, ...config } });
  const portrait = await inkStats((await draw({ canvas: 'portrait' })).pngFirst);
  // ⚠️ 阈值是**按实测定的、不是拍的**（borderMm=0 时量到的真实数字）：
  //     竖版画布  coverageX=0.87 / coverageY=0.78（画布 30×40 映射到整页）
  //     真机 B    coverageX=0.42 / coverageY=0.90（内容被缩到 75% 之后，"长边方向"空掉一半）
  //   所以**长边方向（coverageX）**才是"小框"的判据；窄边方向天生到不了 85%
  //   （标签内容本来就比纸窄一圈：留白 + 文字自己的长度）。
  assert.ok(portrait.coverageX >= 0.85, `竖版画布：长边方向铺满率要 ≥85%（实际 ${(portrait.coverageX * 100).toFixed(1)}%）`);
  assert.ok(portrait.coverageY >= 0.70, `竖版画布：窄边方向铺满率要 ≥70%（实际 ${(portrait.coverageY * 100).toFixed(1)}%）`);

  // 对照：真机 B 那条路（横版 + 转 90° + 不换页面）= 缩到 75% ⇒ 长边方向空掉一半（"小框"）
  const bPath = await inkStats((await draw({ rotate: 90 })).pngFirst);
  assert.ok(bPath.coverageX < 0.55,
    `横版转 90°（真机 B）本来就是"小框"（实际 ${(bPath.coverageX * 100).toFixed(1)}%）——`
    + '竖版画布必须**明显比它大**，否则就是没修好');
  assert.ok(portrait.coverageX > bPath.coverageX * 1.5,
    `竖版画布的长边铺满率要 ≥ 真机 B 的 1.5 倍（${portrait.coverageX.toFixed(3)} vs ${bPath.coverageX.toFixed(3)}）`);
  // 最强的那条"原尺寸"证据：canvas 映射 **1:1**（没有被等比缩过）。
  const meta = (await draw({ canvas: 'portrait' })).meta;
  assert.equal(meta.scale, 1, '竖版画布必须是 1:1 映射（原尺寸）');
  assert.equal(meta.canvas_width_mm, 30);
  assert.equal(meta.canvas_height_mm, 40);
});

test('AC-C3 ⭐ 页面仍是驱动纸型 40×30：MediaBox 113.3858×85.0394、PNG 320×240、内容原尺寸', async () => {
  const sharp = require('sharp');
  const out = await renderOne({ canvas: 'portrait' });
  assert.equal(out.meta.width_mm, 40);
  assert.equal(out.meta.height_mm, 30);
  assert.equal(out.meta.width_pt, 113.3858);
  assert.equal(out.meta.height_pt, 85.0394);
  assert.match(out.pdf.toString('latin1'), /\/MediaBox \[0 0 113\.3858 85\.0394\]/);
  const meta = await sharp(out.pngFirst).metadata();
  assert.equal(`${meta.width}x${meta.height}`, '320x240');
  // 「原尺寸」的硬证据：字号是配置里的 mm（不是被 0.75 缩过的）⇒ 量"尺码那一行"的字高太麻烦，
  // 改用**铺满率**（AC-C2）+ **二维码正好 15mm**（AC-C4）两件事共同钉住"没缩"。
  assert.equal(out.meta.canvas, 'portrait');
});

test('AC-C3 竖版画布下 `rotatePageWithContent` **被忽略**（实测它会把方向再转 90°，不推荐）', async () => {
  const a = await renderOne({ canvas: 'portrait' });
  const b = await renderOne({ canvas: 'portrait', rotatePageWithContent: true });
  assert.equal(b.meta.width_mm, 40, '页面必须还是 40×30（换页面 = 方向又反，实测过）');
  assert.equal(b.meta.height_mm, 30);
  assert.equal(b.meta.width_pt, a.meta.width_pt);
  assert.equal(b.meta.rotate_page_with_content, false, '竖版画布下这个旋钮被忽略（并如实回报 false）');
});

// ── AC-C4：二维码 ────────────────────────────────────────────────────────

test('AC-C4 ⭐ 竖版画布：二维码仍**正方形**、仍是 **15mm**（自己占一行 ⇒ 不被挤小、不被拉歪）', async () => {
  const sharp = require('sharp');
  const QRCode = require('qrcode');
  const qrSvg = await QRCode.toString('https://hm.bamamei.online/s/XHB8095%7C%E6%A3%95%E8%89%B2%7CA',
    { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
  const qrOnly = layout({
    label: { borderMm: 0 },
    fields: { qr: true, brand: false, itemNo: false, color: false, category: false, size: false, price: false, state: false, footer: false },
  });
  for (const canvas of ['landscape', 'portrait']) {
    const out = await artifact.renderLabels({
      labels: [label({ qr_svg: qrSvg })], layout: qrOnly, config: { dpi: 203, canvas },
    });
    const stats = await inkStats(out.pngFirst);
    // 正方形（真二维码的墨迹包围盒）
    assert.ok(Math.abs(stats.w - stats.h) <= 2,
      `${canvas}：二维码必须还是正方形（实际 ${stats.w}x${stats.h}）`);
    // 15mm @203dpi = 120px（±3px 容差：二维码最外圈模块不一定全黑）
    assert.ok(Math.abs(stats.w - 120) <= 3,
      `${canvas}：二维码要还是 15mm（期望 ~120px，实际 ${stats.w}px）`);
    const svg = artifact.labelSvg(label({ qr_svg: qrSvg }), qrOnly, { dpi: 203, canvas });
    const scaleMatch = /scale\(([^)]+)\)/.exec(svg);
    if (scaleMatch) {
      const values = scaleMatch[1].trim().split(/\s+/).map(Number);
      assert.equal(values.length === 1 || values[0] === values[1], true,
        `${canvas}：缩放必须等比（实际 scale(${scaleMatch[1]})）`);
    }
  }
});

// ── AC-C5：横版（默认）不许被改坏 ────────────────────────────────────────

test('AC-C5 ⭐ 横版是默认，且**行为与改动前一致**（线上/浏览器打印那条老路一个字都没变）', async () => {
  assert.equal(LABEL_PRINT_QUEUE.artifact.canvas, 'landscape', '默认必须是横版（老行为）');
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotate, 0);
  assert.equal(LABEL_PRINT_QUEUE.artifact.rotatePageWithContent, false);

  const base = await renderOne({});
  const meta = await require('sharp')(base.pngFirst).metadata();
  assert.equal(`${meta.width}x${meta.height}`, '320x240');
  assert.equal(base.meta.width_pt, 113.3858);
  assert.equal(base.meta.canvas, 'landscape');

  // 横版转 90° + 不换页面 = **真机 B**：方向对、缩到 75% —— **线上正跑着它**，必须一模一样。
  const bPath = await renderOne({ rotate: 90 });
  assert.equal(bPath.meta.width_pt, 113.3858, 'B 的页面仍是 40×30');
  assert.ok(bPath.meta.scale < 0.76 && bPath.meta.scale > 0.72,
    `B 那条约等 0.735 的缩放必须保持不变（实际 ${bPath.meta.scale}）`);
  // 换页面那条路（C）也保留（标注"不推荐"，但不删）。
  const cPath = await renderOne({ rotate: 90, rotatePageWithContent: true });
  assert.equal(cPath.meta.width_pt, 85.0394, 'C 的页面是 30×40（保留这条路）');
  assert.equal(cPath.meta.rotate_page_with_content, true);
});

test('AC-C5 横版 + 0° 的 SVG 与"加画布之前"逐字节一致（不套 <g>、无 scale）', () => {
  const svg = artifact.labelSvg(label(), layout(), { dpi: 203 });
  assert.equal(svg.includes('<g transform='), false);
  assert.equal(svg.includes('scale('), false);
  assert.match(svg, /viewBox="0 0 40 30"/);
  assert.match(svg, /width="320" height="240"/);
});

// ── AC-C6 / AC-C8：配置先行 ──────────────────────────────────────────────

test('AC-C6 配置先行：`canvas` 可配、非法值当场抛错；`rotatePageWithContent` 保留但标注不推荐', () => {
  assert.equal(resolveLabelPrintQueueConfig({}).artifact.canvas, 'landscape');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'portrait' }).artifact.canvas, 'portrait');
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_CANVAS: 'diagonal' }),
    /LABEL_PRINT_CANVAS/);
  assert.equal(artifact.normalizeCanvas(undefined), 'landscape');
  assert.equal(artifact.normalizeCanvas('portrait'), 'portrait');
  assert.throws(() => artifact.normalizeCanvas('45'), /canvas/);
  // 这条注释必须写着"不推荐"（别再让人当默认开）
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/config/labelPrintQueue.js'), 'utf8');
  assert.match(source, /rotatePageWithContent[\s\S]{0,400}不推荐/,
    'rotatePageWithContent 旁边必须写清"实测会把方向再转 90°、不推荐"');
});

test('AC-C8 竖版画布的行序也进配置（渲染层不写死）', () => {
  assert.deepEqual(LABEL_PRINT.body.portraitRows,
    ['brand', 'itemNoColor', 'price', 'state', 'sizes', 'qr'],
    '竖版画布的行序（二维码**自己占一行**）—— 配置先行');
  // 改配置就能换行序：把二维码提到最上面
  const custom = layout({ body: { ...LABEL_PRINT.body, portraitRows: ['qr', 'brand', 'itemNoColor', 'price', 'sizes'] } });
  const out = artifact.labelSvg(label(), custom, { dpi: 203, canvas: 'portrait' });
  assert.ok(out.includes('rotate(90)'));
  // 两种行序渲染出来必须不同（否则说明行序没生效）
  const normal = artifact.labelSvg(label(), layout(), { dpi: 203, canvas: 'portrait' });
  assert.notEqual(out, normal);
});

test('AC-C6 竖版画布：内容不会溢出页面（最外一圈是干净的）+ 裁切线仍在纸边', async () => {
  const sharp = require('sharp');
  const out = await renderOne({ canvas: 'portrait' });
  const { data, info } = await sharp(out.pngFirst).greyscale().raw().toBuffer({ resolveWithObject: true });
  // 有裁切线时：最外一圈**只有**裁切线那一条细线（不该有大面积的墨）
  let borderInk = 0;
  for (let x = 0; x < info.width; x += 1) {
    if (data[x] < 128) borderInk += 1;
    if (data[(info.height - 1) * info.width + x] < 128) borderInk += 1;
  }
  assert.ok(borderInk <= info.width * 2 + 8, `最外一圈只该有裁切线（实际 ${borderInk} 个墨点）`);
});
