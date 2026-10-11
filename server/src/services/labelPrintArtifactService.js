/**
 * 「**可打印产物**」的渲染器 —— 把小助手要打的那一份**在服务器上画出来**，
 * 电脑那边**只负责把它送进打印机**（小助手不懂业务，最稳）。
 *
 * 为什么要有这个文件：
 *   业务负责人 2026-10-11 的新口径是「**普通 USB 标签机 + 店里那台电脑当打印小助手**」，
 *   而**电脑不一定会开着机**。电脑上一个"渲染器"越多、装的东西越多，越容易在她不在的时候坏；
 *   所以把"长什么样"全部留在服务器（本文件），电脑上只剩一条打印命令。
 *
 * 产物流水线（**纯函数，不碰磁盘** —— 落盘在 `labelPrintQueueService` 里）：
 *
 * ```
 *   label（service 已经算好的"印什么"） + layout（config/labelPrint.js）
 *        │  labelSvg()        ← 40×30mm 的矢量图（mm 用户单位 + 精确像素尺寸）
 *        ▼
 *      SVG ──sharp──> PNG（203dpi ⇒ 320×240px，测试打印 / 排障用）
 *              └────> JPEG ──buildPdf()──> 单页 40×30mm 的 PDF（**送打印机的那一份**）
 * ```
 *
 * ⚠️ **为什么是"服务器出 PDF"而不是"电脑浏览器打印"**（她 2026-10-08 那条「不要用 sharp 出 PNG」
 *    针对的是**浏览器打印**那条路 —— 那条路继续用 HTML + CSS，一个字没改）；
 *    这条**新**链路电脑上没有浏览器、也没有人点对话框，必须有一份"喂给打印机就行"的**文件**。
 *    ⇒ 两条路**共用同一份配置**（`config/labelPrint.js`）与**同一份"印什么"**（labelPrintService），
 *      只有"怎么落成一张纸"各写各的（HTML/CSS ↔ SVG/PDF）。
 *
 * 🔴 **mm 是唯一的长度单位**：SVG 的 `viewBox` 用 mm（`0 0 40 30`），
 *    `width/height` 用**精确像素**（`mm/25.4*dpi`）⇒ librsvg 按 8 倍（203dpi）等比映射，
 *    **文字与二维码都不会被重采样**，纸上的毫米数与标签纸严格一致。
 *
 * ⚠️ **两个 sharp 的坑（实测踩过，别改回去）**：
 *   ① **不许传 `density`**：sharp 的 SVG 输入把 `density` 按 **72dpi 为基数**放大
 *      （`density: 203` 会把 320×240 变成 902×676 ⇒ 纸上大了一圈，而且单测不会报错）；
 *      正确做法 = `width/height` 直接写**目标像素**、不传 `density`；
 *   ② **字体名必须显式写死 CJK 链**：服务器只有 `fonts-noto-cjk`，librsvg 拿不到系统默认中文字体，
 *      写缺了中文会变成一个个**方框**、而且**不报错**（`purchaseRequestImageService.js:15-18` 踩过）。
 *
 * ⚠️ **几何数字的"镜子"**：标签上的行高（1.15 / 1.1 / 1.25…）在浏览器那条路里写在
 *    `public/workbench/features/labels/labels.css`（CSS 的 `line-height`）。
 *    本文件为了画出**一样的**一张纸，必须抄一遍 —— 所以 `test/labelPrintArtifact.test.js`
 *    里有一条**防漂移用例**：解析 `labels.css`，逐条断言这里的数字与它一致。
 *    改那边不改这里 ⇒ 那条用例会红（这正是它存在的意义）。
 */
const sharp = require('sharp');
const QRCode = require('qrcode');

const { textValue } = require('./v1BitableGateway');

/** CJK 字体候选链（与 `purchaseRequestImageService.js` 同一套；顺序即优先级）。 */
const FONT_FAMILY = 'Noto Sans CJK SC, Noto Sans SC, WenQuanYi Zen Hei, PingFang SC, sans-serif';

/**
 * 行高"镜子"—— 逐条对应 `public/workbench/features/labels/labels.css` 里的 `line-height`
 * （见文件头"几何数字的镜子"）。`test/labelPrintArtifact.test.js` 会逐条核对。
 */
const LINE_HEIGHTS = Object.freeze({
  brand: 1.15,
  itemNo: 1.1,
  color: 1.15,
  state: 1.25,
  sizes: 1.25,
  price: 1.15,
  footer: 1.2,
});

/** PDF 的点数：1mm = 72/25.4 pt（PDF 的长度单位是 pt，`/MediaBox` 必须用它）。 */
const MM_TO_PT = 72 / 25.4;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** mm → PDF 点（保留 4 位小数：40mm ⇒ 113.3858，够精确且可断言）。 */
const mmToPt = (mm) => Number((num(mm) * MM_TO_PT).toFixed(4));

/** mm → 像素（203dpi ⇒ 8 点/mm；40mm ⇒ 320px，30mm ⇒ 240px）。 */
const mmToPx = (mm, dpi) => Math.max(1, Math.round((num(mm) / 25.4) * num(dpi, 203)));

/** XML 文本转义（货号 / 颜色 / 品牌都来自表，可能带 `&`、`<`）。 */
const escapeXml = (value) => String(value ?? '').replace(/[<>&'"]/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
}[char]));

