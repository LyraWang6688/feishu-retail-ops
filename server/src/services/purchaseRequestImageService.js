const sharp = require('sharp');

/**
 * 「采购申请」明细 → 一张可以直接转发给供应商的 PNG 图片。
 *
 * 为什么要有这个模块：
 * 供应商不用飞书，产品负责人要把「这批找谁订什么」发给对方。
 * 之前她是在飞书表格里截图或者手打，容易漏行、也说不清尺码。
 * 这里把同一个供应商的明细拼成一张单子，她点一下就能转给微信里的供应商。
 *
 * 为什么是 SVG + sharp 而不是 canvas / puppeteer：
 * sharp 本来就在依赖里（图片处理用），它带的 librsvg 能把 SVG 直接转 PNG，
 * 不引入任何新依赖、也不需要 Chromium。排版做成字符串，纯函数可单测。
 *
 * ⚠️ 字体是这里最容易静默出错的地方：服务器只有 fonts-noto-cjk，
 * 没有 fontconfig 的显式配置。SVG 里必须**显式写死** CJK 字体名，
 * 否则中文会渲染成一个个方框，而且不会报错——只有人眼能看出来。
 * 所以 font-family 是一整条候选链，最后兜底到 sans-serif。
 */
const FONT_FAMILY = 'Noto Sans CJK SC, Noto Serif CJK SC, Noto Sans SC, WenQuanYi Zen Hei, sans-serif';

const TITLE = '邯美皮鞋采购申请单';
// 「采购退货单」复用同一套排版（列、字号、合计口径全都一样），只换标题——
// 业务负责人的口径就是"格式和采购申请单一样"。标题做成参数而不是复制一份渲染器：
// 复制一份的话，以后改列宽/截断规则就得改两处，两边迟早会长歪。
const RETURN_TITLE = '邯美皮鞋采购退货单';

// 布局常量（单位 px）。宽度取 900：手机微信里放大看货号够清楚，
// 又不至于大到飞书图片消息再次压缩后糊掉。
const WIDTH = 900;
const MARGIN = 40;
const TABLE_WIDTH = WIDTH - MARGIN * 2; // 820
const ROW_HEIGHT = 42;
const HEADER_ROW_HEIGHT = 48;
const TABLE_TOP = 168;
const TITLE_BASELINE = 78;
const SUBTITLE_BASELINE = 118;
const FOOTER_GAP = 18;
const FOOTER_HEIGHT = 52;
const BOTTOM_PADDING = 36;

// 列宽之和必须等于 TABLE_WIDTH（820）。货号内容最长、给最多空间。
// maxWidth 是单元格能画字的像素宽度（列宽减去左右各 16 的内边距）。
// ⚠️ 截断必须按**像素宽度**而不是字符数：一个汉字在 22px 字号下就占 22px，
// 按字符数限制会让 12 个汉字的颜色轻松捅进「尺码」列（真机渲染验证时踩到过）。
const CELL_PADDING = 16;
const COLUMNS = [
  { key: 'item_no', label: '货号', width: 320, align: 'start' },
  { key: 'color', label: '颜色', width: 220, align: 'start' },
  { key: 'size', label: '尺码', width: 140, align: 'center' },
  { key: 'quantity', label: '数量', width: 140, align: 'center' },
].map((column) => ({ ...column, maxWidth: column.width - CELL_PADDING * 2 }));

const COLORS = {
  ink: '#1f2329',
  muted: '#646a73',
  line: '#c9cdd4',
  headerBg: '#eef1f5',
  stripeBg: '#f7f8fa',
  border: '#8f959e',
};

const escapeXml = (value) => String(value ?? '').replace(/[<>&'"]/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
}[char]));

// 估算一个字符占多宽：汉字/全角按字号 1:1，其余（数字、字母、半角符号）大约 0.56 倍。
// 这是估算不是精确排版——librsvg 的字体度量拿不到，但用来做"别捅出列宽"的判断足够了。
const FULL_WIDTH = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/;
const charWidth = (char, fontSize) => (FULL_WIDTH.test(char) ? fontSize : fontSize * 0.56);

/**
 * 按像素宽度截断，放不下就加省略号。
 * 用 Array.from 遍历，避免把 emoji / 代理对砍成半个。
 */
