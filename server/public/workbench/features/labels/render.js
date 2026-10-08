/**
 * 鞋盒标签打印的**纯渲染**（不碰 DOM、不发请求）—— 单独一个文件，是为了能被测试直接跑：
 * `labelPrintRender.test.js` 把本文件当模块 import，断言"**尺寸 / 字号 / 品牌位置 / 右栏行序 /
 * 字段开关全部来自服务端传下来的 config**"真的落在了 `@page`、CSS 变量与 HTML 结构上，
 * 而不是写死在样式里。
 *
 * ⚠️ 分工（与 service 的边界）：
 *   · service 回答「**印什么**」（品牌/货号/颜色/品类/尺码+数量/单价/二维码 SVG/底部小字，
 *     以及尺码**分几行**）；
 *   · 本文件回答「**怎么摆**」—— 但**一个 mm、一个行序都不写死**：所有尺寸与行序都从
 *     `layout`（= 服务端 `config/labelPrint.js`）里取。改标签纸尺寸 / 品牌位置 / 右栏行序
 *     = 改服务端 config，这一层不用动。
 *
 * ⚠️ 她 2026-10-08 **看了实物标签之后**定案的版式（40×30mm）：
 *     ```
 *                  邯美皮鞋                ← 品牌：**顶部居中**（跨整张标签宽度）
 *     ┌────────┐  0225  棕色 · B          ← 右栏第一行：货号（大字）+ 颜色 · 品类
 *     │ 二维码  │  ¥198                   ← 右栏第二行：单价
 *     └────────┘  36₁ 37₁ 38₁            ← 下面：尺码区（数量角标，数值升序）
 *                 39₁ 40₁
 *     ```
 *     「右栏自上而下放什么」= `layout.body.rows`；「品牌在顶部还是右栏里」= `layout.body.brandRow`。
 *     所以这里只出 HTML + 内联 SVG 二维码，靠 CSS 的 mm 与 `@page` 排版（不出 PNG、不用 sharp）。
 *
 * ⚠️ **货号绝不许压到二维码上**：右栏可用宽度 ≈ 20.5mm，货号一长就挤 —— 处理办法（先丢品类、
 *    再缩字号、最后截断）**全在 config 的 `body.itemNoColor` 里**，本文件的 `planItemNoColor`
 *    只负责执行；此外这一行永远是 `nowrap + overflow: hidden`（第二道保险，见 labels.css）。
 *
 * ⚠️ **数量角标不是 Unicode 下标字符**（`₁` 那种在部分字体下会显示成方框）：
 *    角标是**真的 `<span class="label-size-qty">`**，字号与下沉量都来自 config
 *    （`layout.sizes.qtyFontRatio` / `qtyBaselineShiftEm`）。
 */
import { escapeHtml } from '../../core/formatters.js';

/**
 * 页面上的**用户可见文案**（页面常量）—— 与她看到的字一一对应，改文案只改这里。
 * 后端来的文案（缺值占位 `—`、省略号 `…`）在 `layout.texts` 里，不在这里重写。
 */
export const TEXTS = {
  title: '鞋盒标签打印',
  subtitle: '按条件挑出要打的货 → 每个「编号」一张标签（尺码那一项带各尺码的库存数量）→ 用浏览器打印，A4 一页铺多张',
  printButton: '打印这些标签',
  printHint: '打印时选 A4、缩放 100%（不要"适应页面"）、关掉页眉页脚；出来就是标签纸的尺寸（见下面"每页 N 张"那句），沿虚线剪开贴鞋盒。',
  queryButton: '查询可打印的标签',
  loading: '正在读取「实时库存」…',
  emptyTitle: '没有匹配的库存',
  emptyHint: '换个货号、状态或尺码再试；也可能这些条件下一双都没有。',
  initial: '正在准备…',
  printDisabled: '还没有可打印的标签',
  scanUrlCaption: '标签上的二维码指向：',
};

/** 筛选器的可选项（页面常量；服务端还会按 `layout.filters` 校验一遍）。 */
export const FILTER_OPTIONS = {
  states: ['', '门盒', '样品', '仓库'],
  stateLabels: { '': '全部状态' },
  recentDays: [0, 1, 3, 7, 30],
  recentDayLabels: { 0: '不限', 1: '最近 1 天', 3: '最近 3 天', 7: '最近 7 天', 30: '最近 30 天' },
  sorts: ['shelf', 'recent'],
  sortLabels: { shelf: '货架顺序（货号 → 颜色 → 类别）', recent: '最近新增在前' },
};