/**
 * 一段文字估多宽（mm）—— 与 `features/labels/render.js` 的 `textWidthMm` **同一套系数**
 * （系数本身来自 config 的 `body.itemNoColor.widthEm`，不是这里写死的，所以换分隔符不用改这里）。
 * ⚠️ 估算只用来决定"货号与颜色往右挪多少 / 缩到多小"，纸上**真兜底**的是
 *    `planItemNoColor` 已经算好的字号与截断（这两件事在 service/render 里已定稿）。
 */
const charEm = (char, em) => {
  if ((Array.isArray(em.narrowChars) ? em.narrowChars : []).includes(char)) return num(em.narrow, 0.25);
  if ((Array.isArray(em.wideChars) ? em.wideChars : []).includes(char)) return num(em.wide, 0.72);
  return (char.codePointAt(0) >= 0x2e80 ? num(em.cjk, 1) : num(em.ascii, 0.66));
};

const textWidthMm = (text, fontMm, em = {}) => {
  let width = 0;
  for (const char of String(text ?? '')) width += charEm(char, em) * fontMm;
  return width;
};

/**
 * 「货号 + 颜色（· 品类）」这一行怎么排 —— **与 `render.js` 的 `planItemNoColor` 同一套规则**
 * （同一份 config：`body.itemNoColor`）。
 *
 * ⚠️ 这里是**第二份实现**（服务端 CJS vs 浏览器 ESM，没法互相 import）。
 *    为了不让两份走歪：① 规则与系数**全部来自 config**（一个数字都不写死）；
 *    ② `test/labelPrintArtifact.test.js` 用**同一批夹具**跑两份实现，**逐字段比对**结果。
 */
const planItemNoColor = (label, layout, options = {}) => {
  const body = layout.body || {};
  const config = body.itemNoColor || {};
  const fields = layout.fields || {};
  const em = config.widthEm || {};
  const itemNoMm = num(layout.typography?.itemNoMm, 3.6);
  const fieldMm = num(layout.typography?.fieldMm, 2.8);
  const minItemNoMm = Math.min(itemNoMm, num(config.minItemNoMm, 2.4));
  const gapMm = num(config.gapMm, 1.2);
  const mark = String(config.truncateMark ?? '…');
  const separator = String(config.categorySeparator ?? ' · ');
  const preferColor = config.preferColorOverCategory !== false;
  const available = availableWidthMm(layout, options);

  const missing = String(layout.texts?.missingValue ?? '—');
  const value = (raw) => String(raw ?? '').trim() || missing;
  const itemNo = fields.itemNo ? value(label.item_no) : '';
  const color = fields.color ? value(label.color) : '';
  const category = fields.category ? value(label.category) : '';
  const withCategory = [color, category].filter(Boolean).join(separator);
  const colorOnly = color || category;

  const fitText = (text, fontMm, maxMm) => {
    if (textWidthMm(text, fontMm, em) <= maxMm) return text;
    const markMm = textWidthMm(mark, fontMm, em);
    if (markMm > maxMm) return '';
    let out = '';
    let width = 0;
    for (const char of String(text ?? '')) {
      const charMm = charEm(char, em) * fontMm;
      if (width + charMm + markMm > maxMm) break;
      out += char;
      width += charMm;
    }
    return `${out}${mark}`;
  };

  const fitItem = (availMm) => {
    if (!itemNo) return { sizeMm: itemNoMm, text: '', truncated: false };
    const fullMm = textWidthMm(itemNo, itemNoMm, em);
    if (fullMm <= availMm) return { sizeMm: itemNoMm, text: itemNo, truncated: false };
    const ratio = availMm > 0 ? availMm / fullMm : 0;
    const sizeMm = Math.max(minItemNoMm, Math.min(itemNoMm, itemNoMm * ratio));
    if (textWidthMm(itemNo, sizeMm, em) <= availMm) return { sizeMm, text: itemNo, truncated: false };
    const text = fitText(itemNo, sizeMm, availMm);
    return { sizeMm, text, truncated: text !== itemNo };
  };
  const planFor = (colorText) => ({
    ...fitItem(available - gapMm - textWidthMm(colorText, fieldMm, em)),
    colorText,
  });

  let plan;
  let categoryIncluded = false;
  if (withCategory) {
    const withCat = planFor(withCategory);
    const affordable = withCat.sizeMm >= minItemNoMm - 1e-9 && !withCat.truncated;
    if (affordable || !preferColor) {
      plan = withCat;
      categoryIncluded = Boolean(category);
    } else {
      plan = planFor(colorOnly);
    }
  } else {
    plan = planFor(colorOnly);
  }

  const itemWidthMm = textWidthMm(plan.text, plan.sizeMm, em);
  const colorRoomMm = Math.max(0, available - gapMm - itemWidthMm);
  let colorText = plan.colorText;
  let colorTruncated = false;
  if (textWidthMm(colorText, fieldMm, em) > colorRoomMm) {
    colorText = fitText(colorText, fieldMm, colorRoomMm);
    colorTruncated = true;
  }

  return {
    itemNoText: plan.text,
    itemNoSizeMm: plan.sizeMm,
    itemNoTruncated: plan.truncated,
    colorText,
    colorTruncated,
    categoryIncluded,
    availableWidthMm: available,
    estimatedWidthMm: itemWidthMm + gapMm + textWidthMm(colorText, fieldMm, em),
    gapMm,
  };
};

