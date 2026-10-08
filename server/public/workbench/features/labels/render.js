/**
 * 鞋盒标签打印的**纯渲染**（不碰 DOM、不发请求）—— 单独一个文件，是为了能被测试直接跑：
 * `labelPrintRender.test.js` 把本文件当模块 import，断言"**尺寸 / 字号 / 字段开关来自服务端
 * 传下来的 config**"真的落在了 `@page` 与 CSS 变量上，而不是写死在样式里。
 *
 * ⚠️ 分工（与 service 的边界）：
 *   · service 回答「**印什么**」（品牌/货号/颜色·品类/尺码+数量/单价/二维码 SVG/底部小字，
 *     以及尺码**分几行**）；
 *   · 本文件回答「**怎么摆**」—— 但**一个 mm 都不写死**：所有尺寸都从 `layout`（= 服务端
 *     `config/labelPrint.js`）里取。改标签纸尺寸 = 改服务端 config，这一层不用动。
 *
 * ⚠️ 她 2026-10-08 **定案**的版式（40×30mm，打样 `docs/prototypes/label-40x30-203dpi-fit.png`）：
 *    左二维码（15×15mm、竖向居中）+ 右栏自上而下 = 品牌（小灰字）· 货号（最大字）·
 *    颜色 · 品类 · 尺码+数量角标（最多两行，超出留 `…`）· 单价。
 *    所以这里只出 HTML + 内联 SVG 二维码，靠 CSS 的 mm 与 `@page` 排版（不出 PNG、不用 sharp）。
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

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

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
  const columns = Math.max(1, Math.floor(num(grid.columns, 1)));
  // 数量角标：字号 = 尺码字号 × 比例（比例来自 config，不写死）；下沉量直接就是 CSS 的 em 值。
  const sizeMm = num(typography.sizeMm, 2.8);
  const qtyRatio = num(sizes.qtyFontRatio, 0.64);
  const qtyShiftEm = num(sizes.qtyBaselineShiftEm, 0.2);
  return [
    `--label-w: ${num(label.widthMm, 40)}mm`,
    `--label-h: ${num(label.heightMm, 30)}mm`,
    `--label-pad: ${num(label.paddingMm, 1.5)}mm`,
    `--gap-x: ${num(grid.gapXMm, 0)}mm`,
    `--gap-y: ${num(grid.gapYMm, 0)}mm`,
    `--cols: ${columns}`,
    `--sheet-w: ${num(grid.usableWidthMm, 0)}mm`,
    `--qr-size: ${num(typography.qrSizeMm, 15)}mm`,
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
 * 一张标签。
 * ⚠️ 二维码 SVG **原样内联**（服务端用纯 JS 的 `qrcode` 生成，内容只有我们自己的 URL），
 *    文字一律 `escapeHtml`（货号/颜色来自表，可能带 `&`、`<`）。
 */
export function labelHtml(label, layout) {
  const { fields } = layout;
  // 右栏逐行（与打样图同一版式）：品牌 → 货号（最大字）→ 颜色 · 品类 → 尺码+数量 → 单价。
  const lines = [];
  if (fields.color || fields.category) {
    lines.push([fields.color ? value(label.color, layout) : '', fields.category ? value(label.category, layout) : '']
      .filter(Boolean).join(' · '));
  }
  // 「所属状态」打样图上没有 ⇒ 默认不印；开关打开时印在尺码之前（一行）。
  if (fields.state) lines.push(value(label.state_text, layout));
  const qr = fields.qr && label.qr_svg
    ? `<div class="label-qr" aria-hidden="true">${label.qr_svg}</div>`
    : '';
  return `<article class="label" data-record-id="${escapeHtml(label.number || label.key || label.record_id || '')}">
      <div class="label-main">
        ${qr}
        <div class="label-body">
          ${fields.brand && label.brand_text ? `<div class="label-brand">${escapeHtml(label.brand_text)}</div>` : ''}
          ${fields.itemNo ? `<div class="label-item-no">${escapeHtml(label.item_no || '')}</div>` : ''}
          ${lines.filter(Boolean).map((line) => `<div class="label-field">${escapeHtml(line)}</div>`).join('')}
          ${fields.size ? sizeLinesHtml(label, layout) : ''}
          ${fields.price && label.price_text ? `<div class="label-price">${escapeHtml(label.price_text)}</div>` : ''}
        </div>
      </div>
      ${fields.footer ? `<div class="label-footer">${escapeHtml(label.footer_text || '')}</div>` : ''}
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