/** 右栏行序的兜底（服务端没给 `body.rows` 时用；**唯一真源仍是服务端 config**）。 */
const DEFAULT_ROWS = ['brand', 'itemNoColor', 'price', 'state', 'sizes'];

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** 数值 → 写进 CSS 的 mm 字符串（去掉浮点尾巴，免得 `2.3999999mm` 这种值进 DOM）。 */
const mm = (value, fallback = 0) => `${Number(num(value, fallback).toFixed(3))}mm`;

/**
 * `@page` 规则 —— **整页排版的地基**：纸张尺寸与打印机边距都来自 config。
 * ⚠️ `@page` 里**不能用 CSS 变量**（浏览器不支持），所以这一段是拼出来的字符串，
 *    由页面在运行时插进 `<style>`。这也是"改 config 就能换纸张"的落点。
 */
export function pageStyleText(layout) {
  const { page } = layout;
  const margin = page.marginMm || {};
  return `@page { size: ${num(page.widthMm, 210)}mm ${num(page.heightMm, 297)}mm;`
    + ` margin: ${num(margin.top)}mm ${num(margin.right)}mm ${num(margin.bottom)}mm ${num(margin.left)}mm; }`;
}

/** 标签纸容器上的 CSS 变量 —— 尺寸 / 间距 / 字号 / 每行列数，全部来自 config。 */
export function sheetStyleVars(layout) {
  const { label, grid, typography } = layout;
  const sizes = layout.sizes || {};
  const body = layout.body || {};
  const columns = Math.max(1, Math.floor(num(grid.columns, 1)));
  // 数量角标：字号 = 尺码字号 × 比例（比例来自 config，不写死）；下沉量直接就是 CSS 的 em 值。
  const sizeMm = num(typography.sizeMm, 2.8);
  const qtyRatio = num(sizes.qtyFontRatio, 0.64);
  const qtyShiftEm = num(sizes.qtyBaselineShiftEm, 0.2);
  return [
    `--label-w: ${num(label.widthMm, 40)}mm`,
    `--label-h: ${num(label.heightMm, 30)}mm`,
    `--label-pad: ${num(label.paddingMm, 1.5)}mm`,
    `--label-border: ${mm(label.borderMm, 0.2)}`,
    `--gap-x: ${num(grid.gapXMm, 0)}mm`,
    `--gap-y: ${num(grid.gapYMm, 0)}mm`,
    `--cols: ${columns}`,
    `--sheet-w: ${num(grid.usableWidthMm, 0)}mm`,
    `--qr-size: ${num(typography.qrSizeMm, 15)}mm`,
    `--qr-gap: ${mm(body.qrGapMm, 1.5)}`,
    `--brand-gap: ${mm(body.brandGapMm, 0.6)}`,
    `--item-no-gap: ${mm(body.itemNoColor?.gapMm, 1.2)}`,
    `--item-no-size: ${num(typography.itemNoMm, 3.6)}mm`,
    `--brand-size: ${num(typography.brandMm, 2.4)}mm`,
    `--field-size: ${num(typography.fieldMm, 2.8)}mm`,
    `--size-size: ${sizeMm}mm`,
    `--size-qty-size: ${Number((sizeMm * qtyRatio).toFixed(3))}mm`,
    `--size-qty-shift: -${qtyShiftEm}em`,
    `--size-gap: ${num(sizes.itemGapMm, 1)}mm`,
    `--price-size: ${num(typography.priceMm, 3.2)}mm`,
    `--footer-size: ${num(typography.footerMm, 1.7)}mm`,
  ].join('; ');
}

/** 一个字段值 → 印出来的字（空值用 config 里的占位，不留空）。 */
const value = (raw, layout) => String(raw ?? '').trim() || layout.texts.missingValue;

/**
 * 右栏可用宽度（mm）= 标签宽 − 左右留白 − 裁切线 − 二维码（开着时）− 二维码与右栏的空隙。
 * 40×30 + 15mm 二维码 + 1.5mm 留白 + 0.2mm 裁切线 ⇒ **20.1mm** —— 货号+颜色同行够不够就按这个判。
 * ⚠️ 二维码关掉时右栏拿走整张宽度（排版自然变宽，不用改代码）。
 * ⚠️ 页面用的是 `box-sizing: border-box`（`styles/base.css`）⇒ 裁切线占宽度，必须减掉。
 */
export function availableWidthMm(layout) {
  const label = layout.label || {};
  const body = layout.body || {};
  const fields = layout.fields || {};
  const qr = fields.qr === false ? 0 : num(layout.typography?.qrSizeMm, 15) + num(body.qrGapMm, 1.5);
  const borders = num(label.borderMm, 0.2) * 2;
  return Math.max(0, num(label.widthMm, 40) - num(label.paddingMm, 1.5) * 2 - borders - qr);
}