/**
 * 右栏可用宽度（mm）—— 与 `render.js` 的 `availableWidthMm` 同一条公式：
 * 标签宽 − 左右留白 − 裁切线 × 2 − （二维码宽 + 二维码与右栏的空隙）。
 * 40×30 + 15mm 二维码 + 1.5mm 留白 + 0.2mm 裁切线 ⇒ **20.1mm**。
 */
function availableWidthMm(layout, options = {}) {
  const label = layout.label || {};
  const body = layout.body || {};
  const fields = layout.fields || {};
  const designWidthMm = num(options.designWidthMm, num(label.widthMm, 40));
  // 二维码**永远在左栏**（构图不变）⇒ 它永远从"行方向"里扣宽度（右栏 20.1mm）。
  const qr = fields.qr === false ? 0 : num(layout.typography?.qrSizeMm, 15) + num(body.qrGapMm, 1.5);
  const borders = num(label.borderMm, 0.2) * 2;
  return Math.max(0, designWidthMm - num(label.paddingMm, 1.5) * 2 - borders - qr);
}

/**
 * 二维码：**复用 service 已经算好的那段 SVG**（`label.qr_svg`，由 `qrcode` 出的纯 JS SVG），
 * 只把"摆在哪、多大"注进去 —— **不另起一套出码逻辑**（URL 模板与纠错等级仍是各一处真源）。
 * ⚠️ librsvg 认嵌套 `<svg x y width height viewBox>`，所以直接把根标签补齐这四个属性即可。
 */
const placeQrSvg = (qrSvg, { x, y, sizeMm }) => {
  const raw = String(qrSvg || '').trim();
  if (!raw) return '';
  const placement = `x="${x}" y="${y}" width="${sizeMm}" height="${sizeMm}"`;
  if (/^<svg[\s>]/.test(raw)) {
    return raw.replace(/^<svg/, `<svg ${placement}`);
  }
  return `<svg ${placement} xmlns="http://www.w3.org/2000/svg">${raw}</svg>`;
};

const ROTATIONS = Object.freeze([0, 90, 180, 270]);
/**
 * ⭐ 排版**画布方向**：
 *   · `landscape`（**默认**）—— 老版式：画布 40 宽 × 30 高，品牌沿页面的 40mm 排；
 *   · `portrait`            —— **旋转画布**：按"转过来之后"的画布（30 宽 × 40 高）**重新排版**，
 *     再整幅**按原尺寸**转进 40×30 的页面 ⇒ 方向对（= 真机 B）**且铺满**（= 真机 C），
 *     **不再**"先画好 40×30 再转、转不下就缩到 75%"。
 * 认不出的值当场抛错（不许静默按横版印出一堆方向反的标签）。
 */
const CANVASES = Object.freeze(['landscape', 'portrait']);
const normalizeCanvas = (value) => {
  const canvas = String(value ?? 'landscape').trim() || 'landscape';
  if (!CANVASES.includes(canvas)) {
    throw new Error(`标签画布方向（canvas）只能是 landscape / portrait（横版 / 竖版），当前是「${value}」`);
  }
  return canvas;
};

/** 旋转角度归一化。认不出的值**当场抛错**（配置写错时不许静默按 0 处理 —— 那会印出一堆方向反的标签）。 */
const normalizeRotation = (value) => {
  const angle = Number(value ?? 0);
  if (!ROTATIONS.includes(angle)) {
    throw new Error(`标签旋转角度只能是 0 / 90 / 180 / 270，当前是「${value}」`);
  }
  return angle;
};

/**
 * ⭐⭐ **画布几何**（这次"旋转画布"的核心，一段话讲清三件事）：
 *
 * ```
 *   画布（怎么排版）          页面（MediaBox）        内容相对页面转多少度
 *   landscape（默认）= 40×30  40×30（换页面那档才 30×40）   0 / 90 / 180 / 270（rotate 原样）
 *   portrait        = 30×40   **40×30（永远不换）**         90（+ 可再叠 rotate）
 * ```
 *
 * ⚠️ **为什么竖版要"换画布"而不是"转位图"**（真机结论，别改回去）：
 *    把一幅 40×30 的图转 90° 之后它占 30×40 —— **塞不进 40×30 的页面**，
 *    只能等比缩到 75%（真机 B：方向对、但**四周留白的小框**）；
 *    而"换页面尺寸"（真机 C）会让驱动**再转 90°**（方向又反）。
 *    ⇒ 唯一同时满足"方向对 + 原尺寸铺满 + 页面不换"的做法：
 *      **按转过之后的画布（30×40）重新排版**，再整幅按 1:1 转进 40×30 的页面。
 *
 * 返回里 `scale` = 1 表示**原尺寸**（铺满）；< 1 只在"横版 + 转 90° 且不换页面"那条老路上出现
 * （真机 B 就是它 —— **线上正跑着**，所以那条路必须原样保留）。
 */