const truncateToWidth = (value, maxWidth, fontSize) => {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  const kept = [];
  let used = 0;
  for (const char of chars) {
    const width = charWidth(char, fontSize);
    if (used + width > maxWidth) {
      // 放不下了：先回退到还能容下省略号的位置，再加「…」
      while (kept.length && used + charWidth('…', fontSize) > maxWidth) {
        used -= charWidth(kept[kept.length - 1], fontSize);
        kept.pop();
      }
      return `${kept.join('')}…`;
    }
    kept.push(char);
    used += width;
  }
  return kept.join('');
};

// 尺码只给欧码。表里存的就是欧码数字，这里只负责补一个「码」字，
// 不再拼毫米数——供应商看的就是 37 这种码，双写反而容易看错。
const formatSize = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+(\.\d+)?$/.test(text) ? `${text}码` : text;
};

const formatQuantity = (value) => {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? String(quantity) : '0';
};

/**
 * 明细 → 可读的行。货号优先用「货号」字段，缺失时退回「编号」（货号+颜色），
 * 保证图上永远有东西能认出是哪双鞋。
 */
const normalizeItems = (items) => (Array.isArray(items) ? items : [])
  .map((item) => ({
    item_no: String(item?.item_no || item?.itemNo || item?.product_number || item?.productNumber || '').trim(),
    color: String(item?.color || '').trim(),
    size: formatSize(item?.size),
    quantity: formatQuantity(item?.quantity),
  }))
  .filter((item) => item.item_no || item.size);

const summarize = (items) => ({
  rowCount: items.length,
  totalPairs: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
});

const textAnchorOf = (align) => (align === 'center' ? 'middle' : align === 'end' ? 'end' : 'start');

const cellX = (index, align) => {
  const left = MARGIN + COLUMNS.slice(0, index).reduce((sum, column) => sum + column.width, 0);
  if (align === 'center') return left + COLUMNS[index].width / 2;
  if (align === 'end') return left + COLUMNS[index].width - CELL_PADDING;
  return left + CELL_PADDING;
};

const cellText = (column, index, value, y, options = {}) => {
  const fontSize = options.fontSize || 22;
  return `<text x="${cellX(index, column.align)}" y="${y}" ` +
    `font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="${options.fill || COLORS.ink}" ` +
    `${options.bold ? 'font-weight="bold" ' : ''}text-anchor="${textAnchorOf(column.align)}">` +
    `${escapeXml(truncateToWidth(value, column.maxWidth, fontSize))}</text>`;
};

const formatDate = (value) => {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
};

/**
 * 明细 → SVG 字符串。纯函数：同样的输入永远得到同样的字节，
 * 因此排版规则（标题、尺码写法、合计）都能在没有网络、没有 sharp 的情况下单测。
 */