/**
 * 字符 → 占多少 em（三档都不是猜的：按页面实际字体量过 —— 数字 ≈ 0.60、大写字母 ≈ 0.67、
 * `·` / `-` ≈ 0.72、空格 ≈ 0.2、中文 = 1）。**名单与系数全部来自 config**
 * （`body.itemNoColor.widthEm`）；不在名单里、又不是全角的，按 `ascii` 保守估。
 */
const charEm = (char, em) => {
  if ((Array.isArray(em.narrowChars) ? em.narrowChars : []).includes(char)) return num(em.narrow, 0.25);
  if ((Array.isArray(em.wideChars) ? em.wideChars : []).includes(char)) return num(em.wide, 0.72);
  return (char.codePointAt(0) >= 0x2e80 ? num(em.cjk, 1) : num(em.ascii, 0.66));
};

/** 一个字符占多宽（mm）= em 系数 × 字号。 */
const charWidthMm = (char, fontMm, em) => charEm(char, em) * fontMm;

/** 一段文字估多宽（mm）—— 纯估算，只为"缩到多小 / 截到几个字"；兜底的是 CSS 的 nowrap + hidden。 */
export function textWidthMm(text, fontMm, em = {}) {
  let width = 0;
  for (const char of String(text ?? '')) width += charWidthMm(char, fontMm, em);
  return width;
}

/**
 * 把一段文字截到 `maxMm` 以内：放得下原样返回；放不下就"能放几个字放几个字 + 省略号"。
 * 连省略号都放不下 ⇒ 返回空串（**宁可留白也不越过右栏边界**）。
 */
const fitTextMm = (text, fontMm, maxMm, em, mark) => {
  if (textWidthMm(text, fontMm, em) <= maxMm) return text;
  const markMm = textWidthMm(mark, fontMm, em);
  if (markMm > maxMm) return '';
  let out = '';
  let width = 0;
  for (const char of String(text ?? '')) {
    const charMm = charWidthMm(char, fontMm, em);
    if (width + charMm + markMm > maxMm) break;
    out += char;
    width += charMm;
  }
  return `${out}${mark}`;
};

/**
 * 「货号 + 颜色（· 品类）」这一行的**排布方案**（她定案的第一行）—— 纯函数，可直接断言。
 * 优先顺序（默认，`preferColorOverCategory: true`）：
 *   ① 货号原字号 + 颜色 + 品类 全放得下 → 都印；
 *   ② 只差一点点（货号**缩一点**、但不必缩到 `minItemNoMm`、也不用截断）就能全放下 → 缩货号、品类照印
 *      （她给的样子就是这一档：`0225 棕色 · B`）；
 *   ③ 要牺牲货号才塞得下品类 → **丢品类、保颜色**（她定案「放不下优先保颜色」），再按 ④ 处理货号；
 *   ④ 货号自己太宽 → 从 `itemNoMm` 往下缩，最多缩到 `minItemNoMm`；缩到底还放不下就**截断补 `…`**。
 * `preferColorOverCategory: false` 时 ③ 不丢品类，而是把货号缩到最小 / 截断也要保住品类。
 * 返回的 `estimatedWidthMm` 永远 ≤ `availableWidthMm`（"不越界"这条不变量有单测钉着）。
 */