const canvasGeometry = (layout, options = {}) => {
  const labelCfg = layout.label || {};
  const labelW = num(labelCfg.widthMm, 40);
  const labelH = num(labelCfg.heightMm, 30);
  const canvas = normalizeCanvas(options.canvas);
  const rotateOption = normalizeRotation(options.rotate);
  const portrait = canvas === 'portrait';

  // ⭐⭐ **两档的"页面内容"其实是同一份：原构图（40×30）不重排、不缩放。**
  //
  //  `portrait`（"驱动纸型已修好"那一档）为什么等于"原构图 1:1"：
  //    业务负责人口径 = "逻辑画布 30×40（读向沿 40mm 那条边）+ 整幅转 90° 进页面"。
  //    这两步**正好互相抵消**：画布里那次 −90° 把原构图转进 30×40 框，
  //    页面前那次 +90° 又把它转回 40×30 —— 于是**页面内容 = 原构图本身、页面 40×30、scale=1**。
  //    ⚠️ 也就是说：`portrait` 与 `landscape + rotate:0` **渲染结果逐像素相同**
  //       （`test/labelPrintCanvas.test.js` 里有一条 AC 专门证明这件事，
  //        免得"以为换了个模式、其实没变"）。
  //    ⇒ **真正的开关不在代码里，在那台打印机的驱动纸型**：
  //      驱动纸型 = 40×30 ⇒ 页面按原样打印 ⇒ 原构图就是纸上看到的（方向✓ 构图✓ 铺满✓）；
  //      驱动纸型 = 30×40（她之前的状态）⇒ 驱动会把 40×30 的页面**再转 90°** ⇒ 方向反（= 真机 A）。
  const designW = labelW;
  const designH = labelH;
  const rotation = rotateOption;
  // 页面声明：`portrait` **保持 40×30**（本轮的关键 —— 上一版错在把页面改成 30×40，
  // 于是驱动"看到页面形状与纸型不一致"又转了一次）。
  // `rotatePageWithContent` 是历史老路（实测会被驱动再转 90°、不推荐），保留但默认关。
  const allowSwap = !portrait
    && Boolean(options.rotatePageWithContent)
    && (rotateOption === 90 || rotateOption === 270);
  const pageW = allowSwap ? labelH : labelW;
  const pageH = allowSwap ? labelW : labelH;
  const needW = rotation % 180 === 0 ? designW : designH;
  const needH = rotation % 180 === 0 ? designH : designW;
  const fit = Math.min(1, pageW / needW, pageH / needH);
  const scale = fit >= 1 ? 1 : round(fit * 0.98);
  return {
    canvas,
    portrait,
    labelW,
    labelH,
    designW,
    designH,
    pageW,
    pageH,
    rotate: rotation,
    scale,
    allowSwap,
  };
};

/** 页面尺寸（mm）—— 兼容旧调用（竖版画布 = 画布 30×40、页面仍 40×30）。 */
const pageSizeMm = (layout, options = {}) => {
  const geo = canvasGeometry(layout, options);
  return {
    labelW: geo.labelW, labelH: geo.labelH,
    pageW: geo.pageW, pageH: geo.pageH,
    rotate: geo.rotate, swapped: geo.allowSwap,
  };
};

/**
 * 内容相对页面的那个 `transform`。
 * ⚠️ `rotate === 0 && scale === 1`（横版默认）⇒ **返回空串（不套 `<g>`）**，
 *    保证横版原样的输出与"加画布之前"**逐字节一致**。
 */
const rotationTransform = (geo) => {
  if (geo.rotate === 0 && geo.scale >= 1) return '';
  const parts = [`translate(${round(geo.pageW / 2)} ${round(geo.pageH / 2)})`];
  if (geo.rotate) parts.push(`rotate(${geo.rotate})`);
  if (geo.scale !== 1) parts.push(`scale(${geo.scale})`);
  parts.push(`translate(${round(-geo.designW / 2)} ${round(-geo.designH / 2)})`);
  return parts.join(' ');
};

/**
 * 一张标签的 **SVG**（mm 用户单位 + 精确像素尺寸）—— 版式逐条对应她 2026-10-08 定稿的那张：
 *
 * ```
 *               邯美皮鞋             ← brandRow: 'top'（跨整张、居中）
 *  ┌────────┐  0225  棕色           ← rows: itemNoColor（货号大字 + 颜色）
 *  │ 二维码  │  ¥198                ← rows: price
 *  └────────┘  36₁ 37₁ 38₁         ← rows: sizes（数值升序，最多 maxLines 行）
 * ```
 * ⚠️ **一个 mm、一个行序都不写死**：全部从 `layout`（= `config/labelPrint.js`）来。
 *    改标签纸尺寸 / 品牌位置 / 右栏行序 ⇒ 只改那份 config，本文件不用动。
 * ⚠️ **旋转只在"最外层套一个 transform"**：整幅内容一次性转（见 `rotationTransform`），
 *    里面一个坐标都不用改 —— 这样"改方向"永远不会把版式搞歪。
 * ⚠️ `rotate === 0`（默认）时**输出与加旋转之前逐字节一致**（不套 `<g>`）——
 *    既有用例与既有版式都不受影响。
 */