const buildPurchaseRequestSvg = ({ supplierName, batchNo = '', items = [], generatedAt = new Date(),
  title = TITLE } = {}) => {
  const rows = normalizeItems(items);
  const { rowCount, totalPairs } = summarize(rows);
  const tableHeight = HEADER_ROW_HEIGHT + Math.max(rows.length, 1) * ROW_HEIGHT;
  const footerTop = TABLE_TOP + tableHeight + FOOTER_GAP;
  const height = footerTop + FOOTER_HEIGHT + BOTTOM_PADDING;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`);
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#ffffff"/>`);

  // 标题区：默认「邯美皮鞋采购申请单」，采购退货传「邯美皮鞋采购退货单」；
  // 下面一行写清这批是给谁、哪一批。
  parts.push(`<text x="${WIDTH / 2}" y="${TITLE_BASELINE}" font-family="${FONT_FAMILY}" font-size="34" ` +
    `font-weight="bold" fill="${COLORS.ink}" text-anchor="middle">${escapeXml(title)}</text>`);
  const subtitle = [
    supplierName ? `供应商：${truncateToWidth(supplierName, 300, 18)}` : '供应商：未填写',
    batchNo ? `报货批次：${truncateToWidth(batchNo, 300, 18)}` : '',
    formatDate(generatedAt),
  ].filter(Boolean).join('　　');
  parts.push(`<text x="${WIDTH / 2}" y="${SUBTITLE_BASELINE}" font-family="${FONT_FAMILY}" font-size="18" ` +
    `fill="${COLORS.muted}" text-anchor="middle">${escapeXml(subtitle)}</text>`);

  // 表头
  parts.push(`<rect x="${MARGIN}" y="${TABLE_TOP}" width="${TABLE_WIDTH}" height="${HEADER_ROW_HEIGHT}" fill="${COLORS.headerBg}"/>`);
  const headerTextY = TABLE_TOP + HEADER_ROW_HEIGHT / 2 + 7;
  COLUMNS.forEach((column, index) => {
    parts.push(cellText(column, index, column.label, headerTextY, { fontSize: 20, bold: true }));
  });

  // 明细行：空明细也要画一行「本批次没有明细」，否则整张图只剩标题，看着像渲染失败。
  if (rows.length === 0) {
    const y = TABLE_TOP + HEADER_ROW_HEIGHT + ROW_HEIGHT / 2 + 7;
    parts.push(`<text x="${WIDTH / 2}" y="${y}" font-family="${FONT_FAMILY}" font-size="22" ` +
      `fill="${COLORS.muted}" text-anchor="middle">本批次没有明细</text>`);
  } else {
    rows.forEach((row, rowIndex) => {
      const rowTop = TABLE_TOP + HEADER_ROW_HEIGHT + rowIndex * ROW_HEIGHT;
      if (rowIndex % 2 === 1) {
        parts.push(`<rect x="${MARGIN}" y="${rowTop}" width="${TABLE_WIDTH}" height="${ROW_HEIGHT}" fill="${COLORS.stripeBg}"/>`);
      }
      const y = rowTop + ROW_HEIGHT / 2 + 7;
      COLUMNS.forEach((column, index) => {
        parts.push(cellText(column, index, row[column.key], y));
      });
    });
  }

  // 表格边框 + 竖线：手写线条而不是 <table>，librsvg 对表格支持不稳定。
  const tableBottom = TABLE_TOP + tableHeight;
  parts.push(`<rect x="${MARGIN}" y="${TABLE_TOP}" width="${TABLE_WIDTH}" height="${tableHeight}" ` +
    `fill="none" stroke="${COLORS.border}" stroke-width="1.5"/>`);
  let lineX = MARGIN;
  for (let index = 0; index < COLUMNS.length - 1; index += 1) {
    lineX += COLUMNS[index].width;
    parts.push(`<line x1="${lineX}" y1="${TABLE_TOP}" x2="${lineX}" y2="${tableBottom}" ` +
      `stroke="${COLORS.line}" stroke-width="1"/>`);
  }
  parts.push(`<line x1="${MARGIN}" y1="${TABLE_TOP + HEADER_ROW_HEIGHT}" x2="${MARGIN + TABLE_WIDTH}" ` +
    `y2="${TABLE_TOP + HEADER_ROW_HEIGHT}" stroke="${COLORS.line}" stroke-width="1"/>`);

  // 合计：产品负责人要的是「条数 / 总双数」两个数，都写出来。
  const footerY = footerTop + FOOTER_HEIGHT / 2 + 8;
  parts.push(`<text x="${WIDTH / 2}" y="${footerY}" font-family="${FONT_FAMILY}" font-size="22" ` +
    `font-weight="bold" fill="${COLORS.ink}" text-anchor="middle">合计：${rowCount} 条 / ${totalPairs} 双</text>`);

  parts.push('</svg>');
  return parts.join('\n');
};

/**
 * SVG → PNG（Buffer）。这里只做一层薄薄的 sharp 封装，
 * 所有排版判断都留在 buildPurchaseRequestSvg 里，方便单测。
 *
 * 刻意不传 density：默认 72dpi 时输出像素就等于 SVG 里的 width/height（900px），
 * 传 144 会把图放大成 1800px——飞书图片消息会再压一次，反而更糊。
 */
const renderPurchaseRequestPng = async (input) => {
  const svg = buildPurchaseRequestSvg(input);
  return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
};

module.exports = {
  TITLE,
  RETURN_TITLE,
  FONT_FAMILY,
  buildPurchaseRequestSvg,
  renderPurchaseRequestPng,
  // 导出这些是为了单测能直接断言「尺码写法」「截断口径」和「合计口径」，
  // 而不是只能对着整段 SVG 字符串做模糊匹配。
  formatSize,
  summarize,
  normalizeItems,
  truncateToWidth,
  charWidth,
};