export function planItemNoColor(label, layout) {
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
  const available = availableWidthMm(layout);

  const itemNo = fields.itemNo ? value(label.item_no, layout) : '';
  const color = fields.color ? value(label.color, layout) : '';
  const category = fields.category ? value(label.category, layout) : '';
  const withCategory = [color, category].filter(Boolean).join(separator);
  const colorOnly = color || category;

  /** 在"颜色占了这么多宽度之后"，货号能怎么办（缩 → 截断）。 */
  const fitItem = (availMm) => {
    if (!itemNo) return { sizeMm: itemNoMm, text: '', truncated: false };
    const fullMm = textWidthMm(itemNo, itemNoMm, em);
    if (fullMm <= availMm) return { sizeMm: itemNoMm, text: itemNo, truncated: false };
    const ratio = availMm > 0 ? availMm / fullMm : 0;
    const sizeMm = Math.max(minItemNoMm, Math.min(itemNoMm, itemNoMm * ratio));
    if (textWidthMm(itemNo, sizeMm, em) <= availMm) return { sizeMm, text: itemNo, truncated: false };
    const text = fitTextMm(itemNo, sizeMm, availMm, em, mark);
    return { sizeMm, text, truncated: text !== itemNo };
  };
  /** "这一行印这些颜色文字"时的完整方案。 */
  const planFor = (colorText) => {
    const availMm = available - gapMm - textWidthMm(colorText, fieldMm, em);
    return { ...fitItem(availMm), colorText };
  };

  let plan;
  let categoryIncluded = false;
  if (withCategory) {
    const withCat = planFor(withCategory);
    // 品类要印得住：货号**不必缩到最小字号、也不必截断**；否则（默认口径下）让位给颜色。
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

  // 颜色自己的兜底（只有"颜色文本比整条右栏还长"这种极端情况才会走到）。
  const itemWidthMm = textWidthMm(plan.text, plan.sizeMm, em);
  const colorRoomMm = Math.max(0, available - gapMm - itemWidthMm);
  let colorText = plan.colorText;
  let colorTruncated = false;
  if (textWidthMm(colorText, fieldMm, em) > colorRoomMm) {
    colorText = fitTextMm(colorText, fieldMm, colorRoomMm, em, mark);
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
}

/**
 * 尺码那一项：**在 service 已经分好的行**里，把每个尺码画成 `38` + 数量角标（小号字下沉）。
 * ⚠️ **不用 Unicode 下标字符** —— 角标是真的 `<span>`，字号 / 下沉量来自 config。
 * ⚠️ 两行都放不下时（`size_overflow`），**最后一行尾上补一个 `…`** —— 省略是看得见的。
 */
export function sizeLinesHtml(label, layout) {
  const lines = Array.isArray(label.size_lines)
    ? label.size_lines.filter((tokens) => Array.isArray(tokens) && tokens.length)
    : [];
  if (!lines.length) return '';
  const mark = escapeHtml(layout.texts?.overflowMark || '…');
  return lines.map((tokens, index) => {
    const body = tokens.map((token) => {
      const size = escapeHtml(token.size);
      const qty = escapeHtml(token.qty);
      return `<span class="label-size">${size}<span class="label-size-qty">${qty}</span></span>`;
    }).join('');
    const overflow = index === lines.length - 1 && label.size_overflow
      ? `<span class="label-size-more">${mark}</span>`
      : '';
    return `<div class="label-sizes">${body}${overflow}</div>`;
  }).join('');
}

/**
 * 右栏**每一行怎么画** —— 键就是 `layout.body.rows` 里的行名。
 * 加减行 / 换顺序只改服务端 config 的 `rows`，这里不用动（渲染层只认行名）。
 */
const ROW_RENDERERS = {
  brand: (label, layout) => (layout.fields?.brand && label.brand_text
    ? `<div class="label-brand">${escapeHtml(label.brand_text)}</div>`
    : ''),
  // 第一行：货号（大字，可能缩小 / 截断）+ 颜色 · 品类（放不下先丢品类 —— 见 planItemNoColor）。
  itemNoColor: (label, layout) => {
    const plan = planItemNoColor(label, layout);
    if (!plan.itemNoText && !plan.colorText) return '';
    const itemNo = plan.itemNoText
      ? `<span class="label-item-no">${escapeHtml(plan.itemNoText)}</span>`
      : '';
    const color = plan.colorText
      ? `<span class="label-color">${escapeHtml(plan.colorText)}</span>`
      : '';
    const truncated = plan.itemNoTruncated || plan.colorTruncated;
    return `<div class="label-item-line" style="--item-no-size: ${mm(plan.itemNoSizeMm, layout.typography?.itemNoMm)}"`
      + `${truncated ? ' data-truncated="true"' : ''}>${itemNo}${color}</div>`;
  },
  // 第二行：单价（她要"价格第二行"）。
  price: (label, layout) => (layout.fields?.price && label.price_text
    ? `<div class="label-price">${escapeHtml(label.price_text)}</div>`
    : ''),
  // 所属状态（默认 `fields.state = false` ⇒ 不印；开关打开就按 config 的行序印）。
  state: (label, layout) => (layout.fields?.state
    ? `<div class="label-state">${escapeHtml(value(label.state_text, layout))}</div>`
    : ''),
  // 下面：尺码区（带数量角标，数值升序，放不下自动换行、再溢出补 …）。
  sizes: (label, layout) => (layout.fields?.size ? sizeLinesHtml(label, layout) : ''),
};

/**
 * 一张标签。
 * ⚠️ 结构完全由 config 决定：品牌在**顶部跨整张**（`body.brandRow = 'top'`，她定案）还是
 *    留在右栏里（`'inline'`）；右栏自上而下印哪几行看 `body.rows`。
 * ⚠️ 二维码 SVG **原样内联**（服务端用纯 JS 的 `qrcode` 生成，内容只有我们自己的 URL），
 *    文字一律 `escapeHtml`（货号/颜色来自表，可能带 `&`、`<`）。
 */
export function labelHtml(label, layout) {
  const body = layout.body || {};
  const rows = Array.isArray(body.rows) && body.rows.length ? body.rows : DEFAULT_ROWS;
  const brandText = layout.fields?.brand && label.brand_text ? label.brand_text : '';
  // `brandRow: 'top'`（默认）= 品牌印在标签最上面一行、跨左右；'inline' = 老版式（右栏里那一行）。
  const brandOnTop = body.brandRow !== 'inline';
  const rowsToRender = rows.filter((id) => id !== 'brand' || (brandText && !brandOnTop));
  const bodyHtml = rowsToRender
    .map((id) => (ROW_RENDERERS[id] ? ROW_RENDERERS[id](label, layout) : ''))
    .filter(Boolean)
    .join('');
  const qr = layout.fields?.qr && label.qr_svg
    ? `<div class="label-qr" aria-hidden="true">${label.qr_svg}</div>`
    : '';
  const topBrand = brandOnTop && brandText
    ? `<div class="label-brand label-brand-top" style="text-align: ${escapeHtml(String(body.brandAlign || 'center'))}">${escapeHtml(brandText)}</div>`
    : '';
  return `<article class="label" data-record-id="${escapeHtml(label.number || label.key || label.record_id || '')}">
      ${topBrand}
      <div class="label-main">
        ${qr}
        <div class="label-body">${bodyHtml}</div>
      </div>
      ${layout.fields?.footer ? `<div class="label-footer">${escapeHtml(label.footer_text || '')}</div>` : ''}
    </article>`;
}

/** 整张标签纸（空结果时给一块明确的空白提示，**不炸**）。 */
export function sheetHtml(labels, layout) {
  if (!labels || !labels.length) {
    return `<div class="label-empty"><strong>${escapeHtml(TEXTS.emptyTitle)}</strong>`
      + `<span>${escapeHtml(TEXTS.emptyHint)}</span></div>`;
  }
  return labels.map((label) => labelHtml(label, layout)).join('');
}

/**
 * 结果概要 —— 把"匹配几个编号 / 一共几双 / 显示几张 / 每页几张 / 有没有被截断 /
 * 有没有读不出来的记录 / 有没有编号读不到单价"一次说清（**不静默**）。
 */
export function summaryHtml(data) {
  const grid = data.layout?.grid || {};
  const lines = [
    `匹配 <strong>${escapeHtml(data.total_matched)}</strong> 张标签（一张 = 一个编号）｜`
    + `一共 <strong>${escapeHtml(data.total_pairs ?? 0)}</strong> 双库存｜`
    + `本次显示 <strong>${escapeHtml(data.total_returned)}</strong> 张｜`
    + `${escapeHtml(data.layout?.page?.name || 'A4')} 每页 ${escapeHtml(grid.perPage)} 张`
    + `（${escapeHtml(grid.columns)} 列 × ${escapeHtml(grid.rows)} 行，`
    + `每张 ${escapeHtml(data.layout?.label?.widthMm)}×${escapeHtml(data.layout?.label?.heightMm)}mm）`,
  ];
  const notices = [];
  if (data.truncated) {
    notices.push(`⚠️ 匹配 ${data.total_matched} 个编号，一次最多印 ${data.max_labels} 张 —— `
      + '请再收窄条件（例如加上货号 / 状态 / 尺码），别漏了后面的。');
  }
  const skipped = data.skipped_records?.total || 0;
  if (skipped) {
    notices.push(`⚠️ 有 ${skipped} 条「实时库存」读不出货号/尺码或所属状态为空，已跳过 —— 它们不在上面的张数里。`);
  }
  if (data.filters?.recent_days > 0 && data.missing_created_at) {
    notices.push(`⚠️ 有 ${data.missing_created_at} 条没有「创建时间」，按「最近新增」筛选时被排除。`);
  }
  if (data.missing_price) {
    notices.push(`⚠️ 有 ${data.missing_price} 个编号在「货品信息」里读不到「单价」—— `
      + '这些标签照常打印，只是不印价格（缺的资料补上后重新查一次就有了）。');
  }
  return `<p class="label-summary">${lines.join('')}</p>`
    + notices.map((notice) => `<p class="label-notice">${escapeHtml(notice)}</p>`).join('');
}