function labelSvg(label, layout, options = {}) {
  const dpi = num(options.dpi, 203);
  const labelCfg = layout.label || {};
  const body = layout.body || {};
  const fields = layout.fields || {};
  const typography = layout.typography || {};
  const sizesCfg = layout.sizes || {};
  const texts = layout.texts || {};

  // ⭐⭐ 画布几何：`widthMm/heightMm` 这里是**逻辑画布**（怎么排版），
  //    页面（MediaBox）与"转多少度"由 `geometry` 决定 —— 竖版画布下两者不同（30×40 画布 → 40×30 页面）。
  const geometry = canvasGeometry(layout, options);
  const widthMm = geometry.designW;
  const heightMm = geometry.designH;
  const padMm = num(labelCfg.paddingMm, 1.5);
  const borderMm = num(labelCfg.borderMm, 0.2);

  const widthPx = mmToPx(geometry.pageW, dpi);
  const heightPx = mmToPx(geometry.pageH, dpi);

  // 内容区（`box-sizing: border-box` ⇒ 留白与裁切线都占尺寸）。
  const x0 = padMm + borderMm;
  const y0 = padMm + borderMm;
  const contentW = Math.max(0, widthMm - x0 * 2);
  const contentBottom = heightMm - y0;

  const parts = [];
  // 裁切线：屏幕上虚线、纸上细实线；这里画细实线。
  parts.push(`<rect x="${borderMm / 2}" y="${borderMm / 2}" width="${widthMm - borderMm}" height="${heightMm - borderMm}" fill="none" stroke="#000" stroke-width="${borderMm}" />`);

  // ── 品牌行（`brandRow: 'top'`，她定案：顶部居中、跨整张）────────────────
  const brandText = fields.brand && label.brand_text ? String(label.brand_text) : '';
  const brandOnTop = body.brandRow !== 'inline';
  let mainTop = y0;
  if (brandText && brandOnTop) {
    const brandMm = num(typography.brandMm, 2.4);
    const lineH = brandMm * LINE_HEIGHTS.brand;
    const align = String(body.brandAlign || 'center');
    const anchor = align === 'left' ? 'start' : (align === 'right' ? 'end' : 'middle');
    const tx = align === 'left' ? x0 : (align === 'right' ? x0 + contentW : x0 + contentW / 2);
    parts.push(`<text x="${round(tx)}" y="${round(y0 + brandMm * 0.85)}" font-family="${FONT_FAMILY}" font-size="${round(brandMm)}" text-anchor="${anchor}">${escapeXml(brandText)}</text>`);
    mainTop = y0 + lineH + num(body.brandGapMm, 0.6);
  }

  // ── 底部小字（默认不印）：占了高度，右栏与二维码都要让位 ────────────────
  // `.label-footer` = padding-top 0.4mm + border-top 0.15mm + 一行 line-height 1.2。
  const footerMm = num(typography.footerMm, 1.7);
  const footerH = fields.footer ? footerMm * LINE_HEIGHTS.footer + 0.4 + 0.15 : 0;
  const footerTop = contentBottom - footerH;
  if (fields.footer) {
    parts.push(`<line x1="${round(x0)}" y1="${round(footerTop + 0.4)}" x2="${round(x0 + contentW)}" y2="${round(footerTop + 0.4)}" stroke="#000" stroke-width="0.15" />`);
    parts.push(`<text x="${round(x0)}" y="${round(footerTop + 0.4 + footerMm * 0.95)}" font-family="${FONT_FAMILY}" font-size="${round(footerMm)}">${escapeXml(String(label.footer_text || texts.missingValue || ''))}</text>`);
  }
  const mainBottom = fields.footer ? footerTop : contentBottom;
  const mainH = Math.max(0, mainBottom - mainTop);

  // ── 二维码（左，竖直居中）──────────────────────────────────────────────
  // 二维码边长：**两档都用同一个 `qrSizeMm`（15mm）** —— 画布都是 40×30，右栏 20.1mm 装得下。
  const qrMm = num(typography.qrSizeMm, 15);
  const qrGapMm = num(body.qrGapMm, 1.5);
  // ⭐⭐ **构图保持原样**（业务负责人 2026-10-12 真机反馈：「左边是二维码、右边是信息的这个已经变了」）：
  //   二维码**永远在左栏**、信息在右栏 —— 横版竖版**都是这一套构图**，只是画布尺寸不同。
  //   ⚠️ 竖版画布的"行方向"只有 30mm（画布是 30×40）⇒ 二维码旁边只剩 ~10mm 给货号，
  //      所以竖版把二维码**调小**（`typography.portraitQrSizeMm`，配置可改）—— 见那里的说明。
  let rightX = x0;
  if (fields.qr && qrMm > 0) {
    const qrY = mainTop + Math.max(0, (mainH - qrMm) / 2);
    parts.push(placeQrSvg(label.qr_svg, { x: round(x0), y: round(qrY), sizeMm: round(qrMm) }));
    rightX = x0 + qrMm + qrGapMm;
  }
  // 右栏从 `rightX` 到内容区右边（竖版画布下 = 整幅内容宽）—— 具体画多宽由下面的估算决定，
  // 排版不会越过这条界线（`planItemNoColor` 已经把字宽算进可用宽度里）。

  // ── 右栏：行序与每一行的画法都来自 config（`body.rows`）——
  //   ⚠️ **竖版画布不再另排行序**（她要求"保持原构图"）：两档用的是**同一份 `body.rows`**。
  const rows = Array.isArray(body.rows) && body.rows.length
    ? body.rows
    : ['brand', 'itemNoColor', 'price', 'state', 'sizes'];
  const itemNoMm = num(typography.itemNoMm, 3.6);
  const fieldMm = num(typography.fieldMm, 2.8);
  const priceMm = num(typography.priceMm, 3.2);
  const sizeMm = num(typography.sizeMm, 2.8);
  const qtyRatio = num(sizesCfg.qtyFontRatio, 0.64);
  const qtyShiftEm = num(sizesCfg.qtyBaselineShiftEm, 0.2);
  const sizeGapMm = num(sizesCfg.itemGapMm, 1);

  const itemPlan = planItemNoColor(label, layout, { designWidthMm: widthMm });
  const sizeLines = Array.isArray(label.size_lines) ? label.size_lines.filter((line) => Array.isArray(line) && line.length) : [];
  const overflowMark = String(texts.overflowMark ?? '…');

  /** `brandRow: 'inline'` 时品牌占右栏一行（老版式；现默认在顶部，所以这条一般是 0）。 */
  const brandMmRow = () => (brandText && !brandOnTop ? num(typography.brandMm, 2.4) * LINE_HEIGHTS.brand : 0);

  /** 每一行占多高（mm）—— 行高系数见 LINE_HEIGHTS（与 labels.css 一致，有防漂移用例）。 */
  const rowHeight = (id) => {
    if (id === 'itemNoColor') return itemNoMm * LINE_HEIGHTS.itemNo;
    if (id === 'price') return priceMm * LINE_HEIGHTS.price;
    if (id === 'state') return fieldMm * LINE_HEIGHTS.state;
    if (id === 'sizes') return Math.max(1, sizeLines.length) * sizeMm * LINE_HEIGHTS.sizes;
    if (id === 'brand') return brandMmRow();
    // ⭐ 二维码自己占一行（竖版画布）：高度 = 二维码边长 + 上面一点空隙。
    return 0;
  };

  const activeRows = rows.filter((id) => {
    if (id === 'brand') return Boolean(brandText) && !brandOnTop;
    if (id === 'itemNoColor') return Boolean(itemPlan.itemNoText || itemPlan.colorText);
    if (id === 'price') return Boolean(fields.price && label.price_text);
    if (id === 'state') return Boolean(fields.state);
    if (id === 'sizes') return Boolean(fields.size) && sizeLines.length > 0;
    if (id === 'qr') return false; // 二维码不在行流里（永远是左栏）

    return false;
  });
  const totalH = activeRows.reduce((sum, id) => sum + rowHeight(id), 0);
  let cursor = mainTop + Math.max(0, (mainH - totalH) / 2);

  for (const id of activeRows) {
    const h = rowHeight(id);
    const baseline = cursor + h * 0.82;
    if (id === 'brand') {
      parts.push(`<text x="${round(rightX)}" y="${round(baseline)}" font-family="${FONT_FAMILY}" font-size="${round(num(typography.brandMm, 2.4))}">${escapeXml(brandText)}</text>`);
    } else if (id === 'itemNoColor') {
      let x = rightX;
      if (itemPlan.itemNoText) {
        parts.push(`<text x="${round(x)}" y="${round(baseline)}" font-family="${FONT_FAMILY}" font-size="${round(itemPlan.itemNoSizeMm)}" font-weight="800">${escapeXml(itemPlan.itemNoText)}</text>`);
        x += textWidthMm(itemPlan.itemNoText, itemPlan.itemNoSizeMm, body.itemNoColor?.widthEm || {}) + itemPlan.gapMm;
      }
      if (itemPlan.colorText) {
        parts.push(`<text x="${round(x)}" y="${round(baseline)}" font-family="${FONT_FAMILY}" font-size="${round(fieldMm)}">${escapeXml(itemPlan.colorText)}</text>`);
      }
    } else if (id === 'price') {
      parts.push(`<text x="${round(rightX)}" y="${round(baseline)}" font-family="${FONT_FAMILY}" font-size="${round(priceMm)}" font-weight="700">${escapeXml(String(label.price_text))}</text>`);
    } else if (id === 'state') {
      parts.push(`<text x="${round(rightX)}" y="${round(baseline)}" font-family="${FONT_FAMILY}" font-size="${round(fieldMm)}">${escapeXml(String(label.state_text || texts.missingValue || ''))}</text>`);
    } else if (id === 'sizes') {
      sizeLines.forEach((tokens, lineIndex) => {
        const lineBaseline = cursor + (lineIndex + 0.82) * sizeMm * LINE_HEIGHTS.sizes;
        let x = rightX;
        for (const token of tokens) {
          const sizeText = String(token?.size ?? '');
          parts.push(`<text x="${round(x)}" y="${round(lineBaseline)}" font-family="${FONT_FAMILY}" font-size="${round(sizeMm)}">${escapeXml(sizeText)}</text>`);
          const sizeTextW = textWidthMm(sizeText, sizeMm, body.itemNoColor?.widthEm || {});
          const qtyText = String(token?.qty ?? '');
          if (qtyText) {
            const qtyMm = sizeMm * qtyRatio;
            // CSS 的 `vertical-align: -Xem` 是**相对角标自己的字号**下沉 ⇒ y 加 X × 角标字号。
            parts.push(`<text x="${round(x + sizeTextW)}" y="${round(lineBaseline + qtyMm * qtyShiftEm)}" font-family="${FONT_FAMILY}" font-size="${round(qtyMm)}">${escapeXml(qtyText)}</text>`);
            x += sizeTextW + textWidthMm(qtyText, qtyMm, body.itemNoColor?.widthEm || {}) + sizeGapMm;
          } else {
            x += sizeTextW + sizeGapMm;
          }
        }
        // 两行都放不下时最后一行补 `…`（**省略是看得见的**，与页面同一条口径）。
        if (lineIndex === sizeLines.length - 1 && label.size_overflow) {
          parts.push(`<text x="${round(x)}" y="${round(lineBaseline)}" font-family="${FONT_FAMILY}" font-size="${round(sizeMm)}">${escapeXml(overflowMark)}</text>`);
        }
      });
    }
    cursor += h;
  }

  const inner = parts.join('');
  // ⚠️ 横版 + 0°（默认）⇒ `transform` 是空串 ⇒ **不套 `<g>`**，
  //    输出与"加画布之前"逐字节一致（线上/浏览器打印那条老路一个字都没变）。
  const transform = rotationTransform(geometry);
  const body2 = transform ? `<g transform="${transform}">${inner}</g>` : inner;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${geometry.pageW} ${geometry.pageH}">`
    + `<rect width="${geometry.pageW}" height="${geometry.pageH}" fill="#ffffff" />`
    + body2
    + '</svg>';
}

