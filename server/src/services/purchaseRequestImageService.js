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
 *
 * 排版（2026-10-06 业务负责人第二次拍板的「合并版」）：
 * 明细**先按货号分组**：每个货号一行跨列的「分组行」（有底色、字比正文重）；
 * 组内**再按颜色归并**：同货号 ＋ 同颜色 → **一行**（不同颜色各自一行），
 * 该颜色的所有尺码＋数量用「、」拼进**同一格**：`37码×1、41码×3`。
 * ⇒ 表结构 = 分组行（货号）＋ 两列「颜色 | 尺码×数量」（**不再有单独的数量列**）。
 * 一张图里放全部货号——不是每个货号出一张图（多图只在**多供应商**时出现，
 * 那是 purchaseWebhookService.groupItemsBySupplier 的事，跟这里无关）。
 *
 * ⚠️ 格式（列顺序 / 列宽 / 分隔符「、」/ 乘法号「×」/ 要不要合计）**不在本文件里写死**：
 * 全在 `config/purchaseRequestImageLayout.js`——这里是逻辑，那里是格式。
 * 采购单与退货单**共用这一个渲染器**（只换标题），所以改一处两张图一起变。
 */
const {
  WIDTH,
  MARGIN,
  TABLE_WIDTH,
  ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
  GROUP_ROW_HEIGHT,
  TABLE_TOP,
  TITLE_BASELINE,
  SUBTITLE_BASELINE,
  FOOTER_GAP,
  FOOTER_HEIGHT,
  BOTTOM_PADDING,
  CELL_PADDING,
  COLUMNS,
  COLORS,
  SHOW_TOTAL,
  SIZE_QUANTITY_SEPARATOR,
  SIZE_QUANTITY_MULTIPLIER,
} = require('../config/purchaseRequestImageLayout');

const FONT_FAMILY = 'Noto Sans CJK SC, Noto Serif CJK SC, Noto Sans SC, WenQuanYi Zen Hei, sans-serif';

// ⚠️ 2026-10-06 业务负责人拍板改的两个标题：出图是给她转给供应商的**单据**，
// 名字跟着单据走——报货出「采购单」、退货出「退货单」。
// （「单据信息」表里那个附件**字段名**仍叫「采购申请单」，那是生产表字段，不改。）
const TITLE = '邯美皮鞋采购单';
// 「退货单」复用同一套排版（列、字号、合计口径全都一样），只换标题——
// 业务负责人的口径就是"格式和采购单一样"。标题做成参数而不是复制一份渲染器：
// 复制一份的话，以后改列宽/截断规则就得改两处，两边迟早会长歪。
const RETURN_TITLE = '邯美皮鞋退货单';

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

// ─── 分组与组内排序（「🅱️ 分组版」的排版规则）────────────────────────────────
// 全部是纯函数：同样的输入永远得到同样的分组与顺序，可以脱离 sharp 单测。

// 货号缺失的明细（历史草稿可能只有尺码）也得有个分组行，
// 否则它会被并进上一组、看着像那一组的货。⚠️ 跟「供应商」一样：
// 这里给的是**显式的兜底标题**，不是悄悄不画。
const UNKNOWN_ITEM_NO = '未标注货号';

/**
 * 从「37码」这样的展示值里取数字，用来按**数字大小**排尺码。
 * ⚠️ 不能直接按字符串排：字符串序下 "40" < "9"（逐字符比 '4' < '9'），
 * 尺码就会变成 39/40/41 看着对、一遇到 40/9/41 就乱。
 * 取不到数字的（「均码」「XL」这类）返回 null → 由 compareSize 兜到**最后**。
 */
const sizeSortValue = (value) => {
  const match = /^(\d+(?:\.\d+)?)/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
};

/**
 * 尺码比较：数字升序；非数字尺码一律排在有数字的**后面**
 * （「均码」不该插在 39 和 40 中间）；同为非数字时按字符串兜底，
 * 保证顺序**确定**——排序不确定的代价是同一批数据两次出图长得不一样。
 */