/** 数字收敛到 3 位小数（免得 `2.3999999` 这种值进 SVG，也让打样图与单测可断言）。 */
function round(value) {
  return Number(num(value).toFixed(3));
}

/**
 * SVG → PNG。⚠️ **不传 `density`**（见文件头坑①）；`width/height` 已经是精确像素。
 */
const svgToPng = (svg, options = {}) => sharp(Buffer.from(svg), { ...(options.sharpOptions || {}) })
  .png({ compressionLevel: 9 })
  .toBuffer();

/** PNG → JPEG（塞进 PDF 用；标签是文字 + 二维码，黑白为主，quality 高一点免得二维码糊）。 */
const pngToJpeg = (png, options = {}) => sharp(png)
  .jpeg({ quality: num(options.quality, 92), chromaSubsampling: '4:4:4' })
  .toBuffer();

/**
 * **最小 PDF 写出器**（不引任何依赖）—— 一个任务一份 PDF，**一页一张 40×30mm 的标签**。
 *
 * 为什么手写而不是装 `pdfkit`：
 *   · 需求小到只有一个形状（**N 个页面，每页铺满一张图**），手写 60 行就够；
 *   · 这个仓库刻意避免为一条链路拉进一棵依赖树，而且**新依赖要在她电脑/服务器上都能装**；
 *   · 关键要求只有一个：**每页的 `/MediaBox` 必须是标签纸的真实尺寸**（40×30mm ⇒ 113.3858×85.0394pt），
 *     这样 Windows 侧的打印器不用做任何缩放，纸上就是一整张 40×30。
 *
 * 结构（`x 0 obj … endobj` 全部按字节偏移写进 xref）：
 * ```
 *   1 Catalog → 2 Pages → 每页 { Page / Contents / Image(XObject, DCTDecode=JPEG) }
 * ```
 * `test/labelPrintArtifact.test.js` 会**逐条解析 xref**，断言每个偏移都真的指回 `N 0 obj` —— 
 * 手写 PDF 最容易错的就是偏移，所以那条用例不是"点一下"，是把文件当真 PDF 验。
 */