const compareSize = (left, right) => {
  const a = sizeSortValue(left);
  const b = sizeSortValue(right);
  if (a === null && b === null) return left < right ? -1 : left > right ? 1 : 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a !== b) return a - b;
  // 数字相同但写法不同（理论上不会，formatSize 只会产出「37码」）：按字符串定序
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * 明细行 → 分组（**第一层：按货号**）。每条明细**只属于一个分组**。
 *
 * 排序规则（业务负责人 2026-10-06 拍板）：
 * - **货号**：按**首次出现顺序**排。选它而不是字典序，是因为明细的输入顺序
 *   本身就是"她报货的顺序"，字典序会把 A-1366 和 8088 混着重排，
 *   而且混合格式（货号 + 字母款号）的字典序对人没有意义。稳定、可预期优先。
 * - **颜色**：组内同样按**首次出现顺序**分组（同一颜色必须连续），
 *   理由同上——不去猜"哪种颜色该排前面"。
 * - **尺码**：颜色内按**数字**升序（见 compareSize），非数字尺码兜到最后。
 *
 * ⚠️ 这里**只排顺序、不合并行**：输出仍是"一个尺码一行"。把同颜色的行并成图上的一行
 * 是**下一层** `mergeSizesByColor` 的事——两层分开，各自的顺序规则才能单独单测。
 * 注意这里只重排**显示顺序**：`summarize` 仍然按传入的行数/数量求和，口径一个数都不变。
 */
const groupRowsByItemNo = (rows) => {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row?.item_no || '';
    if (!groups.has(key)) groups.set(key, { itemNo: key, label: key || UNKNOWN_ITEM_NO, rows: [] });
    groups.get(key).rows.push(row);
  });

  return [...groups.values()].map((group) => {
    // 颜色先按首次出现登记序号，再把组内行排成「颜色连续、颜色内尺码升序」。
    const colorOrder = new Map();
    group.rows.forEach((row) => {
      if (!colorOrder.has(row.color)) colorOrder.set(row.color, colorOrder.size);
    });
    const sorted = [...group.rows].sort((left, right) => {
      const byColor = colorOrder.get(left.color) - colorOrder.get(right.color);
      return byColor !== 0 ? byColor : compareSize(left.size, right.size);
    });
    return { itemNo: group.itemNo, label: group.label, rows: sorted };
  });
};

// ─── 第二层：组内「按颜色归并」（业务负责人 2026-10-06 的「合并版」）──────────────
// 她的原话：「一个颜色一行，然后尺码和数量放一块。比方说：41码×1、41码×2、41码×3 这种」
// ⇒ 同货号 ＋ 同颜色 → **一行**；不同颜色各自一行；该颜色的全部尺码拼在**同一格**里。

/**
 * 「尺码×数量」——格里的最小单位。符号（乘法号）来自排版配置，不写死在这里。
 * 数量为 0（认不出数量时的兜底，见 formatQuantity）也照写 `37码×0`：
 * 图是给供应商看的，宁可把 0 明示出来，也不要悄悄少写一双。
 */
const formatSizeQuantity = (size, quantity) => `${size}${SIZE_QUANTITY_MULTIPLIER}${quantity}`;

/**
 * 分组内的明细行 → **图上的一行一行**：同颜色并成一行，尺码用「、」拼进同一格。
 *
 * 返回的每一项同时给出两个字段，正好对上配置里的两列
 *（`COLUMNS[i].key`：`color` / `sizeQuantity`），渲染端按 `row[column.key]` 取数：
 *   { color: '黑', sizeQuantity: '9码×1、40码×1、41码×1、均码×1' }
 *
 * 尺码顺序**照第一层的口径**：数字升序、非数字（均码/XL）兜到最后（compareSize）。
 * 这里再排一次不是"另立一套"——而是让这个函数**独立成立**：
 * 传进来乱序的行也得到同样的结果，单测不必先跑 groupRowsByItemNo。
 *
 * 颜色缺失（历史草稿可能只有尺码）时 `color` 是空串：跟改前一样留空、不编一个假颜色。
 * 不增删行：所有明细都会出现在某个颜色格里（数量也不做任何加总）。
 */
const mergeSizesByColor = (rows) => {
  const byColor = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = row?.color || '';
    if (!byColor.has(key)) byColor.set(key, []);
    byColor.get(key).push(row);
  });

  return [...byColor.entries()].map(([color, colorRows]) => {
    const ordered = [...colorRows].sort((left, right) => compareSize(left.size, right.size));
    return {
      color,
      sizeQuantity: ordered.map((row) => formatSizeQuantity(row.size, row.quantity))
        .join(SIZE_QUANTITY_SEPARATOR),
    };
  });
};

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

/**
 * 画 [top, bottom] 这一段的列间竖线。
 * ⚠️ 分组版的竖线**不能**从表头一路画到表底：分组行是跨列的，
 * 一条竖线穿过去会把它切成两半，看着像「货号只属于第一列」。
 * 所以按段调用：列头一段，每个货号的分组明细各一段。
 */
const pushColumnLines = (parts, top, bottom) => {
  let x = MARGIN;
  for (let index = 0; index < COLUMNS.length - 1; index += 1) {
    x += COLUMNS[index].width;
    parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" ` +
      `stroke="${COLORS.line}" stroke-width="1"/>`);
  }
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
 * 因此排版规则（标题、尺码×数量的写法、列宽/截断）都能在没有网络、没有 sharp 的情况下单测。
 */
const buildPurchaseRequestSvg = ({ supplierName, batchNo = '', items = [], generatedAt = new Date(),
  title = TITLE } = {}) => {
  const rows = normalizeItems(items);
  // 两层排版：① 按货号分组 → ② 组内把**同颜色**并成图上的一行。
  // 并好之后每个分组自带 `colorRows`（图上真正的一行一行），表高/斑马纹/竖线都按它算。
  const groups = groupRowsByItemNo(rows)
    .map((group) => ({ ...group, colorRows: mergeSizesByColor(group.rows) }));
  const { rowCount, totalPairs } = summarize(rows);
  // 表高 = 列头 + Σ（分组行 + 该组的**颜色行**）。空明细时仍然留一行正文的高度，
  // 给「本批次没有明细」那句话站脚。
  const bodyHeight = rows.length === 0
    ? ROW_HEIGHT
    : groups.reduce((sum, group) => sum + GROUP_ROW_HEIGHT + group.colorRows.length * ROW_HEIGHT, 0);
  const tableHeight = HEADER_ROW_HEIGHT + bodyHeight;
  const footerTop = TABLE_TOP + tableHeight + FOOTER_GAP;
  // 合计行由配置开关控制（见 config/purchaseRequestImageLayout.js 的 SHOW_TOTAL）：
  // 关掉时整张图**不留那条空带**，底部只留 BOTTOM_PADDING。
  const height = TABLE_TOP + tableHeight + (SHOW_TOTAL ? FOOTER_GAP + FOOTER_HEIGHT : 0) + BOTTOM_PADDING;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`);
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#ffffff"/>`);

  // 标题区：默认「邯美皮鞋采购单」，采购退货传「邯美皮鞋退货单」；
  // 下面一行写清这批是给谁、哪一批。
  parts.push(`<text x="${WIDTH / 2}" y="${TITLE_BASELINE}" font-family="${FONT_FAMILY}" font-size="34" ` +
    `font-weight="bold" fill="${COLORS.ink}" text-anchor="middle">${escapeXml(title)}</text>`);
  // ⚠️ 没有供应商时**不渲染「供应商：」这一段**（业务负责人 2026-10-06：
  // 「没维护供应商的货品，也应该能正常出单」）。以前这里写「供应商：未填写」，
  // 看着像一条警告、像这张单有问题；留空才是"正常出单"的样子。
  // 有供应商的那一段照旧渲染——供应商信息一个都没删。
  const subtitle = [
    supplierName ? `供应商：${truncateToWidth(supplierName, 300, 18)}` : '',
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

  // 明细：**按货号分组**——每个货号一条跨满整张表的「分组行」（底色 + 加粗 + 字号 24），
  // 组内**每个颜色一行**，两列写 颜色 | 尺码×数量（`37码×1、41码×3`）。
  // 空明细也要画一行「本批次没有明细」，否则整张图只剩标题，看着像渲染失败。
  if (rows.length === 0) {
    const y = TABLE_TOP + HEADER_ROW_HEIGHT + ROW_HEIGHT / 2 + 7;
    parts.push(`<text x="${WIDTH / 2}" y="${y}" font-family="${FONT_FAMILY}" font-size="22" ` +
      `fill="${COLORS.muted}" text-anchor="middle">本批次没有明细</text>`);
  } else {
    let cursorY = TABLE_TOP + HEADER_ROW_HEIGHT;
    groups.forEach((group, groupIndex) => {
      const groupTop = cursorY;
      const detailTop = groupTop + GROUP_ROW_HEIGHT;
      parts.push(`<rect x="${MARGIN}" y="${groupTop}" width="${TABLE_WIDTH}" height="${GROUP_ROW_HEIGHT}" fill="${COLORS.groupBg}"/>`);
      // ⚠️ 第 1 条分组行的上边线就是表头下边线（下面统一画），这里只补组与组之间的那条；
      // 画在底色**之后**，否则会被分组行的底色盖掉一半、看着像条细灰缝。
      if (groupIndex > 0) {
        parts.push(`<line x1="${MARGIN}" y1="${groupTop}" x2="${MARGIN + TABLE_WIDTH}" y2="${groupTop}" ` +
          `stroke="${COLORS.line}" stroke-width="1"/>`);
      }
      // 分组行跨满整张表：x 从左边距 + 单元格内边距起，可画宽度就是 TABLE_WIDTH 去掉左右内边距。
      parts.push(`<text x="${MARGIN + CELL_PADDING}" y="${groupTop + GROUP_ROW_HEIGHT / 2 + 8}" ` +
        `font-family="${FONT_FAMILY}" font-size="24" font-weight="bold" fill="${COLORS.ink}" text-anchor="start">` +
        `${escapeXml(truncateToWidth(group.label, TABLE_WIDTH - CELL_PADDING * 2, 24))}</text>`);
      // 分组行下的横线：把「标题」和「它的明细」切开。
      parts.push(`<line x1="${MARGIN}" y1="${detailTop}" x2="${MARGIN + TABLE_WIDTH}" y2="${detailTop}" ` +
        `stroke="${COLORS.line}" stroke-width="1"/>`);

      group.colorRows.forEach((row, rowIndex) => {
        const rowTop = detailTop + rowIndex * ROW_HEIGHT;
        // 斑马纹改成**分组内**重新起算：分组行本身已经有底色，
        // 再叠一层全局斑马纹只会让相邻两组的同一位置长得不一样，反而更难数行。
        if (rowIndex % 2 === 1) {
          parts.push(`<rect x="${MARGIN}" y="${rowTop}" width="${TABLE_WIDTH}" height="${ROW_HEIGHT}" fill="${COLORS.stripeBg}"/>`);
        }
        const y = rowTop + ROW_HEIGHT / 2 + 7;
        COLUMNS.forEach((column, index) => {
          parts.push(cellText(column, index, row[column.key], y));
        });
      });

      // 竖线只画在**明细行那一段**：分组行是跨列的，横穿一条竖线会把它切开。
      pushColumnLines(parts, detailTop, detailTop + group.colorRows.length * ROW_HEIGHT);
      cursorY = detailTop + group.colorRows.length * ROW_HEIGHT;
    });
  }

  // 表格边框 + 竖线：手写线条而不是 <table>，librsvg 对表格支持不稳定。
  parts.push(`<rect x="${MARGIN}" y="${TABLE_TOP}" width="${TABLE_WIDTH}" height="${tableHeight}" ` +
    `fill="none" stroke="${COLORS.border}" stroke-width="1.5"/>`);
  // 列头那一段的竖线照旧画满——列头仍然是一行格子的表头。
  pushColumnLines(parts, TABLE_TOP, TABLE_TOP + HEADER_ROW_HEIGHT);
  parts.push(`<line x1="${MARGIN}" y1="${TABLE_TOP + HEADER_ROW_HEIGHT}" x2="${MARGIN + TABLE_WIDTH}" ` +
    `y2="${TABLE_TOP + HEADER_ROW_HEIGHT}" stroke="${COLORS.line}" stroke-width="1"/>`);

  // 合计（默认**不画**，见配置里的 SHOW_TOTAL）：数量已经写在「尺码×数量」格里，
  // 而「条」在合并版里对不上图上能数出来的行数。
  // 留着这段渲染是让"改回来只要把开关翻成 true"，不是删掉重写。
  if (SHOW_TOTAL) {
    const footerY = footerTop + FOOTER_HEIGHT / 2 + 8;
    parts.push(`<text x="${WIDTH / 2}" y="${footerY}" font-family="${FONT_FAMILY}" font-size="22" ` +
      `font-weight="bold" fill="${COLORS.ink}" text-anchor="middle">合计：${rowCount} 条 / ${totalPairs} 双</text>`);
  }

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
  // 合并版的排版契约：列宽（和必须等于 TABLE_WIDTH）、分组顺序、尺码数字序、
  // 以及「同颜色并成一行」的归并规则。
  COLUMNS,
  TABLE_WIDTH,
  GROUP_ROW_HEIGHT,
  UNKNOWN_ITEM_NO,
  groupRowsByItemNo,
  mergeSizesByColor,
  formatSizeQuantity,
  SIZE_QUANTITY_SEPARATOR,
  SIZE_QUANTITY_MULTIPLIER,
  SHOW_TOTAL,
  sizeSortValue,
  compareSize,
  // 布局常量也导出：单测要按**坐标**断言「分组行跨满整张表、字比正文重」，
  // 而不是靠 includes 某段字符串蒙过去。
  COLORS,
  MARGIN,
  CELL_PADDING,
  TABLE_TOP,
  ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
};