function buildPdf(pages, options = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  if (!list.length) throw new Error('buildPdf 至少需要一页');
  const objects = new Map(); // 对象号 → Buffer（按号排序写出，号与顺序都不许跳）
  let nextId = 1;
  const alloc = () => {
    const id = nextId;
    nextId += 1;
    objects.set(id, null);
    return id;
  };

  const catalogId = alloc();
  const pagesId = alloc();
  const pageIds = list.map(() => ({ pageId: alloc(), contentId: alloc(), imageId: alloc() }));
  const title = String(options.title || '');
  const infoId = title ? alloc() : null;

  const kids = pageIds.map((entry) => `${entry.pageId} 0 R`).join(' ');
  objects.set(catalogId, Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
  objects.set(pagesId, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`));
  if (infoId) {
    // 标题里的 `(` `)` `\` 在 PDF 字符串里必须转义（中文用 UTF-16BE 太啰嗦，这里只放 ASCII 占位）。
    const safeTitle = title.replace(/([()\\])/g, '\\$1');
    objects.set(infoId, Buffer.from(`<< /Title (${safeTitle}) /Producer (feishu-retail-ops labelPrintArtifactService) >>`));
  }

  list.forEach((page, index) => {
    const { pageId, contentId, imageId } = pageIds[index];
    const wPt = mmToPt(page.widthMm);
    const hPt = mmToPt(page.heightMm);
    const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    const jpeg = Buffer.isBuffer(page.jpeg) ? page.jpeg : Buffer.from(page.jpeg || '');

    objects.set(pageId, Buffer.from(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${wPt} ${hPt}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    objects.set(contentId, Buffer.from(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ));
    // ⚠️ 图片流是**二进制**：必须是独立的 Buffer 拼进来（字符串模板会把 JPEG 弄坏）。
    const imageHead = Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    objects.set(imageId, Buffer.concat([imageHead, jpeg, Buffer.from('\nendstream')]));
  });

  const chunks = [];
  let offset = 0;
  const push = (buffer) => {
    chunks.push(buffer);
    offset += buffer.length;
  };
  // 二进制注释行：告诉所有工具"这是二进制文件"，别按文本处理（PDF 规范推荐）。
  push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'));

  // ⚠️ 偏移必须**逐字节**对得上，否则她的打印机驱动会直接打不开 —— 用累计 offset，不靠估算。
  const offsets = new Map();
  const ids = [...objects.keys()].sort((left, right) => left - right);
  for (const id of ids) {
    const body = objects.get(id);
    if (!body) continue;
    offsets.set(id, offset);
    push(Buffer.from(`${id} 0 obj\n`));
    push(body);
    push(Buffer.from('\nendobj\n'));
  }

  const xrefOffset = offset;
  const maxId = ids[ids.length - 1];
  const lines = ['xref', `0 ${maxId + 1}`, '0000000000 65535 f '];
  for (let id = 1; id <= maxId; id += 1) {
    const at = offsets.get(id);
    lines.push(at === undefined
      ? '0000000000 65535 f '
      : `${String(at).padStart(10, '0')} 00000 n `);
  }
  push(Buffer.from(`${lines.join('\n')}\n`));
  push(Buffer.from(
    `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`,
  ));
  return Buffer.concat(chunks);
}

/**
 * 一整批标签 → 可打印产物（**纯函数**，不落盘）。
 * 返回：
 *   · `pdf`      —— 送打印机的那一份（N 页，每页 40×30mm）；
 *   · `pngFirst` —— 第一页的 PNG（kept 时写盘：测试打印 / 排障 / 本地页面预览）；
 *   · `pages`    —— 每页的元信息（编号 / 尺寸 / 像素），进任务记录供页面显示。
 */
async function renderLabels({ labels, layout, config = {}, logger = null }) {
  const list = Array.isArray(labels) ? labels : [];
  if (!list.length) throw new Error('没有可打印的标签（renderLabels 收到空列表）');
  const dpi = num(config.dpi, 203);
  // ⭐⭐ 画布方向：`canvas` 决定"按哪个画布排版"（竖版 = 旋转画布、原尺寸铺满）；
  //    `rotate` / `rotatePageWithContent` 是更底层的旋钮（老路 A/B/C 都靠它们精确复现）。
  const canvas = normalizeCanvas(config.canvas);
  const rotate = normalizeRotation(config.rotate);
  const rotatePageWithContent = Boolean(config.rotatePageWithContent);
  const page = canvasGeometry(layout, { canvas, rotate, rotatePageWithContent });
  const pages = [];
  let pngFirst = null;
  for (const label of list) {
    const svg = labelSvg(label, layout, { dpi, canvas, rotate, rotatePageWithContent });
    const png = await svgToPng(svg);
    if (!pngFirst) pngFirst = png;
    const jpeg = await pngToJpeg(png, { quality: config.jpegQuality });
    pages.push({
      jpeg,
      // ⚠️ 这两个是**页面**尺寸（可能已经跟着转过），不是标签自身尺寸。
      widthPx: mmToPx(page.pageW, dpi),
      heightPx: mmToPx(page.pageH, dpi),
      widthMm: page.pageW,
      heightMm: page.pageH,
      number: label.number || label.key || '',
      item_no: label.item_no || '',
      color: label.color || '',
      sizes: (label.sizes || []).map((item) => `${item.size}×${item.qty}`).join(' '),
      total_qty: label.total_qty ?? null,
    });
  }
  const pdf = buildPdf(pages.map((page1) => ({
    jpeg: page1.jpeg, widthPx: page1.widthPx, heightPx: page1.heightPx, widthMm: page1.widthMm, heightMm: page1.heightMm,
  })), { title: `labels-${pages.length}` });
  if (logger && typeof logger.info === 'function') {
    logger.info('label_print.artifact.rendered', {
      pages: pages.length,
      dpi,
      canvas,
      rotate: page.rotate,
      scale: page.scale,
      // ⚠️ 竖版画布下这个旋钮**被忽略** ⇒ 如实回报 false（不是"配了没生效还不知道"）。
      rotate_page_with_content: page.allowSwap || undefined,
      pdf_bytes: pdf.length,
      page_mm: `${page.pageW}x${page.pageH}`,
      canvas_mm: `${page.designW}x${page.designH}`,
    });
  }
  return {
    pdf,
    pngFirst,
    pages: pages.map(({ jpeg, ...rest }) => rest),
    meta: {
      dpi,
      canvas,
      // 内容相对页面实际转了多少度（竖版画布 = 90 + rotate）
      rotate: page.rotate,
      // 1 = **原尺寸**（铺满）；<1 只会出现在"横版 + 转 90° + 不换页面"那条老路上
      scale: page.scale,
      rotate_page_with_content: page.allowSwap,
      // 页面尺寸（送打印机那一份的真实 MediaBox）
      width_mm: page.pageW,
      height_mm: page.pageH,
      width_pt: mmToPt(page.pageW),
      height_pt: mmToPt(page.pageH),
      // 逻辑画布（"按哪个方向排版"）与标签自身尺寸
      canvas_width_mm: page.designW,
      canvas_height_mm: page.designH,
      label_width_mm: page.labelW,
      label_height_mm: page.labelH,
      page_count: pages.length,
      pdf_bytes: pdf.length,
    },
  };
}

module.exports = {
  FONT_FAMILY,
  LINE_HEIGHTS,
  MM_TO_PT,
  ROTATIONS,
  CANVASES,
  normalizeCanvas,
  canvasGeometry,
  escapeXml,
  textWidthMm,
  availableWidthMm,
  planItemNoColor,
  placeQrSvg,
  normalizeRotation,
  pageSizeMm,
  rotationTransform,
  labelSvg,
  svgToPng,
  pngToJpeg,
  buildPdf,
  renderLabels,
  mmToPt,
  mmToPx,
  round,
};
